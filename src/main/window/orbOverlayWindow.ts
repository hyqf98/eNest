/**
 * orbOverlayWindow — 左侧圆轨透明置顶悬浮窗
 * 覆盖在插件 WebContentsView 之上，不占用插件内容宽度（inset 恒 0）。
 * 壳子 renderer 经 ShellSyncOrbState 推送 Tab 状态；悬浮窗经同一 shellApi 操作。
 */
import { app, BrowserWindow } from 'electron'
import { join } from 'node:path'
import { ORB_OVERLAY_WIDTH, TITLEBAR_HEIGHT } from '@shared/constants'
import { IpcChannels, type OrbRailState } from '@shared/types/ipc'
import {
  getMainWindow,
  getShellBounds,
  resolvePreload,
  setPluginLeftInset
} from '@main/window/createShellWindow'
import { logInfo } from '@main/logs/logService'

let overlayWin: BrowserWindow | null = null
let lastState: OrbRailState = {
  view: 'home',
  tabStyle: 'classic',
  activeTabId: null,
  tabs: []
}

export function getOrbRailState(): OrbRailState {
  return lastState
}

export function setOrbRailState(state: OrbRailState): void {
  lastState = { ...state }
  if (overlayWin && !overlayWin.isDestroyed()) {
    overlayWin.webContents.send(IpcChannels.ShellOrbEvent, {
      type: 'orb-state',
      state: lastState
    })
  }
  if (lastState.tabStyle === 'orb') {
    setPluginLeftInset(0)
  }
}

function layoutOverlay(): void {
  if (!overlayWin || overlayWin.isDestroyed()) return
  const b = getShellBounds()
  const top = TITLEBAR_HEIGHT
  overlayWin.setBounds({
    x: b.x,
    y: b.y + top,
    width: ORB_OVERLAY_WIDTH,
    height: Math.max(80, b.height - top)
  })
}

function loadOverlay(win: BrowserWindow): void {
  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (devUrl) {
    void win.loadURL(`${devUrl.replace(/\/$/, '')}/orb-overlay.html`)
  } else {
    void win.loadFile(join(app.getAppPath(), 'out', 'renderer', 'orb-overlay.html'))
  }
}

export function createOrbOverlayWindow(): void {
  if (overlayWin && !overlayWin.isDestroyed()) return

  const win = new BrowserWindow({
    width: ORB_OVERLAY_WIDTH,
    height: 400,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    focusable: true,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: resolvePreload('shellPreload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      partition: 'enest-shell',
      backgroundThrottling: false
    }
  })

  win.setAlwaysOnTop(true, 'screen-saver')
  try {
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  } catch {
    /* optional API */
  }

  loadOverlay(win)

  win.webContents.once('did-finish-load', () => {
    if (!win.isDestroyed()) {
      win.webContents.send(IpcChannels.ShellOrbEvent, {
        type: 'orb-state',
        state: lastState
      })
    }
  })

  overlayWin = win
  logInfo('orb', 'overlay window created')
}

export function showOrbOverlay(): void {
  createOrbOverlayWindow()
  if (!overlayWin || overlayWin.isDestroyed()) return
  layoutOverlay()
  overlayWin.showInactive()
}

export function hideOrbOverlay(): void {
  if (overlayWin && !overlayWin.isDestroyed()) overlayWin.hide()
}

export function layoutOrbOverlay(): void {
  if (!overlayWin || overlayWin.isDestroyed() || !overlayWin.isVisible()) return
  layoutOverlay()
}

export function destroyOrbOverlay(): void {
  if (overlayWin && !overlayWin.isDestroyed()) overlayWin.destroy()
  overlayWin = null
}

/** tabStyle 变化：orb 显示悬浮窗（插件全宽）；classic 隐藏 */
export function applyOrbOverlayVisibility(tabStyle: 'classic' | 'orb'): void {
  lastState = { ...lastState, tabStyle }
  if (tabStyle === 'orb') {
    setPluginLeftInset(0)
    showOrbOverlay()
    const parent = getMainWindow()
    if (parent && !parent.isDestroyed()) {
      parent.removeAllListeners('resize')
      parent.on('resize', layoutOrbOverlay)
      parent.on('move', layoutOrbOverlay)
    }
  } else {
    hideOrbOverlay()
  }
}
