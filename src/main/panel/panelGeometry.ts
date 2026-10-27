/**
 * panelGeometry — 自由面板的纯几何逻辑
 * 职责：矩形归一与钳制、新组件落位、拖动/缩放的吸附与辅助线计算。
 * 关键约束：本模块**不得**引入 Electron 或任何主进程模块，只做纯数据运算，
 *          以便被 PanelManager、面板窗口布局与单元测试直接复用。
 * 坐标系：全部为面板内容区本地 DIP，左上原点。
 */
import {
  PANEL_SNAP_THRESHOLD,
  PANEL_WIDGET_DEFAULT_HEIGHT,
  PANEL_WIDGET_DEFAULT_WIDTH,
  PANEL_WIDGET_MIN_HEIGHT,
  PANEL_WIDGET_MIN_WIDTH,
  type PanelGuide,
  type PanelPoint,
  type PanelResizeEdge,
  type PanelWidgetRect
} from '@shared/types/panel'

export interface PanelSize { width: number; height: number }

/** 落位时使用的网格步长：既保证视觉整齐，也避免浮点坐标在持久化里累积噪声。 */
const GRID = 8

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value))

function finite(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/** 把任意输入归一为合法组件矩形：取整、满足最小尺寸、限制在面板内容区内。 */
export function clampRect(input: Partial<PanelWidgetRect> | null | undefined, panel: PanelSize): PanelWidgetRect {
  const width = Math.max(PANEL_WIDGET_MIN_WIDTH, Math.round(finite(input?.width, PANEL_WIDGET_DEFAULT_WIDTH)))
  const height = Math.max(PANEL_WIDGET_MIN_HEIGHT, Math.round(finite(input?.height, PANEL_WIDGET_DEFAULT_HEIGHT)))
  const maxWidth = Math.max(PANEL_WIDGET_MIN_WIDTH, Math.round(panel.width))
  const maxHeight = Math.max(PANEL_WIDGET_MIN_HEIGHT, Math.round(panel.height))
  const finalWidth = Math.min(width, maxWidth)
  const finalHeight = Math.min(height, maxHeight)
  return {
    x: Math.round(clamp(finite(input?.x), 0, Math.max(0, maxWidth - finalWidth))),
    y: Math.round(clamp(finite(input?.y), 0, Math.max(0, maxHeight - finalHeight))),
    width: finalWidth,
    height: finalHeight
  }
}

function rectsOverlap(a: PanelWidgetRect, b: PanelWidgetRect, gap = 0): boolean {
  return a.x < b.x + b.width + gap && b.x < a.x + a.width + gap
    && a.y < b.y + b.height + gap && b.y < a.y + a.height + gap
}

/**
 * 为新组件寻找空位：按行扫描（步长 = 网格），返回第一个不与既有组件重叠的位置。
 * 全部被占满时返回 null，由调用方决定是否扩容面板或拒绝添加。
 */
export function findFreeSlot(existing: readonly PanelWidgetRect[], panel: PanelSize, size?: Partial<PanelSize>): PanelWidgetRect | null {
  const width = Math.max(PANEL_WIDGET_MIN_WIDTH, Math.round(size?.width ?? PANEL_WIDGET_DEFAULT_WIDTH))
  const height = Math.max(PANEL_WIDGET_MIN_HEIGHT, Math.round(size?.height ?? PANEL_WIDGET_DEFAULT_HEIGHT))
  if (width > panel.width || height > panel.height) return null
  const lastX = Math.floor((panel.width - width) / GRID) * GRID
  const lastY = Math.floor((panel.height - height) / GRID) * GRID
  for (let y = GRID; y <= lastY; y += GRID) {
    for (let x = GRID; x <= lastX; x += GRID) {
      const candidate: PanelWidgetRect = { x, y, width, height }
      if (!existing.some(rect => rectsOverlap(candidate, rect, GRID / 2))) return candidate
    }
  }
  return null
}

/** 按落点推算「拖入即嵌入」的位置：以指针为中心放置，再吸附与钳制。 */
export function rectAtPointer(point: PanelPoint, others: readonly PanelWidgetRect[], panel: PanelSize, size?: Partial<PanelSize>): PanelWidgetRect {
  const width = Math.max(PANEL_WIDGET_MIN_WIDTH, Math.round(size?.width ?? PANEL_WIDGET_DEFAULT_WIDTH))
  const height = Math.max(PANEL_WIDGET_MIN_HEIGHT, Math.round(size?.height ?? PANEL_WIDGET_DEFAULT_HEIGHT))
  const centered = { x: Math.round(point.x - width / 2), y: Math.round(point.y - height / 2), width, height }
  return computeSnap(centered, others, panel).rect
}

/** 吸附候选线：某轴上的位置集合。 */
interface AxisCandidates {
  positions: number[]
}

function axisCandidates(others: readonly PanelWidgetRect[], panel: PanelSize, axis: 'x' | 'y'): AxisCandidates {
  const positions: number[] = axis === 'x'
    ? [0, panel.width / 2, panel.width]
    : [0, panel.height / 2, panel.height]
  for (const rect of others) {
    if (axis === 'x') positions.push(rect.x, rect.x + rect.width / 2, rect.x + rect.width)
    else positions.push(rect.y, rect.y + rect.height / 2, rect.y + rect.height)
  }
  return { positions }
}

/** 一个轴上的吸附结果：位移量与该轴上命中的辅助线。 */
interface AxisSnap { delta: number; position: number | null }

/**
 * 在单轴上为移动中的矩形寻找最优吸附。
 * movableEdges 是本次拖动真正会移动的边（移动 = 三条边都动；缩放 = 只动被拖的那条）。
 */
function snapAxis(
  edges: Array<{ value: number; kind: 'start' | 'center' | 'end' }>,
  candidates: AxisCandidates,
  threshold: number
): AxisSnap {
  let best: AxisSnap = { delta: 0, position: null }
  let bestDistance = threshold + 1
  for (const edge of edges) {
    for (const target of candidates.positions) {
      const distance = Math.abs(target - edge.value)
      if (distance > threshold || distance >= bestDistance) continue
      bestDistance = distance
      best = { delta: target - edge.value, position: target }
    }
  }
  return best
}

function edgesFor(rect: PanelWidgetRect, axis: 'x' | 'y', movable: MovableEdges): Array<{ value: number; kind: 'start' | 'center' | 'end' }> {
  const start = axis === 'x' ? rect.x : rect.y
  const size = axis === 'x' ? rect.width : rect.height
  const out: Array<{ value: number; kind: 'start' | 'center' | 'end' }> = []
  if (movable.start) out.push({ value: start, kind: 'start' })
  if (movable.end) out.push({ value: start + size, kind: 'end' })
  if (movable.start || movable.end) out.push({ value: start + size / 2, kind: 'center' })
  return out
}

export interface MovableEdges { start: boolean; end: boolean }

/** 拖动/缩放时哪些边在移动：move 三条都动；resize 只动被抓住的边。 */
export function movableEdges(mode: 'move' | 'resize', edge?: PanelResizeEdge): { x: MovableEdges; y: MovableEdges } {
  if (mode === 'move') return { x: { start: true, end: true }, y: { start: true, end: true } }
  const has = (token: string): boolean => !!edge && edge.includes(token as never)
  return { x: { start: has('w'), end: has('e') }, y: { start: has('n'), end: has('s') } }
}

/**
 * 计算吸附后的矩形与辅助线。
 * 同时最多输出一横一竖两条线；未命中任何候选时原样返回。
 */
export function computeSnap(
  candidate: PanelWidgetRect,
  others: readonly PanelWidgetRect[],
  panel: PanelSize,
  options?: { threshold?: number; movable?: { x: MovableEdges; y: MovableEdges } }
): { rect: PanelWidgetRect; guides: PanelGuide[] } {
  const threshold = options?.threshold ?? PANEL_SNAP_THRESHOLD
  const movable = options?.movable ?? { x: { start: true, end: true }, y: { start: true, end: true } }
  const rect: PanelWidgetRect = { ...candidate }
  const guides: PanelGuide[] = []

  const snapX = snapAxis(edgesFor(rect, 'x', movable.x), axisCandidates(others, panel, 'x'), threshold)
  if (snapX.position !== null) {
    rect.x = Math.round(rect.x + snapX.delta)
    guides.push(guideFor('x', snapX.position, rect, others, panel))
  }
  const snapY = snapAxis(edgesFor(rect, 'y', movable.y), axisCandidates(others, panel, 'y'), threshold)
  if (snapY.position !== null) {
    rect.y = Math.round(rect.y + snapY.delta)
    guides.push(guideFor('y', snapY.position, rect, others, panel))
  }
  return { rect, guides }
}

/**
 * 辅助线的可视范围：覆盖面板全高/全宽中最小的「足以说明对齐关系」的区间。
 * 直接横跨整个面板会让画面过于嘈杂，这里取参与对齐的矩形与候选线的并集。
 */
function guideFor(axis: 'x' | 'y', position: number, rect: PanelWidgetRect, others: readonly PanelWidgetRect[], panel: PanelSize): PanelGuide {
  let from = axis === 'x' ? rect.y : rect.x
  let to = axis === 'x' ? rect.y + rect.height : rect.x + rect.width
  for (const other of others) {
    const touches = axis === 'x'
      ? [other.x, other.x + other.width / 2, other.x + other.width].some(value => Math.abs(value - position) < 0.5)
      : [other.y, other.y + other.height / 2, other.y + other.height].some(value => Math.abs(value - position) < 0.5)
    if (!touches) continue
    from = Math.min(from, axis === 'x' ? other.y : other.x)
    to = Math.max(to, axis === 'x' ? other.y + other.height : other.x + other.width)
  }
  const limit = axis === 'x' ? panel.height : panel.width
  return {
    axis,
    position: Math.round(position),
    from: Math.round(Math.max(0, from - GRID)),
    to: Math.round(Math.min(limit, to + GRID))
  }
}

/**
 * 按拖动模式把指针位移换算为矩形。
 * 缩放时同时守住最小尺寸，避免边被拖过对边导致矩形翻转。
 */
export function applyDrag(
  start: PanelWidgetRect,
  mode: 'move' | 'resize',
  edge: PanelResizeEdge | undefined,
  delta: PanelPoint,
  panel: PanelSize
): PanelWidgetRect {
  if (mode === 'move') {
    return clampRect({ ...start, x: start.x + delta.x, y: start.y + delta.y }, panel)
  }
  let { x, y, width, height } = start
  const right = start.x + start.width
  const bottom = start.y + start.height
  if (edge?.includes('w')) {
    x = Math.min(start.x + delta.x, right - PANEL_WIDGET_MIN_WIDTH)
    width = right - x
  }
  if (edge?.includes('e')) width = Math.max(PANEL_WIDGET_MIN_WIDTH, start.width + delta.x)
  if (edge?.includes('n')) {
    y = Math.min(start.y + delta.y, bottom - PANEL_WIDGET_MIN_HEIGHT)
    height = bottom - y
  }
  if (edge?.includes('s')) height = Math.max(PANEL_WIDGET_MIN_HEIGHT, start.height + delta.y)
  return clampRect({ x, y, width, height }, panel)
}

/** 面板窗口尺寸变化后重新排布：尽量保留原位置，超出则整体收缩回内容区。 */
export function fitWidgetsToPanel(widgets: readonly PanelWidgetRect[], panel: PanelSize): PanelWidgetRect[] {
  return widgets.map(rect => clampRect(rect, panel))
}

/** 圆整为整数矩形，供 view.setBounds 使用（避免子像素抖动）。 */
export function toIntegerRect(rect: PanelWidgetRect): PanelWidgetRect {
  return {
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    width: Math.max(1, Math.round(rect.width)),
    height: Math.max(1, Math.round(rect.height))
  }
}
