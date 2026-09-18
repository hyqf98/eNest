/**
 * shared/types/ipc — IPC 通道与负载类型定义
 * 职责：定义主进程 / preload / 渲染进程三方共用的通道名常量与请求/响应类型。
 * 被 shellPreload、pluginPreload、主进程各 handler 共同引用。
 * 关键依赖：无（纯类型定义）。
 */
import type { AnimationLevel } from './plugin'
import type { QuickPluginModeInfo } from './quick'
import type { SshPluginEvent } from './ssh-db'

/**
 * IPC 通道常量 — 主进程 / preload / 渲染进程共用。
 * 约定：全部为 request-response（invoke），事件推送走 `shell:event`。
 */
export const IpcChannels = {
  /** 壳子 → 主进程 */
  ShellGetPlugins: 'shell:get-plugins',
  ShellOpenPlugin: 'shell:open-plugin',
  ShellClosePlugin: 'shell:close-plugin',
  ShellActivatePlugin: 'shell:activate-plugin',
  /** 隐藏全部插件 WebContentsView（回首页/设置时调用，避免遮挡壳子 UI） */
  ShellHidePlugins: 'shell:hide-plugins',
  /** 设置插件内容区左侧 inset（orb 传统通道模式；overlay 模式恒为 0） */
  ShellSetPluginInset: 'shell:set-plugin-inset',
  /** 壳子 → 主进程：同步圆轨悬浮窗所需 Tab 状态 */
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
  ShellGetBounds: 'shell:get-bounds',
  ShellSetContentBounds: 'shell:set-content-bounds',
  ShellGetTheme: 'shell:get-theme',
  ShellSetTheme: 'shell:set-theme',
  ShellLoadDevPlugin: 'shell:load-dev-plugin',
  ShellReloadPlugin: 'shell:reload-plugin',
  ShellOpenDevTools: 'shell:open-devtools',
  ShellGetSettings: 'shell:get-settings',
  ShellSetSettings: 'shell:set-settings',
  /** 壳子设置页：拉取插件已注册的设置 section 列表 */
  ShellGetSettingsSections: 'shell:get-settings-sections',
  /** 壳子设置页：写入单个插件设置项（同步 Bridge + SettingsStore） */
  ShellSetPluginSetting: 'shell:set-plugin-setting',

  /** 路径与数据 */
  ShellGetPaths: 'shell:get-paths',
  ShellPickFile: 'shell:pick-file',
  ShellGetPluginReadme: 'shell:get-plugin-readme',
  ShellQueryDb: 'shell:query-db',

  /** 硬件加速（写入设置后需重启） */
  ShellGetHardwareAccel: 'shell:get-hardware-accel',
  ShellSetHardwareAccel: 'shell:set-hardware-accel',

  /** 网络代理：读/写（写即 session.setProxy）/ 连通性测试 */
  ShellGetProxy: 'shell:get-proxy',
  ShellSetProxy: 'shell:set-proxy',
  ShellTestProxy: 'shell:test-proxy',

  /** 自定义字体：复制到 ~/eNest/fonts/、读 base64、删除 */
  ShellSaveCustomFont: 'shell:save-custom-font',
  ShellReadCustomFont: 'shell:read-custom-font',
  ShellDeleteCustomFont: 'shell:delete-custom-font',

  /** 插件拖拽/路径安装：入队后由主进程 installQueue 限流执行 */
  ShellInstallPlugin: 'shell:install-plugin',
  ShellGetInstallQueue: 'shell:get-install-queue',

  /** 卸载插件：关闭 Tab → 清 partition storage → 删文件 → 重扫注册表 */
  ShellUninstallPlugin: 'shell:uninstall-plugin',

  /** 启用/禁用已安装插件（持久化到 plugins/disabled.json） */
  ShellSetPluginEnabled: 'shell:set-plugin-enabled',

  /** 从市场安装/更新插件：本地 sample 优先，否则远程 assetUrl 下载入队 */
  ShellInstallMarketPlugin: 'shell:install-market-plugin',

  /** 应用自动更新（GitHub Release + electron-updater） */
  ShellCheckUpdate: 'shell:check-update',
  ShellDownloadUpdate: 'shell:download-update',
  ShellInstallUpdate: 'shell:install-update',
  ShellGetUpdateState: 'shell:get-update-state',

  /** 系统级通知（Electron Notification） */
  ShellSystemNotify: 'shell:system-notify',

  /** 快捷启动（Quick 小窗） */
  QuickToggle: 'quick:toggle',
  QuickHide: 'quick:hide',
  QuickSearch: 'quick:search',
  QuickOpen: 'quick:open',
  QuickScanApps: 'quick:scan-apps',
  QuickGetConfig: 'quick:get-config',
  QuickSetHotkeys: 'quick:set-hotkeys',
  /** 探测组合键是否可被本进程注册（用于录制时发现系统/他应用占用） */
  QuickProbeHotkey: 'quick:probe-hotkey',
  /** 渲染层测量内容高度后请求调整小窗高度（内容撑开/收起） */
  QuickResize: 'quick:resize',

  WindowMinimize: 'window:minimize',
  WindowMaximize: 'window:maximize',
  WindowClose: 'window:close',

  /** 插件 preload → 主进程（经 permission 校验） */
  PluginCall: 'plugin:call',
  PluginEvent: 'plugin:event',

  /** 壳子 → 主进程：读取 plugin:call 调用跟踪环形缓冲（DevConsole） */
  ShellGetPluginTrace: 'shell:get-plugin-trace',

  /** 主进程 → 插件 webContents 生命周期推送（enter/out/beforeClose/destroy） */
  PluginLifecycle: 'plugin:lifecycle',
  /** 插件 preload → 主进程：beforeClose 确认（可选，超时 300ms 兜底） */
  PluginLifecycleAck: 'plugin:lifecycle-ack',

  /** 主进程 → 壳子渲染进程推送 */
  ShellEvent: 'shell:event',

  /** Quick 渲染层 → 主进程：Esc 请求隐藏 */
  QuickHideRequest: 'quick:hide-request',
  /** 主进程 → Quick 渲染层：窗口已显示，请求聚焦输入框 */
  QuickShown: 'quick:shown'
} as const

