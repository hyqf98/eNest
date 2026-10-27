/**
 * shared/types/panel — 自由面板（小组件）契约
 * 职责：面板/组件几何、持久化记录、面板 surface 与宿主之间的 IPC 载荷。
 * 被主进程（PanelManager / panelWindows / PluginHost）、preload 与 renderer 共用。
 * 关键依赖：无（纯类型，禁止引入 Electron 或主进程模块）。
 *
 * 语义约定：
 * - 所有矩形均为面板内容区内的 DIP 坐标（左上原点），不含窗口边框。
 * - 组件矩形包含宿主绘制的 26px 组件条；插件原生视图在此基础上内缩。
 * - 插件在面板中是「移动」语义：同一 webContents 换父级，不复制实例。
 */
import type { ResolvedAppearance } from './appearance'

/** 面板材质：无 = 纯色半透明底板；blur = 背板毛玻璃；system = 系统原生材质（macOS vibrancy / Windows acrylic）。 */
export type PanelMaterial = 'none' | 'blur' | 'system'

/** 面板外观（壳级设置，不随主题变化）。 */
export interface PanelAppearance {
  /** 底板不透明度 0.3–1；材质为 system 时由系统材质主导，此值作为叠加层浓度。 */
  opacity: number
  material: PanelMaterial
}

export const DEFAULT_PANEL_APPEARANCE: PanelAppearance = { opacity: 0.78, material: 'blur' }

/** 面板矩形；displayId 用于多屏恢复时定位，-1 表示未绑定显示器。 */
export interface PanelBounds {
  x: number
  y: number
  width: number
  height: number
  displayId: number
}

/** 组件矩形：面板内容区本地 DIP。 */
export interface PanelWidgetRect {
  x: number
  y: number
  width: number
  height: number
}

/** 单个组件的持久化记录。 */
export interface PersistedPanelWidget extends PanelWidgetRect {
  pluginId: string
  /** 同面板内的层叠顺序，值越大越靠上。 */
  z: number
}

/** 单个面板的持久化记录（写入设置 panels 段，只由主进程写）。 */
export interface PersistedPanel {
  id: string
  bounds: PanelBounds
  widgets: PersistedPanelWidget[]
}

/** 组件运行状态（不持久化）。 */
export type PanelWidgetStatus = 'loading' | 'ready' | 'error' | 'hibernated'

/** 推给面板 chrome 渲染层的单个组件快照。 */
export interface PanelWidgetState extends PanelWidgetRect {
  pluginId: string
  title: string
  /** 插件 manifest 声明的图标（data URL 或 assets 路径），无则用 glyph。 */
  icon?: string | null
  glyph?: string
  z: number
  status: PanelWidgetStatus
  error?: string
}

/** 面板外观快照（含解析后的主题 token，chrome 自绘底板与组件条时使用）。 */
export interface PanelThemeSnapshot {
  mode: 'light' | 'dark'
  tokens: Record<string, string>
  animationLevel: 'low' | 'medium' | 'high'
}

/** 面板 surface 的完整状态快照。 */
export interface PanelState {
  id: string
  /** 面板内容区尺寸（窗口客户区）。 */
  width: number
  height: number
  widgets: PanelWidgetState[]
  appearance: PanelAppearance
  theme: PanelThemeSnapshot
  /**
   * 完整外观快照（宿主解析结果）：chrome 用 applyAppearanceToDom 应用，
   * 使圆角/字号/动画档/组件材质等 V2 语义与主壳一致（与 notification-overlay 同做法）。
   */
  resolvedAppearance?: ResolvedAppearance
  /** 组件数量上限，chrome 据此禁用「添加组件」。 */
  widgetLimit: number
}

