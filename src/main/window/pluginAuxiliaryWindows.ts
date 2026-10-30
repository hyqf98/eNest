import { createHash, randomUUID } from 'node:crypto'
import { BrowserWindow, ipcMain, screen, session, webContents, type Session, type IpcMainInvokeEvent } from 'electron'
import { IpcChannels } from '@shared/types/ipc'
import type { AuxiliaryContext, AuxiliaryEvent, AuxiliaryOpen, AuxiliaryUpdate, AuxiliaryWindowState } from '@shared/types/auxiliary'
import { pluginRegistry } from '@main/plugin/PluginRegistry'
import { pluginHost } from '@main/plugin/PluginHost'
import { getRuntimeScope, type PluginRuntimeScope } from '@main/plugin/PluginRuntimeScope'
import { resolvePluginFile } from '@main/plugin/pluginPaths'
import { registerPluginProtocolForSession } from '@main/plugin/pluginProtocol'
import { permissionService } from '@main/plugin/PermissionService'
import { captureDisplaySource, resolveCaptureDisplay } from '@main/screen/screenService'
import { resolvePreload } from '@main/window/createShellWindow'
import { assertInteractive, assertInteractionEpoch, getInteractionEpoch, isNonInteractive, isResidentActivation, grantAuxiliaryInteraction } from '@main/plugin/pluginInteractionPolicy'

interface Surface {
  id: string
  slot: number
  entry: string
  url: string
  scope: PluginRuntimeScope
  revision: string
  interactionEpoch: number
  win?: BrowserWindow
  session?: Session
  wcId?: number
  closed: boolean
  initial: unknown
  initialBytes: number
  contextRead: boolean
  display: AuxiliaryContext['display']
  capture?: { displayId: number; withAudio: boolean }
  topmost: boolean
  placement: 'window' | 'display'
  interaction: 'capture' | 'passthrough'
  detachDisplay?: () => void
  geometryTimer?: ReturnType<typeof setTimeout>
  capturing: boolean
  captureUsed: boolean
  release: () => void
  requestStart: number
  requests: number
  messageBytes: number
  timer?: ReturnType<typeof setTimeout>
}
const surfaces = new Map<string, Surface>()
const senders = new Map<number, Surface>()
// Electron retains Session objects until app exit. Reuse only fully retired, plugin-private slots.
const slots = new Map<string, Map<number, string>>()
let registered = false
const MAX_INITIAL = 32 * 1024 * 1024
const MAX_MESSAGE = 1024 * 1024

