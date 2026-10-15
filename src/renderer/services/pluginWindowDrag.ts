import gsap from 'gsap'
import { d, ease } from '@renderer/gsap/marketMotion'
import type { PluginDragFeedback, PluginDropTarget, PluginWindowsApi, WindowRect } from '@shared/types/plugin-window'

const START_DISTANCE = 8

/** One source keeps pointer capture until mouse-up; native views move only after commit. */
export function bindPluginDragSource(root: HTMLElement, resolve: (target: Element) => { element: HTMLElement; pluginId: string } | null): () => void {
  const api = window.enestWindows
  if (!api) return () => {}
  let gesture: { pointerId: number; element: HTMLElement; pluginId: string; x: number; y: number; started: boolean; token?: string; released?: boolean; endedTokens?: Set<string> } | null = null
  let frame = 0
  let suppressClick = false
  let disposed = false
  const tick = () => {
    frame = 0
    if (gesture?.token) api.updateDrag(gesture.token)
  }
  const finish = (cancel: boolean, notifyHost = true) => {
    const current = gesture
    if (!current) return
    gesture = null
    current.released = cancel
    cancelAnimationFrame(frame); frame = 0
    current.element.classList.remove('plugin-drag-source')
    document.documentElement.classList.remove('plugin-dragging')
    if (current.element.hasPointerCapture(current.pointerId)) current.element.releasePointerCapture(current.pointerId)
    api.armDrag(null)
    if (notifyHost && current.token) void api.endDrag(current.token, cancel).catch(() => {})
  }
  const down = (event: PointerEvent) => {
    if (event.button !== 0 || event.isPrimary === false || event.pointerType === 'touch' || gesture) return
    suppressClick = false
    const source = event.target instanceof Element ? resolve(event.target) : null
    if (!source?.pluginId) return
    gesture = { pointerId: event.pointerId, element: source.element, pluginId: source.pluginId, x: event.clientX, y: event.clientY, started: false }
    try {
      source.element.setPointerCapture(event.pointerId)
      // The source window takes focus before it crosses the threshold. Keep Quick available meanwhile.
      api.armDrag(source.pluginId)
    } catch { gesture = null; api.armDrag(null) }
  }
  const move = (event: PointerEvent) => {
    const current = gesture
    if (!current || current.pointerId !== event.pointerId) return
    if (!current.started && Math.hypot(event.clientX - current.x, event.clientY - current.y) >= START_DISTANCE) {
      current.started = true
      suppressClick = true
      const source = resolve(current.element)
      if (!source || source.pluginId !== current.pluginId) { finish(true); return }
      current.element.classList.add('plugin-drag-source')
      document.documentElement.classList.add('plugin-dragging')
      void api.beginDrag(source.pluginId).then(result => {
        if (!result) { if (gesture === current) finish(true); return }
        current.token = result.token
        // Native feedback may precede the invoke reply. Only its matching token ends this gesture.
        if (current.endedTokens?.has(result.token)) { if (gesture === current) finish(true, false); return }
        // Mouse-up, Escape or unmount may precede the asynchronous begin reply.
        if (current.released !== undefined || disposed) void api.endDrag(result.token, current.released ?? true).catch(() => {})
        else api.updateDrag(result.token)
      }).catch(() => { if (gesture === current) finish(true) })
    }
    if (current.started) {
      event.preventDefault()
      if (current.token && !frame) frame = requestAnimationFrame(tick)
    }
  }
  const up = (event: PointerEvent) => { if (gesture?.pointerId === event.pointerId) finish(false) }
  const cancel = (event: PointerEvent) => { if (gesture?.pointerId === event.pointerId) finish(true) }
  const key = (event: KeyboardEvent) => {
    if (event.key === 'Escape' && gesture?.started) { event.preventDefault(); event.stopImmediatePropagation(); finish(true) }
  }
  const click = (event: MouseEvent) => {
    if (suppressClick) { suppressClick = false; event.preventDefault(); event.stopImmediatePropagation() }
  }
  const hidden = () => { if (document.hidden) finish(true) }
  const unload = () => finish(true)
  const offDrag = api.onDrag(event => {
    // A host watchdog or retired runtime can end a drag while the pointer is still held.
    // Other plugins' broadcasts and final feedback after our pointer-up are unrelated.
    const current = gesture
    if (event.active || !event.token || !current?.started || event.pluginId !== current.pluginId) return
    if (current.token) { if (event.token === current.token) finish(true, false) }
    else (current.endedTokens ??= new Set()).add(event.token)
  })
  // Pointer listeners live on the document so captured events still arrive after leaving the source's bounds.
  root.addEventListener('pointerdown', down)
  root.addEventListener('click', click, true)
  document.addEventListener('pointermove', move, { passive: false })
  document.addEventListener('pointerup', up)
  document.addEventListener('pointercancel', cancel)
  document.addEventListener('lostpointercapture', cancel)
  document.addEventListener('keydown', key, true)
  document.addEventListener('visibilitychange', hidden)
  window.addEventListener('pagehide', unload)
  window.addEventListener('blur', unload)
  return () => {
    disposed = true; offDrag(); finish(true)
    root.removeEventListener('pointerdown', down); root.removeEventListener('click', click, true)
    document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up)
    document.removeEventListener('pointercancel', cancel); document.removeEventListener('lostpointercapture', cancel)
    document.removeEventListener('keydown', key, true); document.removeEventListener('visibilitychange', hidden)
    window.removeEventListener('pagehide', unload)
    window.removeEventListener('blur', unload)
  }
}

