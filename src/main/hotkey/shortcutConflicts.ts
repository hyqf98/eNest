import { randomUUID } from 'node:crypto'
import { normalizeAccelerator, normalizeUserShortcut } from '@shared/accelerator'
import type { ShortcutProbeResult } from '@shared/types/shortcuts'
import { settingsStore } from '@main/settings/SettingsStore'
import { pluginRegistry } from '@main/plugin/PluginRegistry'
import { getHotkeyOwner, probeNativeHotkey, type HotkeyOwner } from './hotkeyRegistry'

const confirmations = new Map<string, { signature: string; expires: number }>()

function signature(probe: ShortcutProbeResult): string | undefined {
  if (probe.status === 'shortcut') {
    const binding = settingsStore.getPluginShortcuts().find(item => item.id === probe.ownerBindingId)
    if (!binding?.enabled || normalizeAccelerator(binding.accelerator, process.platform) !== probe.accelerator) return undefined
    return JSON.stringify([probe.accelerator, probe.status, binding])
  }
  if (probe.status === 'quick') {
    const quick = settingsStore.getQuickLauncherSettings()
    return JSON.stringify([probe.accelerator, probe.status, quick?.enabled, quick?.hotkeys, quick?.activeHotkey])
  }
  return undefined
}

function confirmable(probe: ShortcutProbeResult): ShortcutProbeResult {
  const state = signature(probe)
  if (!state) return probe
  const now = Date.now()
  for (const [token, entry] of confirmations) if (entry.expires <= now) confirmations.delete(token)
  for (const [token, entry] of confirmations) if (entry.signature === state) return { ...probe, overrideToken: token }
  while (confirmations.size >= 128) confirmations.delete(confirmations.keys().next().value!)
  const token = randomUUID()
  confirmations.set(token, { signature: state, expires: now + 5 * 60_000 })
  return { ...probe, overrideToken: token }
}

/** Re-read the owner immediately before mutating. A changed owner needs a new confirmation. */
export function consumeShortcutOverride(token: unknown, current: ShortcutProbeResult): boolean {
  if (typeof token !== 'string') return false
  const entry = confirmations.get(token)
  confirmations.delete(token)
  return !!entry && entry.expires > Date.now() && entry.signature === signature(current)
}

export function overrideOwner(probe: ShortcutProbeResult): HotkeyOwner | undefined {
  if (probe.status === 'quick') return { kind: 'quick', id: 'launcher' }
  if (probe.status === 'shortcut' && probe.ownerBindingId) return { kind: 'shortcut', id: probe.ownerBindingId, pluginId: probe.ownerPluginId }
  return undefined
}

export function probeShortcutConflict(value: string, excludeId?: string, excludeQuick = false): ShortcutProbeResult {
  const accelerator = normalizeUserShortcut(value, process.platform)
  if (!accelerator) return { accelerator: String(value ?? ''), status: 'invalid', hint: '快捷键需包含 Ctrl、Alt、Command 或 Super 等修饰键' }
  const owner = getHotkeyOwner(accelerator)
  const label = (id?: string) => id ? pluginRegistry.get(id)?.name ?? id : undefined
  // A real runtime owner takes priority over stale configured bindings and can never be replaced.
  if (owner?.kind === 'runtime') return { accelerator, status: 'runtime', ownerPluginId: owner.pluginId,
    ownerLabel: label(owner.pluginId), hint: '插件运行时快捷键不能直接覆盖，请先在该插件中关闭或修改。' }
  if (owner?.kind === 'quick' && !excludeQuick) return confirmable({ accelerator, status: 'quick', ownerLabel: '快捷启动（Quick）' })
  const configured = settingsStore.getPluginShortcuts().find(binding => {
    const plugin = pluginRegistry.get(binding.pluginId)
    return binding.id !== excludeId && binding.enabled && plugin?.installed && plugin.enabled !== false
      && normalizeAccelerator(binding.accelerator, process.platform) === accelerator
  })
  if (configured) return confirmable({ accelerator, status: 'shortcut', ownerBindingId: configured.id,
    ownerPluginId: configured.pluginId, ownerLabel: label(configured.pluginId) })
  if ((owner?.kind === 'quick' && excludeQuick) || (owner?.kind === 'shortcut' && owner.id === excludeId)) return { accelerator, status: 'free' }
  // 自由面板快捷键是壳级占用，与插件快捷键冲突时报告为系统占用（不能由业务覆盖）。
  if (owner?.kind === 'panel') return { accelerator, status: 'system', hint: '该快捷键已被自由面板占用，请先在通用设置中更改面板快捷键。' }
  if (owner) return { accelerator, status: owner.kind, ownerBindingId: owner.kind === 'shortcut' ? owner.id : undefined,
    ownerPluginId: owner.pluginId, ownerLabel: label(owner.pluginId), hint: '该快捷键的归属状态已变化，请刷新后重试。' }
  const native = probeNativeHotkey(accelerator)
  return { accelerator, status: native.free && !native.ours ? 'free' : 'system',
    ...(native.hint ? { hint: native.free && !native.ours ? native.hint : `${native.hint}；系统或其他应用的快捷键无法由 eNest 覆盖。` }
      : native.ours ? { hint: '已被 eNest 其他功能占用，不能直接覆盖。' } : {}) }
}
