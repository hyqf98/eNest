import { getRuntimeScope } from '@main/plugin/PluginRuntimeScope'
import { sendShellEvent } from '@main/window/createShellWindow'
import type { QuickInputConfig, QuickInputMessage, QuickInputState } from '@shared/types/plugin-tools'
import type { PluginEventPayload } from '@shared/types/ipc'

let state: QuickInputState | null = null
const subscribedScopes = new WeakSet<object>()
let host: { current(): string | null; send(id: string, event: PluginEventPayload): void; dismiss(id: string): void } | null = null
export function bindQuickInputHost(value: NonNullable<typeof host>): void { host = value }
export function getQuickInputState(): QuickInputState | null {
  if (state && (host?.current() !== state.pluginId || getRuntimeScope(state.pluginId)?.owner.generation !== state.generation)) clearQuickInput()
  return state
}
export function clearQuickInput(pluginId?: string): void {
  if (!state || (pluginId && pluginId !== state.pluginId)) return
  state = null
  sendShellEvent({ type: 'quick-input', state: null })
}
export function configureQuickInput(pluginId: string, input: QuickInputConfig): boolean {
  const scope = getRuntimeScope(pluginId)
  if (host?.current() !== pluginId || !scope || scope.isClosing) return false
  const first = !subscribedScopes.has(scope)
  state = { pluginId, generation: scope.owner.generation, placeholder: String(input?.placeholder ?? '').slice(0, 160), value: String(input?.value ?? '').slice(0, 100000) }
  if (first) {
    subscribedScopes.add(scope)
    const generation = scope.owner.generation
    scope.addDisposer(() => { if (state?.pluginId === pluginId && state.generation === generation) clearQuickInput(pluginId) })
  }
  sendShellEvent({ type: 'quick-input', state: { ...state } })
  return true
}
export function escapeQuickInput(pluginId: string): boolean {
  const current = getQuickInputState()
  if (host?.current() !== pluginId) return false
  if (current?.value) {
    current.value = ''
    sendShellEvent({ type: 'quick-input', state: { ...current } })
    host.send(pluginId, { type: 'quick-input-change', value: '' })
    return true
  }
  clearQuickInput(pluginId)
  host.dismiss(pluginId)
  return true
}
export function handleQuickInput(message: QuickInputMessage): boolean {
  const current = getQuickInputState()
  if (!current || current.pluginId !== message?.pluginId || current.generation !== message.generation) return false
  if (message.type === 'escape') return escapeQuickInput(current.pluginId)
  if (message.type === 'change') {
    current.value = String(message.value ?? '').slice(0, 100000)
    host?.send(current.pluginId, { type: 'quick-input-change', value: current.value })
  } else if (message.type === 'action' && ['next', 'previous', 'submit', 'clear'].includes(message.action)) {
    if (message.action === 'clear') return escapeQuickInput(current.pluginId)
    host?.send(current.pluginId, { type: 'quick-input-action', action: message.action })
  } else return false
  return true
}
