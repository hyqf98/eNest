import { app, BaseWindow, nativeTheme, screen, WebContentsView, type View, type WebContents } from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { SHELL_PARTITION } from '@shared/constants'
import { IpcChannels, type ShellEventPayload } from '@shared/types/ipc'
import type { DetachedWindowSession, PluginLaunchMode } from '@shared/types/plugin'
import type { DetachedPluginState, WindowPoint, WindowRect } from '@shared/types/plugin-window'
import { normalizeDetachedWindowSession } from '@shared/windowState'
import { registerTrustedSurface } from '@main/ipc/ipcSecurity'
import { resolvePreload, resolveWindowIcon, setDetachedAppearanceSink } from '@main/window/createShellWindow'
import { settingsStore } from '@main/settings/SettingsStore'
import { resolveThemeTokens } from '@main/theme/resolveThemeCss'
import { themePackRegistry } from '@main/theme/themePacks'
import { resolveBackgroundEffect, resolveThemeBackground } from '@shared/backgroundEffects'

interface DetachedRecord {
  pluginId: string
  window: BaseWindow
  windowId: number
  chrome: WebContentsView
  contents: WebContents
  mode: PluginLaunchMode
  state: DetachedPluginState | null
  history: DetachedWindowSession
  historyTimer?: ReturnType<typeof setTimeout>
  lazy: boolean
  coverUntilReady: boolean
  restoring: boolean
  disposing: boolean
  closeRequested: boolean
  removeListeners: () => void
  fitDisplay: () => void
}
interface WindowHost {
  close(id: string): void | Promise<void>
  visibility(id: string, visible: boolean): void
  layout(id: string): void
  snapshot(id: string): DetachedPluginState | null
  history?(id: string, state: DetachedWindowSession): void
  activate?(id: string): void | Promise<unknown>
}
const windows = new Map<string, DetachedRecord>()
let nativeListenerUsers = 0
const onDisplaysChanged = (): void => { for (const entry of windows.values()) entry.fitDisplay() }
const onThemeChanged = (): void => broadcastDetachedAppearance()
function acquireNativeListeners(): () => void {
  if (++nativeListenerUsers === 1) {
    screen.on('display-metrics-changed', onDisplaysChanged)
    screen.on('display-removed', onDisplaysChanged)
    nativeTheme.on('updated', onThemeChanged)
  }
  let released = false
  return () => {
    if (released) return
    released = true
    if (--nativeListenerUsers === 0) {
      screen.removeListener('display-metrics-changed', onDisplaysChanged)
      screen.removeListener('display-removed', onDisplaysChanged)
      nativeTheme.removeListener('updated', onThemeChanged)
    }
  }
}
let host: WindowHost | null = null
let windowObserver: ((window: BaseWindow) => void) | null = null
export function observeDetachedWindows(observer: (window: BaseWindow) => void): void {
  windowObserver = observer
  for (const entry of windows.values()) observer(entry.window)
}
export function bindDetachedWindowHost(value: WindowHost): void { host = value }
const chromeHeight = (mode: PluginLaunchMode): number => mode === 'quick' ? 100 : 36
function record(id: string | number): DetachedRecord | undefined {
  return typeof id === 'string' ? windows.get(id) : [...windows.values()].find(entry => entry.windowId === id)
}

export function constrainDetachedBounds(bounds: WindowRect): WindowRect {
  const area = screen.getDisplayMatching(bounds).workArea
  const width = Math.max(1, Math.min(Math.round(bounds.width), area.width))
  const height = Math.max(1, Math.min(Math.round(bounds.height), area.height))
  return {
    x: Math.round(Math.max(area.x, Math.min(bounds.x, area.x + area.width - width))),
    y: Math.round(Math.max(area.y, Math.min(bounds.y, area.y + area.height - height))), width, height
  }
}

