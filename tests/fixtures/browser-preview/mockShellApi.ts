import type {
  PluginShortcutInput, PluginShortcutsSnapshot,
  PluginShortcutMutationResult, PluginShortcutLaunchResult, ShortcutProbeResult
} from '@shared/types/shortcuts'
import type { AccountState, AccountLoginResult } from '@shared/types/account'
import type { QuickProviderStateSnapshot } from '@shared/types/quickTheme'
import type { McpStatus } from '@shared/types/mcpSettings'
/** Browser-preview-only adapter. Loaded lazily when no native preload is present. */
import type {
  AppPaths,
  DevPluginLoadOptions,
  MarketInstallResult,
  PluginMarketStatus,
  PluginLaunchPatch,
  PluginPermission,
  PluginPermissionGrant,
  PluginSummary,
  PluginTab,
  ProxyConfig,
  ThemeMode,
  ThemeTokens
} from '@shared/types/plugin'
import type {
  HardwareAccelSetResult,
  HardwareAccelState,
  PickFileOptions,
  PluginLaunchSetResult,
  ProxySetResult,
  ShellSettingsSection,
  ShellThemeResult
} from '@shared/types/shell'
import type { AppearanceSettings, AppearanceSnapshot, ThemePackV2, ThemeProfilePatch } from '@shared/types/appearance'
import type { WorkspaceRoute } from '@shared/types/workspace'
import { normalizePluginMemoryMonitor, type PluginMemoryMonitorSettings, type PluginMemorySnapshot } from '@shared/types/pluginMemory'
import { PERFORMANCE_CAPTURE_LIMITS, type PerformanceCaptureState, type PerformanceCaptureExportResult } from '@shared/types/performanceCapture'
import { migrateAppearanceSettings, patchThemeProfile, resolveAppearance, themeProfileKey } from '@shared/theme/appearance'
import { BUILTIN_THEME_PACKS, DEFAULT_THEME_IDENTITY } from '@shared/theme/builtinThemes'
import { createShortcutMock } from './shortcutMock'
import { PLUGIN_PERMISSIONS } from '@shared/types/plugin'
import { filterPermissionGrants, requiresUserConsent } from '@shared/pluginPermissionPolicy'
import type {
  ShellEventPayload,
  OrbEventPayload,
  OrbRailState,
  OrbRailSyncRequest,
  InstallJobInfo,
  PluginCallTraceEntry,
  ProxyTestResult,
  UpdateStatePayload,
  PluginDirtyState,
  PluginSaveSummary,
  GithubLoginSessionPayload,
  GithubProfileState
} from '@shared/types/ipc'
import type {
  ApplicationScanResult,
  QuickCommand,
  QuickCommandKind,
  QuickHotkeyApplyResult,
  QuickHotkeyConfig,
  QuickHotkeyPatch,
  QuickOpenRequest
} from '@shared/types/quick'
import {
  mockRegistry,
  readMockSettings,
  readMockTheme,
  writeMockSettings,
  writeMockTheme,
  type ShellSettingsData,
} from './mockData'

import type { ShellApi } from '@renderer/services/shellApi'
import { readQuickStateSnapshot, readQuickStateValue } from '@renderer/components/quickStateValidation'

type EventCb = (payload: ShellEventPayload) => void

