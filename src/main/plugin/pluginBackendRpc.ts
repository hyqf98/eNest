import { utilityProcess, webContents, type UtilityProcess } from 'electron'
import { getRuntimeScope, type PluginRuntimeScope } from './PluginRuntimeScope'
import { resolvePluginBackendPackage } from './pluginBackend'
import { pluginHost } from './PluginHost'
import { registerPluginProcess } from './pluginOwnedProcesses'
import { PluginBackendControl } from './pluginBackendControl'
import { getAppPaths } from '@main/paths/pathsService'
import { interactionErrorCode, runHostRpc } from '@main/plugin/pluginInteractionPolicy'

interface Pending {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  release: () => void
  timer: ReturnType<typeof setTimeout>
  startedAt: number
  method: string
}
interface Backend {
  scope: PluginRuntimeScope
  child: UtilityProcess
  pending: Map<number, Pending>
  closed: boolean
  failedClose: boolean
  exited: boolean
  retired: boolean
  detach: () => void
  unregister: () => void
  exit: Promise<void>
  resolveExit: () => void
  releases: Set<() => void>
  control: PluginBackendControl
  hostRequests: Set<number>
  startedAt: number
  completed: number
  failed: number
  lastDurationMs: number | null
  shutdown?: Promise<void>
}
const backends = new Map<string, Backend>()
let sequence = 0
const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value, (_, x) => typeof x === 'bigint' ? String(x) : x) ?? '')
function pageOrigin(scope: PluginRuntimeScope): string | null {
  try {
    const url = new URL(webContents.fromId(scope.owner.wcId)?.getURL() ?? '')
    if (url.protocol === 'enest:' && url.hostname === 'plugin') return 'enest://plugin'
    if (['http:', 'https:'].includes(url.protocol)) return url.origin
  } catch { /* No network origin is granted for a missing page. */ }
  return null
}
function trace(backend: Backend, event: string, extra: object = {}): void {
  if (process.env.ENEST_BACKEND_TRACE !== '1') return
  const record = { event, pluginId: backend.scope.owner.pluginId, generation: backend.scope.owner.generation,
    pid: backend.child.pid ?? null, pending: backend.pending.size, ...extra }
  void import('@main/logs/logService').then(({ logInfo }) => logInfo('backend-lifecycle', JSON.stringify(record))).catch(() => {})
}

function stop(backend: Backend, reason: string, unexpected = false): void {
  if (backend.retired) return
  if (!backend.closed) {
    backend.failedClose = unexpected
    backend.closed = true
    trace(backend, 'closing')
    for (const pending of backend.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error(reason))
      backend.releases.add(pending.release)
    }
    backend.pending.clear()
  }
  if (backend.shutdown) return
  const attempt = (async () => {
    await backend.control.beginClose(!backend.exited)
    if (!backend.exited) {
      try { backend.child.postMessage({ type: 'shutdown', reason, deadlineAt: Date.now() + 900 }) } catch { /* Bounded fallback below. */ }
      let grace: ReturnType<typeof setTimeout> | undefined
      try { await Promise.race([backend.exit, new Promise<void>(resolve => { grace = setTimeout(resolve, 900) })]) }
      finally { if (grace) clearTimeout(grace) }
    }
    await backend.control.stopChildren('SIGTERM')
    if (!backend.exited) { try { backend.child.kill() } catch { /* escalate after spawn */ } }
    await new Promise<void>(resolve => setTimeout(resolve, 250))
    await backend.control.stopChildren('SIGKILL')
    if (!backend.exited && backend.child.pid) { try { process.kill(backend.child.pid, 'SIGKILL') } catch { /* exit listener owns cleanup */ } }
    await new Promise<void>(resolve => setTimeout(resolve, 50))
    await backend.control.confirmChildrenExited()
    if (!backend.exited) throw new Error('plugin backend exit not confirmed')
    await backend.control.dispose()
    backend.retired = true
    trace(backend, 'retired')
    backend.unregister()
    backend.detach()
    for (const release of backend.releases) release()
    backend.releases.clear()
    if (backends.get(backend.scope.owner.pluginId) === backend) backends.delete(backend.scope.owner.pluginId)
  })().catch(error => {
    backend.scope.failures.push(`backend cleanup: ${String(error)}`)
    // Retain ownership/barriers, but allow an explicit stop or late exit to retry.
    // No timer retries: an unavailable OS identity sampler has its own cooldown.
    if (backend.shutdown === attempt) backend.shutdown = undefined
    throw error
  })
  backend.shutdown = attempt
  // Abort/exit listeners do not await shutdown; explicit disposal still observes its rejection.
  void attempt.catch(() => {})
}

