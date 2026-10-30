import { screen } from 'electron'
import { performance } from 'node:perf_hooks'
import {
  PANEL_MIN_HEIGHT, PANEL_MIN_WIDTH, type PanelBounds, type PanelDragFeedback,
  type PanelDragMode, type PanelResizeEdge, type PanelWidgetRect, type PersistedPanelWidget
} from '@shared/types/panel'
import { logWarn } from '@main/logs/logService'
import { getPanelForSender, getPanelWindowRecord, pushDragFeedback } from '@main/window/panelWindows'
import { applyDrag, computeSnap, movableEdges } from '@main/panel/panelGeometry'
import { PanelDragLoop, PANEL_DRAG_FEEDBACK_INTERVAL_MS } from '@main/panel/panelDragLoop'

interface PanelDragRecord {
  id: string
  closing: boolean
  windowDragging: boolean
  widgets: ReadonlyMap<string, PersistedPanelWidget & { removing?: boolean }>
}

interface PanelDragHost<T extends PanelDragRecord> {
  panels: ReadonlyMap<string, T>
  applyWidgetBounds(panelId: string, widget: PersistedPanelWidget): void
  otherRects(record: T, exclude?: string): PanelWidgetRect[]
  syncPanelVisibility(panelId: string): void
  syncWidgetOrder(record: T): void
  persist(immediate?: boolean): void
  publishPanel(panelId: string): void
  onGeometryChanged(panelId: string, bounds: PanelBounds): void
}

interface DragSession {
  panelId: string
  interactionId: number
  pluginId: string
  mode: PanelDragMode
  edge?: PanelResizeEdge
  startRect: PanelWidgetRect
  startPointer: { x: number; y: number }
  loop?: PanelDragLoop
  lastPointer?: { x: number; y: number }
  lastSize?: { width: number; height: number }
  lastGuides: string
  lastRect: PanelWidgetRect
  pendingFeedback?: PanelDragFeedback
  feedbackAt: number
  ending: boolean
}

interface WindowDragSession {
  panelId: string
  interactionId: number
  mode: PanelDragMode
  edge?: PanelResizeEdge
  /** 起始时窗口的屏幕绝对 bounds。 */
  startBounds: { x: number; y: number; width: number; height: number }
  /** 起始时光标的屏幕绝对坐标。 */
  startPointer: { x: number; y: number }
  loop?: PanelDragLoop
  lastPointer?: { x: number; y: number }
  ending: boolean
}

