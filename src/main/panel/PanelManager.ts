/**
 * PanelManager — 自由面板编排
 * 职责：面板的创建/关闭、组件增删与落位、拖动 tick、吸附反馈、持久化与启动恢复。
 * 模块隔离：
 *  - 不 import PluginHost；插件运行时能力通过 PanelPluginHost 窄接口注入（bindPanelPluginHost）。
 *  - 不 import 具体窗口实现细节；原生窗口由 panelWindows 提供，事件经 PanelWindowHost 回调回流。
 * 性能约束：
 *  - 拖动由主进程 tick 驱动（读光标 + setBounds），渲染层不逐帧上报矩形。
 *  - 拖动中只做 setBounds 与（吸附变化时）一次 IPC；不重排 child view、不改窗口材质。
 */
import { screen } from 'electron'
import { randomUUID } from 'node:crypto'
import {
  PANEL_MAX_PANELS,
  PANEL_MAX_WIDGETS,
  PANEL_MIN_HEIGHT,
  PANEL_MIN_WIDTH,
  PANEL_WIDGET_MIN_HEIGHT,
  type PanelAppearance,
  type PanelBounds,
  type PanelCandidate,
  type PanelCommand,
  type PanelDragMode,
  type PanelResizeEdge,
  type PanelState,
  type PanelWidgetRect,
  type PanelWidgetState,
  type PersistedPanel,
  type PersistedPanelWidget
} from '@shared/types/panel'
import type { PluginPlacement } from '@shared/types/plugin-window'
import type { View } from 'electron'
import { logInfo, logWarn } from '@main/logs/logService'
import { pluginRegistry } from '@main/plugin/PluginRegistry'
import { isEnabledSync } from '@main/plugin/pluginEnabledStore'
import { settingsStore } from '@main/settings/SettingsStore'
import { sendShellEvent } from '@main/window/createShellWindow'
import {
  bindPanelWindowHost,
  broadcastPanelAppearance,
  broadcastPanelTheme,
  createPanelWindow,
  destroyAllPanelWindows,
  destroyPanelWindow,
  getPanelContentParent,
  getPanelContentSize,
  getPanelForSender,
  getPanelWindowRecord,
  layoutPanelChrome,
  markPanelChromeReady,
  pushDragFeedback,
  pushState,
  setPluginViewBounds,
  type PanelWindowHost,
  type PanelWindowRecord
} from '@main/window/panelWindows'
import {
  applyDrag,
  clampRect,
  computeSnap,
  findFreeSlot,
  fitWidgetsToPanel,
  movableEdges,
  rectAtPointer
} from '@main/panel/panelGeometry'
import { destroyDetachedWindow, getDetachedWindow } from '@main/window/detachedPluginWindows'
import {
  cancelScheduledPanels,
  flushPanels,
  isFreePanelEnabled,
  readPanelAppearance,
  readPanels,
  schedulePanels
} from '@main/panel/panelStore'

/** 插件运行时窄接口：由 PluginHost 实现并注入，避免面板模块反向依赖。 */
export interface PanelPluginHost {
  /** 把插件挂到面板（移动语义）。rect 为组件矩形（含组件条）。 */
  mountInPanel(pluginId: string, panelId: string): Promise<void>
  /** 把插件移出面板：target 决定回到 shell Tab 还是独立窗口。 */
  unmountFromPanel(pluginId: string, target: 'shell' | 'detached', position?: { x: number; y: number }): Promise<void>
  /** 面板内组件的原生视图 bounds（组件矩形 → 视图矩形由 panelWindows 换算）。 */
  setPanelWidgetBounds(pluginId: string, rect: PanelWidgetRect): void
  /**
   * 拖动期间临时隐藏/恢复组件的插件视图。
   * 必须隐藏：光标掠过插件原生 view 时 OS 输入会路由到该 view，chrome 文档收不到
   * pointer 事件，拖动会卡死；隐藏后指针始终留在 chrome 内，capture 持续有效。
   */
  setPanelWidgetVisibility(pluginId: string, visible: boolean): void
  /** 关闭面板内所有插件运行时（完整 closePlugin 链路）。 */
  closePanelPlugins(panelIds: string[]): Promise<void>
  /** 当前插件所处 placement（用于候选过滤与去重）。 */
  getPlacement(pluginId: string): PluginPlacement
  /** 面板内插件的显示状态（标题/图标/错误）。 */
  describePanelWidget(pluginId: string): { title: string; icon?: string | null; glyph?: string; status: PanelWidgetState['status']; error?: string } | null
  /** 插件原生视图引用（布局用）。 */
  getPluginView(pluginId: string): View | null
}

interface WidgetRecord extends PersistedPanelWidget {
  /** 拖动前的矩形，用于取消时还原。 */
  startRect?: PanelWidgetRect
}

interface PanelRecord {
  id: string
  bounds: PanelBounds
  widgets: Map<string, WidgetRecord>
  /** 组件层叠计数。 */
  zCounter: number
  closing: boolean
  /** 启动恢复中：插件尚未挂载。 */
  restoring: boolean
  /** chrome 覆盖层（右键菜单/选择器）打开中：插件原生视图必须让位。 */
  overlay: boolean
  /** 整块面板正在被主进程驱动移动/缩放：期间抑制插件视图并暂停事件回流的重复持久化。 */
  windowDragging: boolean
}

