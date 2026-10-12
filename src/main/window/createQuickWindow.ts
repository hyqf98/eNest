/**
 * createQuickWindow — 快捷启动独立小窗
 * 职责：创建/销毁无边框置顶 Quick BrowserWindow，由透明主 renderer 绘制圆角表面，
 * 提供 toggle/hide/show 与居中定位；失焦自动隐藏。
 * 兼任 mini 插件容器：提供 getQuickPluginBounds（插件 view 铺输入条以下区域），
 * 尺寸变更联动 relayoutQuickPlugins（PluginHost 注入，避免循环依赖）。
 * 被 index.ts / quickHotkey / quickHandlers / PluginHost 调用。
 * 关键依赖：resolvePreload、settingsStore（动画）、logService。
 */
import { join } from 'node:path'
import { app, BrowserWindow, screen } from 'electron'
import {
  QUICK_BAR_AREA_H,
  QUICK_BORDER_WIDTH,
  QUICK_MAX_HEIGHT,
  QUICK_MIN_HEIGHT,
  QUICK_WIDTH,
  SHELL_PARTITION
} from '@shared/constants'
import { IpcChannels } from '@shared/types/ipc'
import { ensureShellSessionProtocol } from '@main/plugin/pluginProtocol'
import { logError, logInfo } from '@main/logs/logService'
import { settingsStore } from '@main/settings/SettingsStore'
import { resolvePreload, setQuickEventSink } from './createShellWindow'

let quickWindow: BrowserWindow | null = null
let lastPushedAnim = ''
let currentTargetHeight = QUICK_MIN_HEIGHT
let currentTargetWidth = QUICK_WIDTH
const WORK_AREA_INSET = 16
const QUICK_MIN_WIDTH = 480
const QUICK_MAX_WIDTH = 1200
/** blur 宽限截止：在此之前只抢焦点、不 hide */
let blurGuardUntil = 0
/** toggle 防抖 */
let lastToggleAt = 0
/** 待执行的 blur-hide 定时器 */
let pendingBlurTimer: ReturnType<typeof setTimeout> | null = null
const TOGGLE_DEBOUNCE_MS = 260
/** 呼出后保护期：show/app 激活/IME 会抢焦点，期内 blur 只回焦不收起 */
const SHOW_BLUR_GRACE_MS = 900

/**
 * PluginHost 注入的插件 view 联动布局回调（quick 窗高变化时同步 setBounds）。
 * 直接 import PluginHost 会形成模块环（Host → quickWindow → Host），故用注入。
 */
let relayoutQuickPlugins: (() => void) | null = null

/** PluginHost 启动时注入联动回调（幂等） */
export function setQuickPluginRelayout(fn: (() => void) | null): void {
  relayoutQuickPlugins = fn
}

/** mini 插件位于搜索条下方；保留一像素外边框，宽高取实际原生窗口。 */
export function getQuickPluginBounds(): Electron.Rectangle {
  const bounds = quickWindow && !quickWindow.isDestroyed()
    ? quickWindow.getContentBounds()
    : { width: currentTargetWidth, height: currentTargetHeight }
  return {
    x: QUICK_BORDER_WIDTH,
    y: QUICK_BAR_AREA_H,
    width: Math.max(0, bounds.width - QUICK_BORDER_WIDTH * 2),
    height: Math.max(0, bounds.height - QUICK_BAR_AREA_H - QUICK_BORDER_WIDTH)
  }
}

/** 把动画档位写入 Quick 文档根，供 CSS [data-anim] 分档 */
function pushAnimLevel(): void {
  const wc = quickWindow?.webContents
  if (!wc || wc.isDestroyed()) return
  const level = settingsStore.getAll().general.animationLevel || 'medium'
  if (level === lastPushedAnim) return
  lastPushedAnim = level
  const js = `document.documentElement.dataset.anim=${JSON.stringify(level)}`
  void wc.executeJavaScript(js).catch(() => undefined)
}

function loadQuickRenderer(win: BrowserWindow): void {
  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (devUrl) {
    void win.webContents.loadURL(`${devUrl}?surface=quick`)
  } else {
    void win.webContents.loadFile(join(app.getAppPath(), 'out', 'renderer', 'index.html'), {
      query: { surface: 'quick' }
    })
  }
}

/** 窗口不得越过当前屏幕工作区；小屏幕仍允许完整显示搜索栏。 */
function clampQuickSize(workArea: Electron.Rectangle): { width: number; height: number } {
  const maxWidth = Math.max(1, Math.min(QUICK_MAX_WIDTH, workArea.width - WORK_AREA_INSET * 2))
  const maxHeight = Math.max(1, Math.min(QUICK_MAX_HEIGHT, workArea.height - WORK_AREA_INSET * 2))
  return {
    width: Math.min(maxWidth, Math.max(Math.min(QUICK_MIN_WIDTH, maxWidth), currentTargetWidth)),
    height: Math.min(maxHeight, Math.max(Math.min(QUICK_MIN_HEIGHT, maxHeight), currentTargetHeight))
  }
}

