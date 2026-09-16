/**
 * orbOverlayWindow — 左侧圆轨透明子窗口
 * 作为主窗 child 附着：拖动/缩放时跟随主窗，不抢全局置顶（不会浮到其它 App 之上）。
 * 覆盖在插件 WebContentsView 之上，不占用插件内容宽度（inset 恒 0）。
 */
import { app, BrowserWindow, type BaseWindow } from 'electron'
import { join } from 'node:path'
import { ORB_OVERLAY_WIDTH, TITLEBAR_HEIGHT } from '@shared/constants'
import { IpcChannels, type OrbRailState } from '@shared/types/ipc'
import {
  getMainWindow,
  getShellBounds,
  resolvePreload,
  setPluginLeftInset
} from '@main/window/createShellWindow'
import { logInfo, logWarn } from '@main/logs/logService'

let overlayWin: BrowserWindow | null = null
let attachedTo: BaseWindow | null = null
let parentListenersBound = false

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

/** 主窗几何变化时同步悬浮窗（拖动、缩放） */
function onParentGeometry(): void {
  layoutOverlay()
}

/** 主窗失焦：藏起悬浮窗，避免盖到其它应用 */
function onParentBlur(): void {
  if (overlayWin && !overlayWin.isDestroyed() && overlayWin.isVisible()) {
    overlayWin.hide()
  }
}

/** 主窗聚焦：orb 模式恢复悬浮窗 */
function onParentFocus(): void {
  if (lastState.tabStyle === 'orb') {
    showOrbOverlay()
  }
}

function bindParentListeners(parent: BaseWindow): void {
  if (attachedTo === parent && parentListenersBound) return
  unbindParentListeners()
  attachedTo = parent
  parent.on('move', onParentGeometry)
  parent.on('resize', onParentGeometry)
  parent.on('moved', onParentGeometry)
  parent.on('blur', onParentBlur)
  parent.on('focus', onParentFocus)
  parentListenersBound = true
}

function unbindParentListeners(): void {
  if (!attachedTo || attachedTo.isDestroyed()) {
    attachedTo = null
    parentListenersBound = false
    return
  }
  attachedTo.off('move', onParentGeometry)
  attachedTo.off('resize', onParentGeometry)
  attachedTo.off('moved', onParentGeometry)
  attachedTo.off('blur', onParentBlur)
  attachedTo.off('focus', onParentFocus)
  parentListenersBound = false
  attachedTo = null
}

export function createOrbOverlayWindow(): void {
  if (overlayWin && !overlayWin.isDestroyed()) return

  const parent = getMainWindow()
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
    // 不设全局 alwaysOnTop；用 parent 绑定跟随主窗，只盖在本应用之上
    alwaysOnTop: false,
    focusable: true,
    backgroundColor: '#00000000',
    ...(parent && !parent.isDestroyed()
      ? { parent: parent as unknown as BrowserWindow }
      : {}),
    webPreferences: {
      preload: resolvePreload('shellPreload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      partition: 'enest-shell',
      backgroundThrottling: false
    }
  })

  // 附加父子关系（部分 Electron 版本需显式 setParentWindow）
  if (parent && !parent.isDestroyed()) {
    try {
      const anyWin = win as unknown as { setParentWindow?: (p: BaseWindow) => void }
      anyWin.setParentWindow?.(parent)
    } catch (err) {
      logWarn('orb', `setParentWindow failed: ${(err as Error).message}`)
    }
    bindParentListeners(parent)
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
  // 子窗口：不抢焦点，但要保证叠在插件 WebContentsView 之上
  try {
    overlayWin.moveTop()
  } catch {
    /* ignore */
  }
  overlayWin.showInactive()
}

export function hideOrbOverlay(): void {
  if (overlayWin && !overlayWin.isDestroyed()) overlayWin.hide()
}

export function layoutOrbOverlay(): void {
  if (!overlayWin || overlayWin.isDestroyed() || !overlayWin.isVisible()) return
  layoutOverlay()
  try {
    overlayWin.moveTop()
  } catch {
    /* ignore */
  }
}

export function destroyOrbOverlay(): void {
  unbindParentListeners()
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
    if (parent && !parent.isDestroyed()) bindParentListeners(parent)
  } else {
    hideOrbOverlay()
  }
}