interface DragSession {
  panelId: string
  pluginId: string
  mode: PanelDragMode
  edge?: PanelResizeEdge
  startRect: PanelWidgetRect
  startPointer: { x: number; y: number }
  frame: ReturnType<typeof setTimeout> | null
  watchdog: ReturnType<typeof setInterval> | null
  lastInput: number
  lastGuides: string
  lastRect: PanelWidgetRect
  ending: boolean
}

const panels = new Map<string, PanelRecord>()
let host: PanelPluginHost | null = null
let drag: DragSession | null = null
/** 整块面板的移动/缩放会话（与组件拖动互斥）。 */
interface WindowDragSession {
  panelId: string
  mode: PanelDragMode
  edge?: PanelResizeEdge
  /** 起始时窗口的屏幕绝对 bounds。 */
  startBounds: { x: number; y: number; width: number; height: number }
  /** 起始时光标的屏幕绝对坐标。 */
  startPointer: { x: number; y: number }
  frame: ReturnType<typeof setTimeout> | null
  watchdog: ReturnType<typeof setInterval> | null
  lastInput: number
  ending: boolean
}
let windowDrag: WindowDragSession | null = null
/** 拖动无渲染层输入超过该时长视为 chrome 失联，安全收尾。 */
const DRAG_IDLE_TIMEOUT_MS = 30_000
/** 恢复队列：控制开机时并发拉起渲染进程的数量。 */
const restoreQueue: Array<{ panelId: string; pluginId: string }> = []
let restoreWorkers = 0
const RESTORE_CONCURRENCY = 2

export function bindPanelPluginHost(value: PanelPluginHost | null): void {
  host = value
}

function requireHost(): PanelPluginHost {
  if (!host) throw new Error('panel plugin host is not ready')
  return host
}

/** 功能未开启时所有入口统一拒绝（IPC 层也做前置守卫）。 */
export function assertFreePanelEnabled(): void {
  if (!isFreePanelEnabled()) throw new Error('自由面板未开启')
}

// —— 持久化 ——

function snapshot(): PersistedPanel[] {
  return [...panels.values()].map(record => ({
    id: record.id,
    bounds: { ...record.bounds },
    widgets: [...record.widgets.values()]
      .sort((a, b) => a.z - b.z)
      .map(({ pluginId, x, y, width, height, z }) => ({ pluginId, x, y, width, height, z }))
  }))
}

function persist(immediate = false): void {
  const data = snapshot()
  if (immediate) void flushPanels(data)
  else schedulePanels(data)
}

// —— 状态投影 ——

function widgetState(record: PanelRecord, widget: WidgetRecord): PanelWidgetState {
  const described = host?.describePanelWidget(widget.pluginId) ?? null
  return {
    pluginId: widget.pluginId,
    x: widget.x, y: widget.y, width: widget.width, height: widget.height, z: widget.z,
    title: described?.title ?? pluginRegistry.get(widget.pluginId)?.name ?? widget.pluginId,
    icon: described?.icon ?? pluginRegistry.get(widget.pluginId)?.icon ?? null,
    glyph: described?.glyph ?? pluginRegistry.get(widget.pluginId)?.glyph,
    status: described?.status ?? (record.restoring ? 'loading' : 'ready'),
    error: described?.error
  }
}

function panelState(record: PanelRecord): PanelState {
  const existing = getPanelWindowRecord(record.id)?.state
  const size = getPanelContentSize(record.id)
  return {
    id: record.id,
    width: size.width,
    height: size.height,
    widgets: [...record.widgets.values()].sort((a, b) => a.z - b.z).map(widget => widgetState(record, widget)),
    appearance: readPanelAppearance(),
    theme: existing?.theme ?? { mode: 'light', tokens: {}, animationLevel: 'medium' },
    // theme 与 resolvedAppearance 必须成对保留：chrome 靠后者应用 V2 语义，缺一会退回默认外观。
    resolvedAppearance: existing?.resolvedAppearance,
    widgetLimit: PANEL_MAX_WIDGETS
  }
}

/** 推送面板状态；面板窗口不存在时静默。 */
export function publishPanel(panelId: string): void {
  const record = panels.get(panelId)
  const native = getPanelWindowRecord(panelId)
  if (!record || !native) return
  native.state = panelState(record)
  pushState(native)
}

/** 通知主壳刷新（设置页/入口展示面板数量）。 */
function notifyShell(): void {
  try { sendShellEvent({ type: 'panels-changed' }) } catch { /* 壳可能尚未就绪 */ }
}

// —— 布局 ——

/** 把组件矩形应用到原生视图。拖动高频路径只走这里。 */
function applyWidgetBounds(panelId: string, widget: WidgetRecord): void {
  const view = host?.getPluginView(widget.pluginId)
  if (view) setPluginViewBounds(view, widget)
  void panelId
}

