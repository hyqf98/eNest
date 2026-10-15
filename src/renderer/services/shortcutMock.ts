import { normalizeUserShortcut } from '@shared/accelerator'
import { IS_MAC, IS_WINDOWS } from '@shared/platform'
import type { PluginSummary } from '@shared/types/plugin'
import type { PluginShortcutInput, PluginShortcutMutationResult, PluginShortcutsSnapshot, ShortcutProbeResult } from '@shared/types/shortcuts'
import type { QuickHotkeyApplyResult, QuickHotkeyConfig } from '@shared/types/quick'
import type { ShellSettingsData } from './mockData'

/** Browser preview persists the same contract; it cannot verify OS registrations. */
export function createShortcutMock({ read, write, plugins, publish: emit }: {
  read(): ShellSettingsData
  write(settings: ShellSettingsData): void
  plugins(): PluginSummary[]
  publish(snapshot: PluginShortcutsSnapshot): void
}) {
  const platform = IS_MAC ? 'darwin' : IS_WINDOWS ? 'win32' : 'linux'
  const captures = new Map<string, ReturnType<typeof setTimeout>>()
  const normalize = (value: unknown): string | null => normalizeUserShortcut(value, platform)

  const readMigrated = (): ShellSettingsData => {
    const settings = read()
    const bindings = [...(settings.pluginShortcuts ?? [])]
    let migrated = false
    const pluginLaunch = Object.fromEntries(Object.entries(settings.pluginLaunch ?? {}).map(([pluginId, config]) => {
      const { hotkey, ...rest } = config
      if ('hotkey' in config) {
        if (hotkey) bindings.push({ id: crypto.randomUUID(), pluginId, accelerator: normalize(hotkey) ?? hotkey, mode: config.mode ?? 'quick', enabled: true })
        migrated = true
      }
      return [pluginId, rest]
    }))
    if (migrated) {
      const next = { ...settings, pluginLaunch, pluginShortcuts: bindings }
      write(next)
      return next
    }
    return settings
  }
  const quickConfig = (): QuickHotkeyConfig => {
    const saved = readMigrated().quick
    return { enabled: saved?.enabled !== false, hotkeys: saved?.hotkeys ?? ['Alt+Space', 'Control+Space'],
      activeHotkey: saved?.activeHotkey ?? 'Alt+Space', platform, registered: [], error: '浏览器预览无法注册系统快捷键' }
  }
  const probe = (value: string, excludeId?: string, excludeQuick = false): ShortcutProbeResult => {
    const accelerator = normalize(value)
    if (!accelerator) return { accelerator: value, status: 'invalid', hint: '请输入带有 Ctrl、Alt 或 Command 的组合键，例如 Control+Shift+K' }
    const settings = readMigrated()
    const quick = quickConfig()
    if (!excludeQuick && quick.enabled && normalize(quick.activeHotkey) === accelerator) {
      return { accelerator, status: 'quick', ownerLabel: 'Quick 呼出键', hint: '已被 Quick 呼出键占用，请换一个组合键' }
    }
    const owner = settings.pluginShortcuts?.find(binding => binding.id !== excludeId && binding.enabled &&
      plugins().some(plugin => plugin.id === binding.pluginId && plugin.installed && plugin.enabled !== false) && normalize(binding.accelerator) === accelerator)
    if (owner) return { accelerator, status: 'shortcut', ownerBindingId: owner.id, ownerPluginId: owner.pluginId,
      ownerLabel: plugins().find(plugin => plugin.id === owner.pluginId)?.name ?? owner.pluginId, hint: '已被另一条插件绑定占用，请换一个组合键' }
    return { accelerator, status: 'free', hint: '仅已检查应用内配置；系统占用需要在 eNest 中验证' }
  }
  const snapshot = (): PluginShortcutsSnapshot => {
    const bindings = readMigrated().pluginShortcuts ?? []
    return { bindings: bindings.map(binding => ({ ...binding })), states: bindings.map(binding => {
      const plugin = plugins().find(plugin => plugin.id === binding.pluginId && plugin.installed)
      if (!plugin) return { id: binding.id, status: 'plugin-missing' }
      if (!binding.enabled) return { id: binding.id, status: 'disabled' }
      if (plugin.enabled === false) return { id: binding.id, status: 'plugin-disabled' }
      if (captures.size) return { id: binding.id, status: 'suspended' }
      const occupied = probe(binding.accelerator, binding.id)
      return { id: binding.id, status: 'conflict', error: occupied.status !== 'free' ? occupied.hint : '浏览器预览无法注册系统快捷键' }
    }) }
  }
  const publish = (): PluginShortcutsSnapshot => { const next = snapshot(); emit(next); return next }
  const save = (input: PluginShortcutInput): PluginShortcutMutationResult => {
    const current = readMigrated()
    if (input.id && !current.pluginShortcuts?.some(binding => binding.id === input.id)) return { ok: false, error: '快捷键绑定不存在' }
    const plugin = plugins().find(plugin => plugin.id === input.pluginId && plugin.installed)
    if (!plugin) return { ok: false, error: '请选择已安装的插件' }
    if (captures.size) return { ok: false, error: '请先结束快捷键录制' }
    const result = probe(input.accelerator, input.id)
    if (result.status === 'invalid' || (input.enabled && plugin.enabled !== false && result.status !== 'free')) return { ok: false, error: result.hint, probe: result, snapshot: snapshot() }
    if (!['quick', 'shell'].includes(input.mode)) return { ok: false, error: '启动位置无效' }
    const binding = { ...input, id: input.id ?? crypto.randomUUID(), accelerator: result.accelerator, enabled: input.enabled !== false }
    const bindings = current.pluginShortcuts ?? []
    write({ ...current, pluginShortcuts: input.id ? bindings.map(item => item.id === input.id ? binding : item) : [...bindings, binding] })
    return { ok: true, binding, snapshot: publish() }
  }
  const remove = (id: string): PluginShortcutMutationResult => {
    const current = readMigrated()
    write({ ...current, pluginShortcuts: current.pluginShortcuts?.filter(binding => binding.id !== id) ?? [] })
    return { ok: true, snapshot: publish() }
  }
  const endCapture = (token: string): void => {
    const timer = captures.get(token)
    if (!timer) return
    clearTimeout(timer)
    captures.delete(token)
    publish()
  }
  const setQuick = (patch: { enabled?: boolean; hotkeys?: string[]; activeHotkey?: string }): QuickHotkeyApplyResult => {
    const current = quickConfig()
    if (captures.size) return { ...current, ok: false, registered: [], failed: [], error: '请先结束快捷键录制' }
    const next = { ...current, ...patch }
    const result = probe(next.activeHotkey ?? '', undefined, true)
    if (next.enabled && result.status !== 'free') return { ...current, ok: false, registered: [], failed: [next.activeHotkey ?? ''], error: result.hint }
    write({ ...readMigrated(), quick: { enabled: next.enabled, hotkeys: next.hotkeys, activeHotkey: next.activeHotkey } })
    publish()
    return { ...next, ok: true, registered: [], failed: [], error: '已保存预览配置；系统快捷键请在 eNest 中验证' }
  }
  return { snapshot, save, remove, probe, publish, quickConfig, setQuick, endCapture,
    removePlugin(pluginId: string): void {
      const current = readMigrated()
      write({ ...current, pluginShortcuts: current.pluginShortcuts?.filter(binding => binding.pluginId !== pluginId) ?? [] })
      publish()
    },
    beginCapture(): { token: string } {
      const token = crypto.randomUUID()
      captures.set(token, setTimeout(() => endCapture(token), 30_000))
      publish()
      return { token }
    }
  }
}