export function createMockApi(): ShellApi {
  const listeners = new Set<EventCb>()
  let theme = readMockTheme()
  let settings = readMockSettings()
  const openTabs = new Map<string, PluginTab & { status: 'ready' | 'hibernated' }>()
  let activeTabId: string | null = null
  let tabRevision = 0
  let appearanceRevision = 0
  let appearanceKey = ''
  let appearanceState: AppearanceSettings | undefined
  const quickStateKey = 'enest.preview.quick-provider-state.v1'
  let previewQuickContext: import('@shared/types/quick').QuickImageContext[] = []
  const readQuickState = (): QuickProviderStateSnapshot => {
    const saved = localStorage.getItem(quickStateKey)
    if (saved === null) return { revision: 0, value: null, legacy: Reflect.get(readMockSettings().general ?? {}, 'quickLauncher') }
    const snapshot = readQuickStateSnapshot(JSON.parse(saved) as unknown)
    if (!snapshot) throw new Error('Invalid preview Quick private state')
    return snapshot
  }

  const emit = (payload: ShellEventPayload): void => {
    for (const cb of listeners) cb(payload)
  }

  const shortcuts = createShortcutMock({
    read: readMockSettings,
    write: next => { writeMockSettings(next); settings = next },
    plugins: () => mockRegistry.getPlugins(),
    publish: snapshot => emit({ type: 'plugin-shortcuts-changed', snapshot })
  })

  const publishTabs = (): void => emit({
    type: 'plugin-tabs', revision: ++tabRevision, activeTabId,
    tabs: [...openTabs.values()].map(({ id, title, status }) => ({ id, title, status }))
  })
  const closeMockTab = (tabId: string): void => {
    const tabs = [...openTabs.values()]
    const index = tabs.findIndex((tab) => tab.id === tabId)
    if (index >= 0) openTabs.delete(tabs[index].pluginId)
    if (activeTabId === tabId) {
      activeTabId = tabs[index + 1]?.id ?? tabs[index - 1]?.id ?? null
      const next = [...openTabs.values()].find((tab) => tab.id === activeTabId)
      if (next) next.status = 'ready'
    }
    emit({ type: 'tab-closed', tabId })
    publishTabs()
  }

  const mockPaths: AppPaths = {
    root: '~/.eNest',
    plugins: '~/.eNest/plugins',
    data: '~/.eNest/data',
    themes: '~/.eNest/themes',
    settings: '~/.eNest/settings.json',
    database: '~/.eNest/data/enest.db'
  }

  const mockAppearance = (): AppearanceSnapshot => {
    theme = readMockTheme()
    const settings = readMockSettings()
    const general = settings.general ?? {}
    const legacy = { theme, general: {
      fontFamily: general.fontFamily, fontFamilyEn: general.fontFamilyEn,
      fontSizeScale: general.fontSizeScale, animationLevel: general.animationLevel,
      splashBackground: general.splashBackground, tabStyle: general.tabStyle
    } }
    if (!appearanceState) {
      let saved: unknown
      try { saved = JSON.parse(localStorage.getItem('enest.appearance.v2') ?? 'null') } catch { /* Preserve legacy settings if the new profile is corrupt. */ }
      appearanceState = migrateAppearanceSettings(saved ?? {
        version: 2,
        revision: 0,
        mode: theme.mode,
        active: { ...DEFAULT_THEME_IDENTITY },
        profiles: {},
      }, legacy)
    }
    appearanceState.legacy = legacy
    const state = appearanceState
    const key = themeProfileKey(state.active)
    const activePack = BUILTIN_THEME_PACKS.find(pack =>
      pack.source === state.active.source && pack.id === state.active.id) ?? null
    const profile = state.profiles[key] ?? {
      identity: state.active, schemaVersion: 2, values: {}, colors: {}, quarantined: {}
    }
    if (!activePack) {
      profile.colors = structuredClone(theme.overrides ?? {})
      state.profiles[key] = profile
    }
    const systemDark = window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false
    const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
    const contentKey = JSON.stringify([appearanceState, systemDark, reducedMotion, general.customFonts])
    if (contentKey !== appearanceKey) { appearanceKey = contentKey; appearanceRevision++ }
    const appearance = resolveAppearance({ settings: appearanceState, pack: activePack, systemDark, reducedMotion })
    return {
      appearance: { ...appearance, revision: appearanceRevision },
      profile: structuredClone(state.profiles[key]),
      packs: structuredClone(BUILTIN_THEME_PACKS) as ThemePackV2[],
      customFonts: Array.isArray(general.customFonts) ? general.customFonts : []
    }
  }

  return {
    async getMcpStatus(): Promise<McpStatus> {
      return { configuration: { enabled: false, port: 43921 }, state: 'disabled', endpoint: 'http://127.0.0.1:43921/mcp', sessionCount: 0, activeCalls: 0, recentCalls: [], error: 'Browser preview cannot start the native MCP service or access credentials.' }
    },
    async configureMcp() { throw new Error('MCP configuration requires the native eNest application') },
    async copyMcpConnectionConfig() { throw new Error('MCP credentials are unavailable in browser preview') },
    async resetMcpToken() { throw new Error('MCP credentials are unavailable in browser preview') },
    async listMcpTools() { return { tools: [] } },
    async getPlugins() {
      return mockRegistry.getPlugins()
    },
    async getMarketStatus() {
      return { state: 'preview', catalogCount: 0 }
    },
    async getPluginDiagnostics() {
      return {
        sampledAt: Date.now(), platform: 'browser-mock',
        host: { logicalTabs: openTabs.size, activeTabId }, processes: []
      }
    },
    async getPluginMemorySnapshot() {
      const saved = readMockSettings()
      return {
        sampledAt: null,
        intervalMs: 5000,
        settings: normalizePluginMemoryMonitor(saved.general?.pluginMemoryMonitor as Partial<PluginMemoryMonitorSettings> | undefined),
        totalMemoryBytes: null,
        hostMemoryBytes: null,
        sharedMemoryBytes: null,
        unavailableProcessCount: 0,
        plugins: [],
        processes: [],
        error: 'Browser preview cannot sample native plugin memory.'
      }
    },
    async getPerformanceCaptureState() {
      return { status: 'unavailable', captureId: null, startedAt: null, stoppedAt: null, deadlineAt: null,
        sampleCount: 0, retainedBytes: 0, failedSamples: 0, stopReason: null, limits: PERFORMANCE_CAPTURE_LIMITS }
    },
    async startPerformanceCapture() { throw new Error('Browser preview cannot record native performance') },
    async stopPerformanceCapture() { throw new Error('Browser preview cannot record native performance') },
    async exportPerformanceCapture() { throw new Error('Browser preview cannot export native performance') },
    async restoreTabs(ids) {
      for (const id of ids) {
        const plugin = mockRegistry.getById(id)
        if (!plugin?.installed || plugin.enabled === false || openTabs.has(id)) continue
        openTabs.set(id, { id: `t-${id}`, pluginId: id, title: plugin.name,
          color: plugin.color, glyph: plugin.glyph, icon: plugin.icon, badge: '', status: 'hibernated' })
      }
      publishTabs()
    },
    async openPlugin(id, _enter) {
      const plugin = mockRegistry.getById(id)
      if (!plugin) return
      if (plugin.installed && plugin.enabled === false) {
        throw new Error(`plugin disabled: ${id}`)
      }
      if (!plugin.installed) {
        mockRegistry.install(id)
        emit({ type: 'plugins-changed' })
      }
      const installed = mockRegistry.getById(id)
      if (!installed) return
      openTabs.set(id, {
        id: `t-${id}`,
        pluginId: id,
        title: installed.name,
        color: installed.color,
        glyph: installed.glyph,
        icon: installed.icon,
        badge: '',
        status: 'ready',
      })
      activeTabId = `t-${id}`
      publishTabs()
      emit({ type: 'plugin-ready', pluginId: id, generation: tabRevision })
    },
    async closePlugin(tabId) {
      closeMockTab(tabId)
    },
    async stopPluginResources(pluginId) {
      closeMockTab(`t-${pluginId}`)
    },
    async activatePlugin(tabId) {
      const tab = [...openTabs.values()].find((item) => item.id === tabId)
      if (!tab) return
      tab.status = 'ready'
      activeTabId = tabId
      publishTabs()
    },
    async hidePlugins() {
      activeTabId = null
      publishTabs()
    },
    async setPluginInset() {
      /* mock no-op */
    },
    async setPluginTopInset() {
      /* mock no-op */
    },
    async goHome() {
      window.location.hash = ''
    },
    async setShellView() {
      /* mock */
    },
    async setOrbRailExpanded() {
      /* mock */
    },
    async syncOrbState() {
      /* mock */
    },
    async getOrbState() {
      return {
        view: 'home',
        tabStyle: 'classic',
        activeTabId: null,
        animationLevel: 'medium',
        theme: { mode: 'light', tokens: {} },
        profile: null,
        tabs: []
      }
    },
    async uninstallPlugin(id) {
      const name = mockRegistry.getById(id)?.name ?? id
      closeMockTab(`t-${id}`)
      mockRegistry.uninstall(id)
      mockRegistry.setEnabled(id, true)
      shortcuts.removePlugin(id)
      emit({ type: 'uninstall-result', pluginId: id, name, ok: true })
      emit({ type: 'plugins-changed' })
    },
    async setPluginEnabled(id, enabled) {
      const summary = mockRegistry.setEnabled(id, enabled !== false)
      if (!summary) throw new Error(`plugin not found: ${id}`)
      shortcuts.publish()
      emit({ type: 'plugins-changed' })
      return summary
    },
    getPluginShortcuts: async () => shortcuts.snapshot(),
    savePluginShortcut: async input => shortcuts.save(input),
    removePluginShortcut: async id => shortcuts.remove(id),
    probePluginShortcut: async (accelerator, excludeId) => shortcuts.probe(accelerator, excludeId),
    launchPluginShortcut: async id => {
      const binding = shortcuts.snapshot().bindings.find(item => item.id === id)
      if (!binding) return { ok: false, error: '快捷键绑定不存在' }
      const plugin = mockRegistry.getById(binding.pluginId)
      if (!plugin?.installed || plugin.enabled === false) return { ok: false, error: '插件不可用' }
      return { ok: false, error: '浏览器预览不支持原生窗口启动，请在 eNest 中验证' }
    },
    beginShortcutCapture: async () => shortcuts.beginCapture(),
    endShortcutCapture: async token => shortcuts.endCapture(token),
    async setPluginLaunch(id, patch) {
      if ('hotkey' in patch) return { ok: false, error: '请在快捷键设置中管理插件绑定' }
      settings = readMockSettings()
      const next = { ...(settings.pluginLaunch?.[id] ?? {}) }
      if ('mode' in patch) {
        if (patch.mode === null) delete next.mode
        else next.mode = patch.mode
      }
      if (patch.aliases) next.aliases = [...new Set(patch.aliases.map(value => value.trim()).filter(Boolean))]
      settings = { ...settings, pluginLaunch: { ...settings.pluginLaunch, [id]: next } }
      writeMockSettings(settings)
      return { ok: true, config: next }
    },
    async getOpenWithList() {
      return { platform: 'darwin', packaged: false, rows: [] }
    },
    async setOpenWithDefault() {
      return { ok: false, error: '浏览器预览不支持系统默认应用设置' }
    },
    async clearOpenWithDefault() {
      return { ok: false, error: '浏览器预览不支持系统默认应用设置' }
    },
    async routeOpenWith() {
      return { ok: false, error: '浏览器预览不支持系统默认应用设置' }
    },
    async openOpenWithSystemSettings() {
      // Browser preview has no OS default-app settings page.
    },
    async installMarketPlugin(id) {
      const existing = mockRegistry.getById(id)
      if (!existing) throw new Error(`plugin not found: ${id}`)
      if (existing.installed) return { ok: true, mode: 'already', name: existing.name }
      mockRegistry.install(id)
      emit({ type: 'install-result', jobId: `mock-${id}`, name: existing.name, ok: true })
      emit({ type: 'plugins-changed' })
      // Browser preview installs synchronously from its sample registry; report it as completed.
      return { ok: true, mode: 'already', name: existing.name }
    },
    async getTheme() {
      theme = readMockTheme()
      return {
        mode: theme.mode,
        overrides: theme.overrides,
        packId: theme.packId,
        background: theme.background,
        backgroundSource: theme.backgroundSource,
        backgroundEffect: theme.backgroundEffect,
        packs: [],
      }
    },
    async getAppearance() { return mockAppearance() },
    async updateThemeProfile(patch) {
      const current = mockAppearance()
      if (themeProfileKey(patch.theme) !== themeProfileKey(current.profile.identity)) throw new Error('theme unavailable')
      const pack = current.packs.find(item => themeProfileKey(item) === themeProfileKey(patch.theme)) ?? null
      const profile = patchThemeProfile(pack, current.profile, patch)
      const next = structuredClone(appearanceState!)
      next.profiles[themeProfileKey(patch.theme)] = profile
      next.revision++
      // localStorage throws on quota/security errors; do not acknowledge a failed save.
      localStorage.setItem('enest.appearance.v2', JSON.stringify(next))
      appearanceState = next
      const activeKey = themeProfileKey(next.active)
      if (!next.profiles[activeKey]) {
        next.profiles[activeKey] = {
          identity: structuredClone(next.active),
          schemaVersion: 2,
          values: Object.create(null),
          colors: { light: {}, dark: {} },
          quarantined: Object.create(null)
        }
      }
      theme.overrides = structuredClone(profile.colors)
      writeMockTheme(theme)
      const snapshot = mockAppearance()
      emit({ type: 'appearance-changed', revision: snapshot.appearance.revision, appearance: snapshot.appearance })
      return snapshot
    },
    async activateTheme(identity) {
      const current = mockAppearance()
      const pack = current.packs.find(item => item.source === identity.source && item.id === identity.id)
      if (!pack) throw new Error('theme unavailable')
      const next = structuredClone(appearanceState!)
      next.active = structuredClone(identity)
      next.revision++
      localStorage.setItem('enest.appearance.v2', JSON.stringify(next))
      appearanceState = next
      const activeKey = themeProfileKey(next.active)
      if (!next.profiles[activeKey]) {
        next.profiles[activeKey] = {
          identity: structuredClone(next.active),
          schemaVersion: 2,
          values: Object.create(null),
          colors: { light: {}, dark: {} },
          quarantined: Object.create(null)
        }
      }
      const snapshot = mockAppearance()
      emit({ type: 'appearance-changed', revision: snapshot.appearance.revision, appearance: snapshot.appearance })
      return snapshot
    },
    async setAppearanceMode(mode) {
      const next = structuredClone(appearanceState!)
      next.mode = mode
      next.revision++
      localStorage.setItem('enest.appearance.v2', JSON.stringify(next))
      appearanceState = next
      const activeKey = themeProfileKey(next.active)
      if (!next.profiles[activeKey]) {
        next.profiles[activeKey] = {
          identity: structuredClone(next.active),
          schemaVersion: 2,
          values: Object.create(null),
          colors: { light: {}, dark: {} },
          quarantined: Object.create(null)
        }
      }
      const snapshot = mockAppearance()
      emit({ type: 'appearance-changed', revision: snapshot.appearance.revision, appearance: snapshot.appearance })
      return snapshot
    },
    async setTheme(mode, overrides, extra) {
      const selection = extra?.backgroundEffect
      if (selection !== undefined && (typeof selection !== 'string' || selection.length > 1024
        || !selection.trim() || /[\u0000-\u001f\u007f]/.test(selection))) {
        throw new Error('invalid background effect')
      }
      const resolvedKey =
        mode === 'system'
          ? typeof window !== 'undefined' &&
            typeof window.matchMedia === 'function' &&
            window.matchMedia('(prefers-color-scheme: dark)').matches
            ? 'dark'
            : 'light'
          : mode
      if (overrides) theme.overrides[resolvedKey] = overrides
      theme.mode = mode
      if (extra && 'packId' in extra) theme.packId = extra.packId ?? undefined
      if (extra && 'backgroundSource' in extra) theme.backgroundSource = extra.backgroundSource
      if (extra && 'backgroundEffect' in extra) theme.backgroundEffect = extra.backgroundEffect
      if (theme.backgroundSource === 'pack') delete theme.background
      else if (extra && 'background' in extra) theme.background = extra.background ?? undefined
      writeMockTheme(theme)
      emit({ type: 'theme-changed', mode })
      if (extra?.packId !== undefined || extra?.background !== undefined) {
        emit({ type: 'theme-packs-changed' })
      }
    },
    async loadDevPlugin(dirPath) {
      // mock：空路径模拟系统选择框，给一个固定开发目录
      const path = dirPath.trim() || '/tmp/enest-dev-plugin'
      const id = `dev.local.${path.split(/[/\\]/).filter(Boolean).pop() ?? 'plugin'}`
      const existing = mockRegistry.getById(id)
      if (existing) return existing
      const dev: PluginSummary = {
        id,
        name: id.split('.').pop() ?? id,
        version: '0.0.1-dev',
        description: `本地开发插件 · ${path}`,
        author: 'dev',
        category: '开发',
        installs: 'dev',
        color: '#38bdf8',
        glyph: '⚙',
        permissions: [],
        installed: true,
        rootPath: path,
        devUrl: 'http://127.0.0.1:27319',
        dev: true,
        ui: { chrome: 'default', themeAware: true, background: 'opaque', preferredColorScheme: 'auto' },
      }
      return dev
    },
    async forgetDevPlugin() {
      /* mock no-op */
    },
    async reloadPlugin() {
      /* mock no-op */
    },
    async setDevKillOnHide() {
      return false
    },
    async openDevTools() {
      /* mock no-op */
    },
    async getPluginCallTrace() {
      return []
    },
    async getSettings() {
      settings = readMockSettings()
      return {
        ...settings,
        general: {
          ...settings.general,
          pluginMemoryMonitor: normalizePluginMemoryMonitor(settings.general?.pluginMemoryMonitor as Partial<PluginMemoryMonitorSettings> | undefined)
        }
      }
    },
    async setSettings(partial) {
      if ('mcp' in partial || 'mcpToken' in partial || partial.general && ('mcp' in partial.general || 'mcpToken' in partial.general)) {
        throw new Error('MCP security settings require the dedicated native API')
      }
      if ('pluginShortcuts' in partial || 'pluginLaunch' in partial || 'quick' in partial) {
        throw new Error('快捷键和启动偏好必须使用专用设置接口')
      }
      settings = readMockSettings()
      settings = {
        ...settings,
        ...partial,
        general: {
          ...settings.general,
          ...partial.general,
          pluginMemoryMonitor: normalizePluginMemoryMonitor(
            (partial.general?.pluginMemoryMonitor ?? settings.general?.pluginMemoryMonitor) as Partial<PluginMemoryMonitorSettings> | undefined
          )
        },
        // plugins 按插件 id 合并，避免整包覆盖丢失其它插件/键
        plugins: partial.plugins
          ? Object.fromEntries(
              Object.entries({
                ...(settings.plugins ?? {}),
                ...partial.plugins,
              }).map(([id, bag]) => [
                id,
                { ...((settings.plugins?.[id] as Record<string, unknown> | undefined) ?? {}), ...bag },
              ]),
            )
          : settings.plugins,
      }
      writeMockSettings(settings)
      const generalKeys = Object.keys(partial.general ?? {})
      if (generalKeys.length) emit({ type: 'settings-changed', generalKeys })
    },
    async getSettingsSections() {
      return []
    },
    async setPluginSetting(pluginId, key, value) {
      settings = readMockSettings()
      const bag = { ...(settings.plugins?.[pluginId] ?? {}), [key]: value }
      settings = {
        ...settings,
        plugins: { ...(settings.plugins ?? {}), [pluginId]: bag },
      }
      writeMockSettings(settings)
    },
    async getPaths() {
      return { ...mockPaths }
    },
    async pickFile(options?: PickFileOptions) {
      // 浏览器 mock：隐藏 input[type=file]，返回 object URL 供预览
      const acceptMap: Record<string, string> = {
        image: 'image/*',
        video: 'video/*',
        media: 'image/*,video/*',
        font: '.ttf,.otf,.woff,.woff2,font/ttf,font/otf,font/woff,font/woff2',
      }
      return new Promise<string | null>((resolve) => {
        const input = document.createElement('input')
        input.type = 'file'
        input.accept = acceptMap[options?.filters ?? 'media'] ?? 'image/*,video/*'
        input.style.display = 'none'
        const cleanup = () => input.remove()
        input.addEventListener('change', () => {
          const file = input.files?.[0]
          cleanup()
          resolve(file ? URL.createObjectURL(file) : null)
        })
        input.addEventListener('cancel', () => {
          cleanup()
          resolve(null)
        })
        document.body.appendChild(input)
        input.click()
      })
    },
    async getPluginReadme(pluginId) {
      const p = mockRegistry.getById(pluginId)
      const name = p?.name ?? pluginId
      const author = p?.author ?? '未知作者'
      return [
        `# ${name}`,
        '',
        p?.description ?? '这是一个 eNest 桌面插件。',
        '',
        '## 功能亮点',
        '',
        '- **本地优先**：数据默认只保存在本机',
        '- *开箱即用*：安装后即可在多 Tab 中并行运行',
        '- 快捷操作：面板内提供常用命令与搜索',
        '',
        '## 快速开始',
        '',
        '1. 点击「安装」将插件加入壳子',
        '2. 从顶部 Tab 或市场卡片打开',
        '3. 在设置中调整插件偏好与快捷键',
        '',
        '---',
        '',
        `维护者：${author}　·　欢迎在反馈区提交问题。`,
        '',
        '```ts',
        '// 示例：使用插件自己的数据存储',
        'const api = window.enest',
        "await api.storage.set('draft', { text: 'Hello eNest' })",
        '```',
        '',
        '更多说明见 [eNest 开发文档](https://example.com/enest/docs)。',
      ].join('\n')
    },
    async getHardwareAcceleration() {
      settings = readMockSettings()
      const fromSettings = settings.general?.hardwareAcceleration
      return { enabled: fromSettings !== false }
    },
    async setHardwareAcceleration(enabled) {
      const next = enabled !== false
      settings = readMockSettings()
      settings = {
        ...settings,
        general: { ...settings.general, hardwareAcceleration: next },
      }
      writeMockSettings(settings)
      return { needRestart: true }
    },
    async getProxy() {
      settings = readMockSettings()
      return (settings.general?.proxy as ProxyConfig | undefined) ?? { type: 'system' }
    },
    async setProxy(config) {
      const proxy: ProxyConfig = config && config.type ? config : { type: 'system' }
      settings = {
        ...settings,
        general: { ...settings.general, proxy },
      }
      writeMockSettings(settings)
      return { needRestart: false, proxy }
    },
    async testProxy(config) {
      const c = config ?? (await this.getProxy?.()) ?? { type: 'system' }
      if (!c.type || c.type === 'system' || c.type === 'none') return { ok: true, latencyMs: 0 }
      if (!c.host || !c.port) return { ok: false, error: 'host/port required' }
      return { ok: true, latencyMs: 0 }
    },
    async installPlugin(sourcePath) {
      // 浏览器 mock：无法读真实文件系统，用文件名模拟一条 0→100 的进度流水
      const name = sourcePath.split(/[/\\]/).filter(Boolean).pop() ?? sourcePath
      const job: InstallJobInfo = {
        id: `mock-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        name,
        progress: 0,
        status: 'queued'
      }
      emit({ type: 'install-queue', active: [], waiting: [job] })
      window.setTimeout(() => {
        let p = 0
        const timer = window.setInterval(() => {
          p = Math.min(100, p + 25)
          emit({
            type: 'install-progress',
            jobId: job.id,
            name,
            progress: p,
            step: p < 100 ? '安装中' : '完成'
          })
          if (p >= 100) {
            window.clearInterval(timer)
            emit({ type: 'install-result', jobId: job.id, name, ok: true })
            emit({ type: 'install-queue', active: [], waiting: [] })
            emit({ type: 'plugins-changed' })
          }
        }, 180)
      }, 50)
      return { ...job, status: 'active' }
    },
    async getInstallQueue() {
      return { active: [], waiting: [] }
    },
    getPathForFile() {
      return ''
    },
    async checkForUpdates() {
      const state = {
        status: 'not-available' as const,
        currentVersion: '0.0.0-dev',
        packaged: false
      }
      emit({ type: 'update-status', state })
      return state
    },
    async downloadUpdate() {
      return {
        status: 'error' as const,
        currentVersion: '0.0.0-dev',
        error: 'not packaged',
        packaged: false
      }
    },
    async installUpdate() {
      return {
        status: 'error' as const,
        currentVersion: '0.0.0-dev',
        error: 'not packaged',
        packaged: false
      }
    },
    async getUpdateState() {
      return {
        status: 'idle' as const,
        currentVersion: '0.0.0-dev',
        packaged: false
      }
    },
    async getPluginsDirty() {
      return { items: [] }
    },
    async saveAllPlugins() {
      return { total: 0, acked: 0, timedOut: 0, dirtyBefore: 0 }
    },
    async getAccountState() {
      return { user: null, providerId: null, providers: [{ id: 'github', name: 'GitHub', available: false }], pendingProviderId: null, session: null }
    },
    async loginAccount() { return { ok: false as const, error: '请在 eNest 桌面应用内登录' } },
    async cancelAccountLogin() {},
    async logoutAccount() {},
    async githubLogin() {
      return { ok: false as const, error: 'GitHub 登录仅在 eNest 应用内可用' }
    },
    async githubCancelLogin() {
      return { ok: true }
    },
    async getGithubProfile() {
      return { user: null, hasToken: false, polling: false }
    },
    async githubLogout() {
      return { ok: true }
    },
    async systemNotify(title, body) {
      // 浏览器 mock：尝试 Web Notification，失败静默
      try {
        if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
          new Notification(title, { body: body ?? '' })
        }
      } catch {
        /* ignore */
      }
    },
    // Browser settings mirror the native persistence contract; consent dialogs stay native-only.
    async respondPermissionRequest(_requestId, _decision) {
      throw new Error('权限请求仅由原生对话框处理')
    },
    async getPluginPermissionGrants(pluginId) {
      settings = readMockSettings()
      const bag = settings.plugins?.[pluginId]
      const grants = filterPermissionGrants(bag?.permissionGrants)
      if (bag?.permissionGrants && JSON.stringify(bag.permissionGrants) !== JSON.stringify(grants)) {
        settings = { ...settings, plugins: { ...settings.plugins, [pluginId]: { ...bag, permissionGrants: grants } } }
        writeMockSettings(settings)
      }
      return grants
    },
    async setPluginPermissionGrant(pluginId, permission, grant) {
      const plugin = mockRegistry.getById(pluginId)
      if (!plugin?.installed || !plugin.permissions.includes(permission) || !PLUGIN_PERMISSIONS.includes(permission) || !requiresUserConsent(permission)) {
        throw new Error('只能管理已安装插件声明的系统与隐私权限')
      }
      if (!['ask', 'allow', 'deny'].includes(grant)) throw new Error('无效的授权状态')
      settings = readMockSettings()
      const bag = settings.plugins?.[pluginId] ?? {}
      const grants = { ...filterPermissionGrants(bag.permissionGrants), [permission]: grant }
      settings = { ...settings, plugins: { ...settings.plugins, [pluginId]: { ...bag, permissionGrants: grants } } }
      writeMockSettings(settings)
      emit({ type: 'permission-grants-changed', pluginId, grants })
      if (grant !== 'allow' && openTabs.has(pluginId)) closeMockTab(`t-${pluginId}`)
    },
    async openScreenCaptureSettings() {
      /* mock no-op */
    },
    onInstallProgress(cb) {
      const wrapped = (payload: ShellEventPayload): void => {
        if (payload.type === 'install-progress') cb(payload)
      }
      listeners.add(wrapped)
      return () => listeners.delete(wrapped)
    },
    onEvent(cb) {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    minimizeWindow() {
      /* mock no-op */
    },
    maximizeWindow() {
      /* mock no-op */
    },
    closeWindow() {
      window.close()
    },
    async openPath(_path) {
      throw new Error('浏览器预览不支持打开本地目录')
    },
    async openExternal(url) {
      const target = new URL(url)
      if (!['https:', 'http:', 'mailto:'].includes(target.protocol)) throw new Error('Unsupported external link protocol')
      window.open(target.href, '_blank', 'noopener,noreferrer')
    },
    async quickSearch() {
      return { items: [] }
    },
    quickResize() {
      /* mock：浏览器无小窗高度 */
    },
    async quickInput() { return null },
    async quickInputContext(request) {
      // 浏览器预览以内存列表模拟宿主粘贴上下文；文件剪贴板在 Web 不可读。
      if (request.operation === 'clear') {
        if (request.id) previewQuickContext = previewQuickContext.filter(item => item.id !== request.id)
        else previewQuickContext = []
        return { ok: true, items: [...previewQuickContext] }
      }
      if (request.operation === 'list') return { ok: true, items: [...previewQuickContext] }
      try {
        const items = await navigator.clipboard.read()
        const added: import('@shared/types/quick').QuickImageContext[] = []
        for (const item of items) {
          const type = item.types.find(entry => entry.startsWith('image/'))
          if (!type) continue
          const blob = await item.getType(type)
          if (blob.size > 12 * 1024 * 1024) break
          const dimensions = await createImageBitmap(blob)
            .then(image => ({ width: image.width, height: image.height }))
            .catch(() => ({ width: 0, height: 0 }))
          const dataUrl = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader()
            reader.onload = () => resolve(String(reader.result ?? ''))
            reader.onerror = () => reject(reader.error)
            reader.readAsDataURL(blob)
          })
          added.push({ id: crypto.randomUUID(), kind: 'image', width: dimensions.width, height: dimensions.height, size: blob.size, thumbnail: dataUrl })
          break
        }
        previewQuickContext = [...previewQuickContext, ...added].slice(0, 12)
        return { ok: true, items: added }
      } catch {
        return { ok: false, error: 'Browser preview clipboard is unavailable' }
      }
    },
    async quickOpen() {
      return { ok: false, error: 'mock' }
    },
    async quickScanApps() {
      return { apps: [], complete: false, errors: ['mock'] }
    },
    quickGetConfig: async () => shortcuts.quickConfig(),
    quickGetTheme: async () => null,
    async quickProviderState(request) {
      if (request.providerKey !== null) throw new Error('Browser preview has no isolated Quick provider')
      if (request.operation === 'keys') {
        if (request.identities.length > 256 || request.identities.some(identity => typeof identity !== 'string' || !identity || identity.length > 4_096)) throw new Error('Invalid preview Quick identities')
        const keys = await Promise.all(request.identities.map(async identity => {
          const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`enest.preview.quick\u0000${identity}`))
          return `preview-${Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('')}`
        }))
        return { keys }
      }
      const snapshot = readQuickState()
      if (request.operation === 'read') return snapshot
      if (!Number.isSafeInteger(request.expectedRevision) || request.expectedRevision !== snapshot.revision) throw new Error('Quick private state revision conflict')
      const parsed = readQuickStateValue(request.value)
      if (!parsed || snapshot.revision === Number.MAX_SAFE_INTEGER) throw new Error('Invalid preview Quick private state')
      const saved = { revision: snapshot.revision + 1, value: parsed.value }
      localStorage.setItem(quickStateKey, JSON.stringify(saved))
      return saved
    },
    getThemeSettingsConfig: async () => null,
    getThemeSettingsSnapshot: async () => { throw new Error('Browser preview has no isolated theme settings provider') },
    setThemeSettingsActive: async () => false,
    dispatchThemeSettingsAction: async () => ({ ok: false, error: 'Browser preview has no isolated theme settings provider' }),
    quickAuthorizeTheme: async () => false,
    onQuickThemeKey: () => () => undefined,
    quickSetHotkeys: async patch => shortcuts.setQuick(patch),
    quickProbeHotkey: async acc => {
      const probe = shortcuts.probe(acc, undefined, true)
      return { acc: probe.accelerator, free: probe.status === 'free', ours: false, hint: probe.hint,
        ...(probe.status === 'free' ? {} : { conflict: probe }) }
    },
    async createPanel() {
      return { ok: false, cancelled: true, error: 'Browser preview does not support native region selection' }
    },
    async listPanels() {
      return []
    },
    async closePanel() {
      return { ok: false }
    },
    async setPanelHotkey() {
      return { ok: false, enabled: false, hotkey: '', error: 'Browser preview has no native hotkeys' }
    },
  }
}