/** 面板尺寸变化后重排所有组件视图（不重建 child view）。 */
export function layoutPanelWidgets(panelId: string): void {
  const record = panels.get(panelId)
  if (!record) return
  const native = getPanelWindowRecord(panelId)
  if (!native) return
  layoutPanelChrome(native)
  const size = getPanelContentSize(panelId)
  for (const widget of record.widgets.values()) {
    const fitted = clampRect(widget, size)
    if (fitted.x !== widget.x || fitted.y !== widget.y || fitted.width !== widget.width || fitted.height !== widget.height) {
      Object.assign(widget, fitted)
    }
    applyWidgetBounds(panelId, widget)
  }
  publishPanel(panelId)
}

function otherRects(record: PanelRecord, exclude?: string): PanelWidgetRect[] {
  return [...record.widgets.values()]
    .filter(widget => widget.pluginId !== exclude)
    .map(({ x, y, width, height }) => ({ x, y, width, height }))
}

// —— 拖动 ——

/**
 * 中心化组件可见性：拖动（组件或整块面板）中、或 chrome 覆盖层（菜单/选择器）打开时，
 * 插件原生视图全部隐藏。原生视图在 OS 层截走指针、也遮挡 DOM 覆盖层；
 * 恢复可见时由 PluginHost 按 isPresented 判定。所有隐藏路径共用这一个状态机。
 */
function syncPanelVisibility(panelId: string): void {
  const record = panels.get(panelId)
  if (!record) return
  const hidden = record.overlay || record.windowDragging || (!!drag && drag.panelId === panelId)
  for (const pluginId of record.widgets.keys()) host?.setPanelWidgetVisibility(pluginId, !hidden)
}

function dragTick(session: DragSession): void {
  if (drag !== session || session.ending) return
  const record = panels.get(session.panelId)
  const native = getPanelWindowRecord(session.panelId)
  const widget = record?.widgets.get(session.pluginId)
  if (!record || !native || !widget) { endDrag(true); return }
  const cursor = screen.getCursorScreenPoint()
  const windowBounds = native.window.getContentBounds()
  const local = { x: cursor.x - windowBounds.x, y: cursor.y - windowBounds.y }
  const delta = { x: local.x - session.startPointer.x, y: local.y - session.startPointer.y }
  const size = { width: windowBounds.width, height: windowBounds.height }
  const moved = applyDrag(session.startRect, session.mode, session.edge, delta, size)
  const snapped = computeSnap(moved, otherRects(record, session.pluginId), size, {
    movable: movableEdges(session.mode, session.edge)
  })
  const rect = snapped.rect
  widget.x = rect.x; widget.y = rect.y; widget.width = rect.width; widget.height = rect.height
  applyWidgetBounds(session.panelId, widget)

  // 仅在矩形或辅助线集合变化时推送，避免逐帧 IPC。
  const guideKey = snapped.guides.map(guide => `${guide.axis}:${guide.position}:${guide.from}:${guide.to}`).join('|')
  const rectChanged = rect.x !== session.lastRect.x || rect.y !== session.lastRect.y
    || rect.width !== session.lastRect.width || rect.height !== session.lastRect.height
  if (rectChanged || guideKey !== session.lastGuides) {
    session.lastRect = rect
    session.lastGuides = guideKey
    pushDragFeedback(native, { active: true, pluginId: session.pluginId, rect, guides: snapped.guides })
  }
  session.frame = null
}

function scheduleDragTick(session: DragSession): void {
  if (session.frame || session.ending) return
  session.frame = setTimeout(() => { session.frame = null; if (drag === session) dragTick(session) }, 0)
}

/** 渲染层保活触发：把下一帧 tick 排上（主进程自行读光标）；同时刷新存活时间。 */
export function panelDragTick(senderId: number): void {
  const panelId = getPanelForSender(senderId)
  if (!panelId || !drag || drag.panelId !== panelId) return
  drag.lastInput = Date.now()
  scheduleDragTick(drag)
}

function beginDrag(panelId: string, pluginId: string, mode: PanelDragMode, edge?: PanelResizeEdge, pointer?: { x: number; y: number }): void {
  const record = panels.get(panelId)
  const widget = record?.widgets.get(pluginId)
  const native = getPanelWindowRecord(panelId)
  if (!record || !widget || !native) return
  if (drag) endDrag(true)
  const cursor = screen.getCursorScreenPoint()
  const windowBounds = native.window.getContentBounds()
  const session: DragSession = {
    panelId, pluginId, mode, edge,
    startRect: { x: widget.x, y: widget.y, width: widget.width, height: widget.height },
    startPointer: pointer ?? { x: cursor.x - windowBounds.x, y: cursor.y - windowBounds.y },
    frame: null, watchdog: null, lastInput: Date.now(),
    lastGuides: '', lastRect: { x: widget.x, y: widget.y, width: widget.width, height: widget.height },
    ending: false
  }
  drag = session
  // 拖动期间隐藏本面板**所有**组件的原生视图：任何原生 view 都会在 OS 层截走指针，
  // 被拖组件经过其它组件时同样会让 chrome 丢失 pointerup 而卡死。
  // 视觉反馈由 chrome 的组件条（DOM）+ 跟随框 + 辅助线承担，结束时无条件恢复可见。
  syncPanelVisibility(panelId)
  // 看门狗：chrome 失联（卡死/文档被切走）超过阈值时安全收尾，避免组件视图永久隐藏。
  session.watchdog = setInterval(() => {
    if (drag !== session || session.ending) return
    if (Date.now() - session.lastInput > DRAG_IDLE_TIMEOUT_MS || native.window.isDestroyed()) endDrag(true)
  }, 1000)
  session.watchdog.unref?.()
  scheduleDragTick(session)
}

