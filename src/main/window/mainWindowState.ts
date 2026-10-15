import { screen, type BaseWindow } from 'electron'
import { settingsStore } from '@main/settings/SettingsStore'
import type { PluginWindowGeometry } from '@shared/types/plugin'
import { normalizeWindowGeometry } from '@shared/windowState'

let trackedWindow: BaseWindow | null = null
let saveTimer: ReturnType<typeof setTimeout> | null = null
let frozen = false
let previous = ''
let wasMaximized = false

/** Saved coordinates are screen DIP, including negative coordinates on secondary displays. */
export function constrainMainBounds(bounds: PluginWindowGeometry['bounds']): PluginWindowGeometry['bounds'] {
  const area = screen.getDisplayMatching(bounds).workArea
  const width = Math.min(area.width, Math.max(900, bounds.width))
  const height = Math.min(area.height, Math.max(600, bounds.height))
  return {
    x: Math.round(Math.min(Math.max(bounds.x, area.x), area.x + area.width - width)),
    y: Math.round(Math.min(Math.max(bounds.y, area.y), area.y + area.height - height)),
    width, height
  }
}

export function readMainWindowState(): PluginWindowGeometry | undefined {
  const state = normalizeWindowGeometry(settingsStore.getAll().general.mainWindowState)
  return state ? { ...state, bounds: constrainMainBounds(state.bounds) } : undefined
}

/** Freeze before shutdown so native close/minimize events cannot replace the recovery snapshot. */
export function flushMainWindowState(freeze = false): void {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = null
  if (frozen) return
  const win = trackedWindow
  if (win && !win.isDestroyed()) {
    if (!win.isMinimized()) wasMaximized = win.isMaximized()
    const state: PluginWindowGeometry = {
      bounds: win.getNormalBounds(), maximized: wasMaximized, minimized: win.isMinimized()
    }
    const serialized = JSON.stringify(state)
    if (serialized !== previous) {
      previous = serialized
      void settingsStore.setAll({ general: { mainWindowState: state } }).catch(error => {
        previous = ''
        console.warn('[enest] window history save failed', error)
      })
    }
  }
  if (freeze) frozen = true
}

/** Install after initial presentation; startup native events must not rewrite saved state. */
export function trackMainWindowState(win: BaseWindow): void {
  trackedWindow = win
  frozen = false
  previous = ''
  wasMaximized = win.isMinimized() ? readMainWindowState()?.maximized === true : win.isMaximized()
  const schedule = (): void => {
    if (frozen) return
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => flushMainWindowState(), 400)
    saveTimer.unref?.()
  }
  const fitDisplay = (): void => {
    if (frozen || win.isDestroyed() || win.isMaximized() || win.isMinimized()) return
    const current = win.getBounds(), next = constrainMainBounds(current)
    if (JSON.stringify(next) !== JSON.stringify(current)) win.setBounds(next)
  }
  win.on('move', schedule)
  win.on('resize', schedule)
  win.on('maximize', () => { wasMaximized = true; schedule() })
  win.on('unmaximize', () => { wasMaximized = false; schedule() })
  win.on('minimize', schedule)
  win.on('restore', schedule)
  win.on('close', () => flushMainWindowState())
  screen.on('display-removed', fitDisplay)
  screen.on('display-metrics-changed', fitDisplay)
  win.once('closed', () => {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = null
    if (trackedWindow === win) trackedWindow = null
    screen.removeListener('display-removed', fitDisplay)
    screen.removeListener('display-metrics-changed', fitDisplay)
  })
}
