import type { AccountLoginSession } from '@shared/types/account'
/**
 * shared/types/ipc — IPC 通道与负载类型定义
 * 职责：定义主进程 / preload / 渲染进程三方共用的通道名常量与请求/响应类型。
 * 被 shellPreload、pluginPreload、主进程各 handler 共同引用。
 * 关键依赖：无（纯类型定义）。
 */
import type {
  AnimationLevel,
  PluginLaunchConfig,
  PluginLaunchMode,
  PluginPermission,
  PluginPermissionGrant,
  ShellView,
  TabStyle,
  UserProfile
} from './plugin'
import type { ResolvedAppearance } from './appearance'
import type { QuickPluginModeInfo } from './quick'
import type { QuickInputState, QuickInputAction } from './plugin-tools'
import type { ShellNotice } from './notice'
import type { PluginShortcutsSnapshot } from './shortcuts'
import type { NotificationOptions } from './notification'
import type { ShellSettingsSection } from './shell'
import type { AuxiliaryEvent } from './auxiliary'
import type { McpErrorCode } from './mcp'

/**
 * IPC 通道常量 — 主进程 / preload / 渲染进程共用。
 * 约定：全部为 request-response（invoke），事件推送走 `shell:event`。
 */
export const IpcChannels = {
  PluginBackgroundHost: 'plugin-background:host',
  PluginBackgroundReady: 'plugin-background:ready',
  PluginBackgroundRequest: 'plugin-background:request',
  PluginBackgroundResponse: 'plugin-background:response',
  AuxiliaryContext: 'auxiliary:context',
  AuxiliaryMessage: 'auxiliary:message',
  AuxiliaryPost: 'auxiliary:post',
  AuxiliaryClose: 'auxiliary:close',
  PluginWindowState: 'window:plugin-state',
  PluginWindowCommand: 'window:plugin-command',
  PluginWindowEvent: 'window:plugin-event',
  PluginDragBegin: 'window:plugin-drag-begin',
  PluginDragArm: 'window:plugin-drag-arm',
  PluginDragUpdate: 'window:plugin-drag-update',
  PluginDragEnd: 'window:plugin-drag-end',
  PluginDragTargets: 'window:plugin-drag-targets',
  PluginDragEvent: 'window:plugin-drag-event',
  /** 壳子 → 主进程 */
  ShellGetPlugins: 'shell:get-plugins',
  ShellGetMarketStatus: 'shell:get-market-status',
  ShellMcpStatus: 'shell:mcp-status',
  ShellMcpConfigure: 'shell:mcp-configure',
  ShellMcpCopyConnection: 'shell:mcp-copy-connection',
  ShellMcpRotateToken: 'shell:mcp-rotate-token',
  ShellMcpCatalog: 'shell:mcp-catalog',
  ShellOpenPlugin: 'shell:open-plugin',
  ShellClosePlugin: 'shell:close-plugin',
  ShellStopPluginResources: 'shell:stop-plugin-resources',
  ShellActivatePlugin: 'shell:activate-plugin',
  /** 隐藏全部插件 WebContentsView（回首页/设置时调用，避免遮挡壳子 UI） */
  ShellHidePlugins: 'shell:hide-plugins',
  /** 设置插件内容区左侧 inset（orb 传统通道模式；overlay 模式恒为 0） */
  ShellSetPluginInset: 'shell:set-plugin-inset',
  /** 主壳标题栏让出的高度；原生子视图始终保留顶部唤出区。 */
  ShellSetPluginTopInset: 'shell:set-plugin-top-inset',
  /** 壳子 → 主进程：同步圆轨悬浮窗所需 Tab 状态 */
  ShellGetPluginDiagnostics: 'shell:get-plugin-diagnostics',
  ShellGetPluginMemorySnapshot: 'shell:get-plugin-memory-snapshot',
  ShellStartPerformanceCapture: 'shell:start-performance-capture',
  ShellGetPerformanceCaptureState: 'shell:get-performance-capture-state',
  ShellStopPerformanceCapture: 'shell:stop-performance-capture',
  ShellExportPerformanceCapture: 'shell:export-performance-capture',
  ThemeChromeSnapshot: 'theme-chrome:snapshot',
  ThemeChromeChanged: 'theme-chrome:changed',
  ThemeChromeAction: 'theme-chrome:action',
  ThemeChromeReady: 'theme-chrome:ready',
  ThemeSettingsConfig: 'theme-settings:config',
  ThemeSettingsSnapshot: 'theme-settings:snapshot',
  ThemeSettingsActive: 'theme-settings:active',
  ThemeSettingsAction: 'theme-settings:action',
  ShellRestoreTabs: 'shell:restore-tabs',
  ShellSyncOrbState: 'shell:sync-orb-state',
  /** 悬浮窗 → 主进程：读取圆轨状态 */
  ShellGetOrbState: 'shell:get-orb-state',
  /** 主进程 → 悬浮窗：Tab 状态变更推送 */
  ShellOrbEvent: 'shell:orb-event',
  /** 悬浮窗/壳子：回首页 */
  ShellGoHome: 'shell:go-home',
  /** 悬浮窗/壳子：切换主壳视图 */
  ShellSetView: 'shell:set-view',
  /** 圆轨 rail 视图展开/收起：主进程切换 WebContentsView 宽度 */
  ShellSetOrbRailExpanded: 'shell:set-orb-rail-expanded',
  ShellGetTheme: 'shell:get-theme',
  ShellSetTheme: 'shell:set-theme',
  ShellGetAppearance: 'shell:get-appearance',
  ShellUpdateThemeProfile: 'shell:update-theme-profile',
  ShellActivateTheme: 'shell:activate-theme',
  ShellSetAppearanceMode: 'shell:set-appearance-mode',
  ShellSetHomeVisible: 'shell:set-home-visible',
  ShellNavigateWorkspace: 'shell:navigate-workspace',
  ShellRetryHome: 'shell:retry-home',
  ShellGetHomeState: 'shell:get-home-state',
  ShellPickAppearanceMedia: 'shell:pick-appearance-media',
  ShellImportAppearanceFont: 'shell:import-appearance-font',
  ShellRemoveAppearanceFont: 'shell:remove-appearance-font',
  ShellSetAppearancePerformanceLimited: 'shell:set-appearance-performance-limited',
  ModalOpen: 'modal:open',
  ModalReady: 'modal:ready',
  ModalState: 'modal:state',
  ModalRespond: 'modal:respond',
  ShellLoadDevPlugin: 'shell:load-dev-plugin',
  ShellForgetDevPlugin: 'shell:forget-dev-plugin',
  /** 开发者控制台：切换 dev 插件「退出到后台立即结束运行」（对齐 uTools） */
  ShellSetDevKillOnHide: 'shell:set-dev-kill-on-hide',
  /** 开发者控制台：切换 dev 插件 dev（HMR/源码）/ prod（构建产物正式形态）模式 */
  ShellSetDevPluginMode: 'shell:set-dev-plugin-mode',
  /** 开发者控制台：prod 模式手动重建（执行解析出的构建命令并重载） */
  ShellRebuildDevPlugin: 'shell:rebuild-dev-plugin',
  ShellReloadPlugin: 'shell:reload-plugin',
  ShellOpenDevTools: 'shell:open-devtools',
  ShellGetSettings: 'shell:get-settings',
  ShellOpenExternal: 'shell:open-external',
  ShellSetSettings: 'shell:set-settings',
  /** 壳子设置页：拉取插件已注册的设置 section 列表 */
  ShellGetSettingsSections: 'shell:get-settings-sections',
  /** 壳子设置页：写入单个插件设置项（同步 Bridge + SettingsStore） */
  ShellSetPluginSetting: 'shell:set-plugin-setting',

  /** 「打开方式」：列表（贡献+路由+系统状态）/ 设默认 / 移除 / 只写路由 / 打开系统设置 */
  ShellOpenWithList: 'shell:open-with-list',
  ShellOpenWithSetDefault: 'shell:open-with-set-default',
  ShellOpenWithClearDefault: 'shell:open-with-clear-default',
  ShellOpenWithRoute: 'shell:open-with-route',
  ShellOpenWithOpenSystemSettings: 'shell:open-with-open-system-settings',

  /** 路径与数据 */
  ShellGetPaths: 'shell:get-paths',
  ShellOpenPath: 'shell:open-path',
  ShellPickFile: 'shell:pick-file',
  ShellGetPluginReadme: 'shell:get-plugin-readme',

  /** 硬件加速（写入设置后需重启） */
  ShellGetHardwareAccel: 'shell:get-hardware-accel',
  ShellSetHardwareAccel: 'shell:set-hardware-accel',

  /** 网络代理：读/写（写即 session.setProxy）/ 连通性测试 */
  ShellGetProxy: 'shell:get-proxy',
  ShellSetProxy: 'shell:set-proxy',
  ShellTestProxy: 'shell:test-proxy',

  /** 自定义字体：复制到 ~/.eNest/fonts/、读 base64、删除 */
  ShellSaveCustomFont: 'shell:save-custom-font',
  ShellReadCustomFont: 'shell:read-custom-font',
  ShellDeleteCustomFont: 'shell:delete-custom-font',

  /** 插件拖拽/路径安装：入队后由主进程 installQueue 限流执行 */
  InstallDropState: 'install:drop-state',
  InstallDropFiles: 'install:drop-files',
  InstallSurfaceReady: 'install:surface-ready',
  InstallSurfaceState: 'install:surface-state',
  InstallSurfaceDismiss: 'install:surface-dismiss',
  ShellInstallPlugin: 'shell:install-plugin',
  ShellGetInstallQueue: 'shell:get-install-queue',

  /** 卸载插件：关闭 Tab → 清 partition storage → 删文件 → 重扫注册表 */
  ShellUninstallPlugin: 'shell:uninstall-plugin',

  /** 启用/禁用已安装插件（持久化到 plugins/disabled.json） */
  ShellSetPluginEnabled: 'shell:set-plugin-enabled',

  /** 每插件 Quick 搜索偏好：启动方式 / 自定义触发词 */
  ShellSetPluginLaunch: 'shell:set-plugin-launch',
  ShellGetPluginShortcuts: 'shell:get-plugin-shortcuts',
  ShellSavePluginShortcut: 'shell:save-plugin-shortcut',
  ShellRemovePluginShortcut: 'shell:remove-plugin-shortcut',
  ShellProbePluginShortcut: 'shell:probe-plugin-shortcut',
  ShellLaunchPluginShortcut: 'shell:launch-plugin-shortcut',
  ShellBeginShortcutCapture: 'shell:begin-shortcut-capture',
  ShellEndShortcutCapture: 'shell:end-shortcut-capture',

  /** 从市场安装/更新插件：本地 sample 优先，否则远程 assetUrl 下载入队 */
  ShellInstallMarketPlugin: 'shell:install-market-plugin',

  /** 应用自动更新（GitHub Release + electron-updater） */
  ShellCheckUpdate: 'shell:check-update',
  ShellDownloadUpdate: 'shell:download-update',
  ShellInstallUpdate: 'shell:install-update',
  ShellGetUpdateState: 'shell:get-update-state',

  /** 更新重启前：查询插件未保存数据 / 广播一键保存（save.requested 通知） */
  ShellGetPluginsDirty: 'shell:get-plugins-dirty',
  ShellSaveAllPlugins: 'shell:save-all-plugins',

  /** GitHub 个人资料（浏览器授权码流 PKCE / 设备流兜底：登录 / 取消 / 读取 / 退出） */
  ShellAccountState: 'shell:account-state',
  ShellAccountLogin: 'shell:account-login',
  ShellAccountCancel: 'shell:account-cancel',
  ShellAccountLogout: 'shell:account-logout',
  ShellGithubLogin: 'shell:github-login',
  ShellGithubCancelLogin: 'shell:github-cancel-login',
  ShellGetProfile: 'shell:get-profile',
  ShellGithubLogout: 'shell:github-logout',

  /** 系统级通知（Electron Notification） */
  ShellSystemNotify: 'shell:system-notify',
  NotificationShow: 'notification:show',
  NotificationDismiss: 'notification:dismiss',
  NotificationState: 'notification:state',
  NotificationMeasure: 'notification:measure',
  NotificationOpenLink: 'notification:open-link',

  /** 快捷启动（Quick 小窗） */
  QuickToggle: 'quick:toggle',
  QuickHide: 'quick:hide',
  QuickSearch: 'quick:search',
  QuickOpen: 'quick:open',
  QuickScanApps: 'quick:scan-apps',
  QuickGetConfig: 'quick:get-config',
  QuickThemeGetConfig: 'quick:theme-get-config',
  QuickThemeAuthorize: 'quick:theme-authorize',
  QuickProviderState: 'quick:provider-state',
  QuickThemeKey: 'quick:theme-key',
  QuickSetHotkeys: 'quick:set-hotkeys',
  /** 探测组合键是否可被本进程注册（用于录制时发现系统/他应用占用） */
  QuickProbeHotkey: 'quick:probe-hotkey',
  /** 渲染层测量内容高度后请求调整小窗高度（内容撑开/收起） */
  QuickResize: 'quick:resize',
  QuickInput: 'quick:plugin-input',
  /** 读取剪贴板图片/文件并入宿主保管的粘贴上下文，或按 id 移除/清空上下文 */
  QuickInputContext: 'quick:input-context',

  /** Restricted full-page home runtime. The host owns entry, generation and lifecycle. */
  HomeReady: 'home:ready',
  HomeAck: 'home:ack',
  HomeGetCatalog: 'home:get-catalog',
  HomeGetDetail: 'home:get-detail',
  HomeSearch: 'home:search',
  HomeRefresh: 'home:refresh',
  HomeAction: 'home:action',
  HomeGetAppearance: 'home:get-appearance',
  HomeGetConfig: 'home:get-config',
  HomeEvent: 'home:event',  PluginHomeRegister: 'plugin:home-register',

  WindowMinimize: 'window:minimize',
  WindowMaximize: 'window:maximize',
  WindowClose: 'window:close',

  /** 插件 preload → 主进程（经 permission 校验） */
  PluginCall: 'plugin:call',
  PluginEvent: 'plugin:event',
  PluginMcpRegister: 'plugin:mcp-register',
  PluginMcpResult: 'plugin:mcp-result',
  PluginMcpDispatch: 'plugin:mcp-dispatch',
  PluginMcpCancel: 'plugin:mcp-cancel',

  /** 壳子 → 主进程：读取 plugin:call 调用跟踪环形缓冲（DevConsole） */
  ShellGetPluginTrace: 'shell:get-plugin-trace',

  /** 主进程 → 插件 webContents 生命周期推送（enter/out/beforeClose/destroy） */
  PluginLifecycle: 'plugin:lifecycle',
  /** 插件 preload → 主进程：beforeClose 确认（可选，超时 1500ms 兜底） */
  PluginLifecycleAck: 'plugin:lifecycle-ack',

  /** 主进程 → 壳子渲染进程推送 */
  ShellEvent: 'shell:event',

  /** —— 运行时权限（壳层三态）—— */

  /** 废弃 renderer 授权响应通道；主进程拒绝，敏感授权仅由原生对话框决定。 */
  PermissionResponse: 'shell:permission-response',
  /** 壳渲染层 → 主进程：读插件权限授权表（缺省 ask） */
  PermissionGrantsGet: 'shell:permission-grants-get',
  /** 壳渲染层 → 主进程：写单项权限授权（设置页三态分段） */
  PermissionGrantsSet: 'shell:permission-grants-set',
  /**
   * 壳渲染层 → 主进程：打开 macOS「屏幕录制」系统隐私设置面板。
   * 只读安全的内部通道：仅跳转系统设置，不暴露任何插件数据；
   * 插件不可调用（handler 限定壳窗口 sender）。
   */
  OsOpenScreenSettings: 'shell:os-open-screen-settings',

  /** 主进程 → Quick 渲染层：窗口已显示，请求聚焦输入框 */
  QuickShown: 'quick:shown',

  /** —— 自由面板（小组件）：面板 chrome surface ↔ 主进程 —— */
  /** 面板 chrome → 主进程：读取面板状态快照 */
  PanelGetState: 'panel:get-state',
  /** 面板 chrome → 主进程：统一命令入口（添加/移除组件、拖动、关闭面板等） */
  PanelCommand: 'panel:command',
  /** 面板 chrome → 主进程：拖动进行中的保活与节流触发（主进程自行读光标） */
  PanelDragTick: 'panel:drag-tick',
  /** 主进程 → 面板 chrome：状态快照变更 */
  PanelState: 'panel:state',
  /** 主进程 → 面板 chrome：拖动反馈（吸附后的矩形与辅助线） */
  PanelDrag: 'panel:drag',
  /** 壳渲染层 → 主进程：框选区域并创建面板 */
  PanelPickRegion: 'panel:pick-region',
  /** 壳渲染层 → 主进程：列出活动面板（设置页/入口展示） */
  PanelList: 'panel:list',
  /** 壳渲染层 → 主进程：新建面板（先框选） */
  PanelCreate: 'panel:create',
  /** 壳渲染层 → 主进程：关闭指定面板 */
  PanelClose: 'panel:close',
  /** 壳渲染层 → 主进程：保存面板呼出快捷键并立即重注册（返回注册结果，镜像 quick:set-hotkeys） */
  PanelSetHotkey: 'panel:set-hotkey',

  /** 区域选择 surface ↔ 主进程 */
  RegionConfirm: 'panel-region:confirm',
  RegionCancel: 'panel-region:cancel',
  RegionState: 'panel-region:state'
} as const