function endDrag(cancel: boolean): void {
  const session = drag
  if (!session) return
  session.ending = true
  if (session.frame) { clearTimeout(session.frame); session.frame = null }
  if (session.watchdog) { clearInterval(session.watchdog); session.watchdog = null }
  drag = null
  const record = panels.get(session.panelId)
  const widget = record?.widgets.get(session.pluginId)
  const native = getPanelWindowRecord(session.panelId)
  if (record && widget) {
    if (cancel) {
      widget.x = session.startRect.x; widget.y = session.startRect.y
      widget.width = session.startRect.width; widget.height = session.startRect.height
    }
    applyWidgetBounds(session.panelId, widget)
    persist(true)
    publishPanel(session.panelId)
  }
  syncPanelVisibility(session.panelId)
  if (native) pushDragFeedback(native, { active: false, pluginId: session.pluginId })
}

// —— 整块面板移动 / 缩放 ——

/**
 * 面板窗口移动/缩放：主进程驱动。
 * 不用 -webkit-app-region: drag —— 该区域的右键不会触发 contextmenu，
 * 而面板的「添加组件」入口正是空白处右键，因此这里与组件拖动共用同一套 tick 方案。
 */
function windowDragTick(session: WindowDragSession): void {
  if (windowDrag !== session || session.ending) return
  const native = getPanelWindowRecord(session.panelId)
  if (!native || native.window.isDestroyed()) { endWindowDrag(true); return }
  session.frame = null
  const cursor = screen.getCursorScreenPoint()
  const dx = cursor.x - session.startPointer.x
  const dy = cursor.y - session.startPointer.y
  const start = session.startBounds
  let next = { ...start }
  if (session.mode === 'move') {
    next = { ...start, x: Math.round(start.x + dx), y: Math.round(start.y + dy) }
  } else {
    const edge = session.edge ?? 'se'
    const minW = PANEL_MIN_WIDTH, minH = PANEL_MIN_HEIGHT
    let right = start.x + start.width, bottom = start.y + start.height
    if (edge.includes('w')) { next.x = Math.round(Math.min(start.x + dx, right - minW)); next.width = right - next.x }
    if (edge.includes('e')) next.width = Math.max(minW, Math.round(start.width + dx))
    if (edge.includes('n')) { next.y = Math.round(Math.min(start.y + dy, bottom - minH)); next.height = bottom - next.y }
    if (edge.includes('s')) next.height = Math.max(minH, Math.round(start.height + dy))
  }
  native.window.setBounds(next)
}

function scheduleWindowDragTick(session: WindowDragSession): void {
  if (session.frame || session.ending) return
  session.frame = setTimeout(() => { if (windowDrag === session) windowDragTick(session) }, 0)
}

function beginWindowDrag(panelId: string, mode: PanelDragMode, edge?: PanelResizeEdge): void {
  const native = getPanelWindowRecord(panelId)
  const record = panels.get(panelId)
  if (!native || !record || native.window.isDestroyed()) return
  if (windowDrag) endWindowDrag(true)
  if (drag) endDrag(true)
  const bounds = native.window.getBounds()
  const cursor = screen.getCursorScreenPoint()
  const session: WindowDragSession = {
    panelId, mode, edge,
    startBounds: { ...bounds },
    startPointer: cursor,
    frame: null, watchdog: null, lastInput: Date.now(), ending: false
  }
  windowDrag = session
  record.windowDragging = true
  // 移动整块面板时插件视图同样会截走指针，必须临时隐藏（与组件拖动一致）。
  syncPanelVisibility(panelId)
  session.watchdog = setInterval(() => {
    if (windowDrag !== session || session.ending) return
    if (Date.now() - session.lastInput > DRAG_IDLE_TIMEOUT_MS || native.window.isDestroyed()) endWindowDrag(true)
  }, 1000)
  session.watchdog.unref?.()
  scheduleWindowDragTick(session)
}

function endWindowDrag(cancel: boolean): void {
  const session = windowDrag
  if (!session) return
  session.ending = true
  if (session.frame) { clearTimeout(session.frame); session.frame = null }
  if (session.watchdog) { clearInterval(session.watchdog); session.watchdog = null }
  windowDrag = null
  const record = panels.get(session.panelId)
  const native = getPanelWindowRecord(session.panelId)
  if (record) record.windowDragging = false
  if (cancel && native && !native.window.isDestroyed()) native.window.setBounds(session.startBounds)
  if (native && !native.window.isDestroyed()) {
    // 落定后同步一次记录（窗口事件在拖动期间被跳过，避免高频持久化）。
    const bounds = native.window.getBounds()
    onGeometryChanged(session.panelId, { ...bounds, displayId: screen.getDisplayMatching(bounds).id })
  }
  syncPanelVisibility(session.panelId)
}

