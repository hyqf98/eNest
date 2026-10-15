import { getRuntimeScope } from '@main/plugin/PluginRuntimeScope'
import { sendShellEvent } from '@main/window/createShellWindow'
import type { QuickInputConfig, QuickInputMessage, QuickInputState } from '@shared/types/plugin-tools'
import type { PluginEventPayload, ShellEventPayload } from '@shared/types/ipc'

// A compact window is a presentation of an existing runtime, never a global input owner.
const states = new Map<string, QuickInputState>()
const subscribedScopes = new WeakSet<object>()
interface QuickInputHost {
  current(): string | null
  owns?(id: string): boolean
  detached?(id: string): boolean
  publish?(id: string, event: ShellEventPayload): void
  focus?(id: string): void
  send(id: string, event: PluginEventPayload): void
  dismiss(id: string): void
}
let host: QuickInputHost | null = null
const owns = (id: string) => host?.owns ? host.owns(id) : host?.current() === id
function publish(id: string, state: QuickInputState | null): void {
  const event: ShellEventPayload = { type: 'quick-input', state: state ? { ...state } : null }
  if (host?.publish) host.publish(id, event)
  else sendShellEvent(event)
}
export function bindQuickInputHost(value: QuickInputHost): void { host = value }
export function getQuickInputState(pluginId?: string): QuickInputState | null {
  const id = pluginId ?? host?.current()
  const state = id ? states.get(id) : undefined
  if (id && state) {
    const scope = getRuntimeScope(id)
    if (!owns(id) || scope?.owner.generation !== state.generation || scope.isClosing) {
      clearQuickInput(id)
      return null
    }
  }
  return state ? { ...state } : null
}
export function clearQuickInput(pluginId?: string): void {
  const id = pluginId ?? host?.current()
  if (!id || !states.delete(id)) return
  publish(id, null)
}
export function configureQuickInput(pluginId: string, input: QuickInputConfig): boolean {
  const scope = getRuntimeScope(pluginId)
  if (!owns(pluginId) || !scope?.isCurrent() || scope.isClosing) return false
  const state = { pluginId, generation: scope.owner.generation, placeholder: String(input?.placeholder ?? '').slice(0, 160), value: String(input?.value ?? '').slice(0, 100000) }
  states.set(pluginId, state)
  if (!subscribedScopes.has(scope)) {
    subscribedScopes.add(scope)
    const generation = scope.owner.generation
    scope.addDisposer(() => { if (states.get(pluginId)?.generation === generation) clearQuickInput(pluginId) })
  }
  publish(pluginId, state)
  return true
}
export function escapeQuickInput(pluginId: string): boolean {
  const current = getQuickInputState(pluginId)
  if (!owns(pluginId)) return false
  if (current?.value) {
    current.value = ''
    states.set(pluginId, current)
    publish(pluginId, current)
    host?.send(pluginId, { type: 'quick-input-change', value: '' })
    if (host?.detached?.(pluginId)) host.focus?.(pluginId)
    return true
  }
  if (host?.detached?.(pluginId)) {
    // Escape in an independent compact window never docks, hides or destroys it.
    host.focus?.(pluginId)
    return true
  }
  clearQuickInput(pluginId)
  host?.dismiss(pluginId)
  return true
}
export function handleQuickInput(message: QuickInputMessage): boolean {
  const current = getQuickInputState(message?.pluginId)
  if (!current || current.pluginId !== message?.pluginId || current.generation !== message.generation) return false
  if (message.type === 'escape') return escapeQuickInput(current.pluginId)
  if (message.type === 'change') {
    current.value = String(message.value ?? '').slice(0, 100000)
    states.set(current.pluginId, current)
    host?.send(current.pluginId, { type: 'quick-input-change', value: current.value })
  } else if (message.type === 'action' && ['next', 'previous', 'submit', 'clear'].includes(message.action)) {
    if (message.action === 'clear') return escapeQuickInput(current.pluginId)
    host?.send(current.pluginId, { type: 'quick-input-action', action: message.action })
  } else return false
  return true
}