export type IpcChannel = (typeof IpcChannels)[keyof typeof IpcChannels]

/** 壳子 Toast 类型：info 默认样式，success/warn/error 带强调色 */
export type ToastKind = 'info' | 'success' | 'warn' | 'error'

/** shell:event 负载类型 */
export type ShellEventPayload =
  | { type: 'titlebar-native-hover'; inside: boolean }
  | { type: 'theme-chrome-status'; surface: 'classic'; ready: boolean }
  | { type: 'preview-splash' }
  | { type: 'home-status'; state: import('./homeSurface').HomeSurfaceState }
  | { type: 'quick-input'; state: QuickInputState | null }
  | { type: 'plugin-open-settings'; pluginId: string }
  | { type: 'plugins-changed' }
  | { type: 'plugin-ready'; pluginId: string; generation: number }
  | { type: 'plugin-log'; pluginId: string; level: 'info' | 'warn'; message: string }
  | { type: 'plugin-tabs'; revision: number; tabs: Array<{id: string; title: string; icon?: string | null; glyph?: string; color?: string; badge?: string; status: 'loading' | 'ready' | 'error' | 'hibernated'}>; activeTabId: string | null }
  | { type: 'tab-closed'; tabId: string }
  | { type: 'plugin-error'; pluginId: string; message: string }
  | { type: 'settings-sections'; sections: ShellSettingsSection[] }
  | { type: 'theme-changed'; mode: 'light' | 'dark' | 'system' }
  /** 独立窗口按变更键重读设置，不携带插件私有设置或重复触发持久化。 */
  | { type: 'settings-changed'; generalKeys: string[] }
  | { type: 'plugin-settings-changed'; pluginId: string }
  | { type: 'locale-changed'; locale: 'zh-CN' | 'en-US' }
  | { type: 'theme-packs-changed' }
  | { type: 'appearance-changed'; revision: number; appearance: ResolvedAppearance }
  | { type: 'plugin-active'; tabId: string | null }
  | { type: 'plugin-title'; tabId: string; title: string }
  | { type: 'plugin-icon'; tabId: string; icon: string }
  | { type: 'plugin-badge'; tabId: string; badge: string | number }
  /** 插件请求壳子 Toast（由 useShellEvents → toastStore 渲染） */
  | { type: 'plugin-toast'; pluginId: string; message?: string; toastType?: ToastKind; notification?: NotificationOptions }
  | { type: 'install-progress'; jobId: string; name: string; progress: number; step?: string }
  | { type: 'install-queue'; active: InstallJobInfo[]; waiting: InstallJobInfo[] }
  | { type: 'install-result'; jobId: string; name: string; ok: boolean; error?: string }
  /** 卸载结果：与 install-result 同级，壳子据此 toast + 刷新列表 */
  | { type: 'uninstall-result'; pluginId: string; name: string; ok: boolean; error?: string }
  /** 自动更新状态变更（检查 / 下载进度 / 就绪 / 错误） */
  | { type: 'update-status'; state: UpdateStatePayload }
  /** GitHub 个人资料变化（登录成功 / 启动刷新 / 退出）；轨道头像与设置页即时更新 */
  | { type: 'profile-changed'; profile: UserProfile | null }
  /** Provider-neutral account progress; retained GitHub event below supports older clients. */
  | { type: 'account-login-status'; providerId: string; phase: 'pending' | 'authorized' | 'error' | 'cancelled'; message?: string }
  /** 兼容 GitHub 登录进度 */
  | { type: 'github-login-status'; phase: 'pending' | 'authorized' | 'error' | 'cancelled'; message?: string }
  /** 悬浮窗请求主壳回首页 */
  | { type: 'go-home' }
  /** 悬浮窗请求主壳切换视图。工作区路由由宿主 HomeSurfaceManager 自行投影，不随事件下发。 */
  | { type: 'set-view'; view: 'home' | 'settings' | 'plugin'; sectionId?: string }
  /** 快捷键注册失败（至少部分占用） */
  | { type: 'quick-hotkey-failed'; failed: string[]; registered: string[] }
  | { type: 'quick-hotkey-used'; acc: string }
  /** 快捷启动配置变更 */
  | { type: 'quick-config-changed'; enabled: boolean; hotkeys: string[]; activeHotkey?: string }
  /** 某插件的快捷启动配置变更（启动方式/热键/触发词）；渲染层据此刷新命令面与详情 */
  | { type: 'plugin-launch-changed'; pluginId: string; config: PluginLaunchConfig | null }
  | { type: 'plugin-shortcuts-changed'; snapshot: PluginShortcutsSnapshot }
  /** 命令面要求壳子切换视图 */
  | { type: 'quick-open-view'; view: 'home' | 'settings' }
  /**
   * Quick 小窗插件态切换（主进程 → Quick 渲染层，经通用 shell:event 下发）：
   * 挂载 mini 插件 = { pluginId, title }；Esc 固定/收起回列表态 = null。
   * 注意：该事件对主壳渲染层无意义（payload 事件桥过滤），仅 Quick 表面消费。
   */
  | { type: 'quick-plugin-mode'; mode: QuickPluginModeInfo | null }
  | { type: 'quick-focus-search' }
  /**
   * 插件贡献点变更（注册/卸载/覆盖）：渲染层据此刷新对应插槽消费
   * （home-cards 区块、rail-entries、settings sections 等）。
   */
  | { type: 'contributions-changed'; slot: string; source: string }
  /** 原生授权对话框或设置页更新敏感权限后，同步设置 UI。基础能力不进入此表。 */
  | { type: 'permission-grants-changed'; pluginId: string; grants: Partial<Record<PluginPermission, PluginPermissionGrant>> }
  /** 自由面板集合变化（创建/关闭/组件增删）；壳子据此刷新入口与设置页状态。 */
  | { type: 'panels-changed' }
  /** 外部打开无人接手或启动失败：渲染层提示用户（toast） */
  | { type: 'open-with-unhandled'; kind: 'ext' | 'scheme'; value: string; reason: 'no-provider' | 'launch-failed' }
  /**
   * 废弃的 renderer 权限请求载荷，仅保留类型兼容。
   * 宿主不再发出此事件，renderer 不能据此授予权限；原生对话框是唯一授权入口。
   */
  | {
      type: 'permission-request'
      requestId: string
      pluginId: string
      permission: PluginPermission
      summary: string
      osHint?: 'system-pending' | 'denied'
    }

