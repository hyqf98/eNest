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
}

export interface QuickSearchRequest {
  query: string
  limit?: number
}

export interface QuickSearchResult {
  items: QuickCommand[]
}

export type QuickOpenRequest =
  | { kind: 'app'; path: string }
  | { kind: 'plugin'; pluginId: string; code?: string }
  | { kind: 'action'; action: QuickActionId }

export interface QuickOpenResult {
  ok: boolean
  error?: string
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
}

export interface QuickHotkeyApplyResult {
  ok: boolean
  enabled: boolean
  hotkeys: string[]
  registered: string[]
  failed: string[]
  error?: string
}
