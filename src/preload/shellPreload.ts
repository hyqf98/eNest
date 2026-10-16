import { bindNativeInstallDrop } from './installDropBridge'
import type {
  PluginShortcutBinding, PluginShortcutInput, PluginShortcutsSnapshot,
  PluginShortcutMutationResult, PluginShortcutLaunchResult, ShortcutProbeResult
} from '@shared/types/shortcuts'
import type { AccountState, AccountLoginResult } from '@shared/types/account'
/**
 * shellPreload — 壳子渲染层预加载脚本
 * 职责：通过 contextBridge 向壳子渲染层暴露 window.enestShell API，
 * 将渲染层调用桥接到主进程 shellHandlers（含路径、文件选择、README、硬件加速）。
 * 被 createShellWindow 指定为 shell WebContentsView 的 preload。
 * 关键依赖：@shared/types/ipc（通道名与类型）、contextBridge、ipcRenderer。
 */
import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { exposePluginWindowBridge } from './pluginWindowBridge'
import { exposeNotificationClient } from './notificationClientBridge'
import type { QuickInputMessage, QuickInputState } from '@shared/types/plugin-tools'
import {
  IpcChannels,
  type InstallJobInfo,
  type OrbRailState,
  type PluginCallTraceEntry,
  type PluginDirtyState,
  type PluginSaveSummary,
  type GithubLoginSessionPayload,
  type GithubProfileState,
  type ShellEventPayload,
  type UpdateStatePayload
} from '@shared/types/ipc'
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
  ProxyConfig,
  ThemeMode,
  ThemePack,
  ThemeTokens
} from '@shared/types/plugin'
import type { ProxyTestResult } from '@shared/types/ipc'
import type {
  ApplicationScanResult,
  QuickCommandKind,
  QuickHotkeyApplyResult,
  QuickHotkeyConfig,
  QuickHotkeyPatch,
  QuickOpenRequest,
  QuickOpenResult,
  QuickSearchResult
} from '@shared/types/quick'

type Unsubscribe = () => void

/** shell:get-theme 返回：ThemeTokens + 主题包列表 */
export type ShellThemeResult = ThemeTokens & { packs: ThemePack[] }

export interface ShellSettingsData {
  theme?: ThemeTokens
  general?: Record<string, unknown>
  plugins?: Record<string, Record<string, unknown>>
  /** 每插件快捷启动配置表（键 = pluginId）；读取用，写入走 setPluginLaunch */
  pluginLaunch?: Record<string, PluginLaunchConfig>
  pluginShortcuts?: PluginShortcutBinding[]
  [key: string]: unknown
}

/** shell:set-plugin-launch 返回体 */
export interface PluginLaunchSetResult {
  ok: boolean
  error?: string
  /** 成功后的最终配置（空配置为 null） */
  config?: PluginLaunchConfig | null
}

/** 插件注册的设置 section（与主进程 PluginSettingsBridge 对齐） */
export interface ShellSettingsSectionItem {
  key: string
  type: string
  label: string
  entry?: { code: string; payload?: unknown }
  default?: unknown
  options?: Array<{ label: string; value: unknown }>
}

export interface ShellSettingsSection {
  id: string
  title: string
  pluginId: string
  items: ShellSettingsSectionItem[]
}

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

/** 解包 ok/data/error 结构，失败时抛出 Error */
async function unwrapOk<T>(promise: Promise<{ ok: boolean; data?: T; error?: string }>): Promise<T> {
  const result = await promise
  if (!result?.ok) throw new Error(result?.error || 'ipc failed')
  return result.data as T
}

/** 校验 ok 标志，失败时抛出 Error（无 data 场景） */
async function expectOk(promise: Promise<{ ok: boolean; error?: string }>): Promise<void> {
  const result = await promise
  if (!result?.ok) throw new Error(result?.error || 'ipc failed')
}