/** orb 状态快照（main → overlay）；主题、动画及账号由宿主补全。 */
export interface OrbRailState {
  view: ShellView
  tabStyle: TabStyle
  activeTabId: string | null
  /** 动画档位：overlay 独立文档不读主壳 DOM，档位随状态下发 */
  animationLevel: AnimationLevel
  /** 已解析主题（含 tokens）：圆轨/设置钮配色跟随设置页主题 */
  theme: {
    mode: 'light' | 'dark'
    tokens: Record<string, string>
    appearance?: ResolvedAppearance
  }
  /** 已连接账号（dock 设置钮默认显示头像）；未登录为 null */
  profile: {
    name: string | null
    /** data URL（主进程预取缓存），渲染端不发起远程请求 */
    avatar: string | null
  } | null
  tabs: Array<{
    id: string
    pluginId: string
    title: string
    color: string
    glyph: string
    icon?: string | null
    badge?: string
    lazy?: boolean
    crashed?: boolean
  }>
  /**
   * rail-entries 插槽贡献（插件贡献点，声明式）：orb 模式左侧轨道底部入口。
   * 点击经 shellApi.openPlugin(pluginId, { code: openCode }) 打开来源插件。
   * 由主进程从贡献表读取，orb-overlay 负责渲染。
   */
  contribEntries?: Array<{
    id: string
    pluginId: string
    glyph: string
    color: string
    title: string
    openCode?: string
  }>
}