/** 在光标所在显示器的上三分之一居中放置，较高内容向上避让屏幕边缘。 */
function positionOnCursorScreen(win: BrowserWindow): void {
  const { workArea } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  const size = clampQuickSize(workArea)
  const x = Math.round(workArea.x + (workArea.width - size.width) / 2)
  const y = Math.round(Math.max(workArea.y + WORK_AREA_INSET,
    Math.min(workArea.y + workArea.height * 0.22, workArea.y + workArea.height - size.height - WORK_AREA_INSET)))
  win.setBounds({ x, y, ...size })
}

/**
 * 一次性调整原生容器，视觉过渡由 renderer 按动画档位完成。
 * 避免透明 NSWindow 上逐帧 setBounds 引起合成闪烁/原生崩溃；隐藏时仅记住建议尺寸。
 */
export function setQuickContentSize(size: { width?: number; height?: number }): void {
  if (Number.isFinite(size.width) && size.width! > 0) currentTargetWidth = Math.round(size.width!)
  if (Number.isFinite(size.height) && size.height! > 0) currentTargetHeight = Math.round(size.height!)
  const win = quickWindow
  if (!win || win.isDestroyed() || !win.isVisible()) return
  const bounds = win.getBounds()
  const { workArea } = screen.getDisplayMatching(bounds)
  const target = clampQuickSize(workArea)
  if (bounds.width === target.width && bounds.height === target.height) return
  const x = Math.round(Math.max(workArea.x + WORK_AREA_INSET, Math.min(
    bounds.x + (bounds.width - target.width) / 2,
    workArea.x + workArea.width - target.width - WORK_AREA_INSET)))
  const y = Math.round(Math.max(workArea.y + WORK_AREA_INSET, Math.min(
    bounds.y, workArea.y + workArea.height - target.height - WORK_AREA_INSET)))
  try {
    win.setBounds({ x, y, ...target })
    relayoutQuickPlugins?.()
  } catch (err) {
    logError('quick', `resize failed: ${(err as Error).message}`)
  }
}

export function setQuickContentHeight(height: number, _animate?: boolean): void {
  // _animate：旧调用兼容；原生尺寸一次对齐，动效由 renderer 承担。
  if (!Number.isFinite(height) || height <= 0) return
  setQuickContentSize({ height })
}

/** show 后再对齐子视图，兼容跨显示器和隐藏期间的插件尺寸更新。 */
export function applyQuickHeightAfterShow(): void {
  const win = quickWindow
  if (!win || win.isDestroyed() || !win.isVisible()) return
  setQuickContentSize({})
  relayoutQuickPlugins?.()
}

export function getQuickWindow(): BrowserWindow | null {
  return quickWindow
}

export function getQuickWebContents() {
  return quickWindow?.webContents ?? null
}

// Quick 表面事件转发：sendShellEvent 对 quick-plugin-mode 额外投递到 Quick wc
//（独立 WebContents / 独立 ipcRenderer，主壳事件不会自动到达）。模块加载即注册。
setQuickEventSink((payload) => {
  const wc = quickWindow?.webContents
  if (!wc || wc.isDestroyed()) return
  wc.send(IpcChannels.ShellEvent, payload)
})

export function isQuickVisible(): boolean {
  return !!quickWindow && !quickWindow.isDestroyed() && quickWindow.isVisible()
}

