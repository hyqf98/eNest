/** MCP registration, bounded dispatch and cancellation settlement for one page. */
import { ipcRenderer } from 'electron'
import type { McpCancelMessage, McpDispatchMessage, McpRegistrationAck, McpResultMessage, McpToolHandlers } from '@shared/types/mcp'
import * as IpcChannels from '@shared/types/ipc'

let mcpHandlers: McpToolHandlers | undefined

let mcpRegistrationId: string | undefined

let mcpRegistering = false

const earlyMcpDispatches: McpDispatchMessage[] = []

const earlyMcpCancellations = new Map<string, string>()

const activeMcpCalls = new Map<string, { registrationId: string; cancelled: boolean; callbacks: Set<() => void> }>()

function sendMcpResult(message: McpResultMessage): void {
  try {
    const json = JSON.stringify(message)
    if (new TextEncoder().encode(json).byteLength > 1024 * 1024) {
      ipcRenderer.send(IpcChannels.PluginMcpResult, { registrationId: message.registrationId, requestId: message.requestId, errorCode: 'result-too-large' } satisfies McpResultMessage)
    } else ipcRenderer.send(IpcChannels.PluginMcpResult, JSON.parse(json))
  } catch {
    try {
      ipcRenderer.send(IpcChannels.PluginMcpResult, { registrationId: message.registrationId, requestId: message.requestId, errorCode: 'internal-error' } satisfies McpResultMessage)
    } catch { /* The owner may already have been destroyed. */ }
  }
}

async function dispatchMcpCall(message: McpDispatchMessage): Promise<void> {
  if (!mcpHandlers || !mcpRegistrationId || message?.registrationId !== mcpRegistrationId || typeof message.requestId !== 'string') return
  if (activeMcpCalls.has(message.requestId)) return
  const handler = Object.prototype.hasOwnProperty.call(mcpHandlers, message.toolId) ? mcpHandlers[message.toolId] : undefined
  if (!handler || activeMcpCalls.size) {
    sendMcpResult({ registrationId: message.registrationId, requestId: message.requestId, errorCode: handler ? 'busy' : 'not-found' })
    return
  }
  const state = { registrationId: message.registrationId, cancelled: earlyMcpCancellations.get(message.requestId) === message.registrationId, callbacks: new Set<() => void>() }
  earlyMcpCancellations.delete(message.requestId)
  activeMcpCalls.set(message.requestId, state)
  const reply: McpResultMessage = { registrationId: message.registrationId, requestId: message.requestId }
  try {
    reply.result = await handler(message.arguments, {
      requestId: message.requestId,
      deadlineAt: message.deadlineAt,
      onCancel(callback) {
        if (typeof callback !== 'function') throw new TypeError('onCancel requires a function')
        if (state.cancelled) {
          try { callback() } catch { /* Cancellation callbacks must not interrupt settlement. */ }
        } else state.callbacks.add(callback)
        return () => { state.callbacks.delete(callback) }
      }
    })
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code
    if (code === 'needs-consent' || code === 'permission-denied' || code === 'interaction-required') reply.errorCode = code
    reply.result = { content: [{ type: 'text', text: state.cancelled ? 'Tool execution cancelled.' : 'Plugin tool execution failed.' }], isError: true }
  } finally {
    // A cancelled client still needs this real settlement fact to release its host guard.
    activeMcpCalls.delete(message.requestId)
    state.callbacks.clear()
    sendMcpResult(reply)
  }
}

export async function registerMcpHandlers(handlers: McpToolHandlers): Promise<void> {
  if (mcpHandlers || mcpRegistering || mcpRegistrationId) throw new Error('MCP handlers are already registered for this page')
  if (!handlers || typeof handlers !== 'object' || Array.isArray(handlers)) throw new TypeError('MCP handlers must be an object')
  const entries = Object.entries(handlers)
  if (entries.length > 128 || entries.some(([id, handler]) => !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id) || typeof handler !== 'function')) throw new TypeError('MCP handler IDs and functions are invalid')
  mcpRegistering = true
  mcpHandlers = Object.fromEntries(entries)
  try {
    const ack = await ipcRenderer.invoke(IpcChannels.PluginMcpRegister, { toolIds: entries.map(([id]) => id) }) as McpRegistrationAck
    if (!ack || typeof ack.registrationId !== 'string' || !ack.registrationId) throw new Error('MCP registration was not acknowledged')
    mcpRegistrationId = ack.registrationId
    for (const message of earlyMcpDispatches.splice(0)) void dispatchMcpCall(message)
  } catch (error) {
    mcpHandlers = undefined
    mcpRegistrationId = undefined
    earlyMcpDispatches.length = 0
    throw error
  } finally {
    mcpRegistering = false
    earlyMcpCancellations.clear()
  }
}

export function bindPluginMcpBridge(): void {
  ipcRenderer.on(IpcChannels.PluginMcpDispatch, (_event, message: McpDispatchMessage) => {
    if (mcpRegistering && !mcpRegistrationId) {
      if (message && typeof message.registrationId === 'string' && earlyMcpDispatches.length === 0) earlyMcpDispatches.push(message)
      return
    }
    void dispatchMcpCall(message)
  })
  ipcRenderer.on(IpcChannels.PluginMcpCancel, (_event, message: McpCancelMessage) => {
    if (!message || typeof message.requestId !== 'string' || typeof message.registrationId !== 'string') return
    const state = activeMcpCalls.get(message.requestId)
    if (!state) {
      if (mcpRegistering && earlyMcpCancellations.size < 8) earlyMcpCancellations.set(message.requestId, message.registrationId)
      return
    }
    if (state.registrationId !== message.registrationId || state.cancelled) return
    state.cancelled = true
    for (const callback of [...state.callbacks]) {
      try { callback() } catch { /* A single callback must not prevent other listeners. */ }
    }
    state.callbacks.clear()
  })
}
