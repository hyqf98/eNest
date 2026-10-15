import { app, BaseWindow, nativeTheme, shell, WebContentsView, type View, type WebContents, type WebPreferences } from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { IpcChannels } from '@shared/types/ipc'
import { SHELL_PARTITION, TITLEBAR_HEIGHT } from '@shared/constants'
import { normalizeNotification, NOTIFICATION_QUEUE_LIMIT, safeNotificationLink } from '@shared/notification'
import type { NotificationItem, NotificationOverlayState, NotificationPosition } from '@shared/types/notification'
import { handleShellIpc, onShellIpc, registerTrustedSurface, getTrustedSurfaceRole } from '@main/ipc/ipcSecurity'
import { settingsStore } from '@main/settings/SettingsStore'
import { resolveThemeTokens } from '@main/theme/resolveThemeCss'
import { resolvePreload, setNotificationAppearanceSink } from './createShellWindow'
import { registerTransientView, raiseTransientViews } from './transientViews'

interface Entry { item: NotificationItem; owner: object; removeAbort?: () => void }
interface Layer { host: Host; position: NotificationPosition; view: WebContentsView; measured: number; ready: boolean; release: () => void }
interface Host { win: BaseWindow; entries: Entry[]; layers: Map<NotificationPosition, Layer> }
const hosts = new Map<number, Host>()
const layers = new Map<number, Layer>()
const rates = new WeakMap<object, number[]>()
let sequence = 0
let registered = false

function visibleEntries(layer: Layer): NotificationItem[] {
  return layer.host.entries.filter(entry => entry.item.position === layer.position).slice(0, layer.position === 'bottom-right' ? 3 : 1).map(entry => entry.item)
}
function state(layer: Layer): NotificationOverlayState {
  const { win } = layer.host
  const raw = settingsStore.getAll().general.animationLevel
  return {
    items: visibleEntries(layer), position: layer.position,
    animationLevel: raw === 'low' || raw === 'high' ? raw : 'medium',
    theme: resolveThemeTokens('auto'),
    visible: !win.isDestroyed() && win.isVisible() && !win.isMinimized()
  }
}
function layout(layer: Layer): void {
  const { win } = layer.host
  if (win.isDestroyed() || layer.view.webContents.isDestroyed()) return
  const area = win.getContentBounds()
  const width = Math.min(layer.position === 'center' ? 476 : 410, Math.max(180, area.width - 24))
  const height = Math.min(Math.ceil(layer.measured), Math.max(70, area.height - TITLEBAR_HEIGHT - 24))
  const x = layer.position === 'bottom-right' ? area.width - width - 10 : Math.round((area.width - width) / 2)
  const y = layer.position === 'top' ? TITLEBAR_HEIGHT + 6 : layer.position === 'bottom-right' ? area.height - height - 10 : Math.max(TITLEBAR_HEIGHT, Math.round((area.height - height) / 2))
  layer.view.setBounds({ x: Math.max(0, x), y: Math.max(0, y), width, height })
  raiseTransientViews(win)
}
function send(layer: Layer): void {
  if (layer.view.webContents.isDestroyed()) return
  if (layer.ready) layer.view.webContents.send(IpcChannels.NotificationState, state(layer))
  layout(layer)
}
function closeLayer(layer: Layer): void {
  layers.delete(layer.view.webContents.id)
  if (layer.host.layers.get(layer.position) === layer) layer.host.layers.delete(layer.position)
  layer.release()
  if (!layer.host.win.isDestroyed() && layer.host.win.contentView.children.includes(layer.view)) layer.host.win.contentView.removeChildView(layer.view)
  if (!layer.view.webContents.isDestroyed()) layer.view.webContents.close({ waitForBeforeUnload: false })
}
function sync(host: Host): void {
  for (const position of ['top', 'center', 'bottom-right'] as NotificationPosition[]) {
    const has = host.entries.some(entry => entry.item.position === position)
    const layer = host.layers.get(position)
    if (has) send(layer ?? createLayer(host, position))
    else if (layer) closeLayer(layer)
  }
}
function remove(host: Host, id: number): void {
  const index = host.entries.findIndex(entry => entry.item.id === id)
  if (index < 0) return
  host.entries.splice(index, 1)[0].removeAbort?.()
  sync(host)
}
function createLayer(host: Host, position: NotificationPosition): Layer {
  const preferences: WebPreferences & { backgroundColor?: string } = {
    backgroundColor: '#00000000', preload: resolvePreload('notificationPreload.cjs'),
    contextIsolation: true, nodeIntegration: false, sandbox: true, partition: SHELL_PARTITION
  }
  const view = new WebContentsView({ webPreferences: preferences })
  view.setBackgroundColor('#00000000')
  view.setVisible(false)
  host.win.contentView.addChildView(view)
  const layer: Layer = { host, position, view, measured: 180, ready: false, release: registerTransientView(host.win, view, 100) }
  host.layers.set(position, layer)
  layers.set(view.webContents.id, layer)
  layout(layer)
  view.webContents.once('did-finish-load', () => { layer.ready = true; send(layer) })
  view.webContents.once('render-process-gone', () => {
    for (const entry of host.entries.filter(entry => entry.item.position === position)) entry.removeAbort?.()
    host.entries = host.entries.filter(entry => entry.item.position !== position)
    closeLayer(layer)
  })
  const failed = () => {
    if (host.layers.get(position) !== layer) return
    for (const entry of host.entries.filter(entry => entry.item.position === position)) entry.removeAbort?.()
    host.entries = host.entries.filter(entry => entry.item.position !== position)
    closeLayer(layer)
  }
  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (devUrl) {
    const url = `${devUrl.replace(/\/$/, '')}/notification-overlay.html`
    registerTrustedSurface(view.webContents, 'notification', url)
    void view.webContents.loadURL(url).catch(failed)
  } else {
    const file = join(app.getAppPath(), 'out/renderer/notification-overlay.html')
    registerTrustedSurface(view.webContents, 'notification', pathToFileURL(file).href)
    void view.webContents.loadFile(file).catch(failed)
  }
  return layer
}
function hostFor(win: BaseWindow): Host {
  const existing = hosts.get(win.id)
  if (existing) return existing
  const host: Host = { win, entries: [], layers: new Map() }
  hosts.set(win.id, host)
  const refresh = () => { for (const layer of host.layers.values()) send(layer) }
  win.on('resize', refresh)
  win.on('show', refresh)
  win.on('hide', refresh)
  win.on('minimize', refresh)
  win.on('restore', refresh)
  win.once('closed', () => {
    hosts.delete(win.id)
    for (const entry of host.entries) entry.removeAbort?.()
    host.entries = []
    for (const layer of [...host.layers.values()]) closeLayer(layer)
  })
  return host
}

