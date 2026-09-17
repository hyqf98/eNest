/**
 * shared/constants — 全局共享常量
 * 职责：定义应用名称、协议名、session 分区前缀、UI 高度及 tabId ↔ pluginId 转换工具。
 * 被主进程、preload、渲染进程三方共同引用。
 * 关键依赖：无。
 */
export const APP_NAME = 'eNest'
export const PROTOCOL = 'enest'
export const PLUGIN_PARTITION_PREFIX = 'persist:plugin-'
export const SHELL_PARTITION = 'enest-shell'

/** 内容区标题栏高度（壳子 renderer）— 与 CSS --titlebar-h 保持一致 */
export const TITLEBAR_HEIGHT = 36
/** 插件工具条高度：default / minimal / none */
export const PLUGIN_BAR_HEIGHT = 48
export const PLUGIN_BAR_HEIGHT_MINIMAL = 28
export const PLUGIN_BAR_HEIGHT_NONE = 0

/** 圆球直径（与 orb-overlay.css .orb-face 一致） */
export const ORB_FACE_SIZE = 44
/** 设置圆钮直径（与 tabs 独立，不参与展开宽度逻辑） */
export const ORB_SETTINGS_SIZE = 40
/** 圆球悬停放大系数 */
export const ORB_FACE_HOVER_SCALE = 1.14

/**
 * 悬浮窗固定宽度：展开与收起都用同一宽度，避免 hover 时 setBounds
 * 触发 macOS 重合成（插件层短暂盖住悬浮窗）与伪 mouseleave。
 * 计算：把手占位 + panel 边距 + 圆球（含 hover 放大/位移）+ 激活光环。
 */
export const ORB_OVERLAY_WIDTH = 84

/** @deprecated 使用 ORB_OVERLAY_WIDTH；保留签名兼容旧调用 */
export function orbOverlayWidth(_expanded?: boolean): number {
  return ORB_OVERLAY_WIDTH
}

/**
 * 传统左侧通道 inset（仅 classic 关闭 overlay 时不用）。
 * overlay 模式下主进程会强制 setPluginLeftInset(0)。
 */
export const ORB_RAIL_INSET = 0
export const ORB_RAIL_INSET_EXPANDED = 0
export const ORB_RAIL_INSET_CLASSIC = 0

/** 按 manifest.ui.chrome 计算插件条像素高度 */
export function pluginChromeBarHeight(
  chrome: 'default' | 'minimal' | 'none' | undefined
): number {
  if (chrome === 'none') return PLUGIN_BAR_HEIGHT_NONE
  if (chrome === 'minimal') return PLUGIN_BAR_HEIGHT_MINIMAL
  return PLUGIN_BAR_HEIGHT
}

/** 为插件生成独立的 session partition，隔离 cookie/localStorage 等数据 */
export function pluginPartition(pluginId: string): string {
  return `${PLUGIN_PARTITION_PREFIX}${pluginId}`
}

/** 构造 enest://plugin/{pluginId}/{filePath} 协议 URL */
export function pluginProtocolUrl(pluginId: string, filePath = 'index.html'): string {
  return `${PROTOCOL}://plugin/${pluginId}/${filePath}`
}

/** Renderer tab id format: t-{pluginId} */
export function toTabId(pluginId: string): string {
  return pluginId.startsWith('t-') ? pluginId : `t-${pluginId}`
}

/** tabId → pluginId，兼容已带 t- 前缀的输入 */
export function toPluginId(tabId: string): string {
  return tabId.startsWith('t-') ? tabId.slice(2) : tabId
}

/** 数据根目录名（位于用户主目录下，如 ~/eNest） */
export const DATA_DIR_NAME = 'eNest'
export const PLUGINS_DIR = 'plugins'
export const DATA_SUBDIR = 'data'
export const THEMES_DIR = 'themes'
export const SETTINGS_FILE = 'settings.json'
export const DATABASE_FILE = 'enest.db'