function appearance(): NonNullable<DetachedPluginState['appearance']> {
  const general = settingsStore.getAll().general
  const theme = resolveThemeTokens('auto')
  const selectedTheme = settingsStore.getTheme()
  const packs = themePackRegistry.list()
  return {
    resolved: theme.appearance,
    theme: theme.mode, tokens: theme.tokens, animationLevel: theme.appearance?.animation.effective ?? general.animationLevel ?? 'medium',
    backgroundEffect: theme.appearance ? resolveBackgroundEffect(theme.appearance.background.effect, packs) : resolveBackgroundEffect(selectedTheme.backgroundEffect, packs),
    background: theme.appearance && !theme.appearance.theme.legacy ? theme.appearance.background.media : resolveThemeBackground(selectedTheme, packs),
    fontFamily: general.fontFamily, fontFamilyEn: general.fontFamilyEn,
    fontSizeScale: general.fontSizeScale, locale: general.locale
  }
}
function layout(entry: DetachedRecord): void {
  if (entry.window.isDestroyed()) return
  const { width, height } = entry.window.getContentBounds()
  // Chrome is created before the plugin View, so it also supplies the backdrop
  // below transparent plugin pixels. Plugin input/content bounds stay unchanged.
  entry.chrome.setBounds({ x: 0, y: 0, width, height })
  host?.layout(entry.pluginId)
}
function publish(entry: DetachedRecord): void {
  if (entry.contents.isDestroyed() || entry.window.isDestroyed()) return
  const snapshot = host?.snapshot(entry.pluginId) ?? entry.state
  if (!snapshot) return
  const previousCover = entry.coverUntilReady, previousMode = entry.mode
  entry.lazy = snapshot.status === 'lazy'
  if (entry.lazy) entry.coverUntilReady = true
  else if (snapshot.status === 'ready') entry.coverUntilReady = false
  entry.mode = snapshot.mode
  entry.state = { ...snapshot, alwaysOnTop: entry.window.isAlwaysOnTop(), appearance: appearance() }
  if (previousCover !== entry.coverUntilReady || previousMode !== entry.mode) layout(entry)
  entry.window.setTitle(`${snapshot.title} — eNest`)
  entry.contents.send(IpcChannels.PluginWindowEvent, { type: 'state', state: entry.state })
}

