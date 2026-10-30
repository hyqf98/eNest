/** Manifest launch activation, registration and cancellation for one page. */
import { ipcRenderer } from 'electron'
import type {
  PluginActivationContext,
  PluginActivationDispatch,
  PluginActivationHandlers,
  PluginActivationRegistration,
  PluginActivationResult
} from '@shared/types/pluginLaunch'
import * as IpcChannels from '@shared/types/ipc'
import { getQueryParam } from './pluginRpc'

let activationHandlers: PluginActivationHandlers | undefined

let activationRegistration: string | undefined

let activationRegistering = false

let activationContext: PluginActivationContext = ['command', 'index-sync', 'resident'].includes(getQueryParam('activation') ?? '')
  ? getQueryParam('activation') as PluginActivationContext : 'view'

const earlyActivations: PluginActivationDispatch[] = []

const activationCancellations = new Set<string>()

const activeActivations = new Map<string, { cancelled: boolean; callbacks: Set<() => void> }>()

async function dispatchActivation(message: PluginActivationDispatch): Promise<void> {
  if (!activationHandlers || !activationRegistration || message?.registrationId !== activationRegistration || typeof message.requestId !== 'string') return
  const reply: PluginActivationResult = { requestId: message.requestId, registrationId: message.registrationId, ok: false }
  const state = { cancelled: activationCancellations.delete(message.requestId), callbacks: new Set<() => void>() }
  try {
    if (activeActivations.size) throw new Error('Plugin activation is busy')
    activeActivations.set(message.requestId, state)
    const onCancel = (callback: () => void) => {
      if (typeof callback !== 'function') throw new TypeError('Cancellation callback required')
      if (state.cancelled) callback(); else state.callbacks.add(callback)
      return () => { state.callbacks.delete(callback) }
    }
    const request = { ...message, signal: { isAborted: () => state.cancelled,
      throwIfAborted: () => { if (state.cancelled) throw new Error('Activation cancelled') }, onAbort: onCancel }, onCancel }
    if (state.cancelled) throw new Error('Activation cancelled')
    activationContext = message.kind === 'index-sync' ? 'index-sync' : message.kind === 'prepare-view' ? 'view'
      : message.reason.startsWith('resident-') ? 'resident' : 'command'
    if (message.kind === 'index-sync') {
      if (!activationHandlers.indexSync) throw new Error('Index synchronization is unavailable')
      reply.value = await activationHandlers.indexSync(request)
    } else if (message.kind === 'command') {
      if (!activationHandlers.command) throw new Error('Command handler is unavailable')
      reply.value = await activationHandlers.command(request)
    } else await activationHandlers.prepareView?.(request)
    reply.ok = true
  } catch (error) { reply.error = error instanceof Error ? error.message.slice(0, 512) : 'Plugin activation failed' }
  finally {
    activeActivations.delete(message.requestId)
    state.callbacks.clear()
    try {
      const json = JSON.stringify(reply)
      if (new TextEncoder().encode(json).byteLength > 4 * 1024 * 1024 + 4096) throw new Error('Activation response exceeds its budget')
      ipcRenderer.send(IpcChannels.PluginActivationResult, JSON.parse(json))
    } catch {
      ipcRenderer.send(IpcChannels.PluginActivationResult, { requestId: message.requestId, registrationId: message.registrationId, ok: false, error: 'Activation result is invalid or too large' })
    }
  }
}

export async function registerActivationHandlers(handlers: PluginActivationHandlers): Promise<void> {
  if (activationHandlers || activationRegistering) throw new Error('Activation handlers already registered')
  if (!handlers || typeof handlers !== 'object' || Array.isArray(handlers)
    || Object.entries(handlers).some(([key, handler]) => !['command', 'indexSync', 'prepareView'].includes(key) || typeof handler !== 'function')) throw new TypeError('Invalid activation handlers')
  activationHandlers = { ...handlers }; activationRegistering = true
  try {
    const names = [...(handlers.command ? ['command'] : []), ...(handlers.indexSync ? ['index-sync'] : []), ...(handlers.prepareView ? ['prepare-view'] : [])]
    const result = await ipcRenderer.invoke(IpcChannels.PluginActivationRegister, names) as PluginActivationRegistration
    if (!result?.registrationId) throw new Error('Activation registration was not acknowledged')
    activationRegistration = result.registrationId
    for (const message of earlyActivations.splice(0)) void dispatchActivation(message)
  } catch (error) { activationHandlers = undefined; activationRegistration = undefined; earlyActivations.length = 0; throw error }
  finally { activationRegistering = false; activationCancellations.clear() }
}

export function getActivationContext(): PluginActivationContext {
  return activationContext
}

export function bindPluginActivationBridge(): void {
  ipcRenderer.on(IpcChannels.PluginActivationDispatch, (_event, message: PluginActivationDispatch) => {
    if (activationRegistering && !activationRegistration) { if (earlyActivations.length < 1) earlyActivations.push(message); return }
    void dispatchActivation(message)
  })
  ipcRenderer.on(IpcChannels.PluginActivationCancel, (_event, message: { requestId?: string; registrationId?: string }) => {
    if (typeof message?.requestId !== 'string' || typeof message.registrationId !== 'string') return
    if (!activationRegistration && activationRegistering) { if (activationCancellations.size < 8) activationCancellations.add(message.requestId); return }
    if (message.registrationId !== activationRegistration) return
    const active = activeActivations.get(message.requestId)
    if (!active || active.cancelled) return
    active.cancelled = true
    for (const callback of active.callbacks) { try { callback() } catch { /* Cancellation still needs an actual settlement ACK. */ } }
    active.callbacks.clear()
  })
}