function untransformedRect(element: HTMLElement): WindowRect {
  const rect = element.getBoundingClientRect()
  // Tab entrance uses center-origin scale/rotation. Its visual size must not alter hit testing.
  const width = element.offsetWidth || rect.width, height = element.offsetHeight || rect.height
  return { x: rect.x + (rect.width - width) / 2 - (Number(gsap.getProperty(element, 'x')) || 0),
    y: rect.y + (rect.height - height) / 2 - (Number(gsap.getProperty(element, 'y')) || 0), width, height }
}

interface DropOptions {
  kind: 'shell' | 'quick'
  axis?: 'x' | 'y'
  items?: () => HTMLElement[]
  scroller?: HTMLElement
  enabled?: () => boolean
  onFeedback?: (event: PluginDragFeedback) => void
}

/** Target geometry is local DIP; host resolves view origins and rejects stale surfaces. */
export function bindPluginDropTarget(root: HTMLElement, options: DropOptions): { refresh(): void; dispose(): void } {
  const api: PluginWindowsApi | undefined = window.enestWindows
  if (!api) return { refresh() {}, dispose() {} }
  const axis = options.axis ?? 'x'
  let reportFrame = 0, scrollFrame = 0, lastReport = '', signature = ''
  let feedback: PluginDragFeedback = { active: false }
  let moving = new Set<HTMLElement>()
  const indicator = document.createElement('span')
  indicator.className = `plugin-drop-indicator axis-${axis}`
  indicator.hidden = true
  indicator.setAttribute('aria-hidden', 'true')
  document.body.appendChild(indicator)
  const reset = (animate = true) => {
    for (const node of moving) gsap.to(node, { x: 0, y: 0, duration: animate ? d(0.16) : 0, ease: ease('power2.out'), overwrite: true, clearProps: 'transform' })
    moving.clear()
  }
  const paint = () => {
    const accepting = options.enabled?.() !== false && feedback.active && feedback.target === options.kind
    root.classList.toggle('plugin-drop-ready', accepting)
    root.classList.toggle('plugin-drag-session', feedback.active)
    const items = options.items?.() ?? []
    const nextSignature = `${accepting}:${feedback.pluginId}:${feedback.index}:${items.map(item => item.dataset.pluginId).join(',')}`
    if (nextSignature === signature) return
    signature = nextSignature
    indicator.hidden = !accepting || !items.length
    // Commit snapshots arrive with drag-end; discard preview transforms before that order paints.
    if (!accepting || !items.length) { reset(feedback.active); return }
    // Read original boxes in one pass. Transform previews never change reported hit areas.
    const boxes = new Map(items.map(item => [item, untransformedRect(item)]))
    const dragged = items.find(item => item.dataset.pluginId === feedback.pluginId)
    const remaining = items.filter(item => item !== dragged)
    const index = Math.max(0, Math.min(remaining.length, feedback.index ?? remaining.length))
    const position = axis === 'x' ? 'x' : 'y'
    const extent = axis === 'x' ? 'width' : 'height'
    const first = boxes.get(items[0])!
    const gap = items.length > 1 ? boxes.get(items[1])![position] - first[position] - first[extent] : 2
    const placeholder = dragged ? boxes.get(dragged)![extent] : axis === 'x' ? Math.min(first.width, 140) : first.height
    let cursor = first[position]
    for (let i = 0; i <= remaining.length; i++) {
      if (i === index) {
        indicator.style.left = `${axis === 'x' ? cursor : first.x + 2}px`
        indicator.style.top = `${axis === 'y' ? cursor : first.y + 3}px`
        indicator.style.width = `${axis === 'x' ? 2 : first.width - 4}px`
        indicator.style.height = `${axis === 'y' ? 2 : first.height - 6}px`
        if (dragged) {
          moving.add(dragged)
          gsap.to(dragged, { [position]: cursor - boxes.get(dragged)![position], duration: d(0.16), ease: ease('power2.out'), overwrite: true })
        }
        cursor += placeholder + gap
      }
      const node = remaining[i]
      if (!node) continue
      const box = boxes.get(node)!
      moving.add(node)
      gsap.to(node, { [position]: cursor - box[position], duration: d(0.16), ease: ease('power2.out'), overwrite: true })
      cursor += box[extent] + gap
    }
  }
  const report = () => {
    reportFrame = 0
    const rect = root.getBoundingClientRect()
    const targets: PluginDropTarget[] = options.enabled?.() === false || !rect.width || !rect.height ? [] : [{
      kind: options.kind, axis, rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      items: (options.items?.() ?? []).flatMap(element => element.dataset.pluginId ? [{ pluginId: element.dataset.pluginId, rect: untransformedRect(element) }] : [])
    }]
    const serialized = JSON.stringify(targets)
    if (serialized !== lastReport) { lastReport = serialized; api.targets(targets) }
    signature = ''; paint()
  }
  const refresh = () => { if (!reportFrame) reportFrame = requestAnimationFrame(report) }
  const scroll = () => {
    scrollFrame = 0
    const scroller = options.scroller, point = feedback.localPoint
    if (!scroller || !point || !feedback.active || feedback.target !== options.kind) return
    const box = scroller.getBoundingClientRect(), coordinate = axis === 'x' ? point.x : point.y
    const start = axis === 'x' ? box.left : box.top, end = axis === 'x' ? box.right : box.bottom
    const edge = Math.min(28, (end - start) / 4)
    const speed = coordinate < start + edge ? -Math.ceil(9 * Math.min(1, Math.max(0, 1 - (coordinate - start) / edge)))
      : coordinate > end - edge ? Math.ceil(9 * Math.min(1, Math.max(0, 1 - (end - coordinate) / edge))) : 0
    if (!speed) return
    const before = axis === 'x' ? scroller.scrollLeft : scroller.scrollTop
    if (axis === 'x') scroller.scrollLeft += speed; else scroller.scrollTop += speed
    if ((axis === 'x' ? scroller.scrollLeft : scroller.scrollTop) !== before) { refresh(); scrollFrame = requestAnimationFrame(scroll) }
  }
  const off = api.onDrag(event => {
    feedback = event; options.onFeedback?.(event); paint()
    if (!event.active) { cancelAnimationFrame(scrollFrame); scrollFrame = 0 }
    else if (!scrollFrame) scrollFrame = requestAnimationFrame(scroll)
  })
  const resize = new ResizeObserver(refresh)
  resize.observe(root)
  const mutation = new MutationObserver(refresh)
  mutation.observe(root, { childList: true, subtree: true, characterData: true })
  root.addEventListener('scroll', refresh, true)
  window.addEventListener('resize', refresh)
  refresh()
  return { refresh, dispose() {
    off(); resize.disconnect(); mutation.disconnect(); reset(false); indicator.remove()
    cancelAnimationFrame(reportFrame); cancelAnimationFrame(scrollFrame)
    root.removeEventListener('scroll', refresh, true); window.removeEventListener('resize', refresh)
    root.classList.remove('plugin-drop-ready', 'plugin-drag-session'); api.targets([])
  } }
}