function readWindowHistory(entry: DetachedRecord): DetachedWindowSession {
  const win = entry.window
  if (!win.isDestroyed() && !entry.restoring) {
    const minimized = win.isMinimized()
    const normal = normalizeDetachedWindowSession({ ...entry.history, mode: entry.mode, bounds: win.getNormalBounds() })
    entry.history = {
      mode: entry.mode, bounds: constrainDetachedBounds(normal?.bounds ?? entry.history.bounds),
      maximized: minimized ? entry.history.maximized : win.isMaximized(),
      minimized, alwaysOnTop: win.isAlwaysOnTop()
    }
  }
  return { ...entry.history, bounds: { ...entry.history.bounds } }
}
function scheduleHistory(entry: DetachedRecord): void {
  if (entry.disposing || entry.closeRequested || entry.restoring) return
  readWindowHistory(entry)
  if (entry.historyTimer) clearTimeout(entry.historyTimer)
  entry.historyTimer = setTimeout(() => {
    entry.historyTimer = undefined
    if (!entry.disposing && !entry.closeRequested && windows.get(entry.pluginId) === entry) host?.history?.(entry.pluginId, readWindowHistory(entry))
  }, 180)
  entry.historyTimer.unref()
}
function clearHistoryTimer(entry: DetachedRecord): void {
  if (entry.historyTimer) clearTimeout(entry.historyTimer)
  entry.historyTimer = undefined
}
/** Prepared hidden. The host shows only after its plugin View has been attached successfully. */
export async function createDetachedWindow(
  pluginId: string, mode: PluginLaunchMode, size: { width: number; height: number }, position?: WindowPoint,
  options?: { restored?: DetachedWindowSession; lazy?: boolean }
): Promise<BaseWindow> {
  const existing = windows.get(pluginId)
  if (existing && !existing.window.isDestroyed()) return existing.window
  const theme = appearance()
  const point = position ?? screen.getCursorScreenPoint()
  const restored = normalizeDetachedWindowSession(options?.restored)
  if (restored) mode = restored.mode
  const bounds = constrainDetachedBounds(restored?.bounds ?? { x: point.x - 100, y: point.y - 18, width: Math.max(360, size.width), height: Math.max(240, size.height + chromeHeight(mode)) })
  const icon = resolveWindowIcon()
  const win = new BaseWindow({ ...bounds, ...(icon ? { icon } : {}), minWidth: Math.min(360, bounds.width), minHeight: Math.min(240, bounds.height),
    show: false, frame: false, roundedCorners: true, hasShadow: true, alwaysOnTop: restored?.alwaysOnTop === true,
    backgroundColor: theme.theme === 'dark' ? '#182126' : '#f6f8fa', title: 'eNest' })
  let chrome: WebContentsView | null = null
  let chromeContents: WebContents | null = null
  try {
    chrome = new WebContentsView({ webPreferences: {
      preload: resolvePreload('detachedPluginPreload.js'), partition: SHELL_PARTITION,
      contextIsolation: true, nodeIntegration: false, sandbox: true
    } })
    const contents = chromeContents = chrome.webContents
    chrome.setBackgroundColor(theme.theme === 'dark' ? '#182126' : '#f6f8fa')
    win.contentView.addChildView(chrome)
    const lazy = options?.lazy === true
    const entry: DetachedRecord = { pluginId, window: win, windowId: win.id, chrome, contents, mode,
      state: lazy ? { pluginId, title: pluginId, mode, generation: 0, status: 'lazy' } : null,
      history: { mode, bounds, maximized: restored?.maximized === true, minimized: restored?.minimized === true, alwaysOnTop: restored?.alwaysOnTop === true },
      lazy, coverUntilReady: lazy, restoring: lazy,
      disposing: false, closeRequested: false, removeListeners: () => {}, fitDisplay: () => {} }
    windows.set(pluginId, entry)
    windowObserver?.(win)
    const displayChanged = (): void => {
      if (win.isDestroyed()) return
      const previous = win.isMaximized() || win.isMinimized() || win.isFullScreen() ? readWindowHistory(entry).bounds : win.getBounds()
      const next = constrainDetachedBounds(previous)
      entry.history.bounds = next
      if (win.isMaximized() || win.isMinimized() || win.isFullScreen()) { scheduleHistory(entry); return }
      win.setMinimumSize(Math.min(360, next.width), Math.min(240, next.height))
      if (Object.keys(next).some(key => previous[key as keyof WindowRect] !== next[key as keyof WindowRect])) win.setBounds(next)
      scheduleHistory(entry)
    }
    entry.fitDisplay = displayChanged
    entry.removeListeners = acquireNativeListeners()
    win.on('resize', () => { layout(entry); scheduleHistory(entry) })
    win.on('move', () => scheduleHistory(entry))
    win.on('maximize', () => { layout(entry); scheduleHistory(entry) })
    win.on('unmaximize', () => { entry.fitDisplay(); layout(entry); scheduleHistory(entry) })
    win.on('always-on-top-changed', () => { scheduleHistory(entry); publish(entry) })
    const shown = (): void => {
      if (!entry.disposing) host?.visibility(pluginId, true)
      scheduleHistory(entry)
    }
    const hidden = (): void => {
      if (!entry.disposing) host?.visibility(pluginId, false)
      scheduleHistory(entry)
    }
    win.on('show', shown)
    win.on('focus', shown)
    win.on('restore', () => { shown(); if (!entry.restoring) entry.fitDisplay() })
    win.on('hide', hidden)
    win.on('minimize', hidden)
    win.on('close', event => {
      if (entry.disposing) return
      event.preventDefault()
      if (entry.closeRequested) return
      entry.closeRequested = true
      clearHistoryTimer(entry)
      win.hide()
      void Promise.resolve().then(() => host?.close(pluginId)).catch(error => {
        console.warn('[detached] close failed', pluginId, error)
      }).finally(() => { if (windows.get(pluginId) === entry) destroyDetachedWindow(pluginId) })
    })
    win.once('closed', () => {
      clearHistoryTimer(entry)
      entry.removeListeners()
      if (windows.get(pluginId) === entry) windows.delete(pluginId)
      if (!entry.contents.isDestroyed()) entry.contents.close({ waitForBeforeUnload: false })
      if (!entry.disposing && !entry.closeRequested) void Promise.resolve(host?.close(pluginId)).catch(() => {})
    })
    layout(entry)
    const file = join(app.getAppPath(), 'out', 'renderer', 'detached-plugin.html')
    const url = process.env.ELECTRON_RENDERER_URL
      ? new URL('detached-plugin.html', process.env.ELECTRON_RENDERER_URL.replace(/\/?$/, '/'))
      : pathToFileURL(file)
    url.searchParams.set('pluginId', pluginId)
    url.searchParams.set('mode', mode)
    url.searchParams.set('theme', theme.theme)
    if (lazy) url.searchParams.set('lazy', '1')
    registerTrustedSurface(contents, 'detached', url.href)
    let loadTimeout: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        contents.loadURL(url.href),
        new Promise<never>((_, reject) => {
          loadTimeout = setTimeout(() => reject(new Error('Independent window did not become ready')), 10000)
          loadTimeout.unref()
        })
      ])
    } finally { if (loadTimeout) clearTimeout(loadTimeout) }
    if (win.isDestroyed() || windows.get(pluginId) !== entry) throw new Error('Independent window creation cancelled')
    publish(entry)
    return win
  } catch (error) {
    if (windows.get(pluginId)?.window === win) destroyDetachedWindow(pluginId)
    else {
      if (chromeContents && !chromeContents.isDestroyed()) chromeContents.close({ waitForBeforeUnload: false })
      if (!win.isDestroyed()) win.destroy()
    }
    throw error
  }
}