export type IpcChannel = (typeof IpcChannels)[keyof typeof IpcChannels]

/** 壳子 Toast 类型：info 默认样式，success/warn/error 带强调色 */
export type ToastKind = 'info' | 'success' | 'warn' | 'error'

/** shell:event 负载类型 */
export type ShellEventPayload =
  | { type: 'plugins-changed' }
  | { type: 'tab-closed'; tabId: string }
  | { type: 'plugin-error'; pluginId: string; message: string }
  | { type: 'settings-sections'; sections: unknown[] }
  | { type: 'theme-changed'; mode: 'light' | 'dark' | 'system' }
  | { type: 'locale-changed'; locale: 'zh-CN' | 'en-US' }
  | { type: 'theme-packs-changed' }
  | { type: 'plugin-active'; tabId: string | null }
  | { type: 'plugin-title'; tabId: string; title: string }
  | { type: 'plugin-icon'; tabId: string; icon: string }
  | { type: 'plugin-badge'; tabId: string; badge: string | number }
  /** 插件请求壳子 Toast（由 useShellEvents → toastStore 渲染） */
  | { type: 'plugin-toast'; pluginId: string; message: string; toastType?: ToastKind }
  | { type: 'install-progress'; jobId: string; name: string; progress: number; step?: string }
  | { type: 'install-queue'; active: InstallJobInfo[]; waiting: InstallJobInfo[] }
  | { type: 'install-result'; jobId: string; name: string; ok: boolean; error?: string }
  /** 卸载结果：与 install-result 同级，壳子据此 toast + 刷新列表 */
  | { type: 'uninstall-result'; pluginId: string; name: string; ok: boolean; error?: string }
  /** 自动更新状态变更（检查 / 下载进度 / 就绪 / 错误） */
  | { type: 'update-status'; state: UpdateStatePayload }
  /** 悬浮窗请求主壳回首页 */
  | { type: 'go-home' }
  /** 悬浮窗请求主壳切换视图 */
  | { type: 'set-view'; view: 'home' | 'settings' | 'plugin' | 'dev' }
  /** 快捷键注册失败（至少部分占用） */
  | { type: 'quick-hotkey-failed'; failed: string[]; registered: string[] }
  | { type: 'quick-hotkey-used'; acc: string }
  /** 快捷启动配置变更 */
  | { type: 'quick-config-changed'; enabled: boolean; hotkeys: string[]; activeHotkey?: string }
  /** 命令面要求壳子切换视图 */
  | { type: 'quick-open-view'; view: 'home' | 'settings' | 'dev' }
  /**
   * Quick 小窗插件态切换（主进程 → Quick 渲染层，经通用 shell:event 下发）：
   * 挂载 mini 插件 = { pluginId, title }；Esc 固定/收起回列表态 = null。
   * 注意：该事件对主壳渲染层无意义（payload 事件桥过滤），仅 Quick 表面消费。
   */
  | { type: 'quick-plugin-mode'; mode: QuickPluginModeInfo | null }
  /**
   * 插件贡献点变更（注册/卸载/覆盖）：渲染层据此刷新对应插槽消费
   * （home-cards 区块、rail-entries、settings sections 等）。
   */
  | { type: 'contributions-changed'; slot: string; source: string }

