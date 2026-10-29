/** Trusted panel chrome. Native plugin content stays isolated; drag feedback updates DOM only. */
import { useCallback, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import '@renderer/styles/tokens.css'
import '@renderer/styles/appearance.css'
import { Button } from '@renderer/components/ui/Button'
import { Dialog, DialogContent, DialogDescription, DialogOverlay, DialogTitle } from '@renderer/components/ui/Dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@renderer/components/ui/DropdownMenu'
import { applyAppearanceToDom } from '@renderer/services/appearanceDom'
import {
  PANEL_WIDGET_INSET,
  type PanelCandidate,
  type PanelCommand,
  type PanelPoint,
  type PanelResizeEdge,
  type PanelState,
  type PanelSurfaceApi,
  type PanelWidgetRect
} from '@shared/types/panel'
import './panel.css'

declare global {
  interface Window { enestPanel?: PanelSurfaceApi }
}

const api = window.enestPanel
const DRAG_THRESHOLD = 4
const AXES = ['x', 'y'] as const
const RESIZE_HANDLES: Array<{ edge: PanelResizeEdge; style: React.CSSProperties; cursor: string }> = [
  { edge: 'nw', style: { left: 0, top: 0, width: 16, height: 16 }, cursor: 'nwse-resize' },
  { edge: 'ne', style: { right: 0, top: 0, width: 16, height: 16 }, cursor: 'nesw-resize' },
  { edge: 'sw', style: { left: 0, bottom: 0, width: 16, height: 16 }, cursor: 'nesw-resize' },
  { edge: 'se', style: { right: 0, bottom: 0, width: 16, height: 16 }, cursor: 'nwse-resize' }
]
const WINDOW_RESIZE_HANDLES = [
  { edge: 'n' as const, style: { left: 14, right: 14, top: 0, height: 8 }, cursor: 'ns-resize' },
  { edge: 's' as const, style: { left: 14, right: 14, bottom: 0, height: 8 }, cursor: 'ns-resize' },
  { edge: 'w' as const, style: { top: 14, bottom: 14, left: 0, width: 8 }, cursor: 'ew-resize' },
  { edge: 'e' as const, style: { top: 14, bottom: 14, right: 0, width: 8 }, cursor: 'ew-resize' },
  ...RESIZE_HANDLES
]

type GestureTarget = { kind: 'widget'; pluginId: string } | { kind: 'window' }
interface Gesture {
  interactionId: number
  target: GestureTarget
  pointerId: number
  element: HTMLElement
  start: PanelPoint
  mode: 'move' | 'resize'
  edge?: PanelResizeEdge
  started: boolean
}
type CommandResult = Awaited<ReturnType<PanelSurfaceApi['command']>>
interface PickerState { candidates: PanelCandidate[]; loading: boolean; adding?: string; error?: string }
interface PreviewState { revision: number; active: boolean; images: Record<string, string> }

function widgetStyle(rect: PanelWidgetRect): React.CSSProperties {
  return { transform: `translate3d(${rect.x}px, ${rect.y}px, 0)`, width: `${rect.width}px`, height: `${rect.height}px` }
}

function applyRect(node: HTMLElement, rect: PanelWidgetRect): void {
  Object.assign(node.style, widgetStyle(rect))
}

function PanelApp(): React.JSX.Element {
  const [state, setState] = useState<PanelState | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; pluginId?: string } | null>(null)
  const [picker, setPicker] = useState<PickerState | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [dragging, setDragging] = useState<GestureTarget | null>(null)
  const [dropActive, setDropActive] = useState(false)
  const [preview, setPreview] = useState<PreviewState>({ revision: 0, active: false, images: {} })
  const stateRef = useRef<PanelState | null>(null)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const frameRef = useRef<HTMLDivElement | null>(null)
  const guideRefs = useRef<Record<'x' | 'y', HTMLDivElement | null>>({ x: null, y: null })
  const widgetRefs = useRef(new Map<string, HTMLDivElement>())
  const gesture = useRef<Gesture | null>(null)
  const gestureVersion = useRef(0)
  const tickFrame = useRef<number | null>(null)
  const pickerRequest = useRef(0)
  const mounted = useRef(true)

  const command = useCallback(async (payload: PanelCommand): Promise<CommandResult> => {
    if (!api) return { ok: false, error: '宿主不可用' }
    try {
      // Only onState owns live state; an older command reply must not replace a newer snapshot.
      return await api.command(payload)
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : '面板操作失败' }
    }
  }, [])

  const runCommand = useCallback(async (payload: PanelCommand) => {
    const result = await command(payload)
    if (!result.ok && mounted.current) setNotice(result.error ?? '面板操作失败，请重试。')
    return result
  }, [command])

  const clearFeedback = useCallback(() => {
    if (frameRef.current) frameRef.current.style.opacity = '0'
    for (const axis of AXES) if (guideRefs.current[axis]) guideRefs.current[axis]!.style.opacity = '0'
  }, [])

  const finishGesture = useCallback((cancel = false) => {
    const current = gesture.current
    if (!current) return
    gesture.current = null
    if (tickFrame.current !== null) cancelAnimationFrame(tickFrame.current)
    tickFrame.current = null
    try { current.element.releasePointerCapture(current.pointerId) } catch { /* capture already lost */ }
    if (!current.started) return
    if (mounted.current) setDragging(null)
    clearFeedback()
    void command({ action: current.target.kind === 'widget' ? 'widget-drag-end' : 'window-drag-end', interactionId: current.interactionId, cancel }).then(result => {
      if (!mounted.current || gesture.current || current.interactionId !== gestureVersion.current) return
      if (!result.ok) setNotice(result.error ?? '无法结束拖动，请重试。')
      // React may skip equal style props after a cancelled drag; restore the directly mutated DOM.
      for (const widget of stateRef.current?.widgets ?? []) {
        const node = widgetRefs.current.get(widget.pluginId)
        if (node) applyRect(node, widget)
      }
    })
  }, [clearFeedback, command])

  const prepareGesture = useCallback((event: React.PointerEvent<HTMLElement>, target: GestureTarget, mode: 'move' | 'resize', edge?: PanelResizeEdge) => {
    if (event.button !== 0 || !event.isPrimary || !api) return
    if (mode === 'move' && (event.target as HTMLElement).closest('[data-no-drag]')) return
    event.preventDefault()
    event.stopPropagation()
    finishGesture(true)
    const element = event.currentTarget
    try { element.setPointerCapture(event.pointerId) } catch { return }
    const interactionId = ++gestureVersion.current
    gesture.current = { interactionId, target, mode, edge, element, pointerId: event.pointerId, start: { x: event.clientX, y: event.clientY }, started: false }
  }, [finishGesture])

  const onPointerMove = useCallback((event: React.PointerEvent) => {
    const current = gesture.current
    if (!current || current.pointerId !== event.pointerId) return
    if (!current.started) {
      if (Math.hypot(event.clientX - current.start.x, event.clientY - current.start.y) < DRAG_THRESHOLD) return
      current.started = true
      setDragging(current.target)
      if (current.target.kind === 'widget') void command({ action: 'raise-widget', pluginId: current.target.pluginId })
      const payload: PanelCommand = current.target.kind === 'widget'
        ? { action: 'widget-drag-begin', interactionId: current.interactionId, pluginId: current.target.pluginId, mode: current.mode, edge: current.edge, pointer: current.start }
        : { action: 'window-drag-begin', interactionId: current.interactionId, mode: current.mode, edge: current.edge, pointer: current.start }
      void command(payload).then(result => {
        if (!result.ok && gesture.current === current) {
          finishGesture(true)
          setNotice(result.error ?? '无法开始拖动')
        }
      })
    }
    if (tickFrame.current !== null) return
    tickFrame.current = requestAnimationFrame(() => {
      tickFrame.current = null
      if (gesture.current?.started) api?.dragTick(gesture.current.interactionId)
    })
  }, [command, finishGesture])

  useEffect(() => {
    mounted.current = true
    if (!api) { setNotice('面板必须在 eNest 原生窗口中打开。'); return }
    let active = true
    let receivedState = false
    const acceptState = (next: PanelState) => {
      stateRef.current = next
      setState(next)
      if (!gesture.current?.started) for (const widget of next.widgets) {
        const node = widgetRefs.current.get(widget.pluginId)
        if (node) applyRect(node, widget)
      }
    }
    const offState = api.onState(next => { receivedState = true; acceptState(next) })
    void api.getState().then(next => { if (active && next && !receivedState) acceptState(next) }).catch(error => {
      if (active) setNotice(error instanceof Error ? error.message : '无法读取面板状态')
    })
    return () => {
      active = false
      mounted.current = false
      pickerRequest.current++
      offState()
      finishGesture(true)
      void api.command({ action: 'overlay-close' }).catch(() => undefined)
    }
  }, [finishGesture])

  useEffect(() => {
    if (!state) return
    applyAppearanceToDom(state.resolvedAppearance)
    document.documentElement.style.setProperty('--panel-opacity', String(state.appearance.opacity))
    document.documentElement.dataset.material = state.appearance.material
  }, [state?.resolvedAppearance.revision, state?.appearance.opacity, state?.appearance.material])

  useEffect(() => {
    if (!api || !state) return
    api.setDropTarget({ kind: 'panel', rect: { x: 0, y: 0, width: state.width, height: state.height }, axis: 'x', items: [], panelId: state.id })
    return () => api.setDropTarget(null)
  }, [state?.width, state?.height, state?.id])

  useEffect(() => api?.onPluginDrag(feedback => {
    setDropActive(feedback.active === true && feedback.target === 'panel')
  }), [])

  const overlayOpen = menu !== null || picker !== null || notice !== null
  useEffect(() => {
    void runCommand({ action: overlayOpen ? 'overlay-open' : 'overlay-close' })
  }, [overlayOpen, runCommand])

  useEffect(() => api?.onPreview(snapshot => {
    setPreview(current => {
      if (snapshot.revision < current.revision || snapshot.revision === current.revision && !current.active && snapshot.active) return current
      const images = snapshot.active && current.revision === snapshot.revision ? { ...current.images } : {}
      if (snapshot.active) for (const widget of snapshot.widgets) images[widget.pluginId] = widget.dataUrl
      return { revision: snapshot.revision, active: snapshot.active, images }
    })
  }), [])

  useEffect(() => api?.onDrag(feedback => {
    const current = gesture.current
    if (!current?.started || feedback.sourcePanelId !== stateRef.current?.id || feedback.interactionId !== current.interactionId) return
    if (!feedback.active) {
      clearFeedback()
      finishGesture(true)
      return
    }
    if (current.target.kind !== 'widget' || feedback.pluginId !== current.target.pluginId || !feedback.rect) return
    if (frameRef.current) {
      applyRect(frameRef.current, feedback.rect)
      frameRef.current.style.opacity = '1'
    }
    const node = widgetRefs.current.get(feedback.pluginId)
    if (node) applyRect(node, feedback.rect)
    for (const axis of AXES) {
      const guide = guideRefs.current[axis]
      const value = feedback.guides?.find(item => item.axis === axis)
      if (!guide) continue
      if (!value) { guide.style.opacity = '0'; continue }
      guide.style.opacity = '1'
      guide.style.transform = axis === 'x' ? `translate3d(${value.position}px, ${value.from}px, 0)` : `translate3d(${value.from}px, ${value.position}px, 0)`
      guide.style.width = `${axis === 'x' ? 1 : Math.max(1, value.to - value.from)}px`
      guide.style.height = `${axis === 'y' ? 1 : Math.max(1, value.to - value.from)}px`
    }
  }), [clearFeedback, finishGesture])

  useEffect(() => {
    const onBlur = () => finishGesture(true)
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      if (gesture.current) {
        event.preventDefault()
        event.stopPropagation()
        finishGesture(true)
      }
    }
    window.addEventListener('blur', onBlur)
    window.addEventListener('keydown', onKeyDown, true)
    return () => {
      window.removeEventListener('blur', onBlur)
      window.removeEventListener('keydown', onKeyDown, true)
    }
  }, [finishGesture])

  useEffect(() => {
    if (!dragging) return
    // Keep a deliberately stationary held drag alive; blur/lost capture still cancel immediately.
    const timer = setInterval(() => { if (gesture.current?.started) api?.dragTick(gesture.current.interactionId) }, 5000)
    return () => clearInterval(timer)
  }, [dragging])

  const showMenu = (x: number, y: number, pluginId?: string) => {
    finishGesture(true)
    setMenu({ x, y, pluginId })
  }
  const openPicker = async () => {
    const request = ++pickerRequest.current
    setMenu(null)
    setPicker({ candidates: [], loading: true })
    const result = await command({ action: 'list-candidates' })
    if (!mounted.current || pickerRequest.current !== request) return
    setPicker({ candidates: result.candidates ?? [], loading: false, error: result.ok ? undefined : result.error ?? '读取插件失败' })
  }
  const closePicker = () => { pickerRequest.current++; setPicker(null) }
  const addWidget = async (pluginId: string) => {
    const request = pickerRequest.current
    setPicker(current => current && { ...current, adding: pluginId, error: undefined })
    const result = await command({ action: 'add-widget', pluginId })
    if (!mounted.current || pickerRequest.current !== request) return
    if (result.ok) closePicker()
    else setPicker(current => current && { ...current, adding: undefined, error: result.error ?? '添加组件失败' })
  }
  const focusPanel = (event: Event) => { event.preventDefault(); rootRef.current?.focus({ preventScroll: true }) }
  const empty = !state?.widgets.length

  return (
    <div
      ref={rootRef}
      className={`panel-root${dragging?.kind === 'window' ? ' is-window-dragging' : ''}`}
      tabIndex={0}
      aria-label="自由面板，右键打开操作菜单"
      onPointerMove={onPointerMove}
      onPointerUp={event => { if (gesture.current?.pointerId === event.pointerId) finishGesture(false) }}
      onPointerCancel={event => { if (gesture.current?.pointerId === event.pointerId) finishGesture(true) }}
      onLostPointerCapture={event => { if (gesture.current?.pointerId === event.pointerId) finishGesture(true) }}
      onKeyDown={event => {
        if (event.key !== 'ContextMenu' && !(event.key === 'F10' && event.shiftKey)) return
        event.preventDefault()
        const target = (event.target as HTMLElement).closest<HTMLElement>('[data-plugin-id]')
        const bounds = target?.getBoundingClientRect()
        showMenu(bounds ? bounds.x + bounds.width / 2 : 16, bounds ? bounds.y + bounds.height / 2 : 16, target?.dataset.pluginId)
      }}
    >
      <div className="panel-surface" />
      <div className="panel-blank"
        onPointerDown={event => prepareGesture(event, { kind: 'window' }, 'move')}
        onContextMenu={event => { event.preventDefault(); showMenu(event.clientX, event.clientY) }}
      />
      {WINDOW_RESIZE_HANDLES.map(handle => (
        <div key={handle.edge} className={`panel-window-handle edge-${handle.edge}`} style={{ ...handle.style, cursor: handle.cursor }}
          onPointerDown={event => prepareGesture(event, { kind: 'window' }, 'resize', handle.edge)} />
      ))}
      {state?.widgets.map(widget => (
        <div key={widget.pluginId} data-plugin-id={widget.pluginId}
          ref={node => { if (node) widgetRefs.current.set(widget.pluginId, node); else widgetRefs.current.delete(widget.pluginId) }}
          className={`panel-widget${dragging?.kind === 'widget' && dragging.pluginId === widget.pluginId ? ' is-dragging' : ''}`}
          style={widgetStyle(widget)}
        >
          {preview.active && <div className="panel-widget-preview" style={{ inset: PANEL_WIDGET_INSET }} aria-hidden>
            {preview.images[widget.pluginId]
              ? <img src={preview.images[widget.pluginId]} alt="" draggable={false} />
              : <span className="panel-preview-placeholder">{widget.title}</span>}
          </div>}
          <div className="panel-widget-grab" role="button" tabIndex={0}
            aria-label={`${widget.title}，拖动边缘移动，拖动四角缩放，按 Enter 打开操作菜单`}
            onPointerDown={event => prepareGesture(event, { kind: 'widget', pluginId: widget.pluginId }, 'move')}
            onContextMenu={event => { event.preventDefault(); showMenu(event.clientX, event.clientY, widget.pluginId) }}
            onKeyDown={event => {
              if (event.key !== 'Enter' && event.key !== ' ') return
              event.preventDefault()
              const bounds = event.currentTarget.getBoundingClientRect()
              showMenu(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2, widget.pluginId)
            }}
            title="拖动边缘移动 · 拖动四角缩放 · 右键管理组件"
          />
          {widget.status === 'loading' && <span className="panel-widget-status">加载中</span>}
          {(widget.status === 'error' || widget.status === 'hibernated') && <div className="panel-widget-retry" style={{ inset: PANEL_WIDGET_INSET }} data-no-drag>
            <span>{widget.status === 'error' ? widget.error ?? '启动失败' : '已休眠'}</span>
            <Button onClick={() => void runCommand({ action: 'retry-widget', pluginId: widget.pluginId })}>重试</Button>
          </div>}
          {widget.status === 'unsupported' && <div className="panel-widget-retry" style={{ inset: PANEL_WIDGET_INSET }} data-no-drag>
            <span>{widget.title}：{widget.error}</span>
            <Button onClick={() => void runCommand({ action: 'dock-widget', pluginId: widget.pluginId })}>在主窗打开</Button>
            <Button variant="ghost" onClick={() => void runCommand({ action: 'remove-widget', pluginId: widget.pluginId })}>移除</Button>
          </div>}
          {RESIZE_HANDLES.map(handle => <div key={handle.edge} className={`panel-widget-handle edge-${handle.edge}`} style={{ ...handle.style, cursor: handle.cursor }}
            onPointerDown={event => prepareGesture(event, { kind: 'widget', pluginId: widget.pluginId }, 'resize', handle.edge)} />)}
        </div>
      ))}
      {empty && <div className="panel-empty"><span>在这里组合你的桌面组件</span><Button data-no-drag onClick={() => void openPicker()}>添加组件</Button><small>拖动空白处移动面板 · 右键查看更多操作</small></div>}
      {dropActive && <div className="panel-drop-hint" aria-hidden><span>松开即可放入面板</span></div>}
      <div className="panel-drag-frame" ref={frameRef} style={{ opacity: 0 }} />
      {AXES.map(axis => <div key={axis} className={`panel-guide axis-${axis}`} ref={node => { guideRefs.current[axis] = node }} style={{ opacity: 0 }} />)}

      <DropdownMenu open={menu !== null} onOpenChange={open => { if (!open) setMenu(null) }}>
        <DropdownMenuTrigger asChild>
          <button className="panel-menu-anchor" style={{ left: menu?.x ?? 0, top: menu?.y ?? 0 }} tabIndex={-1} aria-label="面板操作" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" sideOffset={0} onCloseAutoFocus={event => { event.preventDefault(); if (!picker && !notice) rootRef.current?.focus() }}>
          <DropdownMenuItem disabled={!!state && state.widgets.length >= state.widgetLimit} onSelect={() => void openPicker()}>添加组件…</DropdownMenuItem>
          {menu?.pluginId && <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => void runCommand({ action: 'dock-widget', pluginId: menu.pluginId! })}>移回主窗</DropdownMenuItem>
            <DropdownMenuItem danger onSelect={() => void runCommand({ action: 'remove-widget', pluginId: menu.pluginId! })}>关闭组件</DropdownMenuItem>
          </>}
          <DropdownMenuSeparator />
          <DropdownMenuItem danger onSelect={() => void runCommand({ action: 'close-panel' })}>关闭面板</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={picker !== null} onOpenChange={open => { if (!open && !picker?.adding) closePicker() }}>
        <DialogOverlay className="panel-picker-backdrop" />
        <DialogContent className="panel-picker" onCloseAutoFocus={focusPanel}
          onEscapeKeyDown={event => { if (picker?.adding) event.preventDefault() }}
          onPointerDownOutside={event => { if (picker?.adding) event.preventDefault() }}>
          <header><DialogTitle>添加组件</DialogTitle><Button className="panel-picker-close" disabled={!!picker?.adding} onClick={closePicker} aria-label="关闭">×</Button></header>
          <DialogDescription className="panel-picker-hint">只显示已适配小组件的插件。完整功能请在主窗使用。</DialogDescription>
          {picker?.error && <p className="panel-picker-hint is-error" role="alert">{picker.error}</p>}
          {picker?.loading ? <p className="panel-picker-hint" role="status">正在读取插件…</p>
            : !picker?.candidates.length ? <p className="panel-picker-hint">没有可添加的插件。</p>
              : <ul className="panel-picker-list">{picker.candidates.map(candidate => (
                <li key={candidate.pluginId}><Button disabled={!!picker.adding} onClick={() => void addWidget(candidate.pluginId)}>
                  <span className="panel-picker-icon" aria-hidden>{candidate.icon ? <img src={candidate.icon} alt="" /> : candidate.glyph ?? '⌥'}</span>
                  <span className="panel-picker-name">{candidate.name}</span>
                  {picker.adding === candidate.pluginId && <span className="panel-picker-note">正在添加…</span>}
                </Button></li>
              ))}</ul>}
        </DialogContent>
      </Dialog>
      <Dialog open={notice !== null} onOpenChange={open => { if (!open) setNotice(null) }}>
        <DialogOverlay className="panel-picker-backdrop" />
        <DialogContent className="panel-picker panel-notice" onCloseAutoFocus={focusPanel}>
          <DialogTitle>操作未完成</DialogTitle>
          <DialogDescription>{notice}</DialogDescription>
          <Button onClick={() => setNotice(null)}>知道了</Button>
        </DialogContent>
      </Dialog>
    </div>
  )
}

const root = document.getElementById('root')
if (root) createRoot(root).render(<PanelApp />)
