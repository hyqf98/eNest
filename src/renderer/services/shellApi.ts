/** Native transport never initializes preview data or silently falls back to mock methods. */
import type { PluginShortcutInput, PluginShortcutsSnapshot, PluginShortcutMutationResult, PluginShortcutLaunchResult, ShortcutProbeResult } from '@shared/types/shortcuts'
import type { AccountState, AccountLoginResult } from '@shared/types/account'
import type { AppPaths, DevPluginLoadOptions, MarketInstallResult, PluginMarketStatus, PluginLaunchPatch, PluginPermission, PluginPermissionGrant, PluginSummary, ProxyConfig, ThemeMode, ThemeTokens } from '@shared/types/plugin'
import type { HardwareAccelSetResult, HardwareAccelState, PickFileOptions, PluginLaunchSetResult, ProxySetResult, ShellSettingsSection, ShellThemeResult } from '@shared/types/shell'
import type { ShellSettingsData } from '@shared/types/shellSettings'
import type { AppearanceSnapshot, ThemeProfilePatch } from '@shared/types/appearance'
import type { ThemeSettingsConfig, ThemeSettingsSnapshot, ThemeSettingsAction, ThemeSettingsActionResult } from '@shared/types/themeSettings'
import type { WorkspaceRoute } from '@shared/types/workspace'
import type { PluginMemorySnapshot } from '@shared/types/pluginMemory'
import type { PerformanceCaptureState, PerformanceCaptureExportResult } from '@shared/types/performanceCapture'
import type { ShellEventPayload, OrbEventPayload, OrbRailState, OrbRailSyncRequest, InstallJobInfo, PluginCallTraceEntry, ProxyTestResult, UpdateStatePayload, PluginDirtyState, PluginSaveSummary, GithubLoginSessionPayload, GithubProfileState } from '@shared/types/ipc'
import type { ApplicationScanResult, QuickCommand, QuickCommandKind, QuickHotkeyApplyResult, QuickHotkeyConfig, QuickHotkeyPatch, QuickOpenRequest } from '@shared/types/quick'
import { createLazyPreviewShellApi, createNativeShellApi } from './shellApiAdapters'

