import { randomUUID } from 'node:crypto'
import { ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import { pluginHost, type McpRuntime } from '@main/plugin/PluginHost'
import { pluginRegistry } from '@main/plugin/PluginRegistry'
import { isPluginPageUrl } from '@main/plugin/pluginSessionPolicy'
import { acquirePluginActivity } from '@main/plugin/activityRegistry'
import { acquireNonInteractive, getHostRpcCount, hasNativeInteraction, whenHostRpcIdle } from '@main/plugin/pluginInteractionPolicy'
import type { PluginRuntimeScope } from '@main/plugin/PluginRuntimeScope'
import { IpcChannels } from '@shared/types/ipc'
import type { McpErrorCode, McpRegistrationAck, McpResultMessage, McpToolResult } from '@shared/types/mcp'
import type { McpCallRecord } from '@shared/types/mcpSettings'
import { getMcpCatalog, type CatalogEntry } from './mcpCatalog'
import { failureCode, failureResult, MCP_MAX_BYTES, McpFailure } from './mcpErrors'
import { validateMcpSchema } from './mcpSchemaValidator'

interface Registration { id: string; runtime: McpRuntime }
interface Job {
  id: string; pluginId: string; toolId: string; source: string; startedAt: number
  controller: AbortController; runtime?: McpRuntime; registration?: Registration; entry?: CatalogEntry
  clientSettled: boolean; handlerSettled: boolean; draining: boolean
  resolve(result: McpToolResult): void; releaseActivity(): void; releaseGuard?: () => void; detachSignal(): void
  timer?: ReturnType<typeof setTimeout>; quarantineTimer?: ReturnType<typeof setTimeout>
}
const registrations = new Map<string, Registration>()
const jobs = new Map<string, Job>()
const unavailable = new WeakSet<PluginRuntimeScope>()
const readyListeners = new Map<string, Set<() => void>>()
const records: McpCallRecord[] = []
let registered = false, accepting = false

function same(a: McpRuntime, b: McpRuntime | null): boolean {
  return !!b && a.scope === b.scope && a.contents === b.contents && a.generation === b.generation
    && a.documentEpoch === b.documentEpoch && a.buildRevision === b.buildRevision
}
function identity(event: IpcMainEvent | IpcMainInvokeEvent): { pluginId: string; runtime: McpRuntime } {
  const pluginId = pluginHost.getPluginIdByWebContentsId(event.sender.id)
  if (!pluginId || event.sender.isDestroyed() || event.senderFrame !== event.sender.mainFrame
    || !isPluginPageUrl(event.senderFrame.url, pluginId, pluginRegistry.get(pluginId)?.devUrl)) throw new McpFailure('permission-denied')
  const runtime = pluginHost.getMcpRuntime(pluginId)
  if (!runtime || runtime.contents !== event.sender || runtime.scope.isClosing || !runtime.scope.isCurrent()) throw new McpFailure('unavailable')
  return { pluginId, runtime }
}
function clientDone(job: Job, result: McpToolResult, code?: McpErrorCode): void {
  if (job.clientSettled) return
  job.clientSettled = true
  job.detachSignal()
  if (job.timer) clearTimeout(job.timer)
  records.unshift({ requestId: job.id, startedAt: job.startedAt, source: job.source, pluginId: job.pluginId, toolId: job.toolId,
    status: code === 'cancelled' ? 'cancelled' : result.isError ? 'error' : 'success', durationMs: Date.now() - job.startedAt, errorCode: code })
  records.length = Math.min(records.length, 100)
  job.resolve(result)
}
function release(job: Job): void {
  if (job.quarantineTimer) clearTimeout(job.quarantineTimer)
  job.releaseGuard?.(); job.releaseGuard = undefined
  job.releaseActivity()
  if (jobs.get(job.pluginId) === job) jobs.delete(job.pluginId)
}
async function drain(job: Job): Promise<void> {
  if (job.draining || !job.handlerSettled) return
  job.draining = true
  if (job.runtime) await whenHostRpcIdle(job.runtime.scope)
  release(job)
}
function cancel(job: Job, code: McpErrorCode): void {
  if (job.controller.signal.aborted) return
  job.controller.abort(new McpFailure(code))
  clientDone(job, failureResult(code), code)
  if (job.registration && job.runtime && !job.runtime.contents.isDestroyed()) {
    job.runtime.contents.send(IpcChannels.PluginMcpCancel, { requestId: job.id, registrationId: job.registration.id })
  }
  job.quarantineTimer = setTimeout(() => {
    if (jobs.get(job.pluginId) !== job || !job.runtime) return
    if (!job.handlerSettled || getHostRpcCount(job.runtime.scope)) unavailable.add(job.runtime.scope)
    // Keep the slot/guard until actual settlement; only the bounded keepalive expires.
    job.releaseActivity()
  }, 2000)
  job.quarantineTimer.unref?.()
  void drain(job)
}
function waitForReady(pluginId: string, runtime: McpRuntime, signal: AbortSignal): Promise<Registration> {
  return new Promise((resolve, reject) => {
    const listeners = readyListeners.get(pluginId) ?? new Set<() => void>()
    const cleanup = (): void => { listeners.delete(check); if (!listeners.size) readyListeners.delete(pluginId); signal.removeEventListener('abort', abort) }
    const abort = (): void => { cleanup(); reject(signal.reason ?? new McpFailure('cancelled')) }
    function check(): void {
      if (signal.aborted) { abort(); return }
      if (!same(runtime, pluginHost.getMcpRuntime(pluginId))) { cleanup(); reject(new McpFailure('unavailable')); return }
      const entry = registrations.get(pluginId)
      if (entry && same(runtime, entry.runtime)) { cleanup(); resolve(entry) }
    }
    listeners.add(check); readyListeners.set(pluginId, listeners)
    signal.addEventListener('abort', abort, { once: true }); check()
  })
}

const resultSchema = {
  type: 'object', required: ['content'], additionalProperties: false,
  properties: { isError: { type: 'boolean' }, structuredContent: {}, content: { type: 'array', maxItems: 1024, items: {
    type: 'object', required: ['type'], properties: { type: { enum: ['text', 'image', 'audio', 'resource', 'resource_link'] }, annotations: { type: 'object' } },
    allOf: [
      { if: { properties: { type: { const: 'text' } } }, then: { required: ['text'], properties: { text: { type: 'string' } } } },
      { if: { properties: { type: { enum: ['image', 'audio'] } } }, then: { required: ['data', 'mimeType'], properties: { data: { type: 'string' }, mimeType: { type: 'string' } } } },
      { if: { properties: { type: { const: 'resource_link' } } }, then: { required: ['uri', 'name'], properties: { uri: { type: 'string' }, name: { type: 'string' } } } },
      { if: { properties: { type: { const: 'resource' } } }, then: { required: ['resource'], properties: { resource: { type: 'object', required: ['uri'], properties: { uri: { type: 'string' }, text: { type: 'string' }, blob: { type: 'string' } }, anyOf: [{ required: ['text'] }, { required: ['blob'] }] } } } }
    ]
  } } }
}
function boundedJson(value: unknown): string {
  let nodes = 0, size = 0
  const stack = [{ value, depth: 0 }]
  while (stack.length) {
    const item = stack.pop()!
    if (++nodes > 50_000 || item.depth > 40) throw new McpFailure('result-too-large')
    if (typeof item.value === 'string') size += Buffer.byteLength(item.value)
    else if (item.value && typeof item.value === 'object') {
      for (const [key, child] of Object.entries(item.value)) { size += Buffer.byteLength(key); stack.push({ value: child, depth: item.depth + 1 }) }
    } else if (item.value !== null && !['number', 'boolean'].includes(typeof item.value)) throw new McpFailure('internal-error')
    if (size > MCP_MAX_BYTES) throw new McpFailure('result-too-large')
  }
  const json = JSON.stringify(value)
  if (Buffer.byteLength(json) > MCP_MAX_BYTES - 2048) throw new McpFailure('result-too-large')
  return json
}
async function resultFor(job: Job, message: McpResultMessage): Promise<void> {
  job.handlerSettled = true
  try {
    if (job.clientSettled) return
    if (message.errorCode) { const code = failureCode({ code: message.errorCode }); clientDone(job, failureResult(code), code); return }
    boundedJson(message.result)
    if (!await validateMcpSchema('mcp-result-v1', resultSchema, message.result)) throw new McpFailure('internal-error')
    const result = message.result!
    if (!result.isError && job.entry?.tool.outputSchema && (result.structuredContent === undefined
      || !await validateMcpSchema(`${job.entry.schemaKey}:out`, job.entry.tool.outputSchema, result.structuredContent))) throw new McpFailure('internal-error')
    if (!same(job.runtime!, pluginHost.getMcpRuntime(job.pluginId))) throw new McpFailure('unavailable')
    clientDone(job, result)
  } catch (error) { const code = failureCode(error); clientDone(job, failureResult(code), code) }
  finally { void drain(job) }
}

export function registerMcpPluginBridge(): void {
  if (registered) return
  registered = true
  ipcMain.handle(IpcChannels.PluginMcpRegister, async (event, input: unknown): Promise<McpRegistrationAck> => {
    const { pluginId, runtime } = identity(event)
    const ids = input && typeof input === 'object' ? Reflect.get(input, 'toolIds') : undefined
    const declared = runtime.scope.isCurrent() ? pluginRegistry.getManifest(pluginId)?.contributes?.mcpTools?.map(tool => tool.id).sort() ?? [] : []
    if (!Array.isArray(ids) || ids.length > 128 || ids.some(id => typeof id !== 'string')
      || !declared.length || JSON.stringify([...ids].sort()) !== JSON.stringify(declared) || registrations.has(pluginId)) throw new McpFailure('invalid-arguments')
    if (!(await getMcpCatalog()).some(entry => entry.tool.pluginId === pluginId) || !same(runtime, pluginHost.getMcpRuntime(pluginId))) throw new McpFailure('unavailable')
    const registration = { id: randomUUID(), runtime }
    registrations.set(pluginId, registration)
    for (const listener of readyListeners.get(pluginId) ?? []) listener()
    return { registrationId: registration.id }
  })
  ipcMain.on(IpcChannels.PluginMcpResult, (event, message: McpResultMessage) => {
    try {
      const { pluginId, runtime } = identity(event), job = jobs.get(pluginId)
      if (!job || !message || message.requestId !== job.id || message.registrationId !== job.registration?.id
        || !job.runtime || !same(job.runtime, runtime) || job.handlerSettled) return
      void resultFor(job, message)
    } catch { /* Stale documents cannot settle another generation. */ }
  })
  pluginHost.onMcpRuntimeRetired((pluginId, reason) => {
    registrations.delete(pluginId)
    const job = jobs.get(pluginId)
    if (job) {
      cancel(job, 'unavailable')
      if (reason !== 'navigation' && job.runtime?.scope.signal.aborted) { job.handlerSettled = true; void drain(job) }
      else if (job.runtime) {
        job.runtime.scope.signal.addEventListener('abort', () => { job.handlerSettled = true; void drain(job) }, { once: true })
      }
    }
    for (const listener of readyListeners.get(pluginId) ?? []) listener()
  })
}

export function setMcpAccepting(value: boolean): void {
  accepting = value
  if (!value) for (const job of jobs.values()) cancel(job, 'cancelled')
}
export function getMcpExecutionState(): { activeCalls: number; recentCalls: McpCallRecord[] } {
  return { activeCalls: jobs.size, recentCalls: records.map(record => ({ ...record })) }
}

export function callMcpTool(input: { pluginId: string; toolId: string; arguments: Record<string, unknown> }, signal: AbortSignal, source: string): Promise<McpToolResult> {
  if (!accepting) return Promise.resolve(failureResult('unavailable'))
  if (!input || typeof input.pluginId !== 'string' || !input.pluginId || input.pluginId.length > 256
    || typeof input.toolId !== 'string' || !input.toolId || input.toolId.length > 64 || !input.arguments || typeof input.arguments !== 'object' || Array.isArray(input.arguments)) return Promise.resolve(failureResult('invalid-arguments'))
  if (signal.aborted) return Promise.resolve(failureResult('cancelled'))
  if (hasNativeInteraction() || jobs.size >= 4 || jobs.has(input.pluginId)) return Promise.resolve(failureResult('busy'))
  return new Promise(resolve => {
    const id = randomUUID()
    const job: Job = { id, pluginId: input.pluginId, toolId: input.toolId, source: source.slice(0, 100).replace(/[\x00-\x1f]/g, ''), startedAt: Date.now(),
      controller: new AbortController(), clientSettled: false, handlerSettled: false, draining: false, resolve,
      releaseActivity: acquirePluginActivity(input.pluginId, `mcp:${id}`, 'MCP execution'), detachSignal: () => {} }
    jobs.set(input.pluginId, job)
    const abort = (): void => cancel(job, 'cancelled')
    signal.addEventListener('abort', abort, { once: true }); job.detachSignal = () => signal.removeEventListener('abort', abort)
    void (async () => {
      try {
        boundedJson(input.arguments)
        job.entry = (await getMcpCatalog()).find(entry => entry.tool.pluginId === input.pluginId && entry.tool.id === input.toolId)
        if (!job.entry) throw new McpFailure('not-found')
        if (!await validateMcpSchema(`${job.entry.schemaKey}:in`, job.entry.tool.inputSchema, input.arguments)) throw new McpFailure('invalid-arguments')
        if (job.controller.signal.aborted) throw job.controller.signal.reason
        if (hasNativeInteraction()) throw new McpFailure('busy')
        const existing = pluginHost.getMcpRuntime(input.pluginId)
        if (existing) {
          if (unavailable.has(existing.scope)) throw new McpFailure('unavailable')
          job.runtime = existing; job.releaseGuard = acquireNonInteractive(existing.scope, 'MCP execution')
        }
        job.timer = setTimeout(() => cancel(job, 'timeout'), 15_000)
        const runtime = await pluginHost.ensureRunningForMcp(input.pluginId, job.controller.signal)
        if (job.controller.signal.aborted) throw job.controller.signal.reason
        if (hasNativeInteraction()) throw new McpFailure('busy')
        if (job.runtime && !same(job.runtime, runtime) || unavailable.has(runtime.scope)) throw new McpFailure('unavailable')
        job.runtime = runtime
        job.releaseGuard ??= acquireNonInteractive(runtime.scope, 'MCP execution')
        job.registration = await waitForReady(input.pluginId, runtime, job.controller.signal)
        if (hasNativeInteraction()) throw new McpFailure('busy')
        if (!same(runtime, pluginHost.getMcpRuntime(input.pluginId)) || runtime.buildRevision !== job.entry.buildRevision
          || pluginHost.isBlockedForOpen(input.pluginId) || !pluginRegistry.isEnabled(input.pluginId)) throw new McpFailure('unavailable')
        clearTimeout(job.timer)
        job.timer = setTimeout(() => cancel(job, 'timeout'), 60_000)
        job.handlerSettled = false
        runtime.contents.send(IpcChannels.PluginMcpDispatch, { registrationId: job.registration.id, requestId: id, toolId: input.toolId, arguments: input.arguments, deadlineAt: Date.now() + 60_000 })
      } catch (error) {
        job.handlerSettled = true
        const code = job.controller.signal.aborted ? failureCode(job.controller.signal.reason) : failureCode(error)
        clientDone(job, failureResult(code), code); void drain(job)
      }
    })()
  })
}
