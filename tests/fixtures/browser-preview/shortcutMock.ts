import { normalizeUserShortcut } from '@shared/accelerator'
import { IS_MAC, IS_WINDOWS } from '@shared/platform'
import type { PluginSummary } from '@shared/types/plugin'
import type { PluginShortcutInput, PluginShortcutMutationResult, PluginShortcutsSnapshot, ShortcutProbeResult } from '@shared/types/shortcuts'
import type { QuickHotkeyApplyResult, QuickHotkeyConfig, QuickHotkeyPatch } from '@shared/types/quick'
import type { ShellSettingsData } from '@shared/types/shellSettings'

/** Browser preview persists the same contract; it cannot verify OS registrations. */
export function createShortcutMock({ read, write, plugins, publish: emit }: {
  read(): ShellSettingsData
  write(settings: ShellSettingsData): void
  plugins(): PluginSummary[]
  publish(snapshot: PluginShortcutsSnapshot): void
}) {
  const platform = IS_MAC ? 'darwin' : IS_WINDOWS ? 'win32' : 'linux'
  const captures = new Map<string, ReturnType<typeof setTimeout>>()
  const confirmations = new Map<string, { signature: string; expires: number }>()
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
  const conflictSignature = (result: ShortcutProbeResult): string | undefined => {
    if (result.status === 'shortcut') return JSON.stringify([result.accelerator, result.status,
      readMigrated().pluginShortcuts?.find(binding => binding.id === result.ownerBindingId)])
    if (result.status === 'quick') {
      const quick = quickConfig()
      return JSON.stringify([result.accelerator, result.status, quick.enabled, quick.hotkeys, quick.activeHotkey])
    }
    return undefined
  }
  const confirmable = (result: ShortcutProbeResult): ShortcutProbeResult => {
    const signature = conflictSignature(result)
    if (!signature) return result
    for (const [token, entry] of confirmations) if (entry.expires <= Date.now()) confirmations.delete(token)
    for (const [token, entry] of confirmations) if (entry.signature === signature) return { ...result, overrideToken: token }
    while (confirmations.size >= 128) confirmations.delete(confirmations.keys().next().value!)
    const token = crypto.randomUUID()
    confirmations.set(token, { signature, expires: Date.now() + 5 * 60_000 })
    return { ...result, overrideToken: token }
  }
  const consume = (token: unknown, result: ShortcutProbeResult): boolean => {
    if (typeof token !== 'string') return false
    const entry = confirmations.get(token)
    confirmations.delete(token)
    return !!entry && entry.expires > Date.now() && entry.signature === conflictSignature(result)
  }
  const probe = (value: string, excludeId?: string, excludeQuick = false): ShortcutProbeResult => {
    const accelerator = normalize(value)
    if (!accelerator) return { accelerator: value, status: 'invalid', hint: '请输入带有 Ctrl、Alt 或 Command 的组合键，例如 Control+Shift+K' }
    const settings = readMigrated()
    const quick = quickConfig()
    if (!excludeQuick && quick.enabled && normalize(quick.activeHotkey) === accelerator) {
      return confirmable({ accelerator, status: 'quick', ownerLabel: 'Quick 呼出键', hint: '已被 Quick 呼出键占用，覆盖后将关闭 Quick 呼出键。' })
    }
    const owner = settings.pluginShortcuts?.find(binding => binding.id !== excludeId && binding.enabled &&
      plugins().some(plugin => plugin.id === binding.pluginId && plugin.installed && plugin.enabled !== false) && normalize(binding.accelerator) === accelerator)
    if (owner) return confirmable({ accelerator, status: 'shortcut', ownerBindingId: owner.id, ownerPluginId: owner.pluginId,
      ownerLabel: plugins().find(plugin => plugin.id === owner.pluginId)?.name ?? owner.pluginId, hint: '已被另一条插件绑定占用，覆盖后将停用原绑定。' })
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
    const active = input.enabled && plugin.enabled !== false
    if (result.status === 'invalid' || (active && (result.status !== 'free' || input.overrideToken) && !consume(input.overrideToken, result))) {
      return { ok: false, error: input.overrideToken ? '快捷键占用已变化或确认已过期，请重新检查后确认。' : result.hint, probe: result, snapshot: snapshot() }
    }
    if (!['quick', 'shell'].includes(input.mode)) return { ok: false, error: '启动位置无效' }
    const binding = { pluginId: input.pluginId, mode: input.mode, id: input.id ?? crypto.randomUUID(), accelerator: result.accelerator, enabled: input.enabled !== false }
    const bindings = current.pluginShortcuts ?? []
    const next = (input.id ? bindings.map(item => item.id === input.id ? binding : item) : [...bindings, binding])
      .map(item => active && item.id === result.ownerBindingId ? { ...item, enabled: false } : item)
    try { write({ ...current, pluginShortcuts: next,
      ...(active && result.status === 'quick' ? { quick: { ...current.quick, enabled: false } } : {}) }) }
    catch (error) { return { ok: false, error: String(error), snapshot: snapshot() } }
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
  const setQuick = (patch: QuickHotkeyPatch): QuickHotkeyApplyResult => {
    const current = quickConfig()
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)
      || (patch.enabled !== undefined && typeof patch.enabled !== 'boolean')
      || (patch.hotkeys !== undefined && (!Array.isArray(patch.hotkeys) || patch.hotkeys.some(key => !normalize(key))))
      || (patch.activeHotkey !== undefined && (typeof patch.activeHotkey !== 'string' || (!!patch.activeHotkey && !normalize(patch.activeHotkey))))
      || (patch.overrideToken !== undefined && (typeof patch.overrideToken !== 'string' || !patch.overrideToken))) {
      return { ...current, ok: false, registered: [], failed: [], error: '快捷键配置无效' }
    }
    if (captures.size) return { ...current, ok: false, registered: [], failed: [], error: '请先结束快捷键录制' }
    const candidates = patch.hotkeys?.length ? patch.hotkeys : current.hotkeys
    const hotkeys = [...new Set(candidates.map(key => normalize(key)).filter((key): key is string => !!key))]
    const preferred = normalize(patch.activeHotkey ?? current.activeHotkey)
    const next = { ...current, enabled: patch.enabled ?? current.enabled, hotkeys,
      activeHotkey: preferred && hotkeys.includes(preferred) ? preferred : hotkeys[0] ?? '' }
    const result = probe(next.activeHotkey ?? '', undefined, true)
    if (next.enabled && (result.status !== 'free' || patch.overrideToken) && !consume(patch.overrideToken, result)) return {
      ...current, ok: false, registered: [], failed: [next.activeHotkey ?? ''], probe: result,
      error: patch.overrideToken ? '快捷键占用已变化或确认已过期，请重新检查后确认。' : result.hint }
    const settings = readMigrated()
    try { write({ ...settings, quick: { enabled: next.enabled, hotkeys: next.hotkeys, activeHotkey: next.activeHotkey },
      pluginShortcuts: (settings.pluginShortcuts ?? []).map(binding => next.enabled && binding.id === result.ownerBindingId ? { ...binding, enabled: false } : binding) }) }
    catch (error) { return { ...current, ok: false, registered: [], failed: [], error: String(error), probe: probe(next.activeHotkey ?? '', undefined, true) } }
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
