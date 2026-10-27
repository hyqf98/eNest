/**
 * panel.tsx — 自由面板 chrome 渲染层
 * 职责：绘制面板底板、每个组件的组件条与边框、对齐辅助线、右键菜单与组件选择器。
 * 关键约束（性能红线）：
 *  - 拖动期间**不 setState**：只直接改 DOM style（translate3d / width / height），
 *    矩形与辅助线数据由主进程推送的 drag feedback 驱动。
 *  - 不在此层渲染插件内容：插件是原生 WebContentsView，永远盖在本层之上。
 *  - 主题 token 由主进程随 PanelState 下发，不自行 invoke 外观接口。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import '@renderer/styles/tokens.css'
import '@renderer/styles/appearance.css'
import './panel.css'
import { applyAppearanceToDom } from '@renderer/services/appearanceDom'
import {
  type PanelCandidate,
  type PanelCommand,
  type PanelDragFeedback,
  type PanelGuide,
  type PanelPoint,
  type PanelResizeEdge,
  type PanelState,
  type PanelWidgetRect
} from '@shared/types/panel'
import type { PanelSurfaceApi } from '@shared/types/panel'

declare global {
  interface Window { enestPanel?: PanelSurfaceApi }
}

const api = window.enestPanel

/** 八向缩放手柄：热区在组件四周内缩带上，命中后用对应 edge 发起 resize。 */
const RESIZE_HANDLES: Array<{ edge: PanelResizeEdge; style: React.CSSProperties; cursor: string }> = [
  { edge: 'n', style: { left: 10, right: 10, top: 0, height: 6 }, cursor: 'ns-resize' },
  { edge: 's', style: { left: 10, right: 10, bottom: 0, height: 6 }, cursor: 'ns-resize' },
  { edge: 'w', style: { top: 10, bottom: 10, left: 0, width: 6 }, cursor: 'ew-resize' },
  { edge: 'e', style: { top: 10, bottom: 10, right: 0, width: 6 }, cursor: 'ew-resize' },
  { edge: 'nw', style: { left: 0, top: 0, width: 12, height: 12 }, cursor: 'nwse-resize' },
  { edge: 'ne', style: { right: 0, top: 0, width: 12, height: 12 }, cursor: 'nesw-resize' },
  { edge: 'sw', style: { left: 0, bottom: 0, width: 12, height: 12 }, cursor: 'nesw-resize' },
  { edge: 'se', style: { right: 0, bottom: 0, width: 12, height: 12 }, cursor: 'nwse-resize' }
]

interface DragVisual {
  pluginId: string
  rect: PanelWidgetRect
  guides: PanelGuide[]
}

/**
 * 面板边缘缩放手柄（四边 + 四角）。
 * 与组件手柄同一套主进程驱动逻辑；边缘热区比组件更宽（8px），便于抓取整块面板。
 */
const WINDOW_RESIZE_HANDLES: Array<{ edge: PanelResizeEdge; style: React.CSSProperties; cursor: string }> = [
  { edge: 'n', style: { left: 14, right: 14, top: 0, height: 8 }, cursor: 'ns-resize' },
  { edge: 's', style: { left: 14, right: 14, bottom: 0, height: 8 }, cursor: 'ns-resize' },
  { edge: 'w', style: { top: 14, bottom: 14, left: 0, width: 8 }, cursor: 'ew-resize' },
  { edge: 'e', style: { top: 14, bottom: 14, right: 0, width: 8 }, cursor: 'ew-resize' },
  { edge: 'nw', style: { left: 0, top: 0, width: 16, height: 16 }, cursor: 'nwse-resize' },
  { edge: 'ne', style: { right: 0, top: 0, width: 16, height: 16 }, cursor: 'nesw-resize' },
  { edge: 'sw', style: { left: 0, bottom: 0, width: 16, height: 16 }, cursor: 'nesw-resize' },
  { edge: 'se', style: { right: 0, bottom: 0, width: 16, height: 16 }, cursor: 'nwse-resize' }
]

/** 应用主题与外观到 :root，供 CSS 变量消费。 */
function applyTheme(state: PanelState): void {
  const root = document.documentElement
  root.dataset.theme = state.theme.mode
  root.dataset.anim = state.theme.animationLevel
  for (const [key, value] of Object.entries(state.theme.tokens)) {
    if (!key.startsWith('--')) continue
    root.style.setProperty(key, value)
  }
  // 完整外观快照：与主壳/其它 overlay 同一套 V2 语义（圆角、字号、材质、动效）。
  if (state.resolvedAppearance) applyAppearanceToDom(state.resolvedAppearance)
  root.style.setProperty('--panel-opacity', String(state.appearance.opacity))
  root.dataset.material = state.appearance.material
}