export interface EnestShellApi {
  getPlugins(): Promise<PluginSummary[]>
  getMarketStatus(refresh?: boolean): Promise<PluginMarketStatus>
  /** 只读性能采样：仅包含当前应用的进程与插件资源计数。 */
  getPluginDiagnostics(): Promise<unknown>
  restoreTabs(ids: string[]): Promise<void>
  openPlugin(id: string, enter?: { code?: string; payload?: unknown }): Promise<void>
  closePlugin(tabId: string): Promise<void>
  activatePlugin(tabId: string): Promise<void>
  /** 隐藏全部插件原生视图（回首页/设置时） */
  hidePlugins(): Promise<void>
  /** 设置插件内容区左侧 inset（orb 圆轨通道） */
  setPluginInset(left: number): Promise<void>
  /** 回首页 */
  goHome(): Promise<void>
  /** 主壳切换视图 */
  setShellView(view: string): Promise<void>
  /** 圆轨 rail 视图展开/收起：主进程切换 WebContentsView 宽度 */
  setOrbRailExpanded(expanded: boolean): Promise<void>
  /** 同步圆轨状态到悬浮窗 */
  syncOrbState(state: {
    view: string
    tabStyle: string
    activeTabId: string | null
    /** 可选：主进程以 settingsStore 为准，不信任该字段 */
    animationLevel?: string
    theme?: { mode: string; tokens: Record<string, string> }
    tabs: unknown[]
  }): Promise<void>
  getOrbState(): Promise<{
    view: string
    tabStyle: string
    activeTabId: string | null
    animationLevel: string
    theme: { mode: string; tokens: Record<string, string> }
    profile?: OrbRailState['profile']
    tabs: unknown[]
    contribEntries?: OrbRailState['contribEntries']
  }>
  /** 卸载插件：关 Tab → 清 storage → 删文件 → 重扫；结果经 uninstall-result 事件 */
  uninstallPlugin(pluginId: string): Promise<void>
  /** 启用/禁用已安装插件（持久化）；成功返回更新后的 summary */
  setPluginEnabled(pluginId: string, enabled: boolean): Promise<PluginSummary>
  getPluginShortcuts(): Promise<PluginShortcutsSnapshot>
  savePluginShortcut(input: PluginShortcutInput): Promise<PluginShortcutMutationResult>
  removePluginShortcut(id: string): Promise<PluginShortcutMutationResult>
  probePluginShortcut(accelerator: string, excludeId?: string): Promise<ShortcutProbeResult>
  launchPluginShortcut(id: string): Promise<PluginShortcutLaunchResult>
  beginShortcutCapture(): Promise<{ token: string }>
  endShortcutCapture(token: string): Promise<void>
  /** 搜索启动偏好；快捷键绑定使用独立服务。 */
  setPluginLaunch(
    pluginId: string,
    patch: PluginLaunchPatch
  ): Promise<PluginLaunchSetResult>
  /** 从市场安装/更新：sample 优先，否则远程入队；force 强制走远程更新 */
  installMarketPlugin(
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
  /** 开发者控制台：切换/查询 dev 插件「退出到后台立即结束运行」（enabled 省略为查询） */
  setDevKillOnHide(pluginId: string, enabled?: boolean): Promise<boolean>
  /** 开发者控制台：切换 dev/prod 模式（打开态原地重载） */
  setDevPluginMode(pluginId: string, mode: 'dev' | 'prod'): Promise<void>
  /** 开发者控制台：prod 模式手动重建并重载 */
  rebuildDevPlugin(pluginId: string): Promise<void>
  openDevTools(pluginId: string): Promise<void>
  /** plugin:call 调用跟踪（最近 200 条环形缓冲，DevConsole 面板轮询） */
  getPluginCallTrace(): Promise<PluginCallTraceEntry[]>
  getSettings(): Promise<ShellSettingsData>
  setSettings(settings: Partial<ShellSettingsData>): Promise<void>
  /** 拉取插件已注册的设置 section 列表 */
  getSettingsSections(): Promise<ShellSettingsSection[]>
  /** 写入单个插件设置项 */
  setPluginSetting(pluginId: string, key: string, value: unknown): Promise<void>
  getPaths(): Promise<AppPaths>
  openPath(path: string): Promise<void>
  pickFile(options?: PickFileOptions): Promise<string | null>
  getPluginReadme(pluginId: string): Promise<string>
  getHardwareAcceleration(): Promise<HardwareAccelState>
  setHardwareAcceleration(enabled: boolean): Promise<HardwareAccelSetResult>
  /** 读取当前代理配置（settings.general.proxy） */
  getProxy(): Promise<ProxyConfig>
  /** 写入并即时 session.setProxy；needRestart 恒为 false */
  setProxy(config: ProxyConfig): Promise<ProxySetResult>
  /** TCP 探测代理连通性；省略 config 时测已保存配置 */
  testProxy(config?: ProxyConfig): Promise<ProxyTestResult>
  /** 复制/写入自定义字体到 ~/.eNest/fonts/，返回落盘路径 */
  saveCustomFont(payload: {
    sourcePath?: string
    dataBase64?: string
    fileName: string
  }): Promise<{ ok: boolean; path?: string; fileName?: string; error?: string }>
  /** 读取自定义字体文件为 base64 */
  readCustomFont(fileName: string): Promise<{ ok: boolean; dataBase64?: string; error?: string }>
  /** 删除自定义字体文件 */
  deleteCustomFont(fileName: string): Promise<{ ok: boolean; error?: string }>
  /** 将本地文件夹 / .enestplugin 路径入队安装；进度经 onEvent / onInstallProgress 推送 */
  installPlugin(sourcePath: string): Promise<InstallJobInfo>
  getInstallQueue(): Promise<{ active: InstallJobInfo[]; waiting: InstallJobInfo[] }>
  /** Electron 13+：File → 绝对路径（file.path 在部分环境不可用） */
  getPathForFile(file: File): string
  /** 检查 GitHub Release 更新；返回最新状态快照 */
  checkForUpdates(): Promise<UpdateStatePayload>
  /** 下载已发现的更新包；进度经 update-status 事件推送 */
  downloadUpdate(): Promise<UpdateStatePayload>
  /** 安装已下载的更新并重启应用 */
  installUpdate(): Promise<UpdateStatePayload>
  getUpdateState(): Promise<UpdateStatePayload>
  /** 更新重启前：运行中插件的未保存数据快照（enest.setDirty 上报） */
  getPluginsDirty(): Promise<PluginDirtyState>
  /** 一键保存：广播 save.requested 通知并等待插件 ack（超时兜底放行） */
  saveAllPlugins(): Promise<PluginSaveSummary>
  /** 宿主登录方式、当前账号与可恢复的授权会话 */
  getAccountState(): Promise<AccountState>
  loginAccount(providerId: string): Promise<AccountLoginResult>
  cancelAccountLogin(providerId: string): Promise<void>
  logoutAccount(providerId: string): Promise<void>
  githubLogin(): Promise<{ ok: true; data: GithubLoginSessionPayload } | { ok: false; error: string }>
  /** 兼容接口：取消浏览器授权或设备码登录 */
  githubCancelLogin(): Promise<{ ok: boolean }>
  /** 读取个人资料状态（用户 / token / 轮询中） */
  getGithubProfile(): Promise<GithubProfileState>
  /** 退出登录：清除加密 token 与资料 */
  githubLogout(): Promise<{ ok: boolean }>
  /** 系统级通知（Electron Notification） */
  systemNotify(title: string, body?: string): Promise<void>
  /** —— 运行时权限（壳层三态）—— */
  /** 响应权限弹窗：decision = once（本次允许）/ always（总是允许）/ deny（拒绝） */
  respondPermissionRequest(
    requestId: string,
    decision: 'once' | 'always' | 'deny'
  ): Promise<void>
  /** 读插件权限授权表（未设置项语义为 'ask'） */
  getPluginPermissionGrants(
    pluginId: string
  ): Promise<Partial<Record<PluginPermission, PluginPermissionGrant>>>
  /** 写单项权限授权（设置页三态分段） */
  setPluginPermissionGrant(
    pluginId: string,
    permission: PluginPermission,
    grant: PluginPermissionGrant
  ): Promise<void>
  /** 打开 macOS「屏幕录制」系统设置（权限引导；仅内部通道） */
  openScreenCaptureSettings(): Promise<void>
  /** 仅订阅 install-progress 事件 */
  onInstallProgress(
    cb: (payload: { jobId: string; name: string; progress: number; step?: string }) => void
  ): Unsubscribe
  onEvent(cb: (payload: ShellEventPayload) => void): Unsubscribe

  /** orb 悬浮窗：订阅主进程推送的 Tab 状态 */
  onOrbEvent(cb: (payload: { type: 'orb-state'; state: OrbRailState }) => void): Unsubscribe

  minimizeWindow(): void
  maximizeWindow(): void
  closeWindow(): void

  // —— 快捷启动 Quick ——
  quickToggle(): Promise<void>
  quickHide(): void
  quickSearch(query: string, limit?: number, kind?: QuickCommandKind, phase?: 'static' | 'enriched' | 'providers'): Promise<QuickSearchResult>
  quickOpen(req: QuickOpenRequest): Promise<QuickOpenResult>
  quickScanApps(force?: boolean): Promise<ApplicationScanResult>
  quickGetConfig(): Promise<QuickHotkeyConfig>
  quickSetHotkeys(payload: QuickHotkeyPatch): Promise<QuickHotkeyApplyResult>
  quickProbeHotkey(acc: string): Promise<import('@shared/types/quick').QuickHotkeyProbeResult>
  /** 请求主进程按内容高度调整小窗 */
  quickResize(height: number, animate?: boolean): void
  quickInput(message?: QuickInputMessage): Promise<QuickInputState | boolean | null>
  onQuickShown(cb: () => void): Unsubscribe
}

const api: EnestShellApi = {
  getPlugins: () => ipcRenderer.invoke(IpcChannels.ShellGetPlugins),
  getMarketStatus: (refresh = false) => ipcRenderer.invoke(IpcChannels.ShellGetMarketStatus, refresh),
  getPluginDiagnostics: () => ipcRenderer.invoke(IpcChannels.ShellGetPluginDiagnostics),
  restoreTabs: (ids) => ipcRenderer.invoke(IpcChannels.ShellRestoreTabs, ids).then(() => undefined),

  openPlugin: (id: string, enter?: { code?: string; payload?: unknown }) =>
    expectOk(ipcRenderer.invoke(IpcChannels.ShellOpenPlugin, id, enter)),

  closePlugin: (tabId: string) =>
    expectOk(ipcRenderer.invoke(IpcChannels.ShellClosePlugin, tabId)),

  activatePlugin: (tabId: string) =>
    expectOk(ipcRenderer.invoke(IpcChannels.ShellActivatePlugin, tabId)),

  hidePlugins: () => expectOk(ipcRenderer.invoke(IpcChannels.ShellHidePlugins)),

  setPluginInset: (left: number) =>
    expectOk(ipcRenderer.invoke(IpcChannels.ShellSetPluginInset, left)),

  goHome: () => expectOk(ipcRenderer.invoke(IpcChannels.ShellGoHome)),

  setShellView: (view: string) =>
    expectOk(ipcRenderer.invoke(IpcChannels.ShellSetView, view)),

  setOrbRailExpanded: (expanded: boolean) =>
    expectOk(ipcRenderer.invoke(IpcChannels.ShellSetOrbRailExpanded, expanded)),

  syncOrbState: (state) =>
    expectOk(ipcRenderer.invoke(IpcChannels.ShellSyncOrbState, state)),

  getOrbState: () =>
    ipcRenderer.invoke(IpcChannels.ShellGetOrbState) as Promise<{
      view: string
      tabStyle: string
      activeTabId: string | null
      animationLevel: string
      theme: { mode: string; tokens: Record<string, string> }
      profile?: OrbRailState['profile']
      tabs: unknown[]
      contribEntries?: OrbRailState['contribEntries']
    }>,

  uninstallPlugin: (pluginId: string) =>
    expectOk(ipcRenderer.invoke(IpcChannels.ShellUninstallPlugin, pluginId)),

  setPluginEnabled: (pluginId: string, enabled: boolean) =>
    unwrapOk<PluginSummary>(
      ipcRenderer.invoke(IpcChannels.ShellSetPluginEnabled, pluginId, enabled)
    ),

  getPluginShortcuts: () => ipcRenderer.invoke(IpcChannels.ShellGetPluginShortcuts),
  savePluginShortcut: input => ipcRenderer.invoke(IpcChannels.ShellSavePluginShortcut, input),
  removePluginShortcut: id => ipcRenderer.invoke(IpcChannels.ShellRemovePluginShortcut, id),
  probePluginShortcut: (accelerator, excludeId) => ipcRenderer.invoke(IpcChannels.ShellProbePluginShortcut, accelerator, excludeId),
  launchPluginShortcut: id => ipcRenderer.invoke(IpcChannels.ShellLaunchPluginShortcut, id),
  beginShortcutCapture: () => ipcRenderer.invoke(IpcChannels.ShellBeginShortcutCapture),
  endShortcutCapture: token => ipcRenderer.invoke(IpcChannels.ShellEndShortcutCapture, token),
  setPluginLaunch: (pluginId, patch) =>
    ipcRenderer.invoke(IpcChannels.ShellSetPluginLaunch, pluginId, patch) as Promise<PluginLaunchSetResult>,

  installMarketPlugin: (pluginId: string, opts?: { force?: boolean }) =>
    unwrapOk<MarketInstallResult>(
      ipcRenderer.invoke(IpcChannels.ShellInstallMarketPlugin, pluginId, opts)
    ),

  getTheme: () => ipcRenderer.invoke(IpcChannels.ShellGetTheme) as Promise<ShellThemeResult>,

  setTheme: async (mode, overrides, extra) => {
    const current = (await ipcRenderer.invoke(IpcChannels.ShellGetTheme)) as ShellThemeResult
    // renderer 已按 resolved(light|dark) 传入 overrides。
    // system 模式写入 system 键，由主进程 SettingsStore + nativeTheme 落到 light/dark
    //（preload 环境 matchMedia 不可靠，不能在渲染桥内解析）。
    const overrideKey = mode === 'system' ? ('system' as const) : mode
    await ipcRenderer.invoke(IpcChannels.ShellSetTheme, {
      mode,
      overrides: {
        ...(current?.overrides ?? {}),
        [overrideKey]: overrides ?? {}
      },
      // 始终带上 packId/background 键：显式 undefined 可清除（取消主题包/背景）
      ...(extra && 'packId' in extra ? { packId: extra.packId } : {}),
      ...(extra && 'background' in extra ? { background: extra.background } : {}),
      ...(extra && 'backgroundSource' in extra ? { backgroundSource: extra.backgroundSource } : {}),
      ...(extra && 'backgroundEffect' in extra ? { backgroundEffect: extra.backgroundEffect } : {})
    })
  },

  loadDevPlugin: (dirPath: string, options?: DevPluginLoadOptions) =>
    unwrapOk<PluginSummary>(ipcRenderer.invoke(IpcChannels.ShellLoadDevPlugin, dirPath, options)),

  forgetDevPlugin: (pluginId: string) =>
    expectOk(ipcRenderer.invoke(IpcChannels.ShellForgetDevPlugin, pluginId)),

  reloadPlugin: (pluginId: string) =>
    expectOk(ipcRenderer.invoke(IpcChannels.ShellReloadPlugin, pluginId)),

  setDevKillOnHide: (pluginId: string, enabled?: boolean) =>
    unwrapOk<boolean>(ipcRenderer.invoke(IpcChannels.ShellSetDevKillOnHide, pluginId, enabled)),

  setDevPluginMode: (pluginId: string, mode: 'dev' | 'prod') =>
    expectOk(ipcRenderer.invoke(IpcChannels.ShellSetDevPluginMode, pluginId, mode)),

  rebuildDevPlugin: (pluginId: string) =>
    expectOk(ipcRenderer.invoke(IpcChannels.ShellRebuildDevPlugin, pluginId)),

  openDevTools: (pluginId: string) =>
    expectOk(ipcRenderer.invoke(IpcChannels.ShellOpenDevTools, pluginId)),

  getPluginCallTrace: () =>
    ipcRenderer.invoke(IpcChannels.ShellGetPluginTrace) as Promise<PluginCallTraceEntry[]>,

  getSettings: () => ipcRenderer.invoke(IpcChannels.ShellGetSettings),

  setSettings: (settings: Partial<ShellSettingsData>) =>
    ipcRenderer.invoke(IpcChannels.ShellSetSettings, settings),

  getSettingsSections: () =>
    ipcRenderer.invoke(IpcChannels.ShellGetSettingsSections) as Promise<ShellSettingsSection[]>,

  setPluginSetting: async (pluginId: string, key: string, value: unknown) => {
    await expectOk(ipcRenderer.invoke(IpcChannels.ShellSetPluginSetting, pluginId, key, value))
  },

  getPaths: () => ipcRenderer.invoke(IpcChannels.ShellGetPaths) as Promise<AppPaths>,
  openPath: (path) => expectOk(ipcRenderer.invoke(IpcChannels.ShellOpenPath, path)),

  pickFile: (options?: PickFileOptions) =>
    ipcRenderer.invoke(IpcChannels.ShellPickFile, options) as Promise<string | null>,

  getPluginReadme: (pluginId: string) =>
    ipcRenderer.invoke(IpcChannels.ShellGetPluginReadme, pluginId) as Promise<string>,

  getHardwareAcceleration: () =>
    ipcRenderer.invoke(IpcChannels.ShellGetHardwareAccel) as Promise<HardwareAccelState>,

  setHardwareAcceleration: (enabled: boolean) =>
    ipcRenderer.invoke(IpcChannels.ShellSetHardwareAccel, enabled) as Promise<HardwareAccelSetResult>,

  getProxy: () => ipcRenderer.invoke(IpcChannels.ShellGetProxy) as Promise<ProxyConfig>,

  setProxy: (config: ProxyConfig) =>
    ipcRenderer.invoke(IpcChannels.ShellSetProxy, config) as Promise<ProxySetResult>,

  testProxy: (config?: ProxyConfig) =>
    ipcRenderer.invoke(IpcChannels.ShellTestProxy, config) as Promise<ProxyTestResult>,

  saveCustomFont: (payload) =>
    ipcRenderer.invoke(IpcChannels.ShellSaveCustomFont, payload) as Promise<{
      ok: boolean
      path?: string
      fileName?: string
      error?: string
    }>,

  readCustomFont: (fileName: string) =>
    ipcRenderer.invoke(IpcChannels.ShellReadCustomFont, fileName) as Promise<{
      ok: boolean
      dataBase64?: string
      error?: string
    }>,

  deleteCustomFont: (fileName: string) =>
    ipcRenderer.invoke(IpcChannels.ShellDeleteCustomFont, fileName) as Promise<{
      ok: boolean
      error?: string
    }>,

  installPlugin: (sourcePath: string) =>
    unwrapOk<InstallJobInfo>(ipcRenderer.invoke(IpcChannels.ShellInstallPlugin, sourcePath)),

  getInstallQueue: () =>
    ipcRenderer.invoke(IpcChannels.ShellGetInstallQueue) as Promise<{
      active: InstallJobInfo[]
      waiting: InstallJobInfo[]
    }>,

  getPathForFile: (file: File) => {
    try {
      return webUtils.getPathForFile(file)
    } catch {
      return ''
    }
  },

  checkForUpdates: () =>
    ipcRenderer.invoke(IpcChannels.ShellCheckUpdate) as Promise<UpdateStatePayload>,
  downloadUpdate: () =>
    ipcRenderer.invoke(IpcChannels.ShellDownloadUpdate) as Promise<UpdateStatePayload>,
  installUpdate: () =>
    ipcRenderer.invoke(IpcChannels.ShellInstallUpdate) as Promise<UpdateStatePayload>,
  getUpdateState: () =>
    ipcRenderer.invoke(IpcChannels.ShellGetUpdateState) as Promise<UpdateStatePayload>,
  getPluginsDirty: () =>
    ipcRenderer.invoke(IpcChannels.ShellGetPluginsDirty) as Promise<PluginDirtyState>,
  saveAllPlugins: () =>
    ipcRenderer.invoke(IpcChannels.ShellSaveAllPlugins) as Promise<PluginSaveSummary>,
  getAccountState: () => ipcRenderer.invoke(IpcChannels.ShellAccountState),
  loginAccount: (providerId) => ipcRenderer.invoke(IpcChannels.ShellAccountLogin, providerId),
  cancelAccountLogin: (providerId) => ipcRenderer.invoke(IpcChannels.ShellAccountCancel, providerId),
  logoutAccount: (providerId) => ipcRenderer.invoke(IpcChannels.ShellAccountLogout, providerId),
  githubLogin: () =>
    ipcRenderer.invoke(IpcChannels.ShellGithubLogin) as Promise<{
      ok: true
      data: GithubLoginSessionPayload
    } | { ok: false; error: string }>,
  githubCancelLogin: () =>
    ipcRenderer.invoke(IpcChannels.ShellGithubCancelLogin) as Promise<{ ok: boolean }>,
  getGithubProfile: () =>
    ipcRenderer.invoke(IpcChannels.ShellGetProfile) as Promise<GithubProfileState>,
  githubLogout: () =>
    ipcRenderer.invoke(IpcChannels.ShellGithubLogout) as Promise<{ ok: boolean }>,

  systemNotify: async (title: string, body?: string) => {
    await expectOk(ipcRenderer.invoke(IpcChannels.ShellSystemNotify, title, body))
  },

  respondPermissionRequest: async (
    requestId: string,
    decision: 'once' | 'always' | 'deny'
  ) => {
    await expectOk(
      ipcRenderer.invoke(IpcChannels.PermissionResponse, { requestId, decision })
    )
  },

  getPluginPermissionGrants: (pluginId: string) =>
    unwrapOk<Partial<Record<PluginPermission, PluginPermissionGrant>>>(
      ipcRenderer.invoke(IpcChannels.PermissionGrantsGet, pluginId)
    ),

  setPluginPermissionGrant: async (
    pluginId: string,
    permission: PluginPermission,
    grant: PluginPermissionGrant
  ) => {
    await expectOk(
      ipcRenderer.invoke(IpcChannels.PermissionGrantsSet, {
        pluginId,
        permission,
        grant
      })
    )
  },

  openScreenCaptureSettings: async () => {
    await expectOk(ipcRenderer.invoke(IpcChannels.OsOpenScreenSettings))
  },

  onInstallProgress(cb): Unsubscribe {
    const handler = (_e: Electron.IpcRendererEvent, payload: ShellEventPayload) => {
      if (payload.type === 'install-progress') cb(payload)
    }
    ipcRenderer.on(IpcChannels.ShellEvent, handler)
    return () => ipcRenderer.removeListener(IpcChannels.ShellEvent, handler)
  },

  onEvent(cb: (payload: ShellEventPayload) => void): Unsubscribe {
    const handler = (_e: Electron.IpcRendererEvent, payload: ShellEventPayload) => cb(payload)
    ipcRenderer.on(IpcChannels.ShellEvent, handler)
    return () => ipcRenderer.removeListener(IpcChannels.ShellEvent, handler)
  },

  onOrbEvent(cb): Unsubscribe {
    const handler = (
      _e: Electron.IpcRendererEvent,
      payload: { type: 'orb-state'; state: OrbRailState }
    ) => cb(payload)
    ipcRenderer.on(IpcChannels.ShellOrbEvent, handler)
    return () => ipcRenderer.removeListener(IpcChannels.ShellOrbEvent, handler)
  },

  minimizeWindow: () => ipcRenderer.send(IpcChannels.WindowMinimize),
  maximizeWindow: () => ipcRenderer.send(IpcChannels.WindowMaximize),
  closeWindow: () => ipcRenderer.send(IpcChannels.WindowClose),

  quickToggle: () => ipcRenderer.invoke(IpcChannels.QuickToggle).then(() => undefined),
  quickHide: () => {
    ipcRenderer.invoke(IpcChannels.QuickHide).catch(() => undefined)
  },
  quickSearch: (query: string, limit?: number, kind?: QuickCommandKind, phase?: 'static' | 'enriched' | 'providers') =>
    ipcRenderer.invoke(IpcChannels.QuickSearch, { query, limit, kind, phase }) as Promise<QuickSearchResult>,
  quickOpen: (req: QuickOpenRequest) =>
    ipcRenderer.invoke(IpcChannels.QuickOpen, req) as Promise<QuickOpenResult>,
  quickScanApps: (force?: boolean) =>
    ipcRenderer.invoke(IpcChannels.QuickScanApps, { force }) as Promise<ApplicationScanResult>,
  quickGetConfig: () =>
    ipcRenderer.invoke(IpcChannels.QuickGetConfig) as Promise<QuickHotkeyConfig>,
  quickSetHotkeys: (payload: QuickHotkeyPatch) => ipcRenderer.invoke(IpcChannels.QuickSetHotkeys, payload) as Promise<QuickHotkeyApplyResult>,
  quickProbeHotkey: (acc: string) =>
    ipcRenderer.invoke(IpcChannels.QuickProbeHotkey, { acc }) as Promise<
      import('@shared/types/quick').QuickHotkeyProbeResult
    >,

  quickResize: (height: number, animate?: boolean) => {
    ipcRenderer.send(IpcChannels.QuickResize, { height, animate })
  },
  quickInput: (message?: QuickInputMessage) => ipcRenderer.invoke(IpcChannels.QuickInput, message),
  onQuickShown(cb: () => void): Unsubscribe {
    const handler = () => cb()
    ipcRenderer.on(IpcChannels.QuickShown, handler)
    return () => ipcRenderer.removeListener(IpcChannels.QuickShown, handler)
  }
}

contextBridge.exposeInMainWorld('enestShell', api)
exposePluginWindowBridge()
exposeNotificationClient()

// Native drag capture also works while a plugin WebContentsView is in front.
bindNativeInstallDrop()
contextBridge.exposeInMainWorld('enestInstallNative', true)