/** One main-owned gesture at a time; chrome only begins, ends and renews it. */
export function createPanelDragController<T extends PanelDragRecord>(host: PanelDragHost<T>) {
  const { panels, applyWidgetBounds, otherRects, syncPanelVisibility, syncWidgetOrder, persist, publishPanel, onGeometryChanged } = host
  let drag: DragSession | null = null
  let windowDrag: WindowDragSession | null = null

  function publishDragFeedback(session: DragSession, now: number, force = false): void {
    if (!session.pendingFeedback || !force && now - session.feedbackAt < PANEL_DRAG_FEEDBACK_INTERVAL_MS) return
    const native = getPanelWindowRecord(session.panelId)
    if (!native) return
    pushDragFeedback(native, session.pendingFeedback)
    session.pendingFeedback = undefined
    session.feedbackAt = now
  }

  function dragTick(session: DragSession, now = performance.now(), force = false): void {
    if (drag !== session || session.ending) return
    const record = panels.get(session.panelId)
    const native = getPanelWindowRecord(session.panelId)
    const widget = record?.widgets.get(session.pluginId)
    if (!record || !native || !widget) { endDrag(true); return }
    const cursor = screen.getCursorScreenPoint()
    const windowBounds = native.window.getContentBounds()
    const local = { x: cursor.x - windowBounds.x, y: cursor.y - windowBounds.y }
    const size = { width: windowBounds.width, height: windowBounds.height }
    if (local.x === session.lastPointer?.x && local.y === session.lastPointer?.y
      && size.width === session.lastSize?.width && size.height === session.lastSize?.height) {
      publishDragFeedback(session, now, force)
      return
    }
    session.lastPointer = local
    session.lastSize = size
    const delta = { x: local.x - session.startPointer.x, y: local.y - session.startPointer.y }
    const moved = applyDrag(session.startRect, session.mode, session.edge, delta, size)
    const snapped = computeSnap(moved, otherRects(record, session.pluginId), size, {
      movable: movableEdges(session.mode, session.edge)
    })
    const rect = snapped.rect
    const guideKey = snapped.guides.map(guide => `${guide.axis}:${guide.position}:${guide.from}:${guide.to}`).join('|')
    const rectChanged = rect.x !== session.lastRect.x || rect.y !== session.lastRect.y
      || rect.width !== session.lastRect.width || rect.height !== session.lastRect.height
    if (rectChanged) {
      Object.assign(widget, rect)
      applyWidgetBounds(session.panelId, widget)
    }
    if (rectChanged || guideKey !== session.lastGuides) {
      session.lastRect = rect
      session.lastGuides = guideKey
      session.pendingFeedback = { sourcePanelId: session.panelId, interactionId: session.interactionId, active: true, pluginId: session.pluginId, rect, guides: snapped.guides }
    }
    publishDragFeedback(session, now, force)
  }

  /** Only the source chrome can renew its own active gesture; renewal never schedules a frame. */
  function panelDragHeartbeat(senderId: number, interactionId: number): void {
    const panelId = getPanelForSender(senderId)
    const session = drag ?? windowDrag
    if (!panelId || !session || session.panelId !== panelId || session.interactionId !== interactionId) return
    session.loop?.heartbeat()
  }

  function beginDrag(panelId: string, interactionId: number, pluginId: string, mode: PanelDragMode, edge?: PanelResizeEdge, pointer?: { x: number; y: number }): void {
    const record = panels.get(panelId)
    const widget = record?.widgets.get(pluginId)
    const native = getPanelWindowRecord(panelId)
    if (!record || record.closing || !native || native.window.isDestroyed()) throw new Error('面板已关闭，无法开始拖动')
    if (!native.window.isFocused()) throw new Error('面板已失去焦点，请重新拖动')
    if (!widget || widget.removing) throw new Error('组件不可用，无法开始拖动')
    if (windowDrag) endWindowDrag(true)
    if (drag) endDrag(true)
    const cursor = screen.getCursorScreenPoint()
    const windowBounds = native.window.getContentBounds()
    const session: DragSession = {
      panelId, interactionId, pluginId, mode, edge,
      startRect: { x: widget.x, y: widget.y, width: widget.width, height: widget.height },
      startPointer: pointer ?? { x: cursor.x - windowBounds.x, y: cursor.y - windowBounds.y },
      feedbackAt: -Infinity,
      lastGuides: '', lastRect: { x: widget.x, y: widget.y, width: widget.width, height: widget.height },
      ending: false
    }
    drag = session
    // 拖动期间隐藏本面板**所有**组件的原生视图：任何原生 view 都会在 OS 层截走指针，
    // 被拖组件经过其它组件时同样会让 chrome 丢失 pointerup 而卡死。
    // 视觉反馈由 chrome 的组件边框（DOM）+ 跟随框 + 辅助线承担，结束时无条件恢复可见。
    syncPanelVisibility(panelId)
    // 看门狗：chrome 失联（卡死/文档被切走）超过阈值时安全收尾，避免组件视图永久隐藏。
    session.loop = new PanelDragLoop({
      current: () => drag === session && !session.ending && panels.get(panelId) === record && !record.closing
        && getPanelWindowRecord(panelId) === native && !native.window.isDestroyed() && native.window.isVisible()
        && !native.chrome.webContents.isDestroyed(),
      tick: now => dragTick(session, now),
      cancel: error => {
        if (error) logWarn('panel', `widget drag failed: ${String(error)}`)
        if (drag === session) endDrag(true)
      }
    })
    session.loop.start()
  }

  function endDrag(cancel: boolean): void {
    const session = drag
    if (!session) return
    session.loop?.stop()
    try { if (!cancel) dragTick(session, performance.now(), true) }
    catch (error) { cancel = true; logWarn('panel', `final widget geometry failed: ${String(error)}`) }
    if (drag !== session) return
    session.ending = true
    drag = null
    const record = panels.get(session.panelId)
    const widget = record?.widgets.get(session.pluginId)
    const native = getPanelWindowRecord(session.panelId)
    try {
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
    } catch (error) { logWarn('panel', `widget drag finalization failed: ${String(error)}`) }
    finally {
      syncPanelVisibility(session.panelId)
      if (native) pushDragFeedback(native, { sourcePanelId: session.panelId, interactionId: session.interactionId, active: false, pluginId: session.pluginId })
    }
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
    const cursor = screen.getCursorScreenPoint()
    if (cursor.x === session.lastPointer?.x && cursor.y === session.lastPointer?.y) return
    session.lastPointer = cursor
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

  function beginWindowDrag(panelId: string, interactionId: number, mode: PanelDragMode, edge?: PanelResizeEdge, pointer?: { x: number; y: number }): void {
    const native = getPanelWindowRecord(panelId)
    const record = panels.get(panelId)
    if (!native || !record || record.closing || native.window.isDestroyed()) throw new Error('面板已关闭，无法开始拖动')
    if (!native.window.isFocused()) throw new Error('面板已失去焦点，请重新拖动')
    if (windowDrag) endWindowDrag(true)
    if (drag) endDrag(true)
    const bounds = native.window.getBounds()
    const content = native.window.getContentBounds()
    const cursor = pointer ? { x: content.x + pointer.x, y: content.y + pointer.y } : screen.getCursorScreenPoint()
    const session: WindowDragSession = {
      panelId, interactionId, mode, edge,
      startBounds: { ...bounds },
      startPointer: cursor,
      ending: false
    }
    windowDrag = session
    record.windowDragging = true
    // 移动整块面板时插件视图同样会截走指针，必须临时隐藏（与组件拖动一致）。
    syncPanelVisibility(panelId)
    session.loop = new PanelDragLoop({
      current: () => windowDrag === session && !session.ending && panels.get(panelId) === record && !record.closing
        && getPanelWindowRecord(panelId) === native && !native.window.isDestroyed() && native.window.isVisible()
        && !native.chrome.webContents.isDestroyed(),
      tick: () => windowDragTick(session),
      cancel: error => {
        if (error) logWarn('panel', `window drag failed: ${String(error)}`)
        if (windowDrag === session) endWindowDrag(true)
      }
    })
    session.loop.start()
  }

  function endWindowDrag(cancel: boolean): void {
    const session = windowDrag
    if (!session) return
    session.loop?.stop()
    try { if (!cancel) windowDragTick(session) }
    catch (error) { cancel = true; logWarn('panel', `final window geometry failed: ${String(error)}`) }
    if (windowDrag !== session) return
    session.ending = true
    windowDrag = null
    const record = panels.get(session.panelId)
    const native = getPanelWindowRecord(session.panelId)
    if (record) record.windowDragging = false
    try {
      if (cancel && native && !native.window.isDestroyed()) native.window.setBounds(session.startBounds)
      if (native && !native.window.isDestroyed()) {
        // 落定后同步一次记录（窗口事件在拖动期间被跳过，避免高频持久化）。
        const bounds = native.window.getBounds()
        onGeometryChanged(session.panelId, { ...bounds, displayId: screen.getDisplayMatching(bounds).id })
      }
      if (record) syncWidgetOrder(record)
    } catch (error) { logWarn('panel', `window drag finalization failed: ${String(error)}`) }
    finally {
      syncPanelVisibility(session.panelId)
      if (native) pushDragFeedback(native, { sourcePanelId: session.panelId, interactionId: session.interactionId, active: false })
    }
  }

  function cancelPanelInteraction(panelId: string): void {
    if (drag?.panelId === panelId) endDrag(true)
    if (windowDrag?.panelId === panelId) endWindowDrag(true)
  }

  return {
    isWidgetDragging: (panelId: string, pluginId?: string) => drag?.panelId === panelId && (pluginId === undefined || drag.pluginId === pluginId),
    heartbeat: panelDragHeartbeat,
    beginWidget: beginDrag,
    endWidget: (panelId: string, interactionId: number, cancel: boolean) => {
      if (drag?.panelId === panelId && drag.interactionId === interactionId) endDrag(cancel)
    },
    beginWindow: beginWindowDrag,
    endWindow: (panelId: string, interactionId: number, cancel: boolean) => {
      if (windowDrag?.panelId === panelId && windowDrag.interactionId === interactionId) endWindowDrag(cancel)
    },
    cancel: cancelPanelInteraction,
    cancelAll: () => { endDrag(true); endWindowDrag(true) }
  }
}