/** Renderer-owned projection; appearance and account data remain host-owned. */
export type OrbRailProjection = Pick<OrbRailState, 'view' | 'tabStyle' | 'activeTabId' | 'tabs'>

export type OrbRailSyncRequest = OrbRailProjection & {
  /** Startup and previews may hide native chrome without changing the theme. */
  chromeVisible?: boolean
}

/** shell:orb-event 负载：主进程 → 悬浮窗 */
export type OrbEventPayload = { type: 'orb-state'; state: OrbRailState }

/** shell:test-proxy 负载 */
export interface ProxyTestResult {
  ok: boolean
  latencyMs?: number
  error?: string
}

/** 插件未保存数据快照（shell:get-plugins-dirty 响应） */
export interface PluginDirtyState {
  items: Array<{
    pluginId: string
    /** 展示名（Tab 标题兜底 manifest 名） */
    name: string
    /** 插件经 enest.setDirty 上报的脏标记 */
    dirty: boolean
  }>
}

/** 一键保存结果（shell:save-all-plugins 响应） */
export interface PluginSaveSummary {
  /** 参与保存的运行中插件数 */
  total: number
  /** ack 成功（含无监听器直通）的插件数 */
  acked: number
  /** 超时 / 失败未确认的插件数 */
  timedOut: number
  /** 请求前上报为脏的插件数 */
  dirtyBefore: number
}

