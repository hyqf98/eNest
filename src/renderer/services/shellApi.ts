import type {
  PluginShortcutInput, PluginShortcutsSnapshot,
  PluginShortcutMutationResult, PluginShortcutLaunchResult, ShortcutProbeResult
} from '@shared/types/shortcuts'
import type { AccountState, AccountLoginResult } from '@shared/types/account'
/**
 * shellApi — 渲染进程与主进程/preload 的桥接层
 * 统一暴露插件生命周期、主题、设置、路径、文件选择、README、硬件加速、DevTools 与窗口控制 API。
 * 存在 preload（window.enestShell）时合并真实实现；否则回退 localStorage mock。
 * 依赖：mockData（mockRegistry / theme / settings）、@shared types。
 */
import type {
  AppPaths,
  DevPluginLoadOptions,
  MarketInstallResult,
  PluginMarketStatus,
  PluginLaunchConfig,
  PluginLaunchPatch,
  PluginPermission,
  PluginPermissionGrant,
  PluginSummary,
  PluginTab,
  ProxyConfig,
  ThemeMode,
  ThemePack,
  ThemeTokens
} from '@shared/types/plugin'
import { createShortcutMock } from './shortcutMock'
import { PLUGIN_PERMISSIONS } from '@shared/types/plugin'
import { filterPermissionGrants, requiresUserConsent } from '@shared/pluginPermissionPolicy'
import type {
  ShellEventPayload,
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
  DEFAULT_SETTINGS,
  mockRegistry,
  readMockSettings,
  readMockTheme,
  writeMockSettings,
  writeMockTheme,
  type ShellSettingsData,
} from '@renderer/services/mockData'

/** shell:get-theme 返回：ThemeTokens + 主题包列表 */
export type ShellThemeResult = ThemeTokens & { packs: ThemePack[] }

export interface PickFileOptions {
  filters?: 'image' | 'video' | 'media' | 'font'
}

export interface HardwareAccelState {
  enabled: boolean
}

export interface HardwareAccelSetResult {
  needRestart: boolean
}

export interface ProxySetResult {
  needRestart: boolean
  proxy: ProxyConfig
}

/** shell:set-plugin-launch 返回体（与 preload PluginLaunchSetResult 对齐） */
export interface PluginLaunchSetResult {
  ok: boolean
  error?: string
  /** 成功后的最终配置（空配置为 null） */
  config?: PluginLaunchConfig | null
}

