import { randomUUID } from 'node:crypto'
import { BaseWindow, screen, WebContentsView, type WebContents } from 'electron'
import { IpcChannels } from '@shared/types/ipc'
import type { PluginDragFeedback, PluginDropTarget, WindowPoint, WindowRect } from '@shared/types/plugin-window'
import { pluginHost } from '@main/plugin/PluginHost'
import { getRuntimeScope } from '@main/plugin/PluginRuntimeScope'
import { pluginRegistry } from '@main/plugin/PluginRegistry'
import { getMainWindow, getShellWebContents } from '@main/window/createShellWindow'
import { acquireQuickInteraction, getQuickWebContents, getQuickWindow } from '@main/window/createQuickWindow'
import { acquireOrbDragExpansion, getOrbDragSurface } from '@main/window/orbRailViews'
import { constrainDetachedBounds, getDetachedChrome, getDetachedWindow, getPluginForDetachedSender, observeDetachedWindows } from '@main/window/detachedPluginWindows'
import { getTrustedSurfaceRole } from '@main/ipc/ipcSecurity'

interface Surface { window: BaseWindow; bounds: WindowRect; contents: WebContents }
interface Registration { contents: WebContents; targets: PluginDropTarget[] }
interface DragSession {
  token: string; pluginId: string; senderId: number; generation: number; revision: number
  source: BaseWindow; sourceContents: WebContents; preview: BaseWindow; previewView: WebContentsView; previewContents: WebContents
  releases: Array<() => void>; cleanup: () => void; watchdog: ReturnType<typeof setInterval>
  lastInput: number; frame: ReturnType<typeof setTimeout> | null; target: Hit | null; ending: boolean
  originZone: WindowRect | null; leftOrigin: boolean; disposed: boolean
}
interface Hit { kind: 'shell' | 'quick'; index: number; senderId: number }
const registrations = new Map<number, Registration>()
const windowOrder = new Map<number, number>()
const trackedWindows = new WeakSet<BaseWindow>()
let order = 0
let session: DragSession | null = null
let armed: { senderId: number; pluginId: string; release: () => void } | null = null

/** Pointer-down protects Quick even before the 8 DIP threshold is crossed. */
export function armPluginWindowDrag(senderId: number, pluginId: string | null): void {
  if (pluginId === null) { if (armed?.senderId === senderId) armed.release(); return }
  if (session || !canSurfaceManagePlugin(senderId, pluginId) || pluginHost.hasWindowInteraction(pluginId)) return
  const source = surface(senderId)
  if (!source || !source.window.isVisible() || source.window.isMinimized()) return
  if (armed?.senderId === senderId && armed.pluginId === pluginId) return
  armed?.release()
  const releaseInteraction = acquireQuickInteraction()
  let released = false
  const release = (): void => {
    if (released) return
    released = true
    clearTimeout(timeout)
    source.window.removeListener('hide', release)
    source.window.removeListener('minimize', release)
    source.window.removeListener('closed', release)
    source.contents.removeListener('destroyed', release)
    source.contents.removeListener('render-process-gone', release)
    releaseInteraction()
    if (armed?.release === release) armed = null
  }
  const timeout = setTimeout(release, 30000)
  timeout.unref()
  source.window.on('hide', release)
  source.window.on('minimize', release)
  source.window.on('closed', release)
  source.contents.once('destroyed', release)
  source.contents.once('render-process-gone', release)
  armed = { senderId, pluginId, release }
}