async function waitForExit(backend: Backend): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try { await Promise.race([Promise.all([backend.exit, backend.shutdown]), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('plugin backend exit not confirmed')), 3000) })]) }
  finally { if (timer) clearTimeout(timer) }
}

function backendFor(pluginId: string): Backend {
  // Recheck permission/path before every call, even when a process already exists.
  const { entry, root } = resolvePluginBackendPackage(pluginId), scope = getRuntimeScope(pluginId)!
  const old = backends.get(pluginId)
  if (old) {
    if (old.scope === scope && !old.closed) return old
    stop(old, 'plugin backend replaced')
    if (!old.retired) throw new Error('previous plugin backend is still retiring')
  }
  const child = utilityProcess.fork(entry, [], { serviceName: `eNest backend ${pluginId} #${scope.owner.generation}`, stdio: 'ignore', execArgv: ['--max-old-space-size=256'], env: { ...process.env, NODE_USE_ENV_PROXY: '1' } })
  let resolveExit!: () => void
  const exit = new Promise<void>(resolve => { resolveExit = resolve })
  const backend: Backend = { scope, child, exit, resolveExit, pending: new Map(), closed: false, failedClose: false, exited: false, retired: false, detach: () => {}, unregister: () => {}, releases: new Set(),
    control: new PluginBackendControl(scope, () => backend.exited ? undefined : child.pid, async () => { stop(backend, 'plugin backend closed'); await waitForExit(backend) }), hostRequests: new Set(),
    startedAt: Date.now(), completed: 0, failed: 0, lastDurationMs: null }
  backends.set(pluginId, backend)
  const abort = () => stop(backend, 'plugin backend closed')
  const shutdown = async () => { abort(); await waitForExit(backend) }
  const unregister = registerPluginProcess({ pluginId, generation: scope.owner.generation, kind: 'backend', getPid: () => backend.exited ? undefined : child.pid, stop: shutdown })
  backend.unregister = () => { unregister(); scope.signal.removeEventListener('abort', abort) }
  child.once('spawn', () => { trace(backend, 'spawn'); if (backend.closed || scope.signal.aborted) stop(backend, 'plugin backend closed') })
  // UtilityProcess fatal errors are followed by exit; retain ownership until then.
  child.once('error', () => stop(backend, 'plugin backend failed', true))
  child.once('exit', code => {
    const unexpected = (!backend.closed || backend.failedClose) && scope.isCurrent() && !scope.isClosing && !scope.signal.aborted
    backend.exited = true
    if (unexpected) pluginHost.sendEvent(pluginId, { type: 'backend.event', event: 'backend.exit', data: { code: Number.isFinite(code) ? code : null, unexpected: true } })
    stop(backend, 'plugin backend exited')
    resolveExit()
  })
  scope.signal.addEventListener('abort', abort, { once: true })
  backend.detach = scope.addDisposer(shutdown)
  if (scope.signal.aborted) abort()
  child.on('message', (message: { type?: string; id?: number; method?: string; params?: unknown; ok?: boolean; data?: unknown; error?: string; event?: string }) => {
    try {
      if (!message || typeof message !== 'object') throw new Error('invalid backend message')
      if (bytes(message) > 8 * 1024 * 1024) throw new Error('plugin backend response exceeds 8 MiB')
      if (message.type === 'shutdown.complete') return // Actual exit, not an acknowledgment, owns cleanup.
      if (message.type === 'host.request') {
        const id = message.id
        if (!Number.isSafeInteger(id) || backend.hostRequests.has(id!) || backend.hostRequests.size >= 64) throw new Error('invalid or excessive backend control requests')
        backend.hostRequests.add(id!)
        const reply = (result: object) => { if (!backend.exited) { try { child.postMessage({ type: 'host.response', id, ...result }) } catch { /* retiring channel */ } } }
        void runHostRpc(scope, () => backend.control.request(message.method, message.params)).then(
          data => reply({ ok: true, data }), error => reply({ ok: false, error: String(error).slice(0, 4096), errorCode: interactionErrorCode(error) })
        ).finally(() => backend.hostRequests.delete(id!))
        return
      }
      if (backend.closed || !scope.isCurrent() || scope.isClosing) return
      if (typeof message.event === 'string') {
        if (!/^[\w.-]{1,80}$/.test(message.event)) throw new Error('invalid backend event')
        // The sender's owner supplies pluginId; payloads cannot impersonate shell/SSH events.
        pluginHost.sendEvent(pluginId, { type: 'backend.event', event: message.event, data: message.data })
        return
      }
      const pending = backend.pending.get(Number(message.id))
      if (!pending) return
      backend.pending.delete(Number(message.id)); clearTimeout(pending.timer); pending.release()
      backend.completed++
      if (message.ok !== true) backend.failed++
      backend.lastDurationMs = Math.max(0, performance.now() - pending.startedAt)
      trace(backend, 'response', { method: pending.method, durationMs: backend.lastDurationMs, ok: message.ok === true })
      if (message.ok === true) pending.resolve(message.data)
      else pending.reject(new Error(String(message.error || 'plugin backend request failed').slice(0, 4096)))
    } catch (error) { stop(backend, String(error), true) }
  })
  child.postMessage({ type: 'init', pluginId, generation: scope.owner.generation, wcId: scope.owner.wcId,
    context: { protocolVersion: 1, appDataPath: getAppPaths().data, packagePath: root, appExecPath: process.execPath, pageOrigin: pageOrigin(scope) } })
  return backend
}

