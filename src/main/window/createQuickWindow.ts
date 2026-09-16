/**
 * createQuickWindow — 快捷启动独立小窗
 * 职责：创建/销毁无边框置顶 Quick BaseWindow，挂载 shellPreload 的 WebContentsView，
 * 提供 toggle/hide/show 与居中定位；失焦自动隐藏。
 * 被 index.ts / quickHotkey / quickHandlers 调用。
 * 关键依赖：resolvePreload、settingsStore（主题）、logService。
 */
import { join } from 'node:path'
import {
  app,
  BaseWindow,
  screen,
  WebContentsView
} from 'electron'
import { SHELL_PARTITION } from '@shared/constants'
import { IpcChannels } from '@shared/types/ipc'
import { resolvePreload } from './createShellWindow'

const QUICK_WIDTH = 720
const QUICK_HEIGHT = 420

let quickWindow: BaseWindow | null = null
let quickView: WebContentsView | null = null

function loadQuickRenderer(view: WebContentsView): void {
  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (devUrl) {
    void view.webContents.loadURL(`${devUrl}?surface=quick`)
  } else {
    void view.webContents.loadFile(join(app.getAppPath(), 'out', 'renderer', 'index.html'), {
      query: { surface: 'quick' }
    })
  }
}

function applyQuickBounds(win: BaseWindow, view: WebContentsView): void {
  const b = win.getContentBounds()
  view.setBounds({ x: 0, y: 0, width: b.width, height: b.height })
}

/** 在光标所在显示器的上三分之一居中放置 */
function positionOnCursorScreen(win: BaseWindow): void {
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  const wa = display.workArea
  const x = Math.round(wa.x + (wa.width - QUICK_WIDTH) / 2)
  const y = Math.round(wa.y + wa.height * 0.22)
  win.setBounds({ x, y, width: QUICK_WIDTH, height: QUICK_HEIGHT })
}

export function getQuickWindow(): BaseWindow | null {
  return quickWindow
}

export function getQuickWebContents() {
  return quickView?.webContents ?? null
}

export function isQuickVisible(): boolean {
  return !!quickWindow && !quickWindow.isDestroyed() && quickWindow.isVisible()
}

/** 确保窗口存在；首次创建后隐藏等待呼出 */
export function ensureQuickWindow(): BaseWindow {
  if (quickWindow && !quickWindow.isDestroyed()) return quickWindow

  const win = new BaseWindow({
    width: QUICK_WIDTH,
    height: QUICK_HEIGHT,
    show: false,
    frame: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: true,
    roundedCorners: true,
    backgroundColor: '#00000000',
    title: 'eNest Quick'
  })

  if (process.platform === 'darwin') {
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  }
  // 尽量高于普通置顶窗口；失败则回退
  try {
    win.setAlwaysOnTop(true, 'screen-saver')
  } catch {
    win.setAlwaysOnTop(true)
  }

  const view = new WebContentsView({
    webPreferences: {
      preload: resolvePreload('shellPreload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      partition: SHELL_PARTITION,
      backgroundThrottling: false
    }
  })

  win.contentView.addChildView(view)
  applyQuickBounds(win, view)
  loadQuickRenderer(view)

  win.on('resize', () => {
    if (!quickWindow || !quickView) return
    applyQuickBounds(quickWindow, quickView)
  })

  // 失焦隐藏：命令面交互完自动收起，不销毁进程
  win.on('blur', () => {
    if (!quickWindow || quickWindow.isDestroyed()) return
    // 录制快捷键或 DevTools 时可能瞬时 blur，延迟判断仍失焦则 hide
    setTimeout(() => {
      if (!quickWindow || quickWindow.isDestroyed()) return
      if (!quickWindow.isFocused() && !quickView?.webContents.isDevToolsOpened()) {
        quickWindow.hide()
      }
    }, 80)
  })

  win.on('closed', () => {
    quickWindow = null
    quickView = null
  })

  quickWindow = win
  quickView = view
  return win
}

export function showQuickWindow(): void {
  const win = ensureQuickWindow()
  positionOnCursorScreen(win)
  const wc = quickView?.webContents
  const focusSearch = (): void => {
    if (!wc || wc.isDestroyed()) return
    wc.focus()
    wc.send(IpcChannels.QuickShown)
  }
  // 首次创建时可能尚未加载完成：等 did-finish-load 再 focus，避免空白帧
  if (wc && !wc.isDestroyed() && !wc.isLoadingMainFrame()) {
    win.show()
    win.focus()
    focusSearch()
  } else if (wc && !wc.isDestroyed()) {
    wc.once('did-finish-load', () => {
      if (!quickWindow || quickWindow.isDestroyed()) return
      win.show()
      win.focus()
      focusSearch()
    })
    win.show()
  } else {
    win.show()
    win.focus()
  }
}

export function hideQuickWindow(): void {
  if (quickWindow && !quickWindow.isDestroyed() && quickWindow.isVisible()) {
    quickWindow.hide()
  }
}

export function toggleQuickWindow(): void {
  if (isQuickVisible()) hideQuickWindow()
  else showQuickWindow()
}

export function destroyQuickWindow(): void {
  if (quickWindow && !quickWindow.isDestroyed()) {
    quickWindow.destroy()
  }
  quickWindow = null
  quickView = null
}
