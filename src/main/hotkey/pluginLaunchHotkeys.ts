/** Legacy module now only owns Quick search preferences; shortcut bindings live separately. */
import type { PluginLaunchConfig, PluginLaunchPatch, PluginLaunchSettings } from '@shared/types/plugin'
import { settingsStore } from '@main/settings/SettingsStore'
import { sendShellEvent } from '@main/window/createShellWindow'
import {
  initPluginShortcuts, disposePluginShortcuts, reconcilePluginShortcuts,
  releasePluginShortcuts, removePluginShortcuts
} from './pluginShortcuts'

export function getPluginLaunchSettings(): PluginLaunchSettings { return settingsStore.getPluginLaunchSettings() }
export function getPluginLaunch(pluginId: string): PluginLaunchConfig | undefined { return settingsStore.getPluginLaunchConfig(pluginId) }
export function getPluginLaunchAliasRevision(): number { return settingsStore.getPluginLaunchRevision() }
export function getPluginLaunchAliases(pluginId: string): string[] {
  const aliases = getPluginLaunch(pluginId)?.aliases
  return Array.isArray(aliases) ? [...new Set(aliases.map(value => String(value ?? '').trim()).filter(Boolean))] : []
}

// Preserve application lifecycle entrypoints while keeping a single registration implementation.
export const applyPluginLaunchHotkeys = reconcilePluginShortcuts
export const initPluginLaunchHotkeys = initPluginShortcuts
export const releasePluginLaunchHotkey = releasePluginShortcuts
export const releaseAllPluginLaunchHotkeys = disposePluginShortcuts

export async function clearPluginLaunch(pluginId: string): Promise<void> {
  const removed = await removePluginShortcuts(pluginId)
  if (!removed.ok) throw new Error(removed.error)
  if (!(pluginId in getPluginLaunchSettings())) return
  await settingsStore.setPluginLaunch(pluginId, null)
  sendShellEvent({ type: 'plugin-launch-changed', pluginId, config: null })
}

export interface SetPluginLaunchResult {
  ok: boolean
  error?: string
  config?: PluginLaunchConfig | null
}

/** Only search preference fields may be changed through the legacy IPC. */
export async function setPluginLaunch(
  pluginId: string, patch: PluginLaunchPatch
): Promise<SetPluginLaunchResult> {
  const id = String(pluginId ?? '').trim()
  if (!id) return { ok: false, error: 'pluginId required' }
  if (patch.hotkey !== undefined) return { ok: false, error: '请在设置的快捷键页面管理插件绑定' }
  if (patch.mode !== undefined && patch.mode !== null && patch.mode !== 'quick' && patch.mode !== 'shell') return { ok: false, error: 'invalid mode' }
  if (patch.aliases !== undefined && !Array.isArray(patch.aliases)) return { ok: false, error: 'invalid aliases' }
  const current = getPluginLaunch(id) ?? {}
  const merged: PluginLaunchConfig = { ...current }
  delete merged.hotkey
  if (patch.mode !== undefined) {
    if (patch.mode === null) delete merged.mode
    else merged.mode = patch.mode
  }
  if (patch.aliases !== undefined) {
    const aliases = [...new Set(patch.aliases.map(value => String(value ?? '').trim()).filter(Boolean))]
    if (aliases.length) merged.aliases = aliases
    else delete merged.aliases
  }
  const config = !merged.mode && !merged.aliases?.length ? null : merged
  await settingsStore.setPluginLaunch(id, config)
  sendShellEvent({ type: 'plugin-launch-changed', pluginId: id, config })
  return { ok: true, config }
}