/** Only the card-sized native regions intercept input; the surrounding plugin remains interactive. */
export function showNotification(win: BaseWindow | null | undefined, payload: unknown, context: { owner: object; source?: string; signal?: AbortSignal }): number {
  if (!win || win.isDestroyed() || context.signal?.aborted) throw new Error('notification container unavailable')
  const normalized = normalizeNotification(payload)
  const now = Date.now()
  const recent = (rates.get(context.owner) ?? []).filter(time => now - time < 10000)
  if (recent.length >= 10) throw new Error('notification rate limit: 10 per 10 seconds')
  const host = hostFor(win)
  if (host.entries.length >= NOTIFICATION_QUEUE_LIMIT) throw new Error('notification queue limit reached')
  recent.push(now); rates.set(context.owner, recent)
  const entry: Entry = { owner: context.owner, item: { ...normalized, id: ++sequence, source: context.source?.slice(0, 80) } }
  host.entries.push(entry)
  if (context.signal) {
    const onAbort = () => remove(host, entry.item.id)
    context.signal.addEventListener('abort', onAbort, { once: true })
    entry.removeAbort = () => context.signal?.removeEventListener('abort', onAbort)
  }
  sync(host)
  return entry.item.id
}
function includesContents(view: View, wc: WebContents): boolean {
  return view instanceof WebContentsView && view.webContents === wc || view.children.some(child => includesContents(child, wc))
}
function windowFor(wc: WebContents): BaseWindow | undefined {
  return BaseWindow.getAllWindows().find(win => includesContents(win.contentView, wc))
}
function requireLayer(wc: WebContents): Layer {
  const layer = layers.get(wc.id)
  if (!layer || layer.view.webContents !== wc) throw new Error('notification surface unavailable')
  return layer
}
export function refreshNotificationOverlays(): void { for (const layer of layers.values()) send(layer) }

export function registerNotificationHandlers(): void {
  if (registered) return
  registered = true
  nativeTheme.on('updated', refreshNotificationOverlays)
  setNotificationAppearanceSink(refreshNotificationOverlays)
  handleShellIpc(IpcChannels.NotificationShow, (event, payload: unknown) => {
    const role = getTrustedSurfaceRole(event.sender.id)
    if (!role || !['shell', 'quick', 'detached'].includes(role)) throw new Error('notification sender denied')
    return showNotification(windowFor(event.sender), payload, { owner: event.sender, source: 'eNest' })
  })
  handleShellIpc(IpcChannels.NotificationDismiss, (event, id: unknown) => {
    if (typeof id !== 'number' || !Number.isSafeInteger(id)) throw new Error('invalid notification id')
    const layer = layers.get(event.sender.id)
    if (layer) {
      if (!visibleEntries(layer).some(item => item.id === id)) throw new Error('notification owner mismatch')
      remove(layer.host, id)
      return
    }
    const win = windowFor(event.sender)
    const host = win && hosts.get(win.id)
    if (!host) return
    const entry = host.entries.find(entry => entry.item.id === id)
    if (entry && entry.owner !== event.sender) throw new Error('notification owner mismatch')
    remove(host, id)
  })
  handleShellIpc(IpcChannels.NotificationState, event => state(requireLayer(event.sender)))
  onShellIpc(IpcChannels.NotificationMeasure, (event, height: unknown) => {
    const layer = layers.get(event.sender.id)
    if (!layer) return
    if (typeof height !== 'number' || !Number.isFinite(height) || height < 40 || height > 5000) return
    layer.measured = Math.ceil(height)
    layout(layer)
    layer.view.setVisible(true)
    raiseTransientViews(layer.host.win)
  })
  handleShellIpc(IpcChannels.NotificationOpenLink, async (event, raw: unknown) => {
    requireLayer(event.sender)
    const url = typeof raw === 'string' ? safeNotificationLink(raw) : undefined
    if (!url) throw new Error('unsafe notification link')
    await shell.openExternal(url)
  })
}
