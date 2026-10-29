/**
 * PanelManager — 自由面板编排
 * 职责：面板的创建/关闭、组件增删与落位、拖动 tick、吸附反馈、持久化与启动恢复。
 * 模块隔离：
 *  - 不 import PluginHost；插件运行时能力通过 PanelPluginHost 窄接口注入（bindPanelPluginHost）。
 *  - 不 import 具体窗口实现细节；原生窗口由 panelWindows 提供，事件经 PanelWindowHost 回调回流。
 * 性能约束：
 *  - 拖动由主进程 tick 驱动（读光标 + setBounds），渲染层不逐帧上报矩形。
 *  - 拖动中只做 setBounds 与变化后的几何反馈；不重排 child view、不改窗口材质。
 */
import { screen } from 'electron'
import { randomUUID } from 'node:crypto'
import {
  PANEL_MAX_PANELS,
  PANEL_MAX_WIDGETS,
  PANEL_MIN_HEIGHT,
  PANEL_MIN_WIDTH,
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
import { resolvePluginViews } from '@shared/types/plugin'
import { supportsPanelLayout } from '@shared/pluginPresentation'
import type { View } from 'electron'
import { logInfo, logWarn } from '@main/logs/logService'
import { pluginRegistry } from '@main/plugin/PluginRegistry'
import { isEnabledSync } from '@main/plugin/pluginEnabledStore'
import { settingsStore } from '@main/settings/SettingsStore'
import { appearanceService } from '@main/theme/appearanceService'
import { getMainWindow, sendShellEvent } from '@main/window/createShellWindow'
import {
  bindPanelWindowHost,
  broadcastPanelAppearance,
  broadcastPanelTheme,
  capturePanelWidgetPreview,
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
  pushPanelPreview,
  pushState,
  setPluginViewBounds,
  type PanelWindowHost
} from '@main/window/panelWindows'
import {
  applyDrag,
  clampRect,
  computeSnap,
  findPanelExpansion,
  findFreeSlot,
  fitWidgetsToPanel,
  movableEdges,
  rectAtPointer
} from '@main/panel/panelGeometry'
import { destroyDetachedWindow, getDetachedWindow } from '@main/window/detachedPluginWindows'
import { cancelRegionSelection } from '@main/panel/regionSelection'
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
  /** 把插件挂到面板（移动语义）。rect 为组件矩形（插件可视区域）。 */
  mountInPanel(pluginId: string, panelId: string, guard?: () => boolean): Promise<void>
  /** 把插件移出面板：target 决定回到 shell Tab 还是独立窗口。 */
  unmountFromPanel(pluginId: string, target: 'shell' | 'detached', position?: { x: number; y: number }): Promise<void>
  /** 恢复旧布局中的未挂载组件时，显式打开主窗而不是套用兼容组件界面。 */
  openInShell(pluginId: string, guard: () => boolean): Promise<void>
  /**
   * 拖动期间临时隐藏/恢复组件的插件视图。
   * 必须隐藏：光标掠过插件原生 view 时 OS 输入会路由到该 view，chrome 文档收不到
   * pointer 事件，拖动会卡死；隐藏后指针始终留在 chrome 内，capture 持续有效。
   */
  setPanelWidgetVisibility(pluginId: string, visible: boolean): void
  /** 关闭面板内所有插件运行时（完整 closePlugin 链路）。 */
  closePanelPlugins(pluginIds: string[]): Promise<void>
  /** 当前插件所处 placement（用于候选过滤与去重）。 */
  getPlacement(pluginId: string): PluginPlacement
  /** 面板内插件的显示状态（标题/图标/错误）。 */
  describePanelWidget(pluginId: string): { title: string; icon?: string | null; glyph?: string; status: PanelWidgetState['status']; error?: string } | null
  /** 插件原生视图引用（布局用）。 */
  getPluginView(pluginId: string): View | null
}

interface WidgetRecord extends PersistedPanelWidget {
  loading?: boolean
  error?: string
  mounting?: Promise<void>
  removing?: boolean
}

interface PanelRecord {
  id: string
  bounds: PanelBounds
  widgets: Map<string, WidgetRecord>
  /** 组件层叠计数。 */
  zCounter: number
  closing: boolean
  /** chrome 覆盖层（右键菜单/选择器）打开中：插件原生视图必须让位。 */
  overlay: boolean
  /** 整块面板正在被主进程驱动移动/缩放：期间抑制插件视图并暂停事件回流的重复持久化。 */
  windowDragging: boolean
}