/** shell:github-login 响应：mode=web（回环授权码流，免输码）或 mode=device（设备流） */
export type GithubLoginSessionPayload = AccountLoginSession

/** shell:get-profile 响应 */
export interface GithubProfileState {
  user: UserProfile | null
  /** 已保存加密 token（启动刷新用） */
  hasToken: boolean
  /** 授权回调 / 设备流轮询等待中 */
  polling: boolean
}

/** 更新状态推送到渲染层的负载 */
export interface UpdateStatePayload {
  status: 'idle' | 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error'
  currentVersion: string
  latestVersion?: string
  releaseName?: string
  releaseNotes?: string
  progress?: number
  downloaded?: boolean
  error?: string
  packaged?: boolean
}

/** 主进程 → 插件 WebContents（IpcChannels.PluginEvent）负载 */
export type PluginEventPayload =
  | AuxiliaryEvent
  | { type: 'deadline-task-change'; taskId: string }
  | { type: 'backend.event'; event: string; data: unknown }
  | { type: 'background.event'; event: string; data: unknown }
  | { type: 'quick-input-change'; value: string }
  | { type: 'quick-input-action'; action: QuickInputAction }
  | { type: 'settings-change'; key: string; value: unknown }
  | {
      type: 'theme-change'
      mode: 'light' | 'dark'
      tokens: Record<string, string>
    }
  | { type: 'appearance-change'; appearance: ResolvedAppearance }
  | {
      type: 'hotkey'
      accelerator: string
    }
  | {
      type: 'locale-change'
      locale: 'zh-CN' | 'en-US'
    }
  | {
      type: 'mode-change'
      mode: PluginLaunchMode
    }
  | {
      type: 'quick-query'
      reqId: string
      query: string
    }
  | { type: 'net.data'; socketId: string; chunk: string }
  | { type: 'net.close'; socketId: string; reason: string }
  | { type: 'net.websocket.message'; socketId: string; data: string; binary: boolean }
  | { type: 'net.websocket.close'; socketId: string; code: number; reason: string }
  | { type: 'net.chunk'; reqId: string; chunk: string; done?: boolean; error?: string }
  | { type: 'shell-notice'; notice: ShellNotice }