/** orb 悬浮窗同步的 Tab 状态（壳子 renderer → main → overlay） */
export interface OrbRailState {
  view: 'home' | 'settings' | 'dev' | 'plugin'
  tabStyle: 'classic' | 'orb'
  activeTabId: string | null
  /** 动画档位：overlay 独立文档不读主壳 DOM，档位随状态下发 */
  animationLevel: AnimationLevel
  /** 已解析主题（含 tokens）：圆轨/设置钮配色跟随设置页主题 */
  theme: {
    mode: 'light' | 'dark'
    tokens: Record<string, string>
  }
  tabs: Array<{
    id: string
    pluginId: string
    title: string
    color: string
    glyph: string
  }>
  /**
   * rail-entries 插槽贡献（插件贡献点，声明式）：orb 模式左侧轨道底部入口。
   * 点击经 shellApi.openPlugin(pluginId, { code: openCode }) 打开来源插件。
   * 本期仅数据层（主进程下发）；渲染消费由 orb-overlay 后续批次接线。
   * 可选字段：overlay/壳子同步路径尚未携带时不影响既有消费方。
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

/** shell:orb-event 负载：主进程 → 悬浮窗 */
export type OrbEventPayload = { type: 'orb-state'; state: OrbRailState }

/** shell:test-proxy 负载 */
export interface ProxyTestResult {
  ok: boolean
  latencyMs?: number
  error?: string
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
  | {
      type: 'theme-change'
      mode: 'light' | 'dark'
      tokens: Record<string, string>
    }
  /** 插件注册的全局热键被按下（enest.hotkey.register 的回调触发） */
  | {
      type: 'hotkey'
      accelerator: string
    }
  /** 壳子界面语言变更（settings.general.locale 变化时广播） */
  | {
      type: 'locale-change'
      locale: 'zh-CN' | 'en-US'
    }
  /**
   * Quick 搜索查询（主进程 → 注册了 quick provider 的插件）：
   * 插件经 enest.contribute.onQuickQuery 监听，计算结果后用
   * enest.contribute.respondQuickQuery(reqId, items) 回传（500ms 超时丢弃）。
   */
  | {
      type: 'quick-query'
      reqId: string
      query: string
    }
  /** SSH 会话数据/退出/错误/指标（com.enest.ssh） */
  | SshPluginEvent

/** 安装队列任务对外视图（active / waiting 列表项） */
export interface InstallJobInfo {
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