export function callPluginBackend(pluginId: string, method: unknown, args: unknown = [], options: unknown = {}): Promise<unknown> {
  if (typeof method !== 'string' || !/^[A-Za-z][\w.-]{0,79}$/.test(method) || !Array.isArray(args)) throw new Error('invalid backend request')
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new Error('invalid backend options')
  const timeoutMs = (options as { timeoutMs?: unknown }).timeoutMs ?? 30_000
  if (!Number.isSafeInteger(timeoutMs) || Number(timeoutMs) < 250 || Number(timeoutMs) > 86_400_000) throw new Error('backend timeout must be 250 ms to 24 hours')
  if (bytes(args) > 4 * 1024 * 1024) throw new Error('plugin backend request exceeds 4 MiB')
  const backend = backendFor(pluginId)
  if (backend.pending.size >= 32) throw new Error('too many pending backend requests')
  const id = ++sequence, release = backend.scope.acquireActivity(`backend:${method}`)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => stop(backend, 'plugin backend request timed out', true), Number(timeoutMs))
    backend.pending.set(id, { resolve, reject, release, timer, startedAt: performance.now(), method })
    try {
      backend.child.postMessage({ id, pluginId, method, args, proxy: { HTTP_PROXY: process.env.HTTP_PROXY, HTTPS_PROXY: process.env.HTTPS_PROXY, ALL_PROXY: process.env.ALL_PROXY, NO_PROXY: process.env.NO_PROXY } })
    } catch (error) { backend.pending.delete(id); clearTimeout(timer); release(); reject(error) }
  })
}

/** Reset an unresponsive native worker without replacing the renderer's runtime identity. */
export async function stopPluginBackend(pluginId: string): Promise<void> {
  const backend = backends.get(pluginId)
  if (!backend) return
  const scope = getRuntimeScope(pluginId)
  if (scope !== backend.scope || !scope?.isCurrent()) throw new Error('plugin backend owner is stale')
  stop(backend, 'plugin backend stopped')
  await waitForExit(backend)
}

export function getBackendDiagnostics() {
  return [...backends.values()].map(backend => ({ pluginId: backend.scope.owner.pluginId, generation: backend.scope.owner.generation,
    pid: backend.exited ? null : backend.child.pid ?? null, closing: backend.closed, pending: backend.pending.size, hostRequests: backend.hostRequests.size,
    startedAt: backend.startedAt, completed: backend.completed, failed: backend.failed, lastDurationMs: backend.lastDurationMs }))
}