export function getDetachedWindow(id: string | number): BaseWindow | null { return record(id)?.window ?? null }
export function getDetachedParent(id: string | number): View | null { return record(id)?.window.contentView ?? null }
export function getDetachedChrome(id: string | number): WebContentsView | null { return record(id)?.chrome ?? null }
export function getDetachedState(id: string | number): DetachedPluginState | null {
  const entry = record(id)
  if (!entry) return null
  const state = host?.snapshot(entry.pluginId) ?? entry.state
  return state ? { ...state, alwaysOnTop: entry.window.isDestroyed() ? entry.history.alwaysOnTop : entry.window.isAlwaysOnTop(), appearance: appearance() } : null
}
export function getPluginForDetachedSender(wcId: number): string | null {
  for (const entry of windows.values()) if (!entry.contents.isDestroyed() && entry.contents.id === wcId) return entry.pluginId
  return null
}
export function getDetachedPluginBounds(id: string | number): WindowRect {
  const entry = record(id)
  if (!entry || entry.window.isDestroyed()) return { x: 0, y: 36, width: 0, height: 0 }
  const { width, height } = entry.window.getContentBounds(), top = chromeHeight(entry.mode)
  return { x: 0, y: top, width, height: Math.max(0, height - top) }
}
export function updateDetachedState(state: DetachedPluginState): void {
  const entry = windows.get(state.pluginId)
  if (!entry) return
  entry.state = state
  publish(entry)
}
export function sendDetachedEvent(id: string | number, event: ShellEventPayload): void {
  const entry = record(id)
  if (entry && !entry.contents.isDestroyed()) entry.contents.send(IpcChannels.PluginWindowEvent, { type: 'shell', event })
}
export function broadcastDetachedAppearance(): void { for (const entry of windows.values()) publish(entry) }
export function destroyDetachedWindow(id: string | number): void {
  const entry = record(id)
  if (!entry) return
  entry.disposing = true
  clearHistoryTimer(entry)
  entry.removeListeners()
  windows.delete(entry.pluginId)
  if (!entry.contents.isDestroyed()) entry.contents.close({ waitForBeforeUnload: false })
  if (!entry.window.isDestroyed()) entry.window.destroy()
}
export function destroyAllDetachedWindows(): void { for (const id of [...windows.keys()]) destroyDetachedWindow(id) }
export function listDetachedWindows(): BaseWindow[] { return [...windows.values()].map(entry => entry.window) }

// 与 createShellWindow 成环（环内模块体顺序由打包器决定），微任务注册避开 TDZ。
queueMicrotask(() => {
  setDetachedAppearanceSink(broadcastDetachedAppearance)
})

/** Restored chrome appears immediately, while the plugin runtime remains absent. */
export function presentRestoredDetachedWindow(id: string | number): void {
  const entry = record(id)
  if (!entry || entry.window.isDestroyed()) return
  const history = { ...entry.history, bounds: { ...entry.history.bounds } }
  entry.restoring = true
  try {
    entry.window.setAlwaysOnTop(history.alwaysOnTop === true)
    entry.window.showInactive()
    if (history.maximized) entry.window.maximize()
    if (history.minimized) entry.window.minimize()
  } finally {
    entry.restoring = false
  }
  layout(entry)
  publish(entry)
  scheduleHistory(entry)
}
export function getDetachedWindowSession(id: string | number): DetachedWindowSession | null {
  const entry = record(id)
  return entry ? readWindowHistory(entry) : null
}
export function toggleDetachedAlwaysOnTop(id: string | number): boolean {
  const entry = record(id)
  if (!entry || entry.window.isDestroyed()) return false
  const next = !entry.window.isAlwaysOnTop()
  entry.window.setAlwaysOnTop(next)
  scheduleHistory(entry)
  publish(entry)
  return next
}