/** chrome 的整块面板拖动保活（主进程自行读光标）。 */
export function panelWindowDragTick(senderId: number): void {
  const panelId = getPanelForSender(senderId)
  if (!panelId || !windowDrag || windowDrag.panelId !== panelId) return
  windowDrag.lastInput = Date.now()
  scheduleWindowDragTick(windowDrag)
}

// —— 组件操作 ——

function nextZ(record: PanelRecord): number {
  record.zCounter += 1
  return record.zCounter
}

function raiseWidget(panelId: string, pluginId: string): void {
  const record = panels.get(panelId)
  const widget = record?.widgets.get(pluginId)
  if (!record || !widget) return
  widget.z = nextZ(record)
  // 拖动进行中该组件的原生视图被隐藏，此刻重排没有意义且违反「拖动不重排 child」红线；
  // 结束恢复可见时按既有父容器顺序即可（面板内组件通常拼接、不重叠）。
  if (drag && drag.panelId === panelId && drag.pluginId === pluginId) return
  const view = host?.getPluginView(pluginId)
  const parent = getPanelContentParent(panelId)
  if (view && parent) {
    try { parent.removeChildView(view); parent.addChildView(view) } catch { /* view 可能已销毁 */ }
  }
}

/** 候选插件：已安装、已启用、且未被其它面板占用。 */
export function listPanelCandidates(excludePanelId?: string): PanelCandidate[] {
  const occupied = new Map<string, string>()
  for (const record of panels.values()) {
    for (const pluginId of record.widgets.keys()) occupied.set(pluginId, record.id)
  }
  return pluginRegistry.list()
    .filter(summary => summary.installed && isEnabledSync(summary.id))
    .filter(summary => {
      const owner = occupied.get(summary.id)
      if (!owner) return true
      if (owner === excludePanelId) return false
      // 已在其它面板中的插件也不可重复添加（单实例运行时）。
      return false
    })
    .map(summary => ({
      pluginId: summary.id,
      name: summary.name,
      icon: summary.icon ?? null,
      glyph: summary.glyph,
      category: summary.category
    }))
}

/**
 * 添加组件。
 * rect 缺省时按落位算法找空位；空间不足则向下/向右扩容面板窗口。
 */
export async function addWidget(panelId: string, pluginId: string, rect?: PanelWidgetRect): Promise<void> {
  assertFreePanelEnabled()
  const record = panels.get(panelId)
  const native = getPanelWindowRecord(panelId)
  if (!record || !native) throw new Error('面板不存在')
  if (record.closing) throw new Error('面板正在关闭')
  if (record.widgets.has(pluginId)) throw new Error('该插件已在此面板中')
  if (record.widgets.size >= PANEL_MAX_WIDGETS) throw new Error(`单个面板最多 ${PANEL_MAX_WIDGETS} 个组件`)
  const summary = pluginRegistry.get(pluginId)
  if (!summary?.installed || !isEnabledSync(pluginId)) throw new Error('插件不可用')
  for (const other of panels.values()) {
    if (other.id !== panelId && other.widgets.has(pluginId)) throw new Error('该插件已在其它面板中')
  }

  const size = getPanelContentSize(panelId)
  const others = otherRects(record)
  let target = rect ? clampRect(rect, size) : findFreeSlot(others, size)
  if (!target) {
    // 空间不足：按现有组件外接尺寸扩容面板窗口（受显示器工作区约束）。
    const needed = Math.max(
      ...others.map(item => item.y + item.height),
      PANEL_WIDGET_MIN_HEIGHT
    ) + PANEL_WIDGET_MIN_HEIGHT + 16
    const display = screen.getDisplayMatching(native.window.getBounds())
    const nextHeight = Math.min(display.workArea.height, needed)
    const current = native.window.getBounds()
    if (nextHeight > current.height) {
      native.window.setBounds({ ...current, height: nextHeight })
      layoutPanelWidgets(panelId)
    }
    const grown = getPanelContentSize(panelId)
    target = findFreeSlot(otherRects(record), grown)
    if (!target) throw new Error('面板空间不足，请先移除部分组件')
  }

  const widget: WidgetRecord = {
    pluginId,
    x: target.x, y: target.y, width: target.width, height: target.height,
    z: nextZ(record)
  }
  record.widgets.set(pluginId, widget)
  record.restoring = false
  publishPanel(panelId)
  persist()
  try {
    await requireHost().mountInPanel(pluginId, panelId)
  } catch (error) {
    record.widgets.delete(pluginId)
    publishPanel(panelId)
    persist()
    throw error
  }
  // 面板挂载后独立窗口已无内容：销毁它，避免留下空壳（moveEntry 只在源是 detached 时销毁，
  // 而拖拽路径可能由 PanelManager 先建立面板 placement，故这里显式兜底一次）。
  if (getDetachedWindow(pluginId)) destroyDetachedWindow(pluginId)
  applyWidgetBounds(panelId, widget)
  publishPanel(panelId)
}