function widgetStyle(rect: PanelWidgetRect): React.CSSProperties {
  return {
    transform: `translate3d(${rect.x}px, ${rect.y}px, 0)`,
    width: `${rect.width}px`,
    height: `${rect.height}px`
  }
}

function PanelApp({ initialState }: { initialState: PanelState | null }): React.JSX.Element {
  const [state, setState] = useState<PanelState | null>(initialState)
  const [menu, setMenu] = useState<{ x: number; y: number; pluginId?: string } | null>(null)
  const [picker, setPicker] = useState<{ candidates: PanelCandidate[]; loading: boolean; error?: string } | null>(null)
  const [dragId, setDragId] = useState<string | null>(null)
  const [windowDragging, setWindowDragging] = useState(false)
  const dragRef = useRef<DragVisual | null>(null)
  /** 组件拖动归属：只由 beginDrag/endDrag 改；feedback 回调不得触碰（否则 end 漏发）。 */
  const activeDragRef = useRef(false)
  const windowDraggingRef = useRef(false)
  const frameRef = useRef<HTMLDivElement | null>(null)
  const guideRefs = useRef<Record<'x' | 'y', HTMLDivElement | null>>({ x: null, y: null })
  const widgetRefs = useRef(new Map<string, HTMLDivElement>())

  useEffect(() => {
    if (!api) return
    let cancelled = false
    void api.getState().then(next => { if (!cancelled && next) setState(next) })
    const offState = api.onState(next => setState(next))
    return () => { cancelled = true; offState() }
  }, [])

  useEffect(() => {
    if (state) applyTheme(state)
  }, [state])

  /**
   * 声明整块内容区为插件拖入目标：Tab / 独立窗口拖到面板上时主进程据此高亮落点，
   * 松手后按指针坐标嵌入。面板尺寸变化时重新声明，保证落点矩形始终等于内容区。
   */
  useEffect(() => {
    if (!api || !state) return
    api.setDropTarget({
      kind: 'panel',
      rect: { x: 0, y: 0, width: state.width, height: state.height },
      axis: 'x',
      items: [],
      panelId: state.id
    })
    return () => api.setDropTarget(null)
  }, [state?.width, state?.height, state?.id])

  /** 外部拖入落点高亮：只在指针进入本面板时显示提示层。 */
  const [dropActive, setDropActive] = useState(false)
  useEffect(() => {
    if (!api) return
    return api.onPluginDrag(feedback => {
      setDropActive(feedback.active === true && feedback.target === 'panel')
    })
  }, [])

  /**
   * 覆盖层（菜单/选择器）打开期间隐藏全部插件原生视图：
   * 原生视图在 OS 层位于 chrome DOM 之上，不隐藏则菜单会被组件内容盖住无法点击。
   */
  const overlayOpen = menu !== null || picker !== null
  useEffect(() => {
    if (!api) return
    void api.command({ action: overlayOpen ? 'overlay-open' : 'overlay-close' })
  }, [overlayOpen])

  /**
   * 拖动反馈：直接改 DOM，不 setState。
   * 只在反馈包含 rect 时更新组件框；辅助线用 transform 定位。
   */
  useEffect(() => {
    if (!api) return
    return api.onDrag(feedback => {
      if (!feedback.active || !feedback.pluginId || !feedback.rect) {
        // 拖动结束：清掉辅助线、隐藏跟随框。组件本体位置由随后推送的 state 快照
        // 触发 React 重渲染落定（主进程在 endDrag 里已 persist + publishPanel）。
        for (const axis of ['x', 'y'] as const) {
          const guide = guideRefs.current[axis]
          if (guide) guide.style.opacity = '0'
        }
        const frame = frameRef.current
        if (frame) frame.style.opacity = '0'
        dragRef.current = null
        // 只清视觉标记，不动 activeDragRef：拖动归属由 pointerup 的 endDrag 负责，
        // 否则 feedback 先到会让 widget-drag-end 漏发、主进程 session 悬挂。
        return
      }
      dragRef.current = { pluginId: feedback.pluginId, rect: feedback.rect, guides: feedback.guides ?? [] }
      const frame = frameRef.current
      if (frame) {
        frame.style.opacity = '1'
        frame.style.transform = `translate3d(${feedback.rect.x}px, ${feedback.rect.y}px, 0)`
        frame.style.width = `${feedback.rect.width}px`
        frame.style.height = `${feedback.rect.height}px`
      }
      const byAxis = new Map((feedback.guides ?? []).map(guide => [guide.axis, guide]))
      for (const axis of ['x', 'y'] as const) {
        const guide = guideRefs.current[axis]
        const value = byAxis.get(axis)
        if (!guide) continue
        if (!value) { guide.style.opacity = '0'; continue }
        guide.style.opacity = '1'
        if (axis === 'x') {
          guide.style.transform = `translate3d(${value.position}px, ${value.from}px, 0)`
          guide.style.width = '1px'
          guide.style.height = `${Math.max(1, value.to - value.from)}px`
        } else {
          guide.style.transform = `translate3d(${value.from}px, ${value.position}px, 0)`
          guide.style.width = `${Math.max(1, value.to - value.from)}px`
          guide.style.height = '1px'
        }
      }
      // 拖动中的组件本体只做视觉跟随（原生 view 由主进程直接 setBounds）。
      const node = widgetRefs.current.get(feedback.pluginId)
      if (node) {
        node.style.transform = `translate3d(${feedback.rect.x}px, ${feedback.rect.y}px, 0)`
        node.style.width = `${feedback.rect.width}px`
        node.style.height = `${feedback.rect.height}px`
      }
    })
  }, [])

  const command = useCallback(async (payload: PanelCommand) => {
    if (!api) return { ok: false, error: '宿主不可用' }
    const result = await api.command(payload)
    if (result.state) setState(result.state)
    return result
  }, [])

  const beginDrag = useCallback((event: React.PointerEvent, pluginId: string, mode: 'move' | 'resize', edge?: PanelResizeEdge) => {
    if (event.button !== 0 || !api || !state) return
    const widget = state.widgets.find(item => item.pluginId === pluginId)
    if (!widget) return
    // 组件条内的按钮不触发拖动。
    if ((event.target as HTMLElement).closest('[data-no-drag]')) return
    event.preventDefault()
    const point: PanelPoint = { x: event.clientX, y: event.clientY }
    ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
    setDragId(pluginId)
    activeDragRef.current = true
    dragRef.current = { pluginId, rect: { x: widget.x, y: widget.y, width: widget.width, height: widget.height }, guides: [] }
    void command({ action: 'widget-drag-begin', pluginId, mode, edge, pointer: point })
  }, [command, state])

  const endDrag = useCallback((cancel = false) => {
    // 守卫用 activeDragRef（只由 begin/end 改），不能复用 dragRef——
    // 后者会被 feedback 回调清空，会让 widget-drag-end 漏发、主进程 session 悬挂。
    if (!activeDragRef.current) return
    activeDragRef.current = false
    dragRef.current = null
    setDragId(null)
    void command({ action: 'widget-drag-end', cancel }).then(result => {
      // 拖动期间组件 DOM 由 feedback 直接改样式；结束时立刻回正到宿主确认的矩形，
      // 避免等下一次 state 推送前出现错位闪动。
      const confirmed = result.state?.widgets
      if (!confirmed) return
      for (const widget of confirmed) {
        const node = widgetRefs.current.get(widget.pluginId)
        if (!node) continue
        node.style.transform = `translate3d(${widget.x}px, ${widget.y}px, 0)`
        node.style.width = `${widget.width}px`
        node.style.height = `${widget.height}px`
      }
    })
  }, [command])

  /** 整块面板移动/缩放：与组件拖动同一套主进程 tick，不用 -webkit-app-region（其右键不触发 contextmenu）。 */
  const beginWindowDrag = useCallback((event: React.PointerEvent, mode: 'move' | 'resize', edge?: PanelResizeEdge) => {
    if (event.button !== 0 || !api) return
    if ((event.target as HTMLElement).closest('[data-no-drag]')) return
    event.preventDefault()
    ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
    windowDraggingRef.current = true
    setWindowDragging(true)
    void command({ action: 'window-drag-begin', mode, edge })
  }, [command])

  const endWindowDrag = useCallback((cancel = false) => {
    if (!windowDraggingRef.current) return
    windowDraggingRef.current = false
    setWindowDragging(false)
    void command({ action: 'window-drag-end', cancel })
  }, [command])

  /**
   * 拖动保活：pointermove 可达 120Hz+，直接发 IPC 会造成高频噪声。
   * 用 rAF 合并到每帧最多一次，与主进程的 setTimeout(0) 合并互补。
   */
  const tickFrame = useRef<number | null>(null)
  const onPointerMove = useCallback(() => {
    if (!windowDraggingRef.current && !activeDragRef.current) return
    if (tickFrame.current !== null) return
    tickFrame.current = requestAnimationFrame(() => {
      tickFrame.current = null
      if (windowDraggingRef.current || activeDragRef.current) api?.dragTick()
    })
  }, [])
  useEffect(() => () => {
    if (tickFrame.current !== null) cancelAnimationFrame(tickFrame.current)
  }, [])

  const openPicker = useCallback(async () => {
    setMenu(null)
    setPicker({ candidates: [], loading: true })
    const result = await command({ action: 'list-candidates' })
    if (!result.ok) { setPicker({ candidates: [], loading: false, error: result.error ?? '读取插件失败' }); return }
    setPicker({ candidates: result.candidates ?? [], loading: false })
  }, [command])

  const addWidget = useCallback(async (pluginId: string) => {
    setPicker(null)
    await command({ action: 'add-widget', pluginId })
  }, [command])

  const empty = (state?.widgets.length ?? 0) === 0
  const guides = useMemo(() => ['x', 'y'] as const, [])

  return (
    <div
      className={`panel-root${windowDragging ? ' is-window-dragging' : ''}`}
      onPointerMove={onPointerMove}
      onPointerUp={() => { endDrag(false); endWindowDrag(false) }}
      onPointerCancel={() => { endDrag(true); endWindowDrag(true) }}
    >
      <div className="panel-surface" />
      {/* 空白层在组件之下：按住拖动整块面板，右键出面板菜单。
          不用 -webkit-app-region: drag —— 该区域的右键不会触发 contextmenu。 */}
      <div
        className="panel-blank"
        onPointerDown={event => beginWindowDrag(event, 'move')}
        onContextMenu={event => { event.preventDefault(); setMenu({ x: event.clientX, y: event.clientY }) }}
      />

      {/* 面板边缘缩放手柄：与组件手柄同一套主进程驱动逻辑。 */}
      {WINDOW_RESIZE_HANDLES.map(handle => (
        <div
          key={handle.edge}
          className={`panel-window-handle edge-${handle.edge}`}
          style={{ ...handle.style, cursor: handle.cursor }}
          data-no-drag
          onPointerDown={event => beginWindowDrag(event, 'resize', handle.edge)}
        />
      ))}

      {state?.widgets.map(widget => (
        <div
          key={widget.pluginId}
          ref={node => {
            if (node) widgetRefs.current.set(widget.pluginId, node)
            else widgetRefs.current.delete(widget.pluginId)
          }}
          className={`panel-widget${dragId === widget.pluginId ? ' is-dragging' : ''}`}
          style={widgetStyle(widget)}
          onPointerDown={event => void command({ action: 'raise-widget', pluginId: widget.pluginId })}
        >
          <div
            className="panel-widget-bar"
            onPointerDown={event => beginDrag(event, widget.pluginId, 'move')}
            onDoubleClick={() => void command({ action: 'dock-widget', pluginId: widget.pluginId })}
            onContextMenu={event => { event.preventDefault(); setMenu({ x: event.clientX, y: event.clientY, pluginId: widget.pluginId }) }}
            title="拖动移动 · 双击移回主窗 · 右键更多操作"
          >
            <span className="panel-widget-icon" aria-hidden>
              {widget.icon ? <img src={widget.icon} alt="" /> : <span className="panel-widget-glyph">{widget.glyph ?? '⌥'}</span>}
            </span>
            <span className="panel-widget-title">{widget.title}</span>
            {widget.status === 'loading' && <span className="panel-widget-status" data-no-drag>加载中</span>}
            {widget.status === 'error' && <span className="panel-widget-status is-error" data-no-drag>{widget.error ?? '启动失败'}</span>}
            <button
              type="button"
              className="panel-widget-more"
              data-no-drag
              aria-label="组件菜单"
              onPointerDown={event => event.stopPropagation()}
              onClick={event => {
                const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
                setMenu({ x: rect.left, y: rect.bottom + 4, pluginId: widget.pluginId })
              }}
            >⋯</button>
          </div>
          <div className="panel-widget-body">
            {(widget.status === 'error' || widget.status === 'hibernated') && (
              <div className="panel-widget-retry" data-no-drag onPointerDown={event => event.stopPropagation()}>
                <span>{widget.status === 'error' ? (widget.error ?? '启动失败') : '已休眠'}</span>
                <button type="button" onClick={() => void command({ action: 'retry-widget', pluginId: widget.pluginId })}>重试</button>
              </div>
            )}
          </div>
          {RESIZE_HANDLES.map(handle => (
            <div
              key={handle.edge}
              className={`panel-widget-handle edge-${handle.edge}`}
              style={{ ...handle.style, cursor: handle.cursor }}
              onPointerDown={event => beginDrag(event, widget.pluginId, 'resize', handle.edge)}
            />
          ))}
        </div>
      ))}

      {empty && <div className="panel-empty">右键添加组件</div>}

      {/* 外部插件拖入时的落点高亮：提示「松手即嵌入」。 */}
      {dropActive && (
        <div className="panel-drop-hint" aria-hidden>
          <span>松开即可放入面板</span>
        </div>
      )}

      {/* 拖动跟随框与对齐辅助线：始终存在，靠 opacity 切换，避免挂载/卸载抖动。 */}
      <div className="panel-drag-frame" ref={node => { frameRef.current = node }} style={{ opacity: 0 }} />
      {guides.map(axis => (
        <div
          key={axis}
          className={`panel-guide axis-${axis}`}
          ref={node => { guideRefs.current[axis] = node }}
          style={{ opacity: 0 }}
        />
      ))}

      {/* 空白区域承接拖动面板与右键菜单（由 panel-blank 层负责） */}

      {menu && (
        <>
          <div className="panel-menu-backdrop" onPointerDown={() => setMenu(null)} onContextMenu={event => { event.preventDefault(); setMenu(null) }} />
          <div className="panel-menu" style={{ left: menu.x, top: menu.y }} role="menu">
            {menu.pluginId ? (
              <>
                <button type="button" role="menuitem" onClick={() => { void command({ action: 'dock-widget', pluginId: menu.pluginId! }); setMenu(null) }}>移回主窗</button>
                <button type="button" role="menuitem" onClick={() => { void command({ action: 'remove-widget', pluginId: menu.pluginId! }); setMenu(null) }}>移除组件</button>
                <hr />
                <button type="button" role="menuitem" className="is-danger" onClick={() => { void command({ action: 'close-panel' }); setMenu(null) }}>关闭面板</button>
              </>
            ) : (
              <>
                <button type="button" role="menuitem" onClick={() => void openPicker()}>添加组件…</button>
                <button type="button" role="menuitem" onClick={() => { void command({ action: 'set-appearance', appearance: { opacity: state?.appearance.opacity === 1 ? 0.78 : 1 } }); setMenu(null) }}>切换不透明度</button>
                <hr />
                <button type="button" role="menuitem" className="is-danger" onClick={() => { void command({ action: 'close-panel' }); setMenu(null) }}>关闭面板</button>
              </>
            )}
          </div>
        </>
      )}

      {picker && (
        <div className="panel-picker-backdrop" onPointerDown={() => setPicker(null)}>
          <div className="panel-picker" onPointerDown={event => event.stopPropagation()} role="dialog" aria-label="添加组件">
            <header>
              <h2>添加组件</h2>
              <button type="button" className="panel-picker-close" onClick={() => setPicker(null)} aria-label="关闭">✕</button>
            </header>
            {picker.loading
              ? <p className="panel-picker-hint" role="status">正在读取插件…</p>
              : picker.error
                ? <p className="panel-picker-hint is-error" role="status">{picker.error}</p>
                : picker.candidates.length === 0
                  ? <p className="panel-picker-hint">没有可添加的插件（已安装且未在其它面板中）。</p>
                  : <ul className="panel-picker-list">
                    {picker.candidates.map(candidate => (
                      <li key={candidate.pluginId}>
                        <button type="button" disabled={!!candidate.panelId} onClick={() => void addWidget(candidate.pluginId)}>
                          <span className="panel-picker-icon" aria-hidden>
                            {candidate.icon ? <img src={candidate.icon} alt="" /> : <span>{candidate.glyph ?? '⌥'}</span>}
                          </span>
                          <span className="panel-picker-name">{candidate.name}</span>
                          {candidate.panelId && <span className="panel-picker-note">已在面板中</span>}
                        </button>
                      </li>
                    ))}
                  </ul>}
          </div>
        </div>
      )}
    </div>
  )
}

const root = document.getElementById('root')
if (root) createRoot(root).render(<PanelApp initialState={null} />)