interface DragSession {
  panelId: string
  interactionId: number
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
let shuttingDown = false
let lifecycleEpoch = 0
let lifecycleQueue: Promise<void> = Promise.resolve()
let pendingCloses = 0
let closingLayout: PersistedPanel[] | null = null
/** 整块面板的移动/缩放会话（与组件拖动互斥）。 */
interface WindowDragSession {
  panelId: string
  interactionId: number
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
interface RestoreJob { record: PanelRecord; widget: WidgetRecord; epoch: number }
const restoreQueue: RestoreJob[] = []
let restoreWorkers = 0
const RESTORE_CONCURRENCY = 2

interface PreviewSession {
  record: PanelRecord
  revision: number
  attempted: Map<string, View>
  bytes: number
}
interface PreviewJob { session: PreviewSession; widget: WidgetRecord; view: View; displayScale: number }
const previewSessions = new Map<string, PreviewSession>()
const previewQueue: PreviewJob[] = []
let previewRevision = 0
let previewWorkers = 0
const PREVIEW_CONCURRENCY = 2
const PREVIEW_SESSION_BYTES = 3 * 1024 * 1024

export function bindPanelPluginHost(value: PanelPluginHost | null): void {
  host = value
}

function requireHost(): PanelPluginHost {
  if (!host) throw new Error('panel plugin host is not ready')
  return host
}

function mountedPluginIds(record: PanelRecord): string[] {
  return [...record.widgets.keys()].filter(pluginId => {
    const placement = host?.getPlacement(pluginId)
    return placement?.kind === 'panel' && placement.panelId === record.id
  })
}

function mountedWidgetView(panelId: string, pluginId: string): View | null {
  const placement = host?.getPlacement(pluginId)
  return placement?.kind === 'panel' && placement.panelId === panelId ? host?.getPluginView(pluginId) ?? null : null
}

/** 功能未开启时所有入口统一拒绝（IPC 层也做前置守卫）。 */
export function assertFreePanelEnabled(): void {
  if (shuttingDown) throw new Error('应用正在退出')
  if (pendingCloses) throw new Error('面板正在关闭，请稍后重试')
  if (!isFreePanelEnabled()) throw new Error('自由面板未开启')
}

function enqueueLifecycle(operation: () => Promise<void>): Promise<void> {
  const next = lifecycleQueue.then(() => shuttingDown ? undefined : operation())
  lifecycleQueue = next.catch(() => undefined)
  return next
}

function isCurrentLifecycle(epoch: number): boolean {
  return !shuttingDown && !pendingCloses && isFreePanelEnabled() && epoch === lifecycleEpoch
}

function isCurrentRecord(record: PanelRecord, epoch: number): boolean {
  return isCurrentLifecycle(epoch) && !record.closing && panels.get(record.id) === record
}

// —— 持久化 ——

function snapshot(): PersistedPanel[] {
  return [...panels.values()].filter(record => !record.closing).map(record => ({
    id: record.id,
    bounds: { ...record.bounds },
    widgets: [...record.widgets.values()]
      .sort((a, b) => a.z - b.z)
      .map(({ pluginId, x, y, width, height, z }) => ({ pluginId, x, y, width, height, z }))
  }))
}

function persist(immediate = false): void {
  if (shuttingDown || closingLayout !== null) return
  const data = snapshot()
  if (immediate) void flushPanels(data)
  else schedulePanels(data)
}

// —— 状态投影 ——

function widgetState(widget: WidgetRecord): PanelWidgetState {
  const described = host?.describePanelWidget(widget.pluginId) ?? null
  const manifest = pluginRegistry.getManifest(widget.pluginId)
  const unsupported = !!manifest && !supportsPanelLayout(manifest.views)
  return {
    pluginId: widget.pluginId,
    x: widget.x, y: widget.y, width: widget.width, height: widget.height, z: widget.z,
    title: described?.title ?? pluginRegistry.get(widget.pluginId)?.name ?? widget.pluginId,
    icon: described?.icon ?? pluginRegistry.get(widget.pluginId)?.icon ?? null,
    glyph: described?.glyph ?? pluginRegistry.get(widget.pluginId)?.glyph,
    status: unsupported ? 'unsupported' : widget.error ? 'error' : widget.loading ? 'loading' : described?.status ?? 'error',
    error: unsupported ? '此插件未提供小组件布局，原布局已保留' : widget.error ?? described?.error ?? (!described && !widget.loading ? '组件尚未启动' : undefined)
  }
}

function panelState(record: PanelRecord): PanelState {
  const existing = getPanelWindowRecord(record.id)?.state
  const size = getPanelContentSize(record.id)
  return {
    id: record.id,
    width: size.width,
    height: size.height,
    widgets: [...record.widgets.values()].sort((a, b) => a.z - b.z).map(widgetState),
    appearance: readPanelAppearance(),
    resolvedAppearance: existing?.resolvedAppearance ?? appearanceService.getAppearance(),
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
  const view = mountedWidgetView(panelId, widget.pluginId)
  if (view) setPluginViewBounds(view, widget)
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

function isCurrentPreview(job: PreviewJob): boolean {
  const { session, widget, view } = job
  const record = session.record
  const placement = host?.getPlacement(widget.pluginId)
  return !shuttingDown && !pendingCloses && !record.closing && !widget.removing
    && placement?.kind === 'panel' && placement.panelId === record.id
    && panels.get(record.id) === record && previewSessions.get(record.id) === session
    && record.widgets.get(widget.pluginId) === widget && host?.getPluginView(widget.pluginId) === view
}

function drainPreviewQueue(): void {
  while (previewWorkers < PREVIEW_CONCURRENCY && previewQueue.length) {
    const job = previewQueue.shift()!
    if (!isCurrentPreview(job) || job.session.bytes >= PREVIEW_SESSION_BYTES) continue
    previewWorkers += 1
    // Keep the native capture slot until it really settles; cancellation never starts unbounded replacement work.
    void capturePanelWidgetPreview(job.view, job.displayScale).then(dataUrl => {
      if (!dataUrl || !isCurrentPreview(job) || job.session.bytes + dataUrl.length > PREVIEW_SESSION_BYTES) return
      const native = getPanelWindowRecord(job.session.record.id)
      if (!native) return
      job.session.bytes += dataUrl.length
      pushPanelPreview(native, { revision: job.session.revision, active: true, widgets: [{ pluginId: job.widget.pluginId, dataUrl }] })
    }).catch(() => { /* A failed preview must not delay input or bring the hidden view back. */ }).finally(() => {
      previewWorkers -= 1
      drainPreviewQueue()
    })
  }
}

function startPanelPreview(record: PanelRecord): void {
  const native = getPanelWindowRecord(record.id)
  if (!native || native.window.isDestroyed() || record.closing || shuttingDown || pendingCloses) return
  let session = previewSessions.get(record.id)
  if (!session) {
    session = { record, revision: ++previewRevision, attempted: new Map(), bytes: 0 }
    previewSessions.set(record.id, session)
    pushPanelPreview(native, { revision: session.revision, active: true, widgets: [] })
  }
  const displayScale = screen.getDisplayMatching(native.window.getBounds()).scaleFactor
  for (const widget of record.widgets.values()) {
    const view = mountedWidgetView(record.id, widget.pluginId)
    if (!view || widget.removing || session.attempted.get(widget.pluginId) === view) continue
    session.attempted.set(widget.pluginId, view)
    previewQueue.push({ session, widget, view, displayScale })
  }
  drainPreviewQueue()
}

function stopPanelPreview(panelId: string): void {
  const session = previewSessions.get(panelId)
  if (!session) return
  previewSessions.delete(panelId)
  for (let index = previewQueue.length - 1; index >= 0; index--) {
    if (previewQueue[index].session === session) previewQueue.splice(index, 1)
  }
  session.attempted.clear()
  const native = getPanelWindowRecord(panelId)
  if (native) pushPanelPreview(native, { revision: session.revision, active: false, widgets: [] })
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
  if (hidden) startPanelPreview(record)
  else stopPanelPreview(panelId)
  for (const pluginId of mountedPluginIds(record)) host?.setPanelWidgetVisibility(pluginId, !hidden)
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
    pushDragFeedback(native, { sourcePanelId: session.panelId, interactionId: session.interactionId, active: true, pluginId: session.pluginId, rect, guides: snapped.guides })
  }
  session.frame = null
}

function scheduleDragTick(session: DragSession): void {
  if (session.frame || session.ending) return
  session.frame = setTimeout(() => { session.frame = null; if (drag === session) dragTick(session) }, 0)
}

/** 渲染层保活触发：把下一帧 tick 排上（主进程自行读光标）；同时刷新存活时间。 */
export function panelDragTick(senderId: number, interactionId: number): void {
  const panelId = getPanelForSender(senderId)
  if (!panelId || !drag || drag.panelId !== panelId || drag.interactionId !== interactionId) return
  drag.lastInput = Date.now()
  scheduleDragTick(drag)
}

function beginDrag(panelId: string, interactionId: number, pluginId: string, mode: PanelDragMode, edge?: PanelResizeEdge, pointer?: { x: number; y: number }): void {
  const record = panels.get(panelId)
  const widget = record?.widgets.get(pluginId)
  const native = getPanelWindowRecord(panelId)
  if (!record || record.closing || !native || native.window.isDestroyed()) throw new Error('面板已关闭，无法开始拖动')
  if (!widget || widget.removing) throw new Error('组件不可用，无法开始拖动')
  if (windowDrag) endWindowDrag(true)
  if (drag) endDrag(true)
  const cursor = screen.getCursorScreenPoint()
  const windowBounds = native.window.getContentBounds()
  const session: DragSession = {
    panelId, interactionId, pluginId, mode, edge,
    startRect: { x: widget.x, y: widget.y, width: widget.width, height: widget.height },
    startPointer: pointer ?? { x: cursor.x - windowBounds.x, y: cursor.y - windowBounds.y },
    frame: null, watchdog: null, lastInput: Date.now(),
    lastGuides: '', lastRect: { x: widget.x, y: widget.y, width: widget.width, height: widget.height },
    ending: false
  }
  drag = session
  // 拖动期间隐藏本面板**所有**组件的原生视图：任何原生 view 都会在 OS 层截走指针，
  // 被拖组件经过其它组件时同样会让 chrome 丢失 pointerup 而卡死。
  // 视觉反馈由 chrome 的组件边框（DOM）+ 跟随框 + 辅助线承担，结束时无条件恢复可见。
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
  if (!cancel) dragTick(session)
  if (drag !== session) return
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
    syncWidgetOrder(record)
    persist(true)
    publishPanel(session.panelId)
  }
  syncPanelVisibility(session.panelId)
  if (native) pushDragFeedback(native, { sourcePanelId: session.panelId, interactionId: session.interactionId, active: false, pluginId: session.pluginId })
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

function beginWindowDrag(panelId: string, interactionId: number, mode: PanelDragMode, edge?: PanelResizeEdge, pointer?: { x: number; y: number }): void {
  const native = getPanelWindowRecord(panelId)
  const record = panels.get(panelId)
  if (!native || !record || record.closing || native.window.isDestroyed()) throw new Error('面板已关闭，无法开始拖动')
  if (windowDrag) endWindowDrag(true)
  if (drag) endDrag(true)
  const bounds = native.window.getBounds()
  const content = native.window.getContentBounds()
  const cursor = pointer ? { x: content.x + pointer.x, y: content.y + pointer.y } : screen.getCursorScreenPoint()
  const session: WindowDragSession = {
    panelId, interactionId, mode, edge,
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
  if (!cancel) windowDragTick(session)
  if (windowDrag !== session) return
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
  if (record) syncWidgetOrder(record)
  syncPanelVisibility(session.panelId)
  if (native) pushDragFeedback(native, { sourcePanelId: session.panelId, interactionId: session.interactionId, active: false })
}

/** chrome 的整块面板拖动保活（主进程自行读光标）。 */
export function panelWindowDragTick(senderId: number, interactionId: number): void {
  const panelId = getPanelForSender(senderId)
  if (!panelId || !windowDrag || windowDrag.panelId !== panelId || windowDrag.interactionId !== interactionId) return
  windowDrag.lastInput = Date.now()
  scheduleWindowDragTick(windowDrag)
}

// —— 组件操作 ——

function nextZ(record: PanelRecord): number {
  record.zCounter += 1
  return record.zCounter
}

/** DOM and native views share persisted z ordering; reorder only outside the drag hot path. */
function syncWidgetOrder(record: PanelRecord): void {
  const parent = getPanelContentParent(record.id)
  if (!parent) return
  for (const widget of [...record.widgets.values()].sort((a, b) => a.z - b.z)) {
    const view = mountedWidgetView(record.id, widget.pluginId)
    if (!view) continue
    try { parent.addChildView(view) } catch { /* view may have retired */ }
  }
}

function raiseWidget(panelId: string, pluginId: string): void {
  const record = panels.get(panelId)
  const widget = record?.widgets.get(pluginId)
  if (!record || !widget) return
  widget.z = nextZ(record)
  // EndDrag applies the final ordering before restoring native visibility.
  if (record.windowDragging || drag?.panelId === panelId) return
  syncWidgetOrder(record)
  publishPanel(panelId)
  persist()
}

/** 候选插件：显式适配 panel、已安装、已启用、且未被其它面板占用。 */
export function listPanelCandidates(): PanelCandidate[] {
  const occupied = new Set<string>()
  for (const record of panels.values()) {
    for (const pluginId of record.widgets.keys()) occupied.add(pluginId)
  }
  return pluginRegistry.list()
    .filter(summary => summary.installed && isEnabledSync(summary.id))
    .filter(summary => supportsPanelLayout(pluginRegistry.getManifest(summary.id)?.views))
    .filter(summary => !occupied.has(summary.id))
    .map(summary => ({
      pluginId: summary.id,
      name: summary.name,
      icon: summary.icon ?? null,
      glyph: summary.glyph,
      category: summary.category
    }))
}

/**
 * 插件声明的组件默认尺寸（manifest views.panel.size，仅 layouts 含 panel 时生效）。
 * findFreeSlot/rectAtPointer 会按宿主最小尺寸与面板内容区钳制；未声明走全局默认。
 */
function declaredWidgetSize(pluginId: string): Partial<{ width: number; height: number }> | undefined {
  return resolvePluginViews(pluginRegistry.getManifest(pluginId)?.views).panel?.size
}

/**
 * 添加组件。
 * rect 缺省时按落位算法找空位；空间不足则向下/向右扩容面板窗口。
 */
export async function addWidget(panelId: string, pluginId: string, rect?: PanelWidgetRect, guard?: () => boolean): Promise<void> {
  assertFreePanelEnabled()
  if (guard?.() === false) throw new Error('plugin move was cancelled')
  const record = panels.get(panelId)
  const native = getPanelWindowRecord(panelId)
  if (!record || !native) throw new Error('面板不存在')
  if (record.closing) throw new Error('面板正在关闭')
  if (record.widgets.has(pluginId)) throw new Error('该插件已在此面板中')
  if (record.widgets.size >= PANEL_MAX_WIDGETS) throw new Error(`单个面板最多 ${PANEL_MAX_WIDGETS} 个组件`)
  const summary = pluginRegistry.get(pluginId)
  if (!summary?.installed || !isEnabledSync(pluginId)) throw new Error('插件不可用')
  if (!supportsPanelLayout(pluginRegistry.getManifest(pluginId)?.views)) throw new Error('此插件未提供小组件布局，请在主窗使用')
  for (const other of panels.values()) {
    if (other.id !== panelId && other.widgets.has(pluginId)) throw new Error('该插件已在其它面板中')
  }

  const size = getPanelContentSize(panelId)
  const declared = declaredWidgetSize(pluginId)
  const others = otherRects(record)
  let target = rect ? clampRect(rect, size) : findFreeSlot(others, size, declared)
  if (!target) {
    const current = native.window.getBounds()
    const area = screen.getDisplayMatching(current).workArea
    const expansion = findPanelExpansion(others, size, area, declared)
    if (!expansion) throw new Error('当前屏幕工作区不足以放入该组件，请缩小现有组件或移除部分组件')
    const next = {
      x: Math.max(area.x, Math.min(current.x, area.x + area.width - expansion.panel.width)),
      y: Math.max(area.y, Math.min(current.y, area.y + area.height - expansion.panel.height)),
      ...expansion.panel
    }
    native.window.setBounds(next)
    target = findFreeSlot(otherRects(record), getPanelContentSize(panelId), declared)
    if (!target) throw new Error('窗口未能扩展到所需大小，请调整面板后重试')
  }

  const widget: WidgetRecord = {
    pluginId,
    x: target.x, y: target.y, width: target.width, height: target.height,
    z: nextZ(record), loading: true
  }
  const epoch = lifecycleEpoch
  record.widgets.set(pluginId, widget)
  persist()
  try {
    await mountWidget(record, widget, epoch, guard)
  } catch (error) {
    if (isCurrentRecord(record, epoch) && record.widgets.get(pluginId) === widget) {
      record.widgets.delete(pluginId)
      publishPanel(panelId)
      persist()
    }
    throw error
  }
  // 面板挂载后独立窗口已无内容：销毁它，避免留下空壳（moveEntry 只在源是 detached 时销毁，
  // 而拖拽路径可能由 PanelManager 先建立面板 placement，故这里显式兜底一次）。
  if (getDetachedWindow(pluginId)) destroyDetachedWindow(pluginId)
}

/** 移除组件与关闭面板沿用同一完整插件关闭链路，不把移除伪装成移回主窗。 */
export async function removeWidget(panelId: string, pluginId: string): Promise<void> {
  const record = panels.get(panelId)
  const widget = record?.widgets.get(pluginId)
  if (!record || record.closing || !widget || widget.removing) return
  if (drag?.panelId === panelId && drag.pluginId === pluginId) endDrag(true)
  widget.removing = true
  try {
    const placement = host?.getPlacement(pluginId)
    if (placement?.kind === 'panel' && placement.panelId === panelId) {
      await requireHost().closePanelPlugins([pluginId])
      if (host?.getPluginView(pluginId)) throw new Error('组件未能关闭，请稍后重试')
    }
    if (panels.get(panelId) === record && record.widgets.delete(pluginId)) {
      publishPanel(panelId)
      persist(true)
    }
  } catch (error) {
    widget.removing = false
    syncPanelVisibility(panelId)
    throw error
  }
}

/** 移回主窗或独立窗口：保留当前运行时与业务状态。 */
export async function dockWidget(panelId: string, pluginId: string, target: 'shell' | 'detached' = 'shell'): Promise<void> {
  const record = panels.get(panelId)
  if (!record || record.closing || !record.widgets.has(pluginId) || record.widgets.get(pluginId)?.removing) return
  const position = target === 'detached' ? screen.getCursorScreenPoint() : undefined
  try {
    const pluginHost = requireHost()
    const previous = pluginHost.getPlacement(pluginId)
    if (previous.kind === 'panel' && previous.panelId === panelId && pluginHost.getPluginView(pluginId)) {
      await pluginHost.unmountFromPanel(pluginId, target, position)
    } else {
      const widget = record.widgets.get(pluginId)
      const epoch = lifecycleEpoch
      await pluginHost.openInShell(pluginId, () => isCurrentRecord(record, epoch) && record.widgets.get(pluginId) === widget)
    }
    const placement = pluginHost.getPlacement(pluginId)
    if (placement.kind === 'panel' && placement.panelId === panelId) throw new Error('组件未能移出面板')
    // PluginHost also forgets successful transfers; failed transfers must keep their chrome and saved layout.
    if (panels.get(panelId) === record && record.widgets.delete(pluginId)) {
      publishPanel(panelId)
      persist()
    }
    if (placement.kind === 'shell') {
      const window = getMainWindow()
      if (window && !window.isDestroyed()) {
        if (window.isMinimized()) window.restore()
        window.show()
        window.focus()
      }
    }
  } catch (error) {
    logWarn('panel', `unmount failed: ${String(error)}`)
    syncPanelVisibility(panelId)
    throw error
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
  // 先收尾拖动，再标记关闭；关闭中的记录不再进入快照，包括 beforeClose 期间触发的退出。
  if (drag?.panelId === panelId) endDrag(true)
  if (windowDrag?.panelId === panelId) endWindowDrag(true)
  record.closing = true
  stopPanelPreview(panelId)
  const pluginIds = mountedPluginIds(record)
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
export function closeAllPanels(keepRecords = false): Promise<void> {
  lifecycleEpoch += 1
  restoreQueue.length = 0
  cancelRegionSelection()
  pendingCloses += 1
  for (const panelId of previewSessions.keys()) stopPanelPreview(panelId)
  return enqueueLifecycle(() => closeAllPanelsNow(keepRecords)).finally(() => { pendingCloses -= 1 })
}

async function closeAllPanelsNow(keepRecords: boolean): Promise<void> {
  const ids = [...panels.keys()]
  if (!ids.length) { if (!keepRecords) persist(true); return }
  endDrag(true)
  endWindowDrag(true)
  // 必须在关闭插件前快照：closePlugin 会经 forgetPanelPlugin 摘除组件记录，
  // 之后再 snapshot 只能拿到空布局，keepRecords 就失去意义。
  closingLayout = keepRecords ? snapshot() : []
  // Save before releasing runtimes; shutdown may arrive while their beforeClose handlers are pending.
  await flushPanels(closingLayout)
  const pluginIds = ids.flatMap(id => {
    const record = panels.get(id)
    return record ? mountedPluginIds(record) : []
  })
  for (const id of ids) {
    const record = panels.get(id)
    if (record) record.closing = true
    stopPanelPreview(id)
  }
  try {
    if (pluginIds.length) await requireHost().closePanelPlugins(pluginIds)
  } catch (error) {
    logWarn('panel', `close plugins failed: ${String(error)}`)
  }
  try {
    destroyAllPanelWindows()
    panels.clear()
  } finally {
    closingLayout = null
  }
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
    id, bounds: { ...bounds }, widgets: new Map(), zCounter: 0, closing: false, overlay: false, windowDragging: false
  }
  const epoch = lifecycleEpoch
  panels.set(id, record)
  try {
    await createPanelWindow({
      id,
      bounds,
      appearance: readPanelAppearance(),
      widgets: [],
      guard: () => isCurrentRecord(record, epoch)
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
export async function dropPluginIntoPanel(panelId: string, pluginId: string, localPoint: { x: number; y: number }, guard?: () => boolean): Promise<void> {
  const record = panels.get(panelId)
  if (!record) throw new Error('面板不存在')
  const size = getPanelContentSize(panelId)
  const rect = rectAtPointer(localPoint, otherRects(record), size, declaredWidgetSize(pluginId))
  await addWidget(panelId, pluginId, rect, guard)
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
  // An unsupported saved placeholder is not a runtime owner and must not block Tab recovery.
  if (!supportsPanelLayout(pluginRegistry.getManifest(pluginId)?.views)) return false
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
    const widget = record.widgets.get(pluginId)
    if (!widget) continue
    applyWidgetBounds(record.id, widget)
    if (!record.windowDragging && drag?.panelId !== record.id) syncWidgetOrder(record)
    if (record.overlay || record.windowDragging || drag?.panelId === record.id) syncPanelVisibility(record.id)
    publishPanel(record.id)
  }
}

/** 插件被其它途径关闭/移出时，从面板记录里摘除（避免幽灵组件）。 */
export function forgetPlugin(pluginId: string): void {
  for (const record of panels.values()) {
    if (!record.widgets.delete(pluginId)) continue
    previewSessions.get(record.id)?.attempted.delete(pluginId)
    for (let index = previewQueue.length - 1; index >= 0; index--) {
      if (previewQueue[index].session.record === record && previewQueue[index].widget.pluginId === pluginId) previewQueue.splice(index, 1)
    }
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
export function restorePanels(): Promise<void> {
  const epoch = lifecycleEpoch
  return enqueueLifecycle(() => restorePanelsNow(epoch))
}

async function restorePanelsNow(epoch: number): Promise<void> {
  if (!isCurrentLifecycle(epoch)) return
  const stored = readPanels()
  if (!stored.length) return
  // Register the complete saved layout before awaiting a window. Intermediate persistence and
  // shutdown must include panels whose chrome has not finished loading yet.
  for (const item of stored) {
    if (panels.has(item.id)) continue
    const bounds = resolveRestoreBounds(item.bounds)
    const record: PanelRecord = {
      id: item.id, bounds, widgets: new Map(), zCounter: 0, closing: false, overlay: false, windowDragging: false
    }
    for (const widget of item.widgets) {
      record.widgets.set(widget.pluginId, { ...widget, loading: true })
      record.zCounter = Math.max(record.zCounter, widget.z)
    }
    panels.set(item.id, record)
  }
  for (const item of stored) {
    if (!isCurrentLifecycle(epoch)) return
    const record = panels.get(item.id)
    if (!record || !isCurrentRecord(record, epoch)) continue
    try {
      const size = { width: record.bounds.width, height: record.bounds.height }
      const fitted = fitWidgetsToPanel([...record.widgets.values()], size)
      let index = 0
      for (const widget of record.widgets.values()) Object.assign(widget, fitted[index++])
      await createPanelWindow({
        id: item.id, bounds: record.bounds, appearance: readPanelAppearance(), widgets: [],
        guard: () => isCurrentRecord(record, epoch)
      })
      if (!isCurrentLifecycle(epoch)) return
      if (!isCurrentRecord(record, epoch)) continue
      publishPanel(item.id)
    } catch (error) {
      if (!isCurrentLifecycle(epoch)) return
      if (!isCurrentRecord(record, epoch)) continue
      logWarn('panel', `restore window failed for ${item.id}: ${String(error)}`)
      // A native/window-load failure is not user intent to delete the saved panel.
      continue
    }
    for (const widget of record.widgets.values()) {
      const manifest = pluginRegistry.getManifest(widget.pluginId)
      if (manifest && !supportsPanelLayout(manifest.views)) {
        widget.loading = false
        continue
      }
      const placement = host?.getPlacement(widget.pluginId)
      if (placement?.kind === 'panel' && placement.panelId === record.id) continue
      if (!restoreQueue.some(job => job.record === record && job.widget === widget && job.epoch === epoch)) {
        restoreQueue.push({ record, widget, epoch })
      }
    }
  }
  persist(true)
  notifyShell()
  drainRestoreQueue()
}

function drainRestoreQueue(): void {
  if (shuttingDown || pendingCloses || !isFreePanelEnabled()) return
  while (restoreWorkers < RESTORE_CONCURRENCY && restoreQueue.length) {
    const job = restoreQueue.shift()!
    restoreWorkers += 1
    void restoreWidget(job).finally(() => {
      restoreWorkers -= 1
      drainRestoreQueue()
    })
  }
}

async function restoreWidget({ record, widget, epoch }: RestoreJob): Promise<void> {
  if (!isCurrentRecord(record, epoch) || record.widgets.get(widget.pluginId) !== widget) return
  try {
    await mountWidget(record, widget, epoch)
  } catch (error) {
    if (isCurrentRecord(record, epoch)) logWarn('panel', `restore widget failed: ${widget.pluginId} ${String(error)}`)
  }
}

function mountWidget(record: PanelRecord, widget: WidgetRecord, epoch: number, guard?: () => boolean): Promise<void> {
  if (widget.mounting) return widget.mounting
  const current = (): boolean => isCurrentRecord(record, epoch)
    && !widget.removing && record.widgets.get(widget.pluginId) === widget && !!getPanelWindowRecord(record.id)
  widget.loading = true
  delete widget.error
  publishPanel(record.id)
  const operation = Promise.resolve().then(async () => {
    try {
      if (!current()) throw new Error('panel mount cancelled')
      if (!pluginRegistry.get(widget.pluginId)?.installed || !isEnabledSync(widget.pluginId)) throw new Error('插件不可用')
      if (!supportsPanelLayout(pluginRegistry.getManifest(widget.pluginId)?.views)) throw new Error('此插件未提供小组件布局，请在主窗使用')
      await requireHost().mountInPanel(widget.pluginId, record.id, () => current() && guard?.() !== false)
      // A successful move changes the source placement revision; only the target lifecycle is checked after commit.
      if (!current()) throw new Error('panel mount cancelled')
      widget.loading = false
      applyWidgetBounds(record.id, widget)
      if (!record.windowDragging && drag?.panelId !== record.id) syncWidgetOrder(record)
      if (record.overlay || record.windowDragging || drag?.panelId === record.id) syncPanelVisibility(record.id)
      publishPanel(record.id)
    } catch (error) {
      if (current()) {
        widget.loading = false
        widget.error = error instanceof Error ? error.message : '组件启动失败'
        publishPanel(record.id)
      }
      throw error
    } finally {
      if (widget.mounting === operation) delete widget.mounting
    }
  })
  widget.mounting = operation
  return operation
}

/** 重试单个失败组件（chrome 错误态按钮）。 */
export async function retryWidget(panelId: string, pluginId: string): Promise<void> {
  assertFreePanelEnabled()
  const record = panels.get(panelId)
  const widget = record?.widgets.get(pluginId)
  if (!record || !widget) return
  try {
    await mountWidget(record, widget, lifecycleEpoch)
  } catch (error) {
    logWarn('panel', `retry failed: ${pluginId} ${String(error)}`)
    throw error
  }
}

// —— 外观 ——

export function applyAppearanceToPanels(): void {
  broadcastPanelAppearance(readPanelAppearance())
}

export function refreshPanelThemes(): void {
  broadcastPanelTheme()
  // 主题的 panelRadius 变化后，组件原生视图圆角要跟着重设（setPluginViewBounds 按当前主题计算）。
  for (const record of panels.values()) {
    for (const widget of record.widgets.values()) applyWidgetBounds(record.id, widget)
  }
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
  if (shuttingDown) return
  endDrag(true)
  endWindowDrag(true)
  cancelScheduledPanels()
  shuttingDown = true
  lifecycleEpoch += 1
  restoreQueue.length = 0
  for (const panelId of previewSessions.keys()) stopPanelPreview(panelId)
  cancelRegionSelection()
  // PluginHost closes every runtime next. Its forgetPlugin callbacks must not overwrite this layout.
  // With the feature disabled there are no live panels, but the saved layout still belongs to the user.
  if (closingLayout !== null) void flushPanels(closingLayout)
  else if (panels.size) void flushPanels(snapshot())
}

/** 退出清理：销毁窗口（插件已由 PluginHost.destroyAll 释放）。 */
export function disposePanels(): void {
  endDrag(true)
  endWindowDrag(true)
  for (const panelId of previewSessions.keys()) stopPanelPreview(panelId)
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
        return { ok: true, candidates: listPanelCandidates() }
      case 'add-widget':
        await addWidget(panelId, command.pluginId, command.rect)
        return { ok: true, state: getPanelState(panelId) ?? undefined }
      case 'remove-widget':
        await removeWidget(panelId, command.pluginId)
        return { ok: true, state: getPanelState(panelId) ?? undefined }
      case 'retry-widget':
        await retryWidget(panelId, command.pluginId)
        return { ok: true, state: getPanelState(panelId) ?? undefined }
      case 'dock-widget':
        await dockWidget(panelId, command.pluginId, 'shell')
        return { ok: true, state: getPanelState(panelId) ?? undefined }
      case 'close-panel':
        await closePanel(panelId)
        return { ok: true }
      case 'set-appearance': {
        const current = readPanelAppearance()
        const next: PanelAppearance = {
          opacity: Math.min(1, Math.max(0, command.appearance.opacity ?? current.opacity)),
          material: command.appearance.material ?? current.material
        }
        await settingsStore.setAll({ general: { panelAppearance: next } })
        applyAppearanceToPanels()
        return { ok: true, state: getPanelState(panelId) ?? undefined }
      }
      case 'widget-drag-begin':
        beginDrag(panelId, command.interactionId, command.pluginId, command.mode, command.edge, command.pointer)
        return { ok: true }
      case 'widget-drag-end':
        if (drag?.panelId !== panelId || drag.interactionId !== command.interactionId) return { ok: true }
        endDrag(command.cancel === true)
        return { ok: true, state: getPanelState(panelId) ?? undefined }
      case 'window-drag-begin':
        beginWindowDrag(panelId, command.interactionId, command.mode, command.edge, command.pointer)
        return { ok: true }
      case 'window-drag-end':
        if (windowDrag?.panelId !== panelId || windowDrag.interactionId !== command.interactionId) return { ok: true }
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