/** preload 注入到渲染进程的完整 shell 能力面 */
export interface ShellApi {
  getPlugins(): Promise<PluginSummary[]>
  getMarketStatus(refresh?: boolean): Promise<PluginMarketStatus>
  /** 只读性能采样，浏览器 mock 不提供原生进程数据。 */
  getPluginDiagnostics(): Promise<unknown>
  getPluginMemorySnapshot(force?: boolean): Promise<PluginMemorySnapshot>
  startPerformanceCapture(): Promise<PerformanceCaptureState>
  getPerformanceCaptureState(): Promise<PerformanceCaptureState>
  stopPerformanceCapture(): Promise<PerformanceCaptureState>
  exportPerformanceCapture(): Promise<PerformanceCaptureExportResult>
  restoreTabs(ids: string[]): Promise<void>
  /** enter.code 透传给插件 onEnter（首页卡片/轨道入口等贡献点打开场景） */
  openPlugin(id: string, enter?: { code?: string; payload?: unknown }): Promise<void>
  closePlugin(tabId: string): Promise<void>
  stopPluginResources(pluginId: string): Promise<void>
  activatePlugin(tabId: string): Promise<void>
  /** 隐藏全部插件原生视图（回首页/设置/开发者时，避免遮挡壳子） */
  hidePlugins(): Promise<void>
  /** 设置插件内容区左侧 inset（px）；orb 悬浮窗模式恒为 0 */
  setPluginInset?(left: number): Promise<void>
  setPluginTopInset?(top: number): Promise<void>
  /** 回首页（隐藏插件 + 主壳 setView home） */
  goHome?(): Promise<void>
  /** 主壳切换视图 */
  setShellView?(view: string): Promise<void>
  /** 圆轨 rail 视图展开/收起：主进程切换 WebContentsView 宽度 */
  setOrbRailExpanded?(expanded: boolean): Promise<void>
  syncOrbState?(state: OrbRailSyncRequest): Promise<void>
  getOrbState?(): Promise<OrbRailState>
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
  getAppearance(): Promise<AppearanceSnapshot>
  updateThemeProfile(patch: ThemeProfilePatch): Promise<AppearanceSnapshot>
  activateTheme(identity: { source: string; id: string }): Promise<AppearanceSnapshot>
  setAppearanceMode(mode: ThemeMode): Promise<AppearanceSnapshot>
  setHomeVisible?(visible: boolean): Promise<void>
  navigateWorkspace?(route: WorkspaceRoute): Promise<void>
  retryHome?(): Promise<void>
  getHomeState?(): Promise<import('@shared/types/homeSurface').HomeSurfaceState>
  pickAppearanceMedia?(options?: { imageOnly?: boolean }): Promise<import('@shared/types/plugin').BackgroundConfig | null>
  importAppearanceFont?(): Promise<import('@shared/types/plugin').CustomFontMeta | null>
  removeAppearanceFont?(id: string): Promise<void>
  openNativeModal?(request: import('@shared/types/modal').NativeModalRequest): Promise<boolean>
  setAppearancePerformanceLimited?(limited: boolean): Promise<AppearanceSnapshot>
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
  getThemeSettingsConfig(): Promise<ThemeSettingsConfig | null>
  getThemeSettingsSnapshot(key: string): Promise<ThemeSettingsSnapshot>
  setThemeSettingsActive(input: { key?: string; active: boolean; bounds?: { x: number; y: number; width: number; height: number } }): Promise<boolean>
  dispatchThemeSettingsAction(key: string, action: ThemeSettingsAction): Promise<ThemeSettingsActionResult>
  getSettings(): Promise<ShellSettingsData>
  setSettings(settings: Partial<ShellSettingsData>): Promise<void>
  /** 拉取插件已注册的设置 section 列表（Electron）；mock 返回空数组 */
  getSettingsSections?(): Promise<ShellSettingsSection[]>
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
  onOrbEvent?(cb: (payload: OrbEventPayload) => void): () => void
  minimizeWindow?(): void
  maximizeWindow?(): void
  closeWindow?(): void
  /** 在系统中打开路径；不可用时 UI 回退为复制剪贴板 */
  openPath?(path: string): Promise<void>
  /** Trusted document links only; the native host revalidates the sender and URL protocol. */
  openExternal(url: string): Promise<void>

  // —— 快捷启动 Quick（Electron preload 提供；mock 可省略）——
  quickToggle?(): Promise<void>
  quickHide?(): void
  quickSearch?(query: string, limit?: number, kind?: QuickCommandKind, phase?: import('@shared/types/quick').QuickSearchPhase, ids?: string[]): Promise<{ items: QuickCommand[]; total?: number }>
  quickOpen?(req: QuickOpenRequest): Promise<{ ok: boolean; error?: string }>
  quickScanApps?(force?: boolean): Promise<ApplicationScanResult>
  quickGetConfig?(): Promise<QuickHotkeyConfig>
  quickGetTheme?(): Promise<import('@shared/types/quickTheme').QuickThemeConfig | null>
  quickAuthorizeTheme?(key: string): Promise<boolean>
  onQuickThemeKey?(cb: (key: { key: string; meta?: boolean; ctrl?: boolean; alt?: boolean; shift?: boolean }) => void): () => void
  quickSetHotkeys?(payload: QuickHotkeyPatch): Promise<QuickHotkeyApplyResult>
  quickProbeHotkey?(acc: string): Promise<import('@shared/types/quick').QuickHotkeyProbeResult>
  quickResize?(height: number, animate?: boolean): void
  quickInput?(message?: import('@shared/types/plugin-tools').QuickInputMessage): Promise<import('@shared/types/plugin-tools').QuickInputState | boolean | null>
  onQuickShown?(cb: () => void): () => void
}


const rawShell = window.enestShell
/** Preview data is development-only; a release missing its preload must fail closed. */
export const shellApi: ShellApi = rawShell ? createNativeShellApi(rawShell)
  : import.meta.env.DEV
    ? createLazyPreviewShellApi(async () => (await import('./mockShellApi')).createMockApi())
    : createNativeShellApi({} as ShellApi)

export const isMockShell = import.meta.env.DEV && !rawShell
export type { ShellSettingsData } from '@shared/types/shellSettings'
