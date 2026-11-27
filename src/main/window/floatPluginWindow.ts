import { BaseWindow, screen, type View } from 'electron'
import { DESKTOP_CORNER_RADIUS } from '@shared/windowFrame'
import { normalizeWindowGeometry } from '@shared/windowState'
import type { FloatWindowOptions, WindowPoint, WindowRect } from '@shared/types/plugin-window'
import type { PluginWindowGeometry } from '@shared/types/plugin'
import { resolveWindowIcon } from './applicationIcon'
import { trackWindowShape } from './windowShape'

export const FLOAT_MIN_WIDTH = 240
export const FLOAT_MIN_HEIGHT = 160
const DEFAULT_WIDTH = 480, DEFAULT_HEIGHT = 320

interface FloatRecord {
  pluginId: string
  window: BaseWindow
  windowId: number
  /** Live screen DIP; a float window never maximizes. */
  geometry: PluginWindowGeometry
  historyTimer?: ReturnType<typeof setTimeout>
  disposing: boolean
  /** True while the host moves the plugin back; the window must not ask again. */
  exiting: boolean
  removeListeners: () => void
}
interface FloatHost {
  /** User closed the window: the host moves the plugin back instead of closing it. */
  exit(pluginId: string): void | Promise<unknown>
  /** Bounds or topmost state changed; the host persists geometry and notifies the plugin. */
  changed(pluginId: string): void
}
const windows = new Map<string, FloatRecord>()
let host: FloatHost | null = null
let nativeListenerUsers = 0
const onDisplaysChanged = (): void => { for (const entry of windows.values()) fitDisplay(entry) }
function acquireNativeListeners(): () => void {
  if (++nativeListenerUsers === 1) {
    screen.on('display-metrics-changed', onDisplaysChanged)
    screen.on('display-removed', onDisplaysChanged)
  }
  let released = false
  return () => {
    if (released) return
    released = true
    if (--nativeListenerUsers === 0) {
      screen.removeListener('display-metrics-changed', onDisplaysChanged)
      screen.removeListener('display-removed', onDisplaysChanged)
    }
  }
}
export function bindFloatWindowHost(value: FloatHost): void { host = value }

function record(id: string | number): FloatRecord | undefined {
  return typeof id === 'string' ? windows.get(id) : [...windows.values()].find(entry => entry.windowId === id)
}

const clampSize = (value: unknown, fallback: number, min: number, max: number): number => {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallback
  return Math.max(min, Math.min(max, n))
}
/** Plugin-supplied options are untrusted: sizes are clamped to sane ranges, booleans coerced. */
export function normalizeFloatOptions(raw: unknown): Required<FloatWindowOptions> {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const minWidth = clampSize(o.minWidth, FLOAT_MIN_WIDTH, FLOAT_MIN_WIDTH, 1600)
  const minHeight = clampSize(o.minHeight, FLOAT_MIN_HEIGHT, FLOAT_MIN_HEIGHT, 1200)
  return {
    width: clampSize(o.width, DEFAULT_WIDTH, minWidth, 3840),
    height: clampSize(o.height, DEFAULT_HEIGHT, minHeight, 2160),
    minWidth, minHeight,
    alwaysOnTop: o.alwaysOnTop !== false
  }
}

export function constrainFloatBounds(bounds: WindowRect, minWidth = FLOAT_MIN_WIDTH, minHeight = FLOAT_MIN_HEIGHT): WindowRect {
  const area = screen.getDisplayMatching(bounds).workArea
  const width = Math.max(1, Math.min(Math.round(bounds.width), area.width))
  const height = Math.max(1, Math.min(Math.round(bounds.height), area.height))
  return {
    x: Math.round(Math.max(area.x, Math.min(bounds.x, area.x + area.width - width))),
    y: Math.round(Math.max(area.y, Math.min(bounds.y, area.y + area.height - height))), width, height
  }
}
function fitDisplay(entry: FloatRecord): void {
  const win = entry.window
  if (win.isDestroyed()) return
  const previous = win.getBounds()
  const next = constrainFloatBounds(previous)
  entry.geometry.bounds = next
  if (Object.keys(next).some(key => next[key as keyof WindowRect] !== previous[key as keyof WindowRect])) win.setBounds(next)
}

/** Preferred top-right of the cursor display. */
export function defaultFloatBounds(options: Required<FloatWindowOptions>): WindowRect {
  const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea
  const margin = 16
  const width = Math.min(options.width, area.width), height = Math.min(options.height, area.height)
  return constrainFloatBounds({ x: area.x + area.width - width - margin, y: area.y + margin, width, height }, options.minWidth, options.minHeight)
}

