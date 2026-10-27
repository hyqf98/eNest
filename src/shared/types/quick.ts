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

/** Validated declaration, not an evaluated match. The selected theme owns matching. */
export type QuickContentType = 'text' | 'regex' | 'over' | 'img' | 'files'

export interface QuickContentMatch {
  type: QuickContentType
  source?: string
  flags?: string
  minLength: number
  maxLength?: number
  /** img/files: lowercase extension allowlist (no dot). Empty means any supported type. */
  extensions?: string[]
  /** files only: accept directory entries. */
  allowDirectory?: boolean
  /** files only: accepted entry count bounds (defaults 1..20). */
  minCount?: number
  maxCount?: number
}

/**
 * Host-held paste-context entry projected into renderers and themes.
 * Full image bytes never enter the theme snapshot: thumbnails are bounded data URLs.
 */
export interface QuickImageContext {
  /** Opaque session handle; valid only until the context is cleared. */
  id: string
  kind: 'image' | 'file' | 'directory'
  name?: string
  size?: number
  width?: number
  height?: number
  /** Bounded PNG data URL for preview (≤64 KiB). */
  thumbnail: string
}

/**
 * Opaque selection of host-held paste-context entries sent with an open request.
 * Only ids the host published in this session resolve; paths and bytes never travel from renderers.
 */
export interface QuickInputSelection {
  imageIds?: string[]
  fileIds?: string[]
  /** Host echo of the current query for the enter input; bounded and re-sliced in main. */
  text?: string
}

/**
 * Bounded enter input handed to a plugin with the launch.
 * Images carry full data URLs (host-validated budgets); files carry a host-minted
 * read-only handle plus display metadata — the path is informational, reading goes via handleId.
 */
export interface QuickEnterInput {
  text?: string
  images?: Array<{ dataUrl: string; width: number; height: number }>
  files?: Array<{ handleId: string; path: string; name: string; size: number; kind: 'file' | 'directory' }>
}

export type QuickSearchPhase = 'catalog' | 'static' | 'enriched' | 'providers'

/** 命令面板可执行项 */
export interface QuickCommand {
  kind: QuickCommandKind
  /** 列表稳定 id */
  id: string
  /** Host-signed stable identity for provider state; does not authorize a launch. */
  stateKey?: string
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
  /** 命中的触发关键词（uTools 风格）；有值时 UI 高亮 */
  keywordHit?: string
  /** 由检索层分组，界面保持组内相关性顺序。 */
  group?: 'best' | 'match' | 'recommendation' | 'provider'
  type?: QuickContentType
  /** 内容匹配或动态 provider 的进入载荷。 */
  payload?: unknown
  content?: QuickContentMatch
}

export interface QuickSearchRequest {
  query: string
  limit?: number
  /** 缺省搜索全部类型；先过滤再排序/截断。 */
  kind?: QuickCommandKind
  /** Directory, native icon enrichment and plugin search are independent host capabilities. */
  phase?: QuickSearchPhase
  /** Native icon lookup only; unknown IDs cannot select a filesystem target. */
  ids?: string[]
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
 * - plugin.input：宿主渲染层选择的粘贴上下文句柄集合（图片/文件按本会话 id 引用，
 *   主进程在启动时校验 id 归属并把字节/文件句柄组装成 enter.input；主题表面不能提交路径或字节）
 * - plugin-escape：插件态 Esc 回列表（载荷 = 当前插件 id）
 * - plugin-pin：⌘Enter / 「固定到主窗」按钮（载荷 = 当前插件 id）
 */
export type QuickOpenRequest =
  | { kind: 'app'; path: string; query?: string }
  | { kind: 'plugin'; pluginId: string; code?: string; container?: QuickOpenContainer; type?: QuickContentType; payload?: unknown; query?: string; input?: QuickInputSelection }
  | { kind: 'action'; action: QuickActionId; query?: string }
  | { kind: 'plugin-escape'; pluginId: string }
  | { kind: 'plugin-pin'; pluginId: string }
  | { kind: 'plugin-tab'; pluginId: string; shift?: boolean }

export interface QuickOpenResult {
  ok: boolean
  error?: string
  /** Returned only after an actual validated successful native launch. */
  opened?: { stateKey: string; at: number }
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

/**
 * quick:input-context 请求。渲染层不提交字节或路径：paste 事件时系统剪贴板必然已包含
 * 被粘贴内容，统一由主进程读取（clipboard.read 位图 / nativeClipboard readFiles 文件）。
 */
export type QuickInputContextRequest =
  | { operation: 'read-clipboard' }
  | { operation: 'list' }
  | { operation: 'clear'; id?: string }
export interface QuickInputContextResult { ok: boolean; error?: string; items?: QuickImageContext[] }

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
  /** Wayland portals do not report actual activation; the first real key event confirms it. */
  systemConfirmationRequired?: boolean
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

export interface QuickHotkeyPatch {
  enabled?: boolean
  hotkeys?: string[]
  activeHotkey?: string
  overrideToken?: string
}

export interface QuickHotkeyApplyResult {
  systemConfirmationRequired?: boolean
  ok: boolean
  enabled: boolean
  hotkeys: string[]
  /** 实际注册成功的 accelerator（互斥模型下最多 1 个） */
  registered: string[]
  failed: string[]
  /** 当前生效键 */
  activeHotkey?: string
  error?: string
  probe?: import('./shortcuts').ShortcutProbeResult
}

/** 录制时探测：free=可被本应用注册；hint=常见系统占用提示 */
export interface QuickHotkeyProbeResult {
  acc: string
  free: boolean
  /** 已是本应用当前注册的键 */
  ours: boolean
  hint?: string
  conflict?: import('./shortcuts').ShortcutProbeResult
}