/** 确保窗口存在；启动时可预创建（隐藏），热键只 show */
export function ensureQuickWindow(): BrowserWindow {
  if (quickWindow && !quickWindow.isDestroyed()) return quickWindow
  // 插件 logo 等 enest:// 资源需在 shell 分区可用
  ensureShellSessionProtocol()

  logInfo('quick', 'ensureQuickWindow: creating BrowserWindow')
  const win = new BrowserWindow({
    width: QUICK_WIDTH,
    height: QUICK_MIN_HEIGHT,
    show: false,
    frame: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    transparent: true,
    hasShadow: true,
    // 圆角仅由 CSS 表面绘制；窗口和主 renderer 都保持透明，不叠加不透明 View 底板。
    roundedCorners: false,
    backgroundColor: '#00000000',
    title: 'eNest Quick',
    webPreferences: {
      preload: resolvePreload('shellPreload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      partition: SHELL_PARTITION,
      backgroundThrottling: false
    }
  })
  logInfo('quick', 'ensureQuickWindow: BrowserWindow ok (renderer lazy)')

  if (process.platform === 'darwin') {
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  }
  try {
    win.setAlwaysOnTop(true, 'floating')
  } catch {
    win.setAlwaysOnTop(true)
  }

  win.on('resize', () => {
    try {
      if (!quickWindow || quickWindow.isDestroyed()) return
      relayoutQuickPlugins?.()
    } catch (err) {
      logError('quick', `resize handler: ${(err as Error).message}`)
    }
  })

  win.webContents.on('render-process-gone', (_e, details) => {
    logError('quick', `render-process-gone: ${details.reason} exitCode=${details.exitCode}`)
  })

  win.webContents.on('did-finish-load', () => {
    lastPushedAnim = ''
    pushAnimLevel()
  })

  win.on('blur', () => {
    try {
      if (!quickWindow || quickWindow.isDestroyed()) return
      if (pendingBlurTimer) {
        clearTimeout(pendingBlurTimer)
        pendingBlurTimer = null
      }
      pendingBlurTimer = setTimeout(() => {
        try {
          pendingBlurTimer = null
          if (!quickWindow || quickWindow.isDestroyed()) return
          if (!quickWindow.isVisible()) return
          if (Date.now() < blurGuardUntil) {
            try {
              quickWindow.focus()
            } catch {
              /* ignore */
            }
            const wc = quickWindow?.webContents
            if (wc && !wc.isDestroyed()) wc.focus()
            return
          }
          if (quickWindow.isFocused()) return
          if (quickWindow.webContents.isDevToolsOpened()) return
          logInfo(
            'quick',
            `blur → hide visible=${quickWindow.isVisible()} focused=${quickWindow.isFocused()}`
          )
          quickWindow.hide()
          quickPluginHiddenHook?.()
        } catch (err) {
          logError('quick', `blur-hide failed: ${(err as Error).message}`)
        }
      }, 160)
    } catch (err) {
      logError('quick', `blur handler: ${(err as Error).message}`)
    }
  })

  win.on('closed', () => {
    if (pendingBlurTimer) clearTimeout(pendingBlurTimer)
    pendingBlurTimer = null
    quickWindow = null
    lastPushedAnim = ''
  })

  quickWindow = win
  return win
}

/** 把 Quick 窗前置并拿到键盘焦点。
 * 注意：不要在 show 前 app.focus——会先把主窗设成 key window，quick 立刻 blur 被收起。 */
function presentAndFocus(win: BrowserWindow): void {
  blurGuardUntil = Date.now() + SHOW_BLUR_GRACE_MS
  if (pendingBlurTimer) {
    clearTimeout(pendingBlurTimer)
    pendingBlurTimer = null
  }

  const step = (name: string, fn: () => void): void => {
    try {
      fn()
    } catch (err) {
      logError('quick', `present.${name} failed: ${(err as Error).stack || String(err)}`)
    }
  }

  step('position', () => positionOnCursorScreen(win))
  step('show', () => win.show())
  step('moveTop', () => win.moveTop())
  // 注：不要在 show 后立刻 setAlwaysOnTop(level)——macOS 26/27 对刚显示的透明窗重设
  // level 会触发原生崩溃（SIGTRAP 无 JS 日志）；创建时已设 alwaysOnTop，无需重申。
  step('focusWin', () => win.focus())
  step('focusWc', () => {
    const wc = quickWindow?.webContents
    if (wc && !wc.isDestroyed()) wc.focus()
  })
  logInfo('quick', `present done visible=${win.isVisible()} bounds=${JSON.stringify(win.getBounds())}`)

  // macOS：app 激活时主窗可能抢 key，保护期内重试把焦点钉回 Quick
  const retryWin = win
  const retryFocus = (tag: string): void => {
    try {
      if (!quickWindow || quickWindow.isDestroyed() || quickWindow !== retryWin) return
      if (!quickWindow.isVisible()) return
      if (quickWindow.isFocused()) return
      if (Date.now() > blurGuardUntil) return
      retryWin.focus()
      const w = quickWindow?.webContents
      if (w && !w.isDestroyed()) w.focus()
      logInfo('quick', `refocus after show (${tag})`)
    } catch (err) {
      logError('quick', `refocus failed (${tag}): ${(err as Error).message}`)
    }
  }
  setTimeout(() => retryFocus('90ms'), 90)
  setTimeout(() => retryFocus('280ms'), 280)
}

export function showQuickWindow(): void {
  logInfo('quick', 'showQuickWindow enter')
  try {
    const win = ensureQuickWindow()
    logInfo('quick', `ensureQuickWindow ok destroyed=${win.isDestroyed()}`)
    // 每次呼出都从空搜索栏开始；搜索结果与插件只在用户操作后展开。
    quickPluginResetHook?.()
    currentTargetHeight = QUICK_MIN_HEIGHT
    currentTargetWidth = QUICK_WIDTH
    const wc = quickWindow?.webContents
    const afterPresent = (): void => {
      try {
        if (!wc || wc.isDestroyed()) return
        wc.focus()
        wc.send(IpcChannels.QuickShown)
        pushAnimLevel()
        logInfo('quick', 'afterPresent ok')
      } catch (err) {
        logError('quick', `afterPresent failed: ${(err as Error).stack || String(err)}`)
      }
    }

    // 首次 show 才 load 渲染层
    if (wc && !wc.isDestroyed() && !wc.isLoadingMainFrame() && wc.getURL() && wc.getURL() !== 'about:blank') {
      presentAndFocus(win)
      afterPresent()
      applyQuickHeightAfterShow()
      logInfo('quick', `show (ready) bounds=${JSON.stringify(win.getBounds())}`)
    } else if (wc && !wc.isDestroyed()) {
      try {
        if (!wc.getURL() || wc.getURL() === 'about:blank') {
          logInfo('quick', 'show: loading renderer first time')
          loadQuickRenderer(win)
        }
      } catch (err) {
        logError('quick', `loadQuickRenderer failed: ${(err as Error).message}`)
      }
      // 首帧文档就绪再显示，避免首次唤出时出现透明空窗。
      wc.once('did-finish-load', () => {
        try {
          if (!quickWindow || quickWindow.isDestroyed()) return
          presentAndFocus(win)
          afterPresent()
          applyQuickHeightAfterShow()
          logInfo('quick', 'show (after load)')
        } catch (err) {
          logError('quick', `show-after-load failed: ${(err as Error).stack || String(err)}`)
        }
      })
    } else {
      presentAndFocus(win)
      applyQuickHeightAfterShow()
      logInfo('quick', 'show (no wc)')
    }
  } catch (err) {
    const stack = (err as Error).stack || String(err)
    logError('quick', `show failed: ${stack}`)
    console.error('[quick] show failed:', stack)
    try {
      destroyQuickWindow()
    } catch {
      /* ignore */
    }
  }
}

/**
 * PluginHost 注入的「呼出前重置」回调：隐藏原生插件视图并回到空搜索态。
 * 插件进程与主动上报的尺寸仍保留，再次显式打开时复用。
 */
let quickPluginResetHook: (() => void) | null = null

/** PluginHost 启动时注入重置回调；传 null 清除 */
export function setQuickPluginResetHook(fn: (() => void) | null): void {
  quickPluginResetHook = fn
}

/**
 * PluginHost 注入的「小窗隐藏」回调：挂载中的插件退 background + 休眠计时。
 * 注入而非直接 import，避免模块环。
 */
let quickPluginHiddenHook: (() => void) | null = null

/** PluginHost 注入小窗隐藏回调；传 null 清除 */
export function setQuickPluginHiddenHook(fn: (() => void) | null): void {
  quickPluginHiddenHook = fn
}

export function hideQuickWindow(reason = 'explicit'): void {
  if (quickWindow && !quickWindow.isDestroyed() && quickWindow.isVisible()) {
    logInfo(
      `quick`,
      `hide (${reason}) focused=${quickWindow.isFocused()} bounds=${JSON.stringify(quickWindow.getBounds())}`
    )
    quickWindow.hide()
    quickPluginHiddenHook?.()
  }
}

export function toggleQuickWindow(): void {
  try {
    const now = Date.now()
    if (now - lastToggleAt < TOGGLE_DEBOUNCE_MS) {
      logInfo('quick', `toggle debounce (${now - lastToggleAt}ms) visible=${isQuickVisible()}`)
      return
    }
    lastToggleAt = now

    const win = quickWindow
    if (win && !win.isDestroyed() && win.isVisible()) {
      if (!win.isFocused()) {
        logInfo('quick', 'toggle: visible but unfocused → refocus')
        showQuickWindow()
        return
      }
      hideQuickWindow('toggle')
      return
    }
    showQuickWindow()
  } catch (err) {
    const stack = (err as Error).stack || String(err)
    logError('quick', `toggle threw: ${stack}`)
    console.error('[quick] toggle threw:', stack)
  }
}

export function destroyQuickWindow(): void {
  if (pendingBlurTimer) {
    clearTimeout(pendingBlurTimer)
    pendingBlurTimer = null
  }
  if (quickWindow && !quickWindow.isDestroyed()) {
    quickWindow.destroy()
  }
  quickWindow = null
}
