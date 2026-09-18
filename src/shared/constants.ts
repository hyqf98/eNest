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

/**
 * orb 圆轨（主窗口内顶层 WebContentsView，非独立窗口）：
 * rail 视图收起为左缘透明窄条（仅把手可见），hover 展开拓宽；
 * dock 视图为左下角常驻设置钮。插件内容全宽渲染（inset 恒 0）。
 * 对齐基准：展开后轨道圆球视觉左缘 ≈ 8px（panel 4 + face 4）；dock 按钮与之对齐并留边距。
 */
export const ORB_RAIL_COLLAPSED_W = 14
export const ORB_RAIL_EXPANDED_W = 84
/** 视图略大于按钮，容纳 hover 放大与柔和阴影 */
export const ORB_DOCK_VIEW_W = 80
export const ORB_DOCK_VIEW_H = 72
/** 设置钮相对窗口左/下内边距（与展开轨道圆球左缘对齐） */
export const ORB_DOCK_PAD_LEFT = 10
export const ORB_DOCK_PAD_BOTTOM = 18

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

/** 数据根目录名（用户主目录下的隐藏目录，如 ~/.eNest） */
export const DATA_DIR_NAME = '.eNest'
export const PLUGINS_DIR = 'plugins'
export const DATA_SUBDIR = 'data'
export const THEMES_DIR = 'themes'
export const SETTINGS_FILE = 'settings.json'
export const DATABASE_FILE = 'enest.db'

// —— Quick 快捷小窗尺寸（createQuickWindow / PluginHost quick 容器共用）——

/** Quick 小窗宽度（px） */
export const QUICK_WIDTH = 720
/** 仅胶囊输入条时的窗口高度（含外缘阴影留白） */
export const QUICK_MIN_HEIGHT = 72
/** Quick 小窗总高度上限（px） */
export const QUICK_MAX_HEIGHT = 520
/**
 * Quick 插件态输入条区域高度：quick 渲染层绘制的顶栏（返回/输入/固定）。
 * mini 插件 WebContentsView 从 y=QUICK_BAR_AREA_H 铺满剩余高度。
 * 与 QuickLauncherApp 插件态根高度（quick.css [data-mode='plugin']）保持一致。
 */
export const QUICK_BAR_AREA_H = 64
/** mini 插件期望高度缺省值（未上报 setHeight / 无 manifest.window.minHeight 时） */
export const QUICK_PLUGIN_DEFAULT_HEIGHT = 300
/** mini 插件区域最小高度（防上报异常小值导致内容不可见） */
export const QUICK_PLUGIN_MIN_HEIGHT = 120

// —— 插件宿主资源策略（休眠 / LRU / crash 自愈）——

/**
 * 后台插件空闲休眠延迟（ms）：进入 background 后多久无激活即休眠
 * （销毁渲染进程、保留逻辑 Tab 与 session 快照）。默认 3 分钟。
 */
export const PLUGIN_HIBERNATE_DELAY_MS = 3 * 60 * 1000

/** 同时存活的插件渲染进程上限（LRU）：超限后把最久未激活的 background 插件立即休眠 */
export const PLUGIN_ALIVE_LIMIT = 6

// —— 插件图标规范（壳子市场 / Tab / 精选统一约定）——
//
// 源图：
// - 推荐 256×256 PNG/WebP，最小 128×128，正方形
// - 关键图形落在约 80% 安全区（四周各留 ~10% 呼吸，避免圆角裁切）
// 显示：
// - PluginCard ≈ 48px
// - FeaturedCarousel 中心 ≈ 64px
// - Tab / orb 轨道 ≈ 20–24px
// CSS：object-fit: cover；border-radius ≈ 容器 28%；加载失败回退 glyph 色块。
// Installer 未引入图像解码依赖，不做像素级校验；前端按本约定消费。

/** 插件 logo 源图推荐边长（px，正方形） */
export const PLUGIN_ICON_SOURCE_SIZE = 256
/** 插件 logo 源图最小边长（px）；小于该值显示可能发糊 */
export const PLUGIN_ICON_SOURCE_MIN = 128
/** 源图安全区占比（0–1）：关键内容应落在中心该比例区域内 */
export const PLUGIN_ICON_SAFE_AREA = 0.8
/** 市场 PluginCard 显示边长（px） */
export const PLUGIN_ICON_DISPLAY_CARD = 48
/** 精选轮播中心图标显示边长（px） */
export const PLUGIN_ICON_DISPLAY_FEATURED = 64
/** Tab / orb 轨道圆球图标显示边长（px，区间下限；上限见 DISPLAY_TAB_MAX） */
export const PLUGIN_ICON_DISPLAY_TAB = 20
/** Tab / orb 显示边长上限（px） */
export const PLUGIN_ICON_DISPLAY_TAB_MAX = 24
/** 图标圆角 / 容器边长 比例（≈28%，与 app 图标语言一致） */
export const PLUGIN_ICON_RADIUS_RATIO = 0.28
/** 显示层 object-fit；源图非正方形时 cover 居中裁切 */
export const PLUGIN_ICON_OBJECT_FIT = 'cover' as const
/** 壳子 chrome 线性图标描边（Lucide 风格，区间 1.5–1.75） */
export const UI_ICON_STROKE_WIDTH = 1.6
