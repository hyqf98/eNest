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
  form?: 'mini' | 'panel'
  /** kind=action */
  action?: QuickActionId
  /** 可显示图标：data URL 或 enest:// 资源；无则 UI 用 kind 色点/首字母 */
  icon?: string
  /** 最近使用时间戳（ms）；有值时 UI 可归入「最近」分区 */
  lastUsedTs?: number
  /** 累计使用次数（来自 settings recent） */
  useCount?: number
  /** 命中的触发关键词（uTools 风格）；有值时 UI 高亮 */
  keywordHit?: string
}

export interface QuickSearchRequest {
  query: string
  limit?: number
}

export interface QuickSearchResult {
  items: QuickCommand[]
}

/** 打开目标容器：quick = Quick 小窗内嵌（mini 插件）；shell = 主窗 Tab（默认） */
export type QuickOpenContainer = 'quick' | 'shell'

/**
 * 打开/交互请求。
 * - app / plugin / action：打开命令（plugin 可带 container：quick = 小窗内嵌 mini）
 * - plugin-escape：插件态 Esc 回列表（载荷 = 当前插件 id）
 * - plugin-pin：⌘Enter / 「固定到主窗」按钮（载荷 = 当前插件 id）
 */
export type QuickOpenRequest =
  | { kind: 'app'; path: string }
  | { kind: 'plugin'; pluginId: string; code?: string; container?: QuickOpenContainer }
  | { kind: 'action'; action: QuickActionId }
  | { kind: 'plugin-escape'; pluginId: string }
  | { kind: 'plugin-pin'; pluginId: string }

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
}

/** 本地已安装应用扫描项 */
export interface LocalApp {
  name: string
  path: string
  /** 次要名（包名 / 显示名） */
  alias?: string
  icon?: string
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