export function pointInRect(point: WindowPoint, rect: WindowRect, margin = 0): boolean {
  return point.x >= rect.x - margin && point.y >= rect.y - margin && point.x < rect.x + rect.width + margin && point.y < rect.y + rect.height + margin
}
export function insertionIndex(point: WindowPoint, target: PluginDropTarget, pluginId: string): number {
  const coordinate = target.axis === 'x' ? point.x : point.y
  const items = target.items.filter(item => item.pluginId !== pluginId)
  const index = items.findIndex(item => coordinate < (target.axis === 'x' ? item.rect.x + item.rect.width / 2 : item.rect.y + item.rect.height / 2))
  return index < 0 ? items.length : index
}
function validRect(value: unknown): value is WindowRect {
  const rect = value as WindowRect
  return !!rect && ['x', 'y', 'width', 'height'].every(key => typeof rect[key as keyof WindowRect] === 'number' && Number.isFinite(rect[key as keyof WindowRect]) && Math.abs(rect[key as keyof WindowRect]) <= 100000)
    && rect.width > 0 && rect.height > 0
}
function surface(senderId: number): Surface | null {
  const role = getTrustedSurfaceRole(senderId)
  let win: BaseWindow | null = null, bounds: WindowRect | null = null, contents: WebContents | null = null
  if (role === 'shell' && getShellWebContents()?.id === senderId) { win = getMainWindow(); contents = getShellWebContents() }
  else if (role === 'quick' && getQuickWebContents()?.id === senderId) { win = getQuickWindow(); contents = getQuickWebContents() }
  else if (role === 'orb') {
    const native = getOrbDragSurface(senderId)
    if (native) { win = native.window; bounds = native.view.getBounds(); contents = native.view.webContents }
  } else if (role === 'detached') {
    const id = getPluginForDetachedSender(senderId)
    if (id) { win = getDetachedWindow(id); contents = getDetachedChrome(id)?.webContents ?? null; bounds = getDetachedChrome(id)?.getBounds() ?? null }
  }
  if (!win || win.isDestroyed() || !contents || contents.isDestroyed()) return null
  const outer = win.getContentBounds()
  return { window: win, contents, bounds: { x: outer.x + (bounds?.x ?? 0), y: outer.y + (bounds?.y ?? 0), width: bounds?.width ?? outer.width, height: bounds?.height ?? outer.height } }
}
export function canSurfaceManagePlugin(senderId: number, pluginId: string): boolean {
  if (typeof pluginId !== 'string' || !pluginId || pluginId.length > 200) return false
  const owner = surface(senderId)
  if (!owner) return false
  const role = getTrustedSurfaceRole(senderId)
  const placement = pluginHost.getPlacement(pluginId)
  if (role === 'detached') return getPluginForDetachedSender(senderId) === pluginId && placement?.kind === 'detached'
  if (role === 'quick') return placement?.kind === 'quick' && pluginHost.getQuickPlugin() === pluginId
  return (role === 'shell' || role === 'orb') && placement?.kind === 'shell' && pluginHost.hasShellTab(pluginId)
}
function trackWindow(win: BaseWindow): void {
  if (trackedWindows.has(win)) return
  trackedWindows.add(win)
  const windowId = win.id
  windowOrder.set(windowId, ++order)
  const raise = (): void => { windowOrder.set(windowId, ++order) }
  win.on('focus', raise)
  win.on('show', raise)
  win.once('closed', () => { windowOrder.delete(windowId); win.removeListener('focus', raise); win.removeListener('show', raise) })
}
export function registerPluginDropTargets(contents: WebContents, input: unknown): void {
  const native = surface(contents.id)
  if (!native) return
  trackWindow(native.window)
  const role = getTrustedSurfaceRole(contents.id)
  const expected = role === 'quick' ? 'quick' : role === 'shell' || role === 'orb' ? 'shell' : null
  const targets: PluginDropTarget[] = []
  if (expected && Array.isArray(input)) for (const target of input.slice(0, 2)) {
    if (target?.kind !== expected || !validRect(target.rect) || !['x', 'y'].includes(target.axis) || !Array.isArray(target.items)) continue
    const items = target.items.slice(0, 500).filter((item: any) => typeof item?.pluginId === 'string' && item.pluginId.length <= 200 && validRect(item.rect))
    targets.push({ kind: expected, rect: { ...target.rect }, axis: target.axis, items: items.map((item: any) => ({ pluginId: item.pluginId, rect: { ...item.rect } })) })
  }
  const senderId = contents.id
  if (!registrations.has(senderId)) contents.once('destroyed', () => {
    registrations.delete(senderId)
    if (session?.senderId === senderId) cancelPluginWindowDrag()
  })
  registrations.set(senderId, { contents, targets })
  // Scrolling can move insertion geometry while the physical pointer is stationary.
  if (session && !session.ending) scheduleTick(session)
}
function windowAt(point: WindowPoint, preview: BaseWindow): BaseWindow | null {
  const visible = BaseWindow.getAllWindows().filter(win => win !== preview && !win.isDestroyed() && win.isVisible() && !win.isMinimized())
  for (const win of visible) trackWindow(win)
  visible.sort((a, b) => Number(b.isAlwaysOnTop()) - Number(a.isAlwaysOnTop()) || Number(b.isFocused()) - Number(a.isFocused()) || (windowOrder.get(b.id) ?? 0) - (windowOrder.get(a.id) ?? 0))
  return visible.find(win => pointInRect(point, win.getBounds())) ?? null
}
function hitAt(active: DragSession, point: WindowPoint): { hit: Hit | null; inside: boolean } {
  const top = windowAt(point, active.preview)
  if (!top) return { hit: null, inside: false }
  for (const [senderId, registration] of registrations) {
    const native = surface(senderId)
    if (!native || native.window !== top || !pointInRect(point, native.bounds)) continue
    const local = { x: point.x - native.bounds.x, y: point.y - native.bounds.y }
    for (const target of registration.targets) if (pointInRect(local, target.rect)) {
      return { hit: { kind: target.kind, index: insertionIndex(local, target, active.pluginId), senderId }, inside: true }
    }
  }
  return { hit: null, inside: true }
}
function broadcast(active: DragSession, feedback: PluginDragFeedback): void {
  feedback = { ...feedback, token: active.token }
  const recipients = new Set([...registrations.keys(), active.senderId])
  for (const senderId of recipients) {
    if (!feedback.active) {
      const contents = registrations.get(senderId)?.contents ?? (senderId === active.senderId ? active.sourceContents : null)
      if (contents && !contents.isDestroyed()) {
        try { contents.send(IpcChannels.PluginDragEvent, feedback) } catch { /* surface retired */ }
      }
      continue
    }
    const native = surface(senderId)
    if (!native || !native.window.isVisible() || native.window.isMinimized()) continue
    if (senderId !== active.senderId && !(registrations.get(senderId)?.targets.length)) continue
    const localPoint = feedback.point ? { x: feedback.point.x - native.bounds.x, y: feedback.point.y - native.bounds.y } : undefined
    try { native.contents.send(IpcChannels.PluginDragEvent, { ...feedback, localPoint }) } catch { /* surface retired */ }
  }
}
function stillCurrent(active: DragSession): boolean {
  return session === active && !active.source.isDestroyed() && active.source.isVisible() && !active.source.isMinimized()
    && !active.ending && canSurfaceManagePlugin(active.senderId, active.pluginId)
    && pluginHost.getPlacementRevision(active.pluginId) === active.revision
    && (getRuntimeScope(active.pluginId)?.owner.generation ?? 0) === active.generation
}
function tick(active: DragSession): void {
  if (!stillCurrent(active)) { cancelPluginWindowDrag(); return }
  const point = screen.getCursorScreenPoint()
  const result = hitAt(active, point)
  if (active.originZone && !pointInRect(point, active.originZone, 16)) active.leftOrigin = true
  active.target = result.hit
  active.preview.setPosition(Math.round(point.x + 14), Math.round(point.y + 18), false)
  broadcast(active, { active: true, pluginId: active.pluginId, point, target: result.hit?.kind ?? (result.inside || !active.leftOrigin ? null : 'outside'), index: result.hit?.index })
}
function previewHtml(title: string, icon?: string | null, glyph?: string): string {
  const escaped = title.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!)
  const safeIcon = typeof icon === 'string' && /^data:image\/(?:png|jpeg|gif|webp);base64,[a-z0-9+/=]+$/i.test(icon) && icon.length <= 500000 ? icon : null
  const safeGlyph = String(glyph || '⌥').slice(0, 4).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!)
  const badge = safeIcon ? `<img class="icon" src="${safeIcon}" alt="">` : `<span class="glyph">${safeGlyph}</span>`
  return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'"><style>html,body{margin:0;background:transparent;color:#f5f7fa;font:13px system-ui}main{margin:4px;border:1px solid #ffffff35;border-radius:12px;overflow:hidden;background:#24333aee;box-shadow:0 3px 12px #0005}header{height:36px;display:flex;align-items:center;gap:8px;padding:0 12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.icon,.glyph{display:block;width:20px;height:20px;flex:none;border-radius:5px}.glyph{font-style:normal;text-align:center;font-size:18px;line-height:20px;color:#70d7c3}#capture{display:none;width:232px;height:122px;object-fit:cover;object-position:top;background:#172126}</style></head><body><main><header>${badge}${escaped}</header><img id="capture"></main></body></html>`
}
export function beginPluginWindowDrag(senderId: number, pluginId: string): { token: string } | null {
  if (session || !canSurfaceManagePlugin(senderId, pluginId) || pluginHost.hasWindowInteraction(pluginId)) return null
  const source = surface(senderId)
  if (!source || !source.window.isVisible() || source.window.isMinimized()) return null
  const point = screen.getCursorScreenPoint()
  let createdPreview: BaseWindow | null = null
  let createdContents: WebContents | null = null
  const releases: Array<() => void> = []
  let cleanup = (): void => {}
  try {
  const preview = createdPreview = new BaseWindow({ x: point.x + 14, y: point.y + 18, width: 242, height: 171, show: false, frame: false, transparent: true,
    focusable: false, skipTaskbar: true, alwaysOnTop: true, resizable: false, hasShadow: false, backgroundColor: '#00000000' })
  const previewView = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } })
  const previewContents = createdContents = previewView.webContents
  previewView.setBackgroundColor('#00000000')
  previewView.setBounds({ x: 0, y: 0, width: 242, height: 171 })
  preview.contentView.addChildView(previewView)
  preview.setIgnoreMouseEvents(true, { forward: true })
  releases.push(acquireQuickInteraction())
  armed?.release()
  releases.push(acquireOrbDragExpansion())
  const cancel = (): void => cancelPluginWindowDrag()
  cleanup = () => { source.window.removeListener('hide', cancel); source.window.removeListener('minimize', cancel); source.window.removeListener('closed', cancel); source.contents.removeListener('destroyed', cancel); source.contents.removeListener('render-process-gone', cancel) }
  source.window.on('hide', cancel)
  source.window.on('minimize', cancel)
  source.window.on('closed', cancel)
  source.contents.once('destroyed', cancel)
  source.contents.once('render-process-gone', cancel)
  const originTarget = registrations.get(senderId)?.targets.find(target => target.items.some(item => item.pluginId === pluginId))
  const originZone = originTarget ? { ...originTarget.rect, x: source.bounds.x + originTarget.rect.x, y: source.bounds.y + originTarget.rect.y } : null
  const active: DragSession = {
    token: randomUUID(), pluginId, senderId, generation: getRuntimeScope(pluginId)?.owner.generation ?? 0,
    revision: pluginHost.getPlacementRevision(pluginId), source: source.window, sourceContents: source.contents, preview, previewView, previewContents, releases,
    lastInput: Date.now(), frame: null, target: null, originZone, leftOrigin: !originZone, ending: false, disposed: false, cleanup,
    watchdog: setInterval(() => { if (session === active && !active.ending && (Date.now() - active.lastInput > 30000 || !stillCurrent(active))) cancelPluginWindowDrag() }, 1000)
  }
  active.watchdog.unref()
  session = active
  const state = pluginHost.getDetachedState(pluginId), summary = pluginRegistry.get(pluginId)
  const title = state?.title ?? summary?.name ?? pluginId
  // No focus transfer and no per-frame capture/reparent. Only this renderer follows the pointer.
  void previewContents.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(previewHtml(title, state?.icon ?? summary?.icon, state?.glyph ?? summary?.glyph))}`).then(() => {
    if (session !== active || preview.isDestroyed()) return
    preview.showInactive()
    const contents = pluginHost.getWebContents(pluginId)
    if (!contents || contents.isDestroyed()) return
    void contents.capturePage().then(capture => {
      if (session !== active || previewContents.isDestroyed() || capture.isEmpty()) return
      const image = capture.resize({ width: 464 }).toDataURL()
      void previewContents.executeJavaScript(`(()=>{const image=document.getElementById('capture');image.src=${JSON.stringify(image)};image.style.display='block'})()`).catch(() => {})
    }).catch(() => {})
  }).catch(() => { if (session === active) cancelPluginWindowDrag() })
  tick(active)
  return { token: active.token }
  } catch (error) {
    if (armed?.senderId === senderId) armed.release()
    if (session?.senderId === senderId) dispose(session)
    else {
      cleanup()
      for (const release of releases) release()
      if (createdContents && !createdContents.isDestroyed()) createdContents.close({ waitForBeforeUnload: false })
      if (createdPreview && !createdPreview.isDestroyed()) createdPreview.destroy()
    }
    console.warn('[plugin-drag] preview creation failed', error)
    return null
  }
}
export function updatePluginWindowDrag(senderId: number, token: string): void {
  const active = session
  if (!active || active.senderId !== senderId || active.token !== token || active.ending) return
  active.lastInput = Date.now()
  scheduleTick(active)
}
function scheduleTick(active: DragSession): void {
  if (active.frame) return
  active.frame = setTimeout(() => { active.frame = null; if (session === active) tick(active) }, 0)
}
function dispose(active: DragSession): void {
  if (active.disposed) return
  active.disposed = true
  if (session === active) session = null
  clearInterval(active.watchdog)
  if (active.frame) clearTimeout(active.frame)
  active.cleanup()
  broadcast(active, { active: false, pluginId: active.pluginId })
  for (const release of active.releases) release()
  if (!active.previewContents.isDestroyed()) active.previewContents.close({ waitForBeforeUnload: false })
  if (!active.preview.isDestroyed()) active.preview.destroy()
}
export function cancelPluginWindowDrag(): void { armed?.release(); if (session) dispose(session) }
export async function endPluginWindowDrag(senderId: number, token: string, cancel = false): Promise<void> {
  const active = session
  if (!active || active.senderId !== senderId || active.token !== token || active.ending) return
  if (cancel || !stillCurrent(active)) { dispose(active); return }
  const point = screen.getCursorScreenPoint(), result = hitAt(active, point)
  active.ending = true
  const targetWindow = result.hit ? surface(result.hit.senderId)?.window : null
  const commitCurrent = (): boolean => !active.disposed && session === active
    && !active.source.isDestroyed() && active.source.isVisible() && !active.source.isMinimized()
    && canSurfaceManagePlugin(active.senderId, active.pluginId)
    && pluginHost.getPlacementRevision(active.pluginId) === active.revision
    && (active.generation === 0 || getRuntimeScope(active.pluginId)?.owner.generation === active.generation)
    && (!targetWindow || !targetWindow.isDestroyed() && targetWindow.isVisible() && !targetWindow.isMinimized())
  try {
    if (result.hit) {
      const { kind, index } = result.hit
      if (kind === 'shell' && pluginHost.getPlacement(active.pluginId)?.kind === 'shell') pluginHost.reorderPlugin(active.pluginId, index)
      else await pluginHost.dockPlugin(active.pluginId, kind, index, commitCurrent)
    } else if (!result.inside && (!active.originZone || active.leftOrigin || !pointInRect(point, active.originZone, 16))) {
      const detached = getDetachedWindow(active.pluginId)
      if (detached && !detached.isDestroyed()) {
        if (detached.isMaximized()) detached.unmaximize()
        detached.setBounds(constrainDetachedBounds({ ...detached.getBounds(), x: point.x - 100, y: point.y - 18 }))
        detached.show(); detached.focus()
      } else await pluginHost.detachPlugin(active.pluginId, point, commitCurrent)
    }
  } finally { dispose(active) }
}
export function getPluginDragDiagnostics() {
  return { active: !!session, armed: !!armed, registrations: registrations.size, sourceId: session?.senderId ?? null }
}

// Observe focus/show order from creation, including windows that have never dragged.
observeDetachedWindows(trackWindow)
