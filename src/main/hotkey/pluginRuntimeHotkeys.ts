/** Plugin runtime shortcuts share the native registry, but remain owned by the runtime. */
import { normalizeAccelerator } from '@shared/accelerator'
import {
  applyHotkeyChanges, getHotkeyOwner, getHotkeyRegistrations, getOwnedHotkey,
  type HotkeyOwner
} from './hotkeyRegistry'

const MAX_PLUGIN_HOTKEYS = 4
const runtimeOwner = (pluginId: string, accelerator: string): HotkeyOwner => ({
  kind: 'runtime', id: `${pluginId}:${accelerator}`, pluginId
})

export function registerRuntimeHotkey(
  pluginId: string,
  accelerator: string,
  onFire: (accelerator: string) => void
): { ok: true } | { ok: false; error: string } {
  const acc = normalizeAccelerator(accelerator, process.platform)
  if (!acc) return { ok: false, error: 'accelerator invalid' }
  const owner = runtimeOwner(pluginId, acc)
  if (!getOwnedHotkey(owner)) {
    const mine = getHotkeyRegistrations().filter(item => item.owner.kind === 'runtime' && item.owner.pluginId === pluginId)
    if (mine.length >= MAX_PLUGIN_HOTKEYS) return { ok: false, error: `hotkey limit reached (max ${MAX_PLUGIN_HOTKEYS})` }
  }
  const result = applyHotkeyChanges([{ owner, registration: { owner, accelerator: acc, onFire: () => onFire(accelerator) } }])
  return result.ok ? { ok: true } : { ok: false, error: result.error ?? 'accelerator registration failed' }
}

/** Only this plugin's exact registration can be removed; unrelated keys are untouched. */
export function unregisterRuntimeHotkey(pluginId: string, accelerator: string): boolean {
  const acc = normalizeAccelerator(accelerator, process.platform)
  if (!acc) return true
  const owner = runtimeOwner(pluginId, acc)
  if (!getOwnedHotkey(owner)) return true
  return applyHotkeyChanges([{ owner, registration: null }]).ok
}

export function getRuntimeHotkeyOwner(accelerator: string): string | undefined {
  const owner = getHotkeyOwner(accelerator)
  return owner?.kind === 'runtime' ? owner.pluginId : undefined
}

export function releasePluginHotkeys(pluginId: string): void {
  const changes = getHotkeyRegistrations()
    .filter(item => item.owner.kind === 'runtime' && item.owner.pluginId === pluginId)
    .map(item => ({ owner: item.owner, registration: null }))
  if (changes.length) applyHotkeyChanges(changes)
}