/** 移除组件：插件回到主窗 Tab（保留运行时，不销毁）。 */
export async function removeWidget(panelId: string, pluginId: string, target: 'shell' | 'detached' = 'shell'): Promise<void> {
  const record = panels.get(panelId)
  if (!record || !record.widgets.has(pluginId)) return
  record.widgets.delete(pluginId)
  publishPanel(panelId)
  persist()
  const position = target === 'detached' ? screen.getCursorScreenPoint() : undefined
  try {
    await requireHost().unmountFromPanel(pluginId, target, position)
  } catch (error) {
    logWarn('panel', `unmount failed: ${String(error)}`)
  }
}

/**
 * 面板窗口尺寸变化：组件矩形收回内容区并重排。
 * 只重排受影响组件，不触碰其它面板。
 */
function onGeometryChanged(panelId: string, bounds: PanelBounds): void {
  const record = panels.get(panelId)
  if (!record || record.closing) return
  record.bounds = bounds
  // 整块面板拖动/缩放期间不重排组件、不落盘：高频事件只记录最终 bounds（endWindowDrag 统一提交）。
  if (record.windowDragging) return
  const size = getPanelContentSize(panelId)
  const fitted = fitWidgetsToPanel([...record.widgets.values()], size)
  let index = 0
  for (const widget of record.widgets.values()) {
    Object.assign(widget, fitted[index++])
    applyWidgetBounds(panelId, widget)
  }
  layoutPanelChrome(getPanelWindowRecord(panelId)!)
  publishPanel(panelId)
  persist()
}

/**
 * 关闭面板：先释放面板内插件运行时（完整 closePlugin 链路），再销毁窗口、清持久化。
 * 顺序不可颠倒：插件视图仍挂在面板窗口上时必须先摘除。
 */
export async function closePanel(panelId: string): Promise<void> {
  const record = panels.get(panelId)
  if (!record || record.closing) return
  // 先结束拖动：endDrag 会 persist + publish，此时记录仍是「活」的，写入的是关闭前的真实布局；
  // 若先置 closing 再 endDrag，会把即将删除的数据写进持久化。
  endDrag(true)
  record.closing = true
  const pluginIds = [...record.widgets.keys()]
  try {
    if (pluginIds.length) await requireHost().closePanelPlugins(pluginIds)
  } catch (error) {
    logWarn('panel', `close plugins failed: ${String(error)}`)
  }
  destroyPanelWindow(panelId)
  panels.delete(panelId)
  persist(true)
  notifyShell()
  logInfo('panel', `closed ${panelId} (${pluginIds.length} widgets)`)
}

/** 关闭全部面板（开关关闭 / 退出）。keepRecords = 保留布局记录供下次开启恢复。 */
export async function closeAllPanels(keepRecords = false): Promise<void> {
  const ids = [...panels.keys()]
  if (!ids.length) { if (!keepRecords) persist(true); return }
  // 必须在关闭插件前快照：closePlugin 会经 forgetPanelPlugin 摘除组件记录，
  // 之后再 snapshot 只能拿到空布局，keepRecords 就失去意义。
  const preserved = keepRecords ? snapshot() : null
  const pluginIds = ids.flatMap(id => [...(panels.get(id)?.widgets.keys() ?? [])])
  for (const id of ids) {
    const record = panels.get(id)
    if (record) record.closing = true
  }
  endDrag(true)
  try {
    if (pluginIds.length) await requireHost().closePanelPlugins(pluginIds)
  } catch (error) {
    logWarn('panel', `close plugins failed: ${String(error)}`)
  }
  destroyAllPanelWindows()
  panels.clear()
  void flushPanels(preserved ?? [])
  notifyShell()
}

// —— 创建 ——

export interface CreatePanelResult { id: string; bounds: PanelBounds }

/** 用框选结果创建面板（已存在同区域面板时直接返回已有面板）。 */
export async function createPanel(bounds: PanelBounds): Promise<CreatePanelResult> {
  assertFreePanelEnabled()
  if (panels.size >= PANEL_MAX_PANELS) throw new Error(`最多 ${PANEL_MAX_PANELS} 个面板`)
  const id = `panel-${randomUUID().slice(0, 8)}`
  const record: PanelRecord = {
    id, bounds: { ...bounds }, widgets: new Map(), zCounter: 0, closing: false, restoring: false, overlay: false, windowDragging: false
  }
  panels.set(id, record)
  try {
    await createPanelWindow({
      id,
      bounds,
      appearance: readPanelAppearance(),
      widgets: []
    })
  } catch (error) {
    panels.delete(id)
    throw error
  }
  const native = getPanelWindowRecord(id)
  if (native) {
    const actual = native.window.getBounds()
    record.bounds = { ...actual, displayId: screen.getDisplayMatching(actual).id }
  }
  // 推一次包含真实 bounds/外观的快照（createPanelWindow 内部的初始 state 是创建前的值）。
  publishPanel(id)
  persist(true)
  notifyShell()
  logInfo('panel', `created ${id} at ${record.bounds.x},${record.bounds.y} ${record.bounds.width}x${record.bounds.height}`)
  return { id, bounds: record.bounds }
}