/** 安装队列任务对外视图（active / waiting 列表项） */
export interface InstallJobInfo {
  step?: string
  id: string
  name: string
  progress: number
  status: 'queued' | 'active' | 'done' | 'failed'
}

/** 插件 API 调用：preload 将 zapi 调用收敛到 plugin:call */
export interface PluginCallRequest {
  pluginId: string
  method: string
  args: unknown[]
}

export interface PluginCallResult {
  ok: boolean
  data?: unknown
  error?: string
  errorCode?: McpErrorCode
}

/**
 * plugin:call 调用跟踪条目（主进程环形缓冲最近 200 条，
 * DevConsole「调用跟踪」面板经 shell:get-plugin-trace 读取）。
 */
export interface PluginCallTraceEntry {
  /** 调用时刻（epoch ms） */
  ts: number
  pluginId: string
  method: string
  ok: boolean
  durationMs: number
  error?: string
}

/** shell:permission-response 载荷：弹窗三按钮决策 */
export interface PermissionResponsePayload {
  requestId: string
  decision: 'once' | 'always' | 'deny'
}

/** shell:permission-grants-set 载荷：单项三态授权写入 */
export interface PermissionGrantSetPayload {
  pluginId: string
  permission: PluginPermission
  grant: PluginPermissionGrant
}