/** Geometry writes are coalesced; the host persists the result. */
function scheduleHistory(entry: FloatRecord): void {
  if (entry.disposing) return
  if (entry.historyTimer) clearTimeout(entry.historyTimer)
  entry.historyTimer = setTimeout(() => {
    entry.historyTimer = undefined
    if (entry.disposing) return
    entry.geometry.bounds = entry.window.getBounds()
    host?.changed(entry.pluginId)
  }, 180)
  entry.historyTimer.unref()
}
function clearHistoryTimer(entry: FloatRecord): void {
  if (entry.historyTimer) clearTimeout(entry.historyTimer)
  entry.historyTimer = undefined
}

/**
 * Prepared hidden; the host shows it only after the plugin view is attached.
 * `alwaysOnTop` is a constructor option on purpose: re-leveling a just-shown window
 * crashes on macOS 26/27 (see createQuickWindow).
 */
export function createFloatWindow(pluginId: string, options: Required<FloatWindowOptions>, restored?: PluginWindowGeometry | null): BaseWindow {
  const existing = windows.get(pluginId)
  if (existing && !existing.window.isDestroyed()) return existing.window
  const restoredBounds = normalizeWindowGeometry(restored)?.bounds
  const bounds = constrainFloatBounds(restoredBounds ?? defaultFloatBounds(options), options.minWidth, options.minHeight)
  const win = new BaseWindow({
    icon: resolveWindowIcon(),
    x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height,
    minWidth: Math.min(options.minWidth, bounds.width), minHeight: Math.min(options.minHeight, bounds.height),
    show: false, frame: false, resizable: true, maximizable: false, fullscreenable: false, minimizable: true,
    skipTaskbar: true, alwaysOnTop: options.alwaysOnTop, hasShadow: true, roundedCorners: true,
    backgroundColor: '#000000', title: 'eNest'
  })
  const entry: FloatRecord = { pluginId, window: win, windowId: win.id,
    geometry: { bounds, alwaysOnTop: options.alwaysOnTop }, disposing: false, exiting: false, removeListeners: () => {} }
  windows.set(pluginId, entry)
  entry.removeListeners = acquireNativeListeners()
  win.on('resize', () => { fitDisplay(entry) })
  win.on('move', () => { scheduleHistory(entry) })
  win.on('always-on-top-changed', () => { entry.geometry.alwaysOnTop = win.isAlwaysOnTop(); host?.changed(pluginId) })
  win.on('closed', () => {
    clearHistoryTimer(entry)
    entry.removeListeners()
    if (windows.get(pluginId) === entry) windows.delete(pluginId)
  })
  // Closing the chrome-less window means "leave float", never "close the plugin".
  win.on('close', event => {
    if (entry.disposing || entry.exiting) return
    event.preventDefault()
    entry.exiting = true
    win.hide()
    void Promise.resolve().then(() => host?.exit(pluginId)).catch(error => {
      entry.exiting = false
      if (!win.isDestroyed()) win.show()
      console.warn('[float] exit failed', pluginId, error)
    })
  })
  trackWindowShape(win, DESKTOP_CORNER_RADIUS)
  if (process.platform === 'darwin') win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  return win
}

export function getFloatWindow(id: string | number): BaseWindow | null { return record(id)?.window ?? null }
export function getFloatParent(id: string | number): View | null { return record(id)?.window.contentView ?? null }
export function getFloatPluginBounds(id: string | number): WindowRect {
  const entry = record(id)
  if (!entry || entry.window.isDestroyed()) return { x: 0, y: 0, width: 0, height: 0 }
  const { width, height } = entry.window.getContentBounds()
  return { x: 0, y: 0, width, height }
}
export function getFloatGeometry(id: string | number): PluginWindowGeometry | null {
  const entry = record(id)
  if (!entry) return null
  return { bounds: { ...entry.geometry.bounds }, alwaysOnTop: entry.geometry.alwaysOnTop === true }
}
export function showFloatWindow(id: string | number): void {
  const win = record(id)?.window
  if (!win || win.isDestroyed()) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}
export function setFloatAlwaysOnTop(id: string | number, value: boolean): boolean {
  const entry = record(id)
  if (!entry || entry.window.isDestroyed()) return false
  const next = value === true
  // Same-level writes are skipped: re-leveling a visible window is what crashes on macOS 26/27.
  if (entry.window.isAlwaysOnTop() === next) return next
  entry.window.setAlwaysOnTop(next)
  entry.geometry.alwaysOnTop = next
  return next
}
export function destroyFloatWindow(id: string | number): void {
  const entry = record(id)
  if (!entry) return
  entry.disposing = true
  clearHistoryTimer(entry)
  entry.removeListeners()
  windows.delete(entry.pluginId)
  if (!entry.window.isDestroyed()) entry.window.destroy()
}
export function destroyAllFloatWindows(): void { for (const id of [...windows.keys()]) destroyFloatWindow(id) }
export function listFloatWindows(): BaseWindow[] { return [...windows.values()].map(entry => entry.window) }
