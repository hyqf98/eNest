/**
 * shared/types/quick — 快捷启动（Quick Launcher）跨进程类型
 * 职责：定义命令项、本地应用、热键配置与搜索/打开请求体。
 * 被 main/hotkey、main/launcher、quickHandlers、preload、Quick 渲染层共同引用。
 */

export type QuickCommandKind = 'app' | 'plugin' | 'action'

export type QuickActionId =
  | 'open-market'
  | 'open-settings'
  | 'refresh-apps'

/** 命令面板可执行项 */
export interface QuickCommand {
  kind: QuickCommandKind
  /** 列表稳定 id */
  id: string
  title: string
  subtitle: string
  /** kind=app：可执行路径；kind=plugin：无 */
  path?: string
  /** 额外检索别名（插件 cmds 除主指令外） */
  aliases?: string[]
  /** kind=plugin */
  pluginId?: string
  code?: string
  /** kind=action */
  action?: QuickActionId
  /** 可显示图标：data URL 或 enest:// 资源；无则 UI 用 kind 色点/首字母 */
  icon?: string
  /** kind=app：linux .desktop Icon= 原始值；appLauncher 提图时解析，其他平台忽略 */
  iconName?: string
  /** 最近使用时间戳（ms）；有值时 UI 可归入「最近」分区 */
  lastUsedTs?: number
  /** 累计使用次数（来自 settings recent） */
  useCount?: number
  /** 命中的触发关键词（uTools 风格）；有值时 UI 高亮 */
  keywordHit?: string
  /** 由检索层分组，界面保持组内相关性顺序。 */
  group?: 'best' | 'match' | 'recommendation' | 'provider'
  type?: 'text' | 'regex' | 'over'
  /** 内容匹配或动态 provider 的进入载荷。 */
  payload?: unknown
}

export interface QuickSearchRequest {
  query: string
  limit?: number
  /** 缺省搜索全部类型；先过滤再排序/截断。 */
  kind?: QuickCommandKind
  /** 静态索引先返回，运行时 provider 随后补齐。 */
  phase?: 'static' | 'enriched' | 'providers'
}

export interface QuickSearchResult {
  items: QuickCommand[]
}

/** 打开目标容器（= 启动方式）：quick = Quick 小窗内嵌 / shell = 主窗大窗 Tab */
export type QuickOpenContainer = 'quick' | 'shell'

/**
 * 打开/交互请求。
 * - app / plugin / action：打开命令（plugin 可带 container 显式指定容器；
 *   缺省由主进程决策：每插件启动方式设置 > 跟随入口 quick）
 * - plugin-escape：插件态 Esc 回列表（载荷 = 当前插件 id）
 * - plugin-pin：⌘Enter / 「固定到主窗」按钮（载荷 = 当前插件 id）
 */
export type QuickOpenRequest =
  | { kind: 'app'; path: string; query?: string }
  | { kind: 'plugin'; pluginId: string; code?: string; container?: QuickOpenContainer; type?: 'text' | 'regex' | 'over'; payload?: unknown; query?: string }
  | { kind: 'action'; action: QuickActionId; query?: string }
  | { kind: 'plugin-escape'; pluginId: string }
  | { kind: 'plugin-pin'; pluginId: string }
  | { kind: 'plugin-tab'; pluginId: string; shift?: boolean }

export interface QuickOpenResult {
  ok: boolean
  error?: string
  /** container=quick 且成功挂载时返回 tabId（t- 前缀），渲染层无需消费 */
  tabId?: string
}

/** Quick 渲染层插件态描述（经 shell:event `quick-plugin-mode` 推送；null 表示回列表态） */
export interface QuickPluginModeInfo {
  pluginId: string
  /** 插件显示名（Tab 标题兜底） */
  title: string
  loading?: boolean
}

/** 本地已安装应用扫描项 */
export interface LocalApp {
  name: string
  path: string
  /** 次要名（包名 / 显示名） */
  alias?: string
  icon?: string
  /** linux .desktop Icon= 原始值（绝对路径或主题名，如 firefox）；提图时解析 */
  iconName?: string
}

export interface ApplicationScanResult {
  apps: LocalApp[]
  complete: boolean
  errors: string[]
}

export interface QuickHotkeyConfig {
  enabled: boolean
  hotkeys: string[]
  platform: NodeJS.Platform
  /** 当前唯一生效的 accelerator；空串表示未选中 */
  activeHotkey?: string
  /** 最近一次用来呼出小窗的 accelerator；无则空串 */
  lastUsedHotkey?: string
  /** Actual OS registrations; selection alone does not imply availability. */
  registered?: string[]
  error?: string
}

export interface QuickHotkeyApplyResult {
  ok: boolean
  enabled: boolean
  hotkeys: string[]
  /** 实际注册成功的 accelerator（互斥模型下最多 1 个） */
  registered: string[]
  failed: string[]
  /** 当前生效键 */
  activeHotkey?: string
  error?: string
}

/** 录制时探测：free=可被本应用注册；hint=常见系统占用提示 */
export interface QuickHotkeyProbeResult {
  acc: string
  free: boolean
  /** 已是本应用当前注册的键 */
  ours: boolean
  hint?: string
}