/** 拖拽落点嵌入：由 pluginWindowDrag 在指针松开时调用。 */
export async function dropPluginIntoPanel(panelId: string, pluginId: string, localPoint: { x: number; y: number }): Promise<void> {
  const record = panels.get(panelId)
  if (!record) throw new Error('面板不存在')
  const size = getPanelContentSize(panelId)
  const rect = rectAtPointer(localPoint, otherRects(record), size)
  await addWidget(panelId, pluginId, rect)
}

export function listPanels(): Array<{ id: string; bounds: PanelBounds; widgetCount: number }> {
  return [...panels.values()].map(record => ({ id: record.id, bounds: { ...record.bounds }, widgetCount: record.widgets.size }))
}

/**
 * 插件是否已被某个面板登记（无论其 placement 是否已建立）。
 * restoreTabs 用它做竞态窗口内的排除：restorePanels 先建记录、后异步挂载，
 * 只查 placements 会漏掉「已登记但尚未挂载」的插件，导致同一插件既恢复成 Tab 又进面板。
 */
export function isPluginInAnyPanel(pluginId: string): boolean {
  for (const record of panels.values()) if (record.widgets.has(pluginId)) return true
  return false
}

export function getPanelState(panelId: string): PanelState | null {
  const record = panels.get(panelId)
  return record ? panelState(record) : null
}

export function getPanelIdForSender(wcId: number): string | null {
  return getPanelForSender(wcId)
}

/** 插件运行时状态变化（ready/error）后刷新对应面板。 */
export function refreshPanelsForPlugin(pluginId: string): void {
  for (const record of panels.values()) {
    if (record.widgets.has(pluginId)) publishPanel(record.id)
  }
}

/** 插件被其它途径关闭/移出时，从面板记录里摘除（避免幽灵组件）。 */
export function forgetPlugin(pluginId: string): void {
  for (const record of panels.values()) {
    if (!record.widgets.delete(pluginId)) continue
    publishPanel(record.id)
    persist()
  }
}

// —— 恢复 ——

function resolveRestoreBounds(bounds: PanelBounds): PanelBounds {
  const displays = screen.getAllDisplays()
  const display = displays.find(item => item.id === bounds.displayId)
  if (display) {
    const area = display.workArea
    const width = Math.min(bounds.width, area.width)
    const height = Math.min(bounds.height, area.height)
    return {
      x: Math.max(area.x, Math.min(bounds.x, area.x + area.width - width)),
      y: Math.max(area.y, Math.min(bounds.y, area.y + area.height - height)),
      width, height, displayId: display.id
    }
  }
  // 显示器已移除：回落到主显示器工作区并居中。
  const primary = screen.getPrimaryDisplay()
  const area = primary.workArea
  const width = Math.min(bounds.width, area.width)
  const height = Math.min(bounds.height, area.height)
  return {
    x: Math.round(area.x + (area.width - width) / 2),
    y: Math.round(area.y + (area.height - height) / 2),
    width, height, displayId: primary.id
  }
}

/**
 * 启动恢复：先建窗口与 chrome（只画占位条，无插件），再按并发上限逐个冷启动插件。
 * 失败保留记录，显示错误与重试入口。
 */
export async function restorePanels(): Promise<void> {
  if (!isFreePanelEnabled()) return
  const stored = readPanels()
  if (!stored.length) return
  for (const item of stored) {
    const bounds = resolveRestoreBounds(item.bounds)
    const record: PanelRecord = {
      id: item.id, bounds, widgets: new Map(), zCounter: 0, closing: false, restoring: true, overlay: false, windowDragging: false
    }
    for (const widget of item.widgets) {
      record.widgets.set(widget.pluginId, { ...widget })
      record.zCounter = Math.max(record.zCounter, widget.z)
    }
    panels.set(item.id, record)
    try {
      const size = { width: bounds.width, height: bounds.height }
      const fitted = fitWidgetsToPanel([...record.widgets.values()], size)
      let index = 0
      for (const widget of record.widgets.values()) Object.assign(widget, fitted[index++])
      await createPanelWindow({ id: item.id, bounds, appearance: readPanelAppearance(), widgets: [] })
      publishPanel(item.id)
    } catch (error) {
      logWarn('panel', `restore window failed for ${item.id}: ${String(error)}`)
      panels.delete(item.id)
      continue
    }
    for (const widget of record.widgets.values()) restoreQueue.push({ panelId: item.id, pluginId: widget.pluginId })
  }
  persist(true)
  notifyShell()
  drainRestoreQueue()
}

function drainRestoreQueue(): void {
  while (restoreWorkers < RESTORE_CONCURRENCY && restoreQueue.length) {
    const job = restoreQueue.shift()!
    restoreWorkers += 1
    void restoreWidget(job).finally(() => {
      restoreWorkers -= 1
      drainRestoreQueue()
    })
  }
}