/** Bound opaque data without executing JSON hooks or retaining a serialized duplicate. */
export function auxiliaryPayloadBytes(value: unknown, max: number): number {
  const seen = new Set<object>()
  let bytes = 0, fields = 0
  const visit = (item: unknown, depth: number): void => {
    if (depth > 20 || ++fields > 50_000) throw new Error('Auxiliary payload structure limit reached')
    if (item == null || typeof item === 'boolean' || typeof item === 'number') bytes += 8
    else if (typeof item === 'string') bytes += Buffer.byteLength(item)
    else if (item instanceof ArrayBuffer) bytes += item.byteLength
    else if (ArrayBuffer.isView(item)) bytes += item.byteLength
    else if (typeof item === 'object') {
      if (seen.has(item)) throw new Error('Auxiliary payload must not contain cycles')
      if (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) throw new Error('Auxiliary payload must be plain data')
      seen.add(item)
      for (const [key, child] of Object.entries(item)) { bytes += Buffer.byteLength(key); visit(child, depth + 1) }
      seen.delete(item)
    } else throw new Error('Auxiliary payload is not serializable')
    if (bytes > max) throw new Error('Auxiliary payload byte limit reached')
  }
  visit(value, 0)
  return bytes
}
function current(surface: Surface, draining = false): boolean {
  return !surface.closed && surface.scope.isCurrent() && !surface.scope.drainSignal.aborted
    && (draining || (!surface.scope.isClosing && !surface.scope.signal.aborted))
    && pluginRegistry.getBuildRevision(surface.scope.owner.pluginId) === surface.revision
}
function requireOwner(pluginId: string): PluginRuntimeScope {
  const scope = getRuntimeScope(pluginId)
  if (!scope?.isCurrent() || scope.isClosing || scope.signal.aborted) throw new Error('Auxiliary owner is closing')
  return scope
}
function owned(pluginId: string, id: string): Surface {
  const surface = surfaces.get(id)
  if (!surface || surface.scope !== getRuntimeScope(pluginId) || !current(surface, true)) throw new Error('Auxiliary window not owned by this runtime')
  return surface
}
function publish(surface: Surface, event: AuxiliaryEvent): void {
  if (!surface.scope.isCurrent() || surface.scope.drainSignal.aborted) return
  // PluginHost removes closing entries before beforeClose. Deliver only to the captured incarnation.
  const owner = webContents.fromId(surface.scope.owner.wcId)
  try { if (owner && !owner.isDestroyed()) owner.send(IpcChannels.PluginEvent, event) } catch { /* Owner can exit between lookup and send. */ }
}
function close(surface: Surface): void {
  if (surface.closed) return
  surface.closed = true
  if (surface.timer) clearTimeout(surface.timer)
  if (surface.geometryTimer) clearTimeout(surface.geometryTimer)
  surface.detachDisplay?.()
  surface.initial = undefined
  surfaces.delete(surface.id)
  const win = surface.win
  if (surface.wcId !== undefined) senders.delete(surface.wcId)
  if (win && !win.isDestroyed()) win.destroy()
  surface.win = undefined
  const isolated = surface.session
  surface.session = undefined
  const releaseSlot = (): void => {
    const own = slots.get(surface.scope.owner.pluginId)
    if (own?.get(surface.slot) === surface.id) own.delete(surface.slot)
    if (!own?.size) slots.delete(surface.scope.owner.pluginId)
  }
  if (isolated) {
    for (const detach of [() => isolated.protocol.unhandle('enest'), () => isolated.webRequest.onBeforeRequest(null),
      () => isolated.webRequest.onHeadersReceived(null), () => isolated.setPermissionRequestHandler(null),
      () => isolated.setPermissionCheckHandler(null), () => isolated.setDevicePermissionHandler(null),
      () => isolated.setDisplayMediaRequestHandler(null), () => isolated.removeAllListeners()]) {
      try { detach() } catch { /* Native teardown can already be in progress. */ }
    }
    void Promise.allSettled([() => isolated.clearStorageData(), () => isolated.clearCache(), () => isolated.closeAllConnections()]
      .map(clear => Promise.resolve().then(clear))).finally(releaseSlot)
  } else releaseSlot()
  surface.release()
  publish(surface, { type: 'auxiliary.closed', windowId: surface.id })
}
function rate(surface: Surface, bytes: number): void {
  const now = Date.now()
  if (now - surface.requestStart >= 1000) { surface.requestStart = now; surface.requests = 0; surface.messageBytes = 0 }
  if (++surface.requests > 120 || (surface.messageBytes += bytes) > 8 * 1024 * 1024) throw new Error('Auxiliary message rate limit reached')
}
function fromEvent(event: IpcMainInvokeEvent): Surface {
  const surface = senders.get(event.sender.id)
  if (!surface || !current(surface, true) || !surface.win || surface.win.isDestroyed() || event.sender !== surface.win.webContents
    || event.senderFrame !== event.sender.mainFrame || event.senderFrame?.url !== surface.url) throw new Error('Retired or foreign auxiliary sender')
  return surface
}
function windowState(surface: Surface): AuxiliaryWindowState {
  return { bounds: surface.win!.getBounds(), display: surface.display, interaction: surface.interaction }
}
function publishGeometry(surface: Surface): void {
  clearTimeout(surface.geometryTimer)
  surface.geometryTimer = setTimeout(() => {
    if (!current(surface) || !surface.win || surface.win.isDestroyed()) return
    const state = windowState(surface)
    publish(surface, { type: 'auxiliary.changed', windowId: surface.id, state })
    surface.win.webContents.send(IpcChannels.AuxiliaryMessage, { type: 'enest:surface-changed', state })
  }, 80)
  surface.geometryTimer.unref?.()
}
function setInteraction(surface: Surface, interaction: 'capture' | 'passthrough'): void {
  const win = surface.win!
  const passive = interaction === 'passthrough'
  surface.interaction = interaction
  win.setIgnoreMouseEvents(passive)
  win.setFocusable(!passive)
  if (passive && win.isFocused()) win.blur()
}
function boundedWindowBounds(surface: Surface, requested: AuxiliaryUpdate['bounds']): Electron.Rectangle {
  const previous = surface.win!.getBounds()
  const area = screen.getDisplayMatching(previous).workArea
  const number = (value: number | undefined, fallback: number): number => typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallback
  const width = Math.max(80, Math.min(area.width, number(requested?.width, previous.width)))
  const height = Math.max(60, Math.min(area.height, number(requested?.height, previous.height)))
  return { width, height, x: Math.max(area.x, Math.min(area.x + area.width - width, number(requested?.x, previous.x))),
    y: Math.max(area.y, Math.min(area.y + area.height - height, number(requested?.y, previous.y))) }
}
export function registerAuxiliaryHandlers(): void {
  if (registered) return
  registered = true
  ipcMain.handle(IpcChannels.AuxiliaryContext, event => {
    const surface = fromEvent(event)
    if (!current(surface)) throw new Error('Auxiliary owner is closing')
    rate(surface, 0)
    if (surface.contextRead) throw new Error('Auxiliary context was already consumed')
    surface.contextRead = true
    const result: AuxiliaryContext = { windowId: surface.id, data: surface.initial, display: surface.display,
      ...(surface.capture ? { capture: { withAudio: surface.capture.withAudio } } : {}) }
    surface.initial = undefined
    return result
  })
  ipcMain.handle(IpcChannels.AuxiliaryPost, (event, data: unknown) => {
    const surface = fromEvent(event)
    rate(surface, auxiliaryPayloadBytes(data, MAX_MESSAGE))
    publish(surface, { type: 'auxiliary.message', windowId: surface.id, data })
  })
  ipcMain.handle(IpcChannels.AuxiliaryClose, event => close(fromEvent(event)))
}
export async function openAuxiliaryWindow(pluginId: string, input: AuxiliaryOpen): Promise<{ windowId: string }> {
  const scope = requireOwner(pluginId)
  const passiveRestore = () => isResidentActivation(scope) && input?.focus === false && !input?.capture
    && (input?.placement !== 'display' || input?.interaction === 'passthrough')
  const assertOpen = (): void => { if (!passiveRestore()) assertInteractive(scope) }
  assertOpen()
  const interactionEpoch = getInteractionEpoch(scope)
  const summary = pluginRegistry.get(pluginId), root = pluginRegistry.getRootPath(pluginId)
  if (!root || !summary || !input || typeof input.entry !== 'string' || !/^assets\/.+\.html$/.test(input.entry) || input.entry.length > 512) throw new Error('Auxiliary entry must be a local plugin HTML asset')
  const initialBytes = auxiliaryPayloadBytes(input.data, MAX_INITIAL)
  const own = [...surfaces.values()].filter(value => value.scope.owner.pluginId === pluginId)
  const ownSlots = slots.get(pluginId) ?? new Map<number, string>()
  if ([...slots.values()].reduce((sum, value) => sum + value.size, 0) >= 24 || ownSlots.size >= 8 || own.reduce((sum, value) => sum + value.initialBytes, 0) + initialBytes > 64 * 1024 * 1024
    || [...surfaces.values()].reduce((sum, value) => sum + value.initialBytes, 0) + initialBytes > 128 * 1024 * 1024) throw new Error('Auxiliary window resource limit reached')
  if (input.capture && (!pluginRegistry.getManifest(pluginId)?.permissions?.includes('screen.record') || !permissionService.isGranted(pluginId, 'screen.record'))) throw new Error('permission denied: screen.record')
  if (input.capture && !pluginHost.isPluginVisible(pluginId)) throw new Error('Capture requires a visible plugin')
  if (!input.capture && input.alwaysOnTop === true && (!pluginRegistry.getManifest(pluginId)?.permissions?.includes('pin.create') || !permissionService.isGranted(pluginId, 'pin.create'))) throw new Error('permission denied: pin.create')
  if (input.interaction !== undefined && !['capture', 'passthrough'].includes(input.interaction)) throw new Error('Invalid auxiliary interaction')
  if (input.capture && input.interaction === 'passthrough') throw new Error('Capture surfaces must be interactive')
  const parent = input.parentWindowId ? owned(pluginId, input.parentWindowId) : undefined
  if (parent && (!parent.win || parent.win.isDestroyed() || parent.capture)) throw new Error('Auxiliary parent unavailable')
  const display = resolveCaptureDisplay(input.capture
    ? input.capture.displayId ?? input.displayId
    : input.displayId ?? parent?.display.id ?? screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).id)
  const id = randomUUID()
  let slot = 0
  while (ownSlots.has(slot)) slot++
  ownSlots.set(slot, id); slots.set(pluginId, ownSlots)
  const surface: Surface = { id, slot, entry: input.entry, url: `enest://plugin/${pluginId}/${input.entry.split('/').map(encodeURIComponent).join('/')}?auxiliary=${id}`,
    scope, revision: pluginRegistry.getBuildRevision(pluginId), interactionEpoch, closed: false, initial: input.data, initialBytes, contextRead: false,
    display: { id: display.id, ...display.bounds, scaleFactor: display.scaleFactor },
    ...(input.capture ? { capture: { displayId: display.id, withAudio: input.capture.withAudio === true } } : {}),
    topmost: input.alwaysOnTop === true, placement: input.placement === 'display' ? 'display' : 'window',
    interaction: input.interaction ?? 'capture', capturing: false, captureUsed: false, release: () => {}, requestStart: 0, requests: 0, messageBytes: 0 }
  surfaces.set(id, surface)
  const releaseActivity = scope.acquireActivity('auxiliary window')
  const abort = (): void => close(surface)
  const detach = scope.addDisposer(abort)
  scope.drainSignal.addEventListener('abort', abort, { once: true })
  let released = false
  surface.release = () => { if (!released) { released = true; detach(); scope.drainSignal.removeEventListener('abort', abort); releaseActivity() } }
  try {
    if (!await resolvePluginFile(root, input.entry, summary.devSource === true)) throw new Error('Auxiliary entry not found or unsafe')
    if (!current(surface)) throw new Error('Auxiliary owner changed')
    if (!passiveRestore()) assertInteractionEpoch(scope, interactionEpoch)
    assertOpen()
    if (parent && !current(parent)) throw new Error('Auxiliary parent retired')
    if (!surface.capture && surface.topmost && !permissionService.isGranted(pluginId, 'pin.create')) throw new Error('permission denied: pin.create')
    const isolated = session.fromPartition(`enest-auxiliary-${createHash('sha256').update(pluginId).digest('hex')}-${slot}`, { cache: false })
    surface.session = isolated
    registerPluginProtocolForSession(isolated, pluginId, root)
    const captureAllowed = (): boolean => !!surface.capture && current(surface)
      && !isNonInteractive(scope) && getInteractionEpoch(scope) === interactionEpoch
      && permissionService.isGranted(pluginId, 'screen.record') && !!surface.win?.isVisible() && surface.win.isFocused()
    isolated.setPermissionRequestHandler((contents, permission, callback, details) => callback(contents === surface.win?.webContents && permission === 'display-capture' && details.isMainFrame && details.requestingUrl === surface.url && captureAllowed()))
    isolated.setPermissionCheckHandler((contents, permission, _origin, details) => contents === surface.win?.webContents && permission === 'display-capture' && details.isMainFrame && details.requestingUrl === surface.url && captureAllowed())
    isolated.setDevicePermissionHandler(() => false)
    isolated.setDisplayMediaRequestHandler((request, callback) => {
      if (!captureAllowed() || surface.captureUsed || surface.capturing || !request.userGesture || request.frame !== surface.win?.webContents.mainFrame || request.frame?.url !== surface.url || !request.videoRequested) { callback({}); return }
      surface.capturing = true
      void captureDisplaySource(pluginId, surface.capture!.displayId).then(source => {
        surface.capturing = false
        if (!captureAllowed() || surface.captureUsed || request.frame !== surface.win?.webContents.mainFrame) { callback({}); return }
        surface.captureUsed = true
        if (surface.timer) { clearTimeout(surface.timer); surface.timer = undefined }
        callback({ video: source, ...(surface.capture!.withAudio && request.audioRequested ? { audio: 'loopback' as const } : {}) })
      }, () => { surface.capturing = false; callback({}) })
    }, { useSystemPicker: false })
    isolated.on('will-download', event => event.preventDefault())
    isolated.on('file-system-access-restricted', (_event, _details, callback) => callback('deny'))
    isolated.webRequest.onBeforeRequest((details, callback) => {
      const prefix = `enest://plugin/${pluginId}/assets/`
      const ours = details.webContentsId === surface.win?.webContents.id
      const local = details.url.startsWith(prefix) && !details.url.includes('?') && !details.url.includes('#')
      const allowed = details.resourceType === 'mainFrame' ? details.url === surface.url : ['script', 'stylesheet', 'image', 'font', 'xhr', 'media'].includes(details.resourceType) && (local || /^(data:|blob:)/.test(details.url))
      callback({ cancel: !current(surface, true) || !ours || !['GET', 'HEAD'].includes(details.method) || !allowed })
    })
    isolated.webRequest.onHeadersReceived((details, callback) => {
      const headers = { ...details.responseHeaders }
      for (const name of Object.keys(headers)) if (name.toLowerCase() === 'content-security-policy') delete headers[name]
      headers['Content-Security-Policy'] = ["default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src blob:; font-src 'self'; connect-src 'self' data: blob:; frame-src 'none'; child-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"]
      callback({ responseHeaders: headers })
    })
    const finite = (value: unknown, fallback: number): number => typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback
    const area = display.workArea, requested = input.bounds ?? {}, fullscreen = input.placement === 'display'
    const width = Math.max(80, Math.min(area.width, finite(requested.width, 360))), height = Math.max(60, Math.min(area.height, finite(requested.height, 270)))
    const win = new BrowserWindow({
      ...(fullscreen ? display.bounds : { width, height, x: Math.max(area.x, Math.min(area.x + area.width - width, finite(requested.x, area.x + (area.width - width) / 2))), y: Math.max(area.y, Math.min(area.y + area.height - height, finite(requested.y, area.y + 80))) }),
      title: String(input.title ?? '').slice(0, 200), frame: false, transparent: input.transparent === true,
      resizable: !fullscreen && input.resizable === true, movable: !fullscreen && input.movable !== false,
      fullscreenable: false, skipTaskbar: true, alwaysOnTop: input.alwaysOnTop === true, hasShadow: false, show: false,
      ...(parent?.win ? { parent: parent.win } : {}),
      webPreferences: { session: isolated, preload: resolvePreload('auxiliaryPreload.js'), sandbox: true, contextIsolation: true,
        nodeIntegration: false, webSecurity: true, backgroundThrottling: !surface.capture, spellcheck: false, navigateOnDragDrop: false }
    })
    surface.win = win
    setInteraction(surface, surface.interaction)
    surface.wcId = win.webContents.id
    senders.set(win.webContents.id, surface)
    const grantInput = (): void => {
      if (!current(surface) || !win.isVisible() || surface.interaction === 'passthrough') return
      try { grantAuxiliaryInteraction(scope) } catch { /* A concurrent noninteractive lease never inherits a gesture. */ }
    }
    win.webContents.on('before-mouse-event', (_event, mouse) => { if (mouse.type === 'mouseDown') grantInput() })
    win.webContents.on('before-input-event', (_event, key) => {
      if (key.type !== 'keyDown' || key.isAutoRepeat) return
      grantInput()
      // Full-display overlays must release the desktop even if their renderer is busy.
      if (key.key === 'Escape' && surface.placement === 'display' && !surface.capture && current(surface)) {
        setInteraction(surface, 'passthrough')
        publishGeometry(surface)
      }
    })
    if (input.alwaysOnTop) win.setAlwaysOnTop(true, 'screen-saver')
    if (process.platform === 'darwin') win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    win.on('move', () => publishGeometry(surface))
    win.on('resize', () => publishGeometry(surface))
    const displayChanged = (): void => {
      if (!current(surface) || win.isDestroyed()) return
      const nextDisplay = screen.getAllDisplays().find(item => item.id === surface.display.id) ?? screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
      if (surface.capture) { close(surface); return }
      // A changed screen must never leave a stale full-screen mouse interceptor behind.
      if (surface.placement === 'display') setInteraction(surface, 'passthrough')
      surface.display = { id: nextDisplay.id, ...nextDisplay.bounds, scaleFactor: nextDisplay.scaleFactor }
      win.setBounds(surface.placement === 'display' ? nextDisplay.bounds : boundedWindowBounds(surface, {}))
      publishGeometry(surface)
    }
    screen.on('display-removed', displayChanged)
    screen.on('display-metrics-changed', displayChanged)
    surface.detachDisplay = () => { screen.removeListener('display-removed', displayChanged); screen.removeListener('display-metrics-changed', displayChanged) }
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    win.webContents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp')
    win.webContents.on('will-attach-webview', event => event.preventDefault())
    win.webContents.on('will-navigate', event => { event.preventDefault(); close(surface) })
    win.webContents.on('will-frame-navigate', event => { event.preventDefault(); close(surface) })
    win.webContents.on('will-redirect', event => { event.preventDefault(); close(surface) })
    win.webContents.once('render-process-gone', () => close(surface))
    win.webContents.once('preload-error', () => close(surface))
    win.once('closed', () => close(surface))
    surface.timer = setTimeout(() => close(surface), 15_000)
    surface.timer.unref?.()
    await win.loadURL(surface.url)
    if (!current(surface)) throw new Error('Auxiliary window closed during loading')
    if (!passiveRestore()) assertInteractionEpoch(scope, interactionEpoch)
    assertOpen()
    if (surface.capture ? !permissionService.isGranted(pluginId, 'screen.record') : surface.topmost && !permissionService.isGranted(pluginId, 'pin.create')) throw new Error('Auxiliary permission was revoked')
    clearTimeout(surface.timer); surface.timer = undefined
    if (surface.capture && !surface.captureUsed) {
      surface.timer = setTimeout(() => close(surface), 120_000)
      surface.timer.unref?.()
    }
    if (input.visible !== false || surface.capture) {
      if (input.focus === false || surface.interaction === 'passthrough') win.showInactive()
      else { win.show(); win.focus() }
    }
    return { windowId: id }
  } catch (error) { close(surface); throw error }
}
export function sendAuxiliaryMessage(pluginId: string, id: string, data: unknown, options?: AuxiliaryUpdate): void {
  const surface = owned(pluginId, id)
  if (options?.interaction !== undefined && !['capture', 'passthrough'].includes(options.interaction)) throw new Error('Invalid auxiliary interaction')
  if (options?.visible === true || options?.focus === true || options?.interaction === 'capture' || options?.bounds) assertInteractive(surface.scope)
  if (options?.interaction && surface.capture) throw new Error('Capture interaction cannot change')
  rate(surface, auxiliaryPayloadBytes(data, MAX_MESSAGE))
  if (options?.interaction) setInteraction(surface, options.interaction)
  if (options?.bounds) {
    if (surface.placement === 'display') throw new Error('Display surface bounds are host controlled')
    surface.win!.setBounds(boundedWindowBounds(surface, options.bounds))
  }
  surface.win!.webContents.send(IpcChannels.AuxiliaryMessage, data)
  if (options?.visible === false) surface.win!.hide()
  else if ((options?.visible === true || options?.focus === true) && !surface.scope.isClosing) {
    if (options?.focus === false || surface.interaction === 'passthrough') surface.win!.showInactive()
    else { surface.win!.show(); surface.win!.focus() }
  }
  if (options?.interaction || options?.bounds) publishGeometry(surface)
}
/** Only an already-visible, current auxiliary of this owner may anchor native dialogs. */
export function getAuxiliaryDialogParent(pluginId: string): BrowserWindow | undefined {
  const candidates = [...surfaces.values()].filter(surface => surface.scope === getRuntimeScope(pluginId) && current(surface)
    && surface.win && !surface.win.isDestroyed() && surface.win.isVisible() && surface.interaction !== 'passthrough')
  return (candidates.find(surface => surface.win!.isFocused()) ?? candidates.at(-1))?.win
}
export function closeAuxiliaryWindow(pluginId: string, id: string): boolean {
  const surface = surfaces.get(id)
  if (!surface) return false
  const scope = getRuntimeScope(pluginId)
  if (surface.scope !== scope) throw new Error('Auxiliary window not owned by this runtime')
  close(surface); return true
}
export function listAuxiliaryWindows(pluginId: string): Array<{ windowId: string; entry: string }> {
  const scope = requireOwner(pluginId)
  return [...surfaces.values()].filter(value => value.scope === scope && current(value)).map(value => ({ windowId: value.id, entry: value.entry }))
}
export function disposeAuxiliaryWindows(): void { for (const surface of [...surfaces.values()]) close(surface) }
export function revokeAuxiliaryCapture(pluginId: string): void {
  for (const surface of [...surfaces.values()]) if (surface.scope.owner.pluginId === pluginId && surface.capture) close(surface)
}
export function revokeAuxiliaryTopmost(pluginId: string): void {
  for (const surface of [...surfaces.values()]) if (surface.scope.owner.pluginId === pluginId && surface.topmost && !surface.capture) close(surface)
}
export function getAuxiliaryMemoryOwners(): Array<{ pluginId: string; generation: number; wcId: number }> {
  return [...surfaces.values()].filter(surface => surface.wcId !== undefined && !surface.closed)
    .map(surface => ({ pluginId: surface.scope.owner.pluginId, generation: surface.scope.owner.generation, wcId: surface.wcId! }))
}
export function getAuxiliaryDiagnostics() {
  return { windows: surfaces.size, captureWindows: [...surfaces.values()].filter(surface => surface.capture).length,
    reservedSlots: [...slots.values()].reduce((sum, value) => sum + value.size, 0),
    payloadReservationBytes: [...surfaces.values()].reduce((sum, surface) => sum + surface.initialBytes, 0) }
}