/** preload 注入到渲染进程的完整 shell 能力面 */
export interface ShellApi {
  getPlugins(): Promise<PluginSummary[]>
  getMarketStatus(refresh?: boolean): Promise<PluginMarketStatus>
  /** 只读性能采样，浏览器 mock 不提供原生进程数据。 */
  getPluginDiagnostics(): Promise<unknown>
  restoreTabs(ids: string[]): Promise<void>
  /** enter.code 透传给插件 onEnter（首页卡片/轨道入口等贡献点打开场景） */
  openPlugin(id: string, enter?: { code?: string; payload?: unknown }): Promise<void>
  closePlugin(tabId: string): Promise<void>
  activatePlugin(tabId: string): Promise<void>
  /** 隐藏全部插件原生视图（回首页/设置/开发者时，避免遮挡壳子） */
  hidePlugins(): Promise<void>
  /** 设置插件内容区左侧 inset（px）；orb 悬浮窗模式恒为 0 */
  setPluginInset?(left: number): Promise<void>
  /** 回首页（隐藏插件 + 主壳 setView home） */
  goHome?(): Promise<void>
  /** 主壳切换视图 */
  setShellView?(view: string): Promise<void>
  /** 圆轨 rail 视图展开/收起：主进程切换 WebContentsView 宽度 */
  setOrbRailExpanded?(expanded: boolean): Promise<void>
  syncOrbState?(state: {
    view: string
    tabStyle: string
    activeTabId: string | null
    /** 可选：主进程以 settingsStore 为准，不信任该字段 */
    animationLevel?: string
    theme?: { mode: string; tokens: Record<string, string> }
    tabs: unknown[]
  }): Promise<void>
  getOrbState?(): Promise<{
    view: string
    tabStyle: string
    activeTabId: string | null
    animationLevel: string
    theme: { mode: string; tokens: Record<string, string> }
    profile?: import('@shared/types/ipc').OrbRailState['profile']
    tabs: unknown[]
    contribEntries?: import('@shared/types/ipc').OrbRailState['contribEntries']
  }>
  /** 卸载插件：关 Tab → 清 storage → 删文件 → 重扫；结果经 uninstall-result 事件 */
  uninstallPlugin?(pluginId: string): Promise<void>
  /** 启用/禁用已安装插件（持久化）；成功返回更新后的 summary */
  setPluginEnabled?(pluginId: string, enabled: boolean): Promise<PluginSummary>
  getPluginShortcuts(): Promise<PluginShortcutsSnapshot>
  savePluginShortcut(input: PluginShortcutInput): Promise<PluginShortcutMutationResult>
  removePluginShortcut(id: string): Promise<PluginShortcutMutationResult>
  probePluginShortcut(accelerator: string, excludeId?: string): Promise<ShortcutProbeResult>
  launchPluginShortcut(id: string): Promise<PluginShortcutLaunchResult>
  beginShortcutCapture(): Promise<{ token: string }>
  endShortcutCapture(token: string): Promise<void>
  /** 搜索启动偏好；快捷键绑定使用独立服务。 */
  setPluginLaunch?(
    pluginId: string,
    patch: PluginLaunchPatch
  ): Promise<PluginLaunchSetResult>
  /** 从市场安装/更新：sample 优先，否则远程入队；force 强制走远程更新 */
  installMarketPlugin?(
    pluginId: string,
    opts?: { force?: boolean }
  ): Promise<MarketInstallResult>
  getTheme(): Promise<ShellThemeResult>
  setTheme(
    mode: ThemeMode,
    overrides?: Record<string, string>,
    extra?: Partial<Pick<ThemeTokens, 'packId' | 'background' | 'backgroundSource' | 'backgroundEffect'>>
  ): Promise<void>
  loadDevPlugin(dirPath: string, options?: DevPluginLoadOptions): Promise<PluginSummary>
  forgetDevPlugin(pluginId: string): Promise<void>
  reloadPlugin(pluginId: string): Promise<void>
  /** 开发者控制台：切换/查询 dev 插件「退出到后台立即结束运行」（mock 恒 false） */
  setDevKillOnHide(pluginId: string, enabled?: boolean): Promise<boolean>
  /** 开发者控制台：切换 dev/prod 模式（mock no-op） */
  setDevPluginMode(pluginId: string, mode: 'dev' | 'prod'): Promise<void>
  /** 开发者控制台：prod 模式手动重建（mock no-op） */
  rebuildDevPlugin(pluginId: string): Promise<void>
  openDevTools(pluginId: string): Promise<void>
  /** plugin:call 调用跟踪（Electron；mock 返回空数组） */
  getPluginCallTrace?(): Promise<PluginCallTraceEntry[]>
  getSettings(): Promise<ShellSettingsData>
  setSettings(settings: Partial<ShellSettingsData>): Promise<void>
  /** 拉取插件已注册的设置 section 列表（Electron）；mock 返回空数组 */
  getSettingsSections?(): Promise<
    Array<{
      id: string
      title: string
      pluginId: string
      items: Array<{
        key: string
        type: string
        label: string
        default?: unknown
        options?: Array<{ label: string; value: unknown }>
      }>
    }>
  >
  /** 写入单个插件设置项（Electron）；mock 回落 setSettings.plugins */
  setPluginSetting?(pluginId: string, key: string, value: unknown): Promise<void>
  getPaths(): Promise<AppPaths>
  pickFile(options?: PickFileOptions): Promise<string | null>
  getPluginReadme(pluginId: string): Promise<string>
  getHardwareAcceleration(): Promise<HardwareAccelState>
  setHardwareAcceleration(enabled: boolean): Promise<HardwareAccelSetResult>
  /** 读取代理配置；浏览器 mock 读 localStorage */
  getProxy?(): Promise<ProxyConfig>
  /** 写入并即时应用；浏览器 mock 仅持久化 */
  setProxy?(config: ProxyConfig): Promise<ProxySetResult>
  /** 测试代理连通性；浏览器 mock 对 none 返回 ok */
  testProxy?(config?: ProxyConfig): Promise<ProxyTestResult>
  /** Electron：复制/写入自定义字体到 ~/.eNest/fonts/；浏览器 mock 返回 not-available */
  saveCustomFont?(payload: {
    sourcePath?: string
    dataBase64?: string
    fileName: string
  }): Promise<{ ok: boolean; path?: string; fileName?: string; error?: string }>
  /** Electron：读取自定义字体 base64；浏览器 mock 走 localStorage */
  readCustomFont?(fileName: string): Promise<{ ok: boolean; dataBase64?: string; error?: string }>
  /** Electron：删除自定义字体文件 */
  deleteCustomFont?(fileName: string): Promise<{ ok: boolean; error?: string }>
  /** 将本地文件夹 / .enestplugin 路径入队安装；进度经 onEvent / onInstallProgress 推送 */
  installPlugin(sourcePath: string): Promise<InstallJobInfo>
  getInstallQueue?(): Promise<{ active: InstallJobInfo[]; waiting: InstallJobInfo[] }>
  /** Electron：File → 绝对路径；浏览器 mock 返回空串 */
  getPathForFile?(file: File): string
  checkForUpdates?(): Promise<UpdateStatePayload>
  downloadUpdate?(): Promise<UpdateStatePayload>
  installUpdate?(): Promise<UpdateStatePayload>
  getUpdateState?(): Promise<UpdateStatePayload>
  /** 更新重启前：运行中插件未保存数据快照（浏览器 mock 返回空） */
  getPluginsDirty?(): Promise<PluginDirtyState>
  /** 一键保存（save.requested 通知 + ack 等待）；mock 返回全 0 汇总 */
  saveAllPlugins?(): Promise<PluginSaveSummary>
  /** 宿主登录方式、当前账号与可恢复的授权会话；mock 返回未登录 */
  getAccountState(): Promise<AccountState>
  loginAccount(providerId: string): Promise<AccountLoginResult>
  cancelAccountLogin(providerId: string): Promise<void>
  logoutAccount(providerId: string): Promise<void>
  githubLogin?(): Promise<{ ok: true; data: GithubLoginSessionPayload } | { ok: false; error: string }>
  /** 兼容接口：取消浏览器授权或设备码登录 */
  githubCancelLogin?(): Promise<{ ok: boolean }>
  /** 读取个人资料状态；mock 返回未登录 */
  getGithubProfile?(): Promise<GithubProfileState>
  /** 退出 GitHub 登录 */
  githubLogout?(): Promise<{ ok: boolean }>
  /** 系统级通知（Electron Notification）；浏览器 mock 用 Web Notification 兜底 */
  systemNotify?(title: string, body?: string): Promise<void>
  /** Legacy response API; the native host rejects renderer-driven consent. */
  respondPermissionRequest?(
    requestId: string,
    decision: 'once' | 'always' | 'deny'
  ): Promise<void>
  /** Read sensitive permission decisions; missing decisions default to ask. */
  getPluginPermissionGrants?(
    pluginId: string
  ): Promise<Partial<Record<PluginPermission, PluginPermissionGrant>>>
  /** 写单项权限授权（设置页三态分段） */
  setPluginPermissionGrant?(
    pluginId: string,
    permission: PluginPermission,
    grant: PluginPermissionGrant
  ): Promise<void>
  /** 打开 macOS「屏幕录制」系统设置（权限引导） */
  openScreenCaptureSettings?(): Promise<void>
  /** 仅订阅 install-progress 事件 */
  onInstallProgress?(
    cb: (payload: { jobId: string; name: string; progress: number; step?: string }) => void
  ): () => void
  onEvent(cb: (payload: ShellEventPayload) => void): () => void
  /** orb 悬浮窗订阅 Tab 状态推送 */
  onOrbEvent?(
    cb: (payload: { type: 'orb-state'; state: import('@shared/types/ipc').OrbRailState }) => void
  ): () => void
  minimizeWindow?(): void
  maximizeWindow?(): void
  closeWindow?(): void
  /** 在系统中打开路径；不可用时 UI 回退为复制剪贴板 */
  openPath?(path: string): Promise<void>

