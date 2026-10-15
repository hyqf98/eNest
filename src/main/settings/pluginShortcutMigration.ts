import type { PluginLaunchSettings } from '@shared/types/plugin'
import type { PluginShortcutBinding } from '@shared/types/shortcuts'

/** Idempotent migration; failed/absent plugins remain visible for the user to repair. */
export function migratePluginShortcuts(launch: PluginLaunchSettings = {}, stored: unknown = []): {
  pluginLaunch: PluginLaunchSettings
  pluginShortcuts: PluginShortcutBinding[]
  migrated: boolean
} {
  const pluginLaunch = structuredClone(launch)
  const pluginShortcuts: PluginShortcutBinding[] = []
  const ids = new Set<string>()
  for (const item of Array.isArray(stored) ? stored : []) {
    if (!item || typeof item !== 'object' || typeof item.id !== 'string' || !item.id
      || typeof item.pluginId !== 'string' || !item.pluginId || typeof item.accelerator !== 'string') continue
    if (ids.has(item.id)) continue
    ids.add(item.id)
    pluginShortcuts.push({ id: item.id, pluginId: item.pluginId, accelerator: item.accelerator,
      mode: item.mode === 'shell' ? 'shell' : 'quick', enabled: item.enabled !== false })
  }
  let migrated = false
  for (const [pluginId, config] of Object.entries(pluginLaunch)) {
    if (!config || typeof config !== 'object' || !Object.hasOwn(config, 'hotkey')) continue
    const accelerator = typeof config.hotkey === 'string' ? config.hotkey.trim() : ''
    const id = `legacy:${encodeURIComponent(pluginId)}`
    if (accelerator && !ids.has(id)) {
      pluginShortcuts.push({ id, pluginId, accelerator, mode: config.mode === 'shell' ? 'shell' : 'quick', enabled: true })
      ids.add(id)
    }
    delete config.hotkey
    migrated = true
  }
  return { pluginLaunch, pluginShortcuts, migrated }
}