/** 面板 chrome → 主进程的命令。 */
export type PanelCommand =
  /** 打开组件选择器前拉取可添加的插件列表（已安装、已启用、且不在任何面板）。 */
  | { action: 'list-candidates' }
  /** 按 pluginId 添加组件；rect 缺省由宿主落位算法决定。 */
  | { action: 'add-widget'; pluginId: string; rect?: PanelWidgetRect }
  /** 移除组件（插件回到 shell Tab，不销毁运行时）。 */
  | { action: 'remove-widget'; pluginId: string }
  /** 组件崩溃/启动失败后的显式重试（冷启动并重新挂载）。 */
  | { action: 'retry-widget'; pluginId: string }
  /** 把组件移回主窗 Tab。 */
  | { action: 'dock-widget'; pluginId: string }
  /** 关闭整个面板（释放面板内全部插件）。 */
  | { action: 'close-panel' }
  /** 更新面板外观（全局设置）。 */
  | { action: 'set-appearance'; appearance: Partial<PanelAppearance> }
  /** 组件拖动/缩放开始；主进程据此建立 drag session。 */
  | { action: 'widget-drag-begin'; pluginId: string; mode: PanelDragMode; edge?: PanelResizeEdge; pointer: PanelPoint }
  /** 拖动结束；commit = false 表示取消并回到起始矩形。 */
  | { action: 'widget-drag-end'; cancel?: boolean }
  /** 整块面板移动/缩放开始（主进程驱动，替代 -webkit-app-region：drag 区不触发 contextmenu）。 */
  | { action: 'window-drag-begin'; mode: PanelDragMode; edge?: PanelResizeEdge }
  /** 面板移动/缩放结束。 */
  | { action: 'window-drag-end'; cancel?: boolean }
  /** 把组件提到最上层。 */
  | { action: 'raise-widget'; pluginId: string }
  /**
   * chrome 打开覆盖层（右键菜单 / 组件选择器）：临时隐藏本面板全部插件原生视图。
   * 原生视图在 OS 层遮挡 DOM，不隐藏则菜单/选择器无法接收点击；关闭覆盖层时配对发送 overlay-close。
   */
  | { action: 'overlay-open' }
  /** 覆盖层关闭：恢复本面板全部插件视图可见。 */
  | { action: 'overlay-close' }

export type PanelDragMode = 'move' | 'resize'
export type PanelResizeEdge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'

export interface PanelPoint { x: number; y: number }

/** 一条对齐辅助线：position 为面板内容区内的 DIP 坐标，from/to 为线段在该轴上的可视范围。 */
export interface PanelGuide {
  axis: 'x' | 'y'
  position: number
  from: number
  to: number
}

/** 主进程 → 面板 chrome 的拖动反馈。只在高频 tick 中按需推送（吸附状态变化时）。 */
export interface PanelDragFeedback {
  active: boolean
  pluginId?: string
  /** 拖动中的实时矩形（吸附后）。 */
  rect?: PanelWidgetRect
  guides?: PanelGuide[]
}

/** 面板 chrome 可调用的宿主 API（由 panelPreload 暴露为 window.enestPanel）。 */
export interface PanelSurfaceApi {
  getState(): Promise<PanelState | null>
  command(command: PanelCommand): Promise<{ ok: boolean; error?: string; state?: PanelState; candidates?: PanelCandidate[] }>
  /** 拖动进行中：由渲染层在指针移动时调用，主进程自行读光标，仅用于保活与节流触发。 */
  dragTick(): void
  onState(callback: (state: PanelState) => void): () => void
  onDrag(callback: (feedback: PanelDragFeedback) => void): () => void
  /**
   * 声明本面板内容区为插件拖入目标（Tab / 独立窗口 → 面板）。
   * 传 null 表示撤销。主进程据此推送落点反馈并按松手坐标嵌入组件。
   */
  setDropTarget(target: import('./plugin-window').PluginDropTarget | null): void
  /** 外部插件拖入过程的反馈（用于落点高亮）。 */
  onPluginDrag(callback: (feedback: import('./plugin-window').PluginDragFeedback) => void): () => void
}

/** 可加入面板的插件候选（组件选择器数据）。 */
export interface PanelCandidate {
  pluginId: string
  name: string
  icon?: string | null
  glyph?: string
  category?: string
  /** 已在某个面板中时为该面板 id，用于提示而非重复添加。 */
  panelId?: string
}

/** 面板呼出快捷键保存 + 重注册结果（镜像 QuickHotkeyApplyResult 的返回语义，供设置页展示真实注册状态）。 */
export interface PanelHotkeyApplyResult {
  ok: boolean
  enabled: boolean
  /** 当前生效的快捷键；未开启或注册失败时可能为空。 */
  hotkey: string
  error?: string
}

/** 面板尺寸与组件约束（主进程与 chrome 共用，避免两端魔法数字漂移）。 */
export const PANEL_WIDGET_BAR_HEIGHT = 26
/** 组件原生视图四周内缩（同时作为可抓取的缩放热区）。 */
export const PANEL_WIDGET_INSET = 4
export const PANEL_WIDGET_MIN_WIDTH = 200
export const PANEL_WIDGET_MIN_HEIGHT = 140
export const PANEL_WIDGET_DEFAULT_WIDTH = 360
export const PANEL_WIDGET_DEFAULT_HEIGHT = 280
export const PANEL_MIN_WIDTH = 320
export const PANEL_MIN_HEIGHT = 240
export const PANEL_MAX_WIDGETS = 24
export const PANEL_MAX_PANELS = 8
/** 吸附阈值（DIP）：距候选线小于该值即吸附。 */
export const PANEL_SNAP_THRESHOLD = 6