  // —— 快捷启动 Quick（Electron preload 提供；mock 可省略）——
  quickToggle?(): Promise<void>
  quickHide?(): void
  quickSearch?(query: string, limit?: number, kind?: QuickCommandKind, phase?: 'static' | 'enriched' | 'providers'): Promise<{ items: QuickCommand[]; total?: number }>
  quickOpen?(req: QuickOpenRequest): Promise<{ ok: boolean; error?: string }>
  quickScanApps?(force?: boolean): Promise<ApplicationScanResult>
  quickGetConfig?(): Promise<QuickHotkeyConfig>
  quickSetHotkeys?(payload: QuickHotkeyPatch): Promise<QuickHotkeyApplyResult>
  quickProbeHotkey?(acc: string): Promise<import('@shared/types/quick').QuickHotkeyProbeResult>
  quickResize?(height: number, animate?: boolean): void
  quickInput?(message?: import('@shared/types/plugin-tools').QuickInputMessage): Promise<import('@shared/types/plugin-tools').QuickInputState | boolean | null>
  onQuickShown?(cb: () => void): () => void
}

type EventCb = (payload: ShellEventPayload) => void

/** 无 Electron preload 时的浏览器 mock：内存 Tab + localStorage 主题/设置 */
function createMockApi(): ShellApi {
  const listeners = new Set<EventCb>()
  let theme = readMockTheme()
  let settings = readMockSettings()
  const openTabs = new Map<string, PluginTab & { status: 'ready' | 'hibernated' }>()
  let activeTabId: string | null = null
  let tabRevision = 0

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

  return {
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
    async installMarketPlugin(id) {
      const existing = mockRegistry.getById(id)
      if (!existing) throw new Error(`plugin not found: ${id}`)
      if (existing.installed) return { ok: true, mode: 'already', name: existing.name }
      mockRegistry.install(id)
      emit({ type: 'install-result', jobId: `mock-${id}`, name: existing.name, ok: true })
      emit({ type: 'plugins-changed' })
      return { ok: true, mode: 'sample', name: existing.name }
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
    async setDevPluginMode() {
      /* mock no-op */
    },
    async rebuildDevPlugin() {
      /* mock no-op */
    },
    async openDevTools() {
      /* mock no-op */
    },
    async getPluginCallTrace() {
      return []
    },
    async getSettings() {
      settings = readMockSettings()
      return { ...settings }
    },
    async setSettings(partial) {
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
      return (settings.general?.proxy as ProxyConfig | undefined) ?? { type: 'none' }
    },
    async setProxy(config) {
      const proxy: ProxyConfig = config && config.type ? config : { type: 'none' }
      settings = {
        ...settings,
        general: { ...settings.general, proxy },
      }
      writeMockSettings(settings)
      return { needRestart: false, proxy }
    },
    async testProxy(config) {
      const c = config ?? (await this.getProxy?.()) ?? { type: 'none' }
      if (!c.type || c.type === 'none') return { ok: true, latencyMs: 0 }
      // 浏览器环境无法 TCP 探测，仅做格式校验
      if (c.type === 'custom') {
        try {
          new URL(c.url ?? '')
          return { ok: true, latencyMs: 0 }
        } catch {
          return { ok: false, error: 'invalid proxy url' }
        }
      }
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
    async quickSearch() {
      return { items: [] }
    },
    quickResize() {
      /* mock：浏览器无小窗高度 */
    },
    async quickInput() { return null },
    async quickOpen() {
      return { ok: false, error: 'mock' }
    },
    async quickScanApps() {
      return { apps: [], complete: false, errors: ['mock'] }
    },
    quickGetConfig: async () => shortcuts.quickConfig(),
    quickSetHotkeys: async patch => shortcuts.setQuick(patch),
    quickProbeHotkey: async acc => {
      const probe = shortcuts.probe(acc, undefined, true)
      return { acc: probe.accelerator, free: probe.status === 'free', ours: false, hint: probe.hint,
        ...(probe.status === 'free' ? {} : { conflict: probe }) }
    },
  }
}

const mockApi = createMockApi()
const rawShell = window.enestShell

/** 单例 API：有 preload 用真实实现（mock 兜底），否则纯 mock */
export const shellApi: ShellApi = rawShell
  ? {
      ...mockApi,
      ...rawShell,
      getPlugins: () => rawShell.getPlugins
        ? rawShell.getPlugins()
        : Promise.reject(new Error('当前宿主未提供插件目录，请重启 eNest')),
      getMarketStatus: (refresh = false) => rawShell.getMarketStatus
        ? rawShell.getMarketStatus(refresh)
        : Promise.reject(new Error('当前宿主未提供市场连接状态，请重启 eNest')),
      getPaths: () => {
        if (rawShell.getPaths) return rawShell.getPaths()
        return mockApi.getPaths()
      },
      openPath: (path) => {
        if (rawShell.openPath) return rawShell.openPath(path)
        return Promise.reject(new Error('当前宿主不支持打开本地目录，请重启 eNest'))
      },
      pickFile: (options) => {
        if (rawShell.pickFile) return rawShell.pickFile(options)
        return mockApi.pickFile(options)
      },
      saveCustomFont: (payload) => {
        if (rawShell.saveCustomFont) return rawShell.saveCustomFont(payload)
        return Promise.resolve({ ok: false, error: 'not-available' })
      },
      readCustomFont: (fileName) => {
        if (rawShell.readCustomFont) return rawShell.readCustomFont(fileName)
        return Promise.resolve({ ok: false, error: 'not-available' })
      },
      deleteCustomFont: (fileName) => {
        if (rawShell.deleteCustomFont) return rawShell.deleteCustomFont(fileName)
        return Promise.resolve({ ok: false, error: 'not-available' })
      },
      getPluginReadme: (pluginId) => {
        if (rawShell.getPluginReadme) return rawShell.getPluginReadme(pluginId)
        return mockApi.getPluginReadme(pluginId)
      },
      getHardwareAcceleration: () => {
        if (rawShell.getHardwareAcceleration) return rawShell.getHardwareAcceleration()
        return mockApi.getHardwareAcceleration()
      },
      setHardwareAcceleration: (enabled) => {
        if (rawShell.setHardwareAcceleration) return rawShell.setHardwareAcceleration(enabled)
        return mockApi.setHardwareAcceleration(enabled)
      },
      getProxy: () => {
        if (rawShell.getProxy) return rawShell.getProxy()
        return mockApi.getProxy?.() ?? Promise.resolve({ type: 'none' as const })
      },
      setProxy: (config) => {
        if (rawShell.setProxy) return rawShell.setProxy(config)
        return (
          mockApi.setProxy?.(config) ??
          Promise.resolve({ needRestart: false, proxy: { type: 'none' as const } })
        )
      },
      testProxy: (config) => {
        if (rawShell.testProxy) return rawShell.testProxy(config)
        return mockApi.testProxy?.(config) ?? Promise.resolve({ ok: true, latencyMs: 0 })
      },
      getTheme: () => {
        if (rawShell.getTheme) return rawShell.getTheme()
        return mockApi.getTheme()
      },
      getSettingsSections: () => {
        if (rawShell.getSettingsSections) return rawShell.getSettingsSections()
        return mockApi.getSettingsSections?.() ?? Promise.resolve([])
      },
      setPluginSetting: (pluginId, key, value) => {
        if (rawShell.setPluginSetting) return rawShell.setPluginSetting(pluginId, key, value)
        return (
          mockApi.setPluginSetting?.(pluginId, key, value) ??
          Promise.resolve()
        )
      },
      setTheme: (mode, overrides, extra) => {
        if (rawShell.setTheme) return rawShell.setTheme(mode, overrides, extra)
        return mockApi.setTheme(mode, overrides, extra)
      },
      minimizeWindow: () => {
        if (rawShell.minimizeWindow) rawShell.minimizeWindow()
        else mockApi.minimizeWindow?.()
      },
      maximizeWindow: () => {
        if (rawShell.maximizeWindow) rawShell.maximizeWindow()
        else mockApi.maximizeWindow?.()
      },
      closeWindow: () => {
        if (rawShell.closeWindow) rawShell.closeWindow()
        else window.close()
      },
    }
  : mockApi

/** 当前是否运行在无 preload 的 mock shell（纯浏览器预览） */
export const isMockShell = !rawShell

export type { ShellSettingsData }
