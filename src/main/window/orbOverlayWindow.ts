/**
 * orbOverlayWindow — 左侧圆轨透明子窗口
 * 作为主窗 child 附着：拖动/缩放时跟随主窗，不抢全局置顶（不会浮到其它 App 之上）。
 * 覆盖在插件 WebContentsView 之上，不占用插件内容宽度（inset 恒 0）。
 * 宽度固定为 ORB_OVERLAY_WIDTH：展开/收起只切 CSS，不再 setBounds，
 * 避免 macOS 重合成导致插件层短暂盖住悬浮窗，以及伪 mouseleave。
 * 默认 setIgnoreMouseEvents(true, {forward:true})：透明区点击穿透到插件；
 * 悬浮窗 renderer 在悬停把手/圆球/设置钮时通过 IPC 收回命中。
 */
import { app, BrowserWindow, type BaseWindow } from 'electron'
import { join } from 'node:path'
import { ORB_OVERLAY_WIDTH, TITLEBAR_HEIGHT } from '@shared/constants'
import { IpcChannels, type OrbRailState } from '@shared/types/ipc'
import type { AnimationLevel } from '@shared/types/plugin'
import {
  getMainWindow,
  getShellBounds,
  resolvePreload,
  setPluginLeftInset
} from '@main/window/createShellWindow'
import { settingsStore } from '@main/settings/SettingsStore'
import { logInfo, logWarn } from '@main/logs/logService'

let overlayWin: BrowserWindow | null = null
let attachedTo: BaseWindow | null = null
let parentListenersBound = false
/** 当前是否接收鼠标（false = 穿透） */
let hitReceive = false
/** 最近一次推到 overlay 的动画档位，避免重复 executeJavaScript */
let lastPushedAnim: AnimationLevel | null = null

let lastState: OrbRailState = {
  view: 'home',
  tabStyle: 'classic',
  activeTabId: null,
  tabs: []
}

export function getOrbRailState(): OrbRailState {
  return lastState
}

function isAnimLevel(v: unknown): v is AnimationLevel {
  return v === 'low' || v === 'medium' || v === 'high'
}

/** 从 settingsStore 读当前动画档位（overlay 独立窗口，主壳不推送 settings 变更） */
function readAnimLevel(): AnimationLevel {
  try {
    const raw = settingsStore.getAll().general.animationLevel
    return isAnimLevel(raw) ? raw : 'medium'
  } catch {
    return 'medium'
  }
}

/** 把 animationLevel 写到 overlay 文档根 data-anim */
function pushAnimLevel(force = false): void {
  if (!overlayWin || overlayWin.isDestroyed()) return
  const level = readAnimLevel()
  if (!force && lastPushedAnim === level) return
  lastPushedAnim = level
  void overlayWin.webContents
    .executeJavaScript(`document.documentElement.dataset.anim = ${JSON.stringify(level)}`)
    .catch(() => undefined)
}

export function setOrbRailState(state: OrbRailState): void {
  lastState = { ...state }
  if (overlayWin && !overlayWin.isDestroyed()) {
    overlayWin.webContents.send(IpcChannels.ShellOrbEvent, {
      type: 'orb-state',
      state: lastState
    })
    // 顺带对齐动画档位（设置页改档后，下一次 tab/view 同步即可生效）
    pushAnimLevel()
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

/** 应用命中模式：穿透 / 接收 */
function applyHitMode(receive: boolean): void {
  hitReceive = receive === true
  if (!overlayWin || overlayWin.isDestroyed()) return
  try {
    if (hitReceive) {
      overlayWin.setIgnoreMouseEvents(false)
    } else {
      overlayWin.setIgnoreMouseEvents(true, { forward: true })
    }
  } catch (err) {
    logWarn('orb', `setIgnoreMouseEvents failed: ${(err as Error).message}`)
  }
}

/** 悬浮窗请求：固定宽度，展开态只影响 renderer CSS */
export function setOrbOverlayExpanded(_expanded: boolean): void {
  /* fixed width — no-op */
}

/** 悬浮窗 renderer：鼠标是否在可交互 chrome 上 */
export function setOrbOverlayHit(receive: boolean): void {
  if (hitReceive === !!receive) return
  applyHitMode(!!receive)
}

function loadOverlay(win: BrowserWindow): void {
  // URL query：首帧即可套用正确档位，避免 medium 弹簧闪一下
  const anim = readAnimLevel()
  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (devUrl) {
    const base = devUrl.replace(/\/$/, '')
    void win.loadURL(`${base}/orb-overlay.html?anim=${encodeURIComponent(anim)}`)
  } else {
    void win.loadFile(join(app.getAppPath(), 'out', 'renderer', 'orb-overlay.html'), {
      query: { anim }
    })
  }
}

/** 主窗几何变化时同步悬浮窗（拖动、缩放） */
function onParentGeometry(): void {
  layoutOverlay()
  try {
    overlayWin?.moveTop()
  } catch {
    /* ignore */
  }
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

  // 确保全透明，避免默认底色「方块」
  win.setBackgroundColor('#00000000')

  // 默认穿透：透明区不挡插件点击；mousemove forward 让 renderer 能检测悬停
  applyHitMode(false)

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
      lastPushedAnim = null
      pushAnimLevel(true)
      // 加载完成后回到穿透态
      applyHitMode(false)
    }
  })

  overlayWin = win
  logInfo('orb', 'overlay window created')
}

export function showOrbOverlay(): void {
  createOrbOverlayWindow()
  if (!overlayWin || overlayWin.isDestroyed()) return
  layoutOverlay()
  // 懒创建/重新显示时对齐当前档位
  pushAnimLevel()
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
  hitReceive = false
  lastPushedAnim = null
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