async function restoreWidget(job: { panelId: string; pluginId: string }): Promise<void> {
  const record = panels.get(job.panelId)
  const widget = record?.widgets.get(job.pluginId)
  if (!record || !widget || record.closing) return
  try {
    await requireHost().mountInPanel(job.pluginId, job.panelId)
    applyWidgetBounds(job.panelId, widget)
    publishPanel(job.panelId)
  } catch (error) {
    logWarn('panel', `restore widget failed: ${job.pluginId} ${String(error)}`)
    publishPanel(job.panelId)
  }
}

/** 重试单个失败组件（chrome 错误态按钮）。 */
export async function retryWidget(panelId: string, pluginId: string): Promise<void> {
  const record = panels.get(panelId)
  const widget = record?.widgets.get(pluginId)
  if (!record || !widget) return
  try {
    await requireHost().mountInPanel(pluginId, panelId)
    applyWidgetBounds(panelId, widget)
  } catch (error) {
    logWarn('panel', `retry failed: ${pluginId} ${String(error)}`)
  }
  publishPanel(panelId)
}

// —— 外观 ——

export function applyAppearanceToPanels(): void {
  broadcastPanelAppearance(readPanelAppearance())
}

export function refreshPanelThemes(): void {
  broadcastPanelTheme()
}

/** 开关切换：开启时恢复布局，关闭时释放插件并保留记录。 */
export async function syncFreePanelSetting(enabled: boolean): Promise<void> {
  if (enabled) {
    await restorePanels()
    return
  }
  await closeAllPanels(true)
}

/** 退出路径：取消待写、立即落盘。 */
export function preparePanelShutdown(): void {
  cancelScheduledPanels()
  endDrag(true)
  void flushPanels(snapshot())
}

/** 退出清理：销毁窗口（插件已由 PluginHost.destroyAll 释放）。 */
export function disposePanels(): void {
  endDrag(true)
  destroyAllPanelWindows()
  panels.clear()
}

export function markPanelReady(panelId: string): void {
  markPanelChromeReady(panelId)
}

/** 注册窗口事件回流（启动时调用一次）。 */
export function registerPanelWindowHost(): void {
  const windowHost: PanelWindowHost = {
    geometryChanged: (id, bounds) => onGeometryChanged(id, bounds),
    closeRequested: (id) => { void closePanel(id) }
  }
  bindPanelWindowHost(windowHost)
}

/** 由 IPC 层调用的统一命令入口（校验已在 panelHandlers 完成）。 */
export async function handlePanelCommand(
  panelId: string,
  command: PanelCommand
): Promise<{ ok: boolean; error?: string; state?: PanelState; candidates?: PanelCandidate[] }> {
  try {
    switch (command.action) {
      case 'list-candidates':
        return { ok: true, candidates: listPanelCandidates(panelId) }
      case 'add-widget':
        await addWidget(panelId, command.pluginId, command.rect)
        return { ok: true, state: getPanelState(panelId) ?? undefined }
      case 'remove-widget':
        await removeWidget(panelId, command.pluginId, 'shell')
        return { ok: true, state: getPanelState(panelId) ?? undefined }
      case 'retry-widget':
        await retryWidget(panelId, command.pluginId)
        return { ok: true, state: getPanelState(panelId) ?? undefined }
      case 'dock-widget':
        await removeWidget(panelId, command.pluginId, 'shell')
        return { ok: true, state: getPanelState(panelId) ?? undefined }
      case 'close-panel':
        await closePanel(panelId)
        return { ok: true }
      case 'set-appearance': {
        const current = readPanelAppearance()
        const next: PanelAppearance = {
          opacity: Math.min(1, Math.max(0.3, command.appearance.opacity ?? current.opacity)),
          material: command.appearance.material ?? current.material
        }
        await settingsStore.setAll({ general: { panelAppearance: next } })
        applyAppearanceToPanels()
        return { ok: true, state: getPanelState(panelId) ?? undefined }
      }
      case 'widget-drag-begin':
        beginDrag(panelId, command.pluginId, command.mode, command.edge, command.pointer)
        return { ok: true }
      case 'widget-drag-end':
        endDrag(command.cancel === true)
        return { ok: true, state: getPanelState(panelId) ?? undefined }
      case 'window-drag-begin':
        beginWindowDrag(panelId, command.mode, command.edge)
        return { ok: true }
      case 'window-drag-end':
        endWindowDrag(command.cancel === true)
        return { ok: true, state: getPanelState(panelId) ?? undefined }
      case 'raise-widget':
        raiseWidget(panelId, command.pluginId)
        return { ok: true }
      case 'overlay-open': {
        // 覆盖层（右键菜单/选择器）是 chrome DOM；插件原生视图在其之上会挡住点击，
        // 故打开时隐藏本面板全部组件视图，关闭时恢复（拖动进行中由状态机接管）。
        const record = panels.get(panelId)
        if (!record) return { ok: false, error: '面板不存在' }
        record.overlay = true
        syncPanelVisibility(panelId)
        return { ok: true }
      }
      case 'overlay-close': {
        const record = panels.get(panelId)
        if (!record) return { ok: false, error: '面板不存在' }
        record.overlay = false
        syncPanelVisibility(panelId)
        return { ok: true }
      }
      default:
        return { ok: false, error: '未知命令' }
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}
