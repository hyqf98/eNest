/**
 * shared/types/panel — 自由面板（小组件）契约
 * 职责：面板/组件几何、持久化记录、面板 surface 与宿主之间的 IPC 载荷。
 * 被主进程（PanelManager / panelWindows / PluginHost）、preload 与 renderer 共用。
 * 关键依赖：无（纯类型，禁止引入 Electron 或主进程模块）。
 *
 * 语义约定：
 * - 所有矩形均为面板内容区内的 DIP 坐标（左上原点），不含窗口边框。
 * - 组件矩形即插件可视区域（含四周内缩）；无标题条，拖动热区在 chrome 边缘层。
 * - 插件在面板中是「移动」语义：同一 webContents 换父级，不复制实例。
 */
import type { ResolvedAppearance } from './appearance'

/** 面板材质：none 不启用原生材质；blur = 背板毛玻璃；system = 系统原生材质。 */
export type PanelMaterial = 'none' | 'blur' | 'system'

/** 面板外观（壳级设置，不随主题变化）。 */
export interface PanelAppearance {
  /** DOM 底板浓度 0–1；0 不会关闭 blur/system 原生材质，完全透明底板需同时设置 material=none。 */
  opacity: number
  material: PanelMaterial
}

export const DEFAULT_PANEL_APPEARANCE: PanelAppearance = { opacity: 0, material: 'none' }

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
export type PanelWidgetStatus = 'loading' | 'ready' | 'error' | 'hibernated' | 'unsupported' | 'cleanup-failed'

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

/** 面板 surface 的完整状态快照。 */
export interface PanelState {
  id: string
  /** 面板内容区尺寸（窗口客户区）。 */
  width: number
  height: number
  widgets: PanelWidgetState[]
  appearance: PanelAppearance
  /**
   * 完整外观快照（宿主解析结果）：chrome 用 applyAppearanceToDom 应用，
   * 使圆角/字号/动画档/组件材质等 V2 语义与主壳一致（与 notification-overlay 同做法）。
   */
  resolvedAppearance: ResolvedAppearance
  /** 组件数量上限，chrome 据此禁用「添加组件」。 */
  widgetLimit: number
}

/** 面板 chrome → 主进程的命令。 */
export type PanelCommand =
  /** 可添加插件：已安装、已启用、显式适配 panel、且不在任何面板。 */
  | { action: 'list-candidates' }
  /** 按 pluginId 添加组件；rect 缺省由宿主落位算法决定。 */
  | { action: 'add-widget'; pluginId: string; rect?: PanelWidgetRect }
  /** 移除组件：完整关闭插件运行时并删除该组件布局。 */
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
  | { action: 'widget-drag-begin'; interactionId: number; pluginId: string; mode: PanelDragMode; edge?: PanelResizeEdge; pointer: PanelPoint }
  /** 拖动结束；cancel = true 表示回到起始矩形。 */
  | { action: 'widget-drag-end'; interactionId: number; cancel?: boolean }
  /** 整块面板移动/缩放开始（主进程驱动，替代 -webkit-app-region：drag 区不触发 contextmenu）。 */
  | { action: 'window-drag-begin'; interactionId: number; mode: PanelDragMode; edge?: PanelResizeEdge; pointer?: PanelPoint }
  /** 面板移动/缩放结束。 */
  | { action: 'window-drag-end'; interactionId: number; cancel?: boolean }
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

/** 主进程 → 面板 chrome 的拖动反馈；变化后合并限频推送，不驱动原生几何。 */
export interface PanelDragFeedback {
  /** 原始手势所属面板；转发到其它面板时也不改写。 */
  sourcePanelId: string
  /** 由来源 chrome 分配的正安全整数，同一页面内跨组件/整窗手势不复用。 */
  interactionId: number
  active: boolean
  pluginId?: string
  /** 拖动中的实时矩形（吸附后）。 */
  rect?: PanelWidgetRect
  guides?: PanelGuide[]
}

/** 仅发给可信 chrome 的临时预览；同 revision 的 widgets 为增量，active=false 时全部释放。 */
export interface PanelPreviewSnapshot {
  revision: number
  active: boolean
  widgets: Array<{ pluginId: string; dataUrl: string }>
}

/** 面板 chrome 可调用的宿主 API（由 panelPreload 暴露为 window.enestPanel）。 */
export interface PanelSurfaceApi {
  getState(): Promise<PanelState | null>
  command(command: PanelCommand): Promise<{ ok: boolean; error?: string; state?: PanelState; candidates?: PanelCandidate[] }>
  /** 低频证明当前手势仍持有指针；不携带坐标、不触发原生几何帧。 */
  dragHeartbeat(interactionId: number): void
  onState(callback: (state: PanelState) => void): () => void
  onDrag(callback: (feedback: PanelDragFeedback) => void): () => void
  onPreview(callback: (snapshot: PanelPreviewSnapshot) => void): () => void
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
}

/** 面板呼出快捷键保存 + 重注册结果（镜像 QuickHotkeyApplyResult 的返回语义，供设置页展示真实注册状态）。 */
export interface PanelHotkeyApplyResult {
  ok: boolean
  enabled: boolean
  /** 当前生效的快捷键；未开启或注册失败时可能为空。 */
  hotkey: string
  error?: string
}

/**
 * 面板矩形与组件约束（主进程与 chrome 共用，避免两端魔法数字漂移）。
 * 组件无标题条：插件原生视图从组件矩形内缩 PANEL_WIDGET_INSET，
 * 拖动热区由 chrome 在组件四周边缘绘制（panel.css）。
 */
/** 组件原生视图四周的透明操作热区；仅留出拖动/缩放命中范围，不绘制常态外壳。 */
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
/** 手势静止时也需续期；主进程有独立超时与原生失焦取消。 */
export const PANEL_DRAG_HEARTBEAT_INTERVAL_MS = 2000
