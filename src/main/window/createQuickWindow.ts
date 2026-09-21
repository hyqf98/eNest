/**
 * createQuickWindow — 快捷启动独立小窗
 * 职责：创建/销毁无边框置顶 Quick BaseWindow，挂载 shellPreload 的 WebContentsView，
 * 提供 toggle/hide/show 与居中定位；失焦自动隐藏。
 * 兼任 mini 插件容器：提供 getQuickPluginBounds（插件 view 铺输入条以下区域），
 * 窗高 tween / resize 每帧联动 relayoutQuickPlugins（PluginHost 注入，避免循环依赖）。
 * 被 index.ts / quickHotkey / quickHandlers / PluginHost 调用。
 * 关键依赖：resolvePreload、settingsStore（主题）、logService。
 */
import { join } from 'node:path'
import {
  app,
  BaseWindow,
  screen,
  WebContentsView
} from 'electron'
import {
  QUICK_BAR_AREA_H,
  QUICK_MAX_HEIGHT,
  QUICK_MIN_HEIGHT,
  QUICK_WIDTH,
  SHELL_PARTITION
} from '@shared/constants'
import { IpcChannels } from '@shared/types/ipc'
import { ensureShellSessionProtocol } from '../plugin/pluginProtocol'
import { logError, logInfo } from '../logs/logService'
import { settingsStore } from '../settings/SettingsStore'
import { resolvePreload, setQuickEventSink } from './createShellWindow'

let quickWindow: BaseWindow | null = null
let quickView: WebContentsView | null = null
let lastPushedAnim = ''
let heightTween: ReturnType<typeof setInterval> | null = null
let currentTargetHeight = QUICK_MIN_HEIGHT
/** 呼出时刻 */
let lastShowAt = 0
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

/**
 * mini 插件在 Quick 小窗的内容边界：
 * x=0、y=输入条区域高（渲染层顶栏 QUICK_BAR_AREA_H）、宽=窗宽、高=窗高-输入条。
 * 窗高不足时保底 0（view 隐藏场景由 PluginHost 控制）。
 */
export function getQuickPluginBounds(): Electron.Rectangle {
  const h = quickWindow && !quickWindow.isDestroyed() ? quickWindow.getBounds().height : QUICK_MIN_HEIGHT
  return {
    x: 0,
    y: QUICK_BAR_AREA_H,
    width: QUICK_WIDTH,
    height: Math.max(0, h - QUICK_BAR_AREA_H)
  }
}

/** 把动画档位写入 Quick 文档根，供 CSS [data-anim] 分档 */
function pushAnimLevel(): void {
  const wc = quickView?.webContents
  if (!wc || wc.isDestroyed()) return
  const level = settingsStore.getAll().general.animationLevel || 'medium'
  if (level === lastPushedAnim) return
  lastPushedAnim = level
  const js = `document.documentElement.dataset.anim=${JSON.stringify(level)}`
  void wc.executeJavaScript(js).catch(() => undefined)
}

function loadQuickRenderer(view: WebContentsView): void {
  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (process.env.QUICK_NOIMG === '1' && process.env.ELECTRON_RENDERER_URL) {
    void view.webContents.loadURL(`${process.env.ELECTRON_RENDERER_URL}?surface=quick&noimg=1`)
  } else if (devUrl) {
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

/** 在光标所在显示器的上三分之一居中放置；高度用当前目标高度 */
function positionOnCursorScreen(win: BaseWindow): void {
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  const wa = display.workArea
  const height = currentTargetHeight
  const x = Math.round(wa.x + (wa.width - QUICK_WIDTH) / 2)
  const y = Math.round(wa.y + wa.height * 0.22)
  win.setBounds({ x, y, width: QUICK_WIDTH, height })
}

/**
 * 按内容高度调整小窗（收起/撑开）。
 * - 窗口不可见时只记录目标高，不 setBounds/tween（隐藏透明 BaseWindow 上反复
 *   setBounds 会在 Electron 上原生崩溃，表现为整包退出且无 JS 日志）
 * - 可见时默认无动画直接对齐，避免 setInterval tween 与合成层冲突
 */
function getExpandDurationMs(): number {
  const level = settingsStore.getAll().general.animationLevel || 'medium'
  if (level === 'low') return 0
  if (level === 'high') return 360
  return 280
}

export function setQuickContentHeight(height: number, animate = true): void {
  const win = quickWindow
  if (!win || win.isDestroyed()) return
  const target = Math.round(Math.min(QUICK_MAX_HEIGHT, Math.max(QUICK_MIN_HEIGHT, height)))
  currentTargetHeight = target

  // 隐藏态：只记高度，show 时再一次性对齐
  if (!win.isVisible()) {
    logInfo('quick', `resize deferred (hidden) target=${target}`)
    return
  }

  const b = win.getBounds()
  const from = b.height
  if (Math.abs(from - target) <= 1) {
    if (heightTween) {
      clearInterval(heightTween)
      heightTween = null
    }
    return
  }
  if (heightTween) {
    clearInterval(heightTween)
    heightTween = null
  }

  // 默认无动画：透明窗 + 快速 setBounds tween 曾导致进程原生退出
  const duration = animate ? getExpandDurationMs() : 0
  const applyOnce = (h: number): void => {
    try {
      const cur = win.getBounds()
      win.setBounds({ x: cur.x, y: cur.y, width: cur.width, height: h })
      relayoutQuickPlugins?.()
    } catch (err) {
      logError('quick', `setBounds failed h=${h}: ${(err as Error).message}`)
    }
  }

  logInfo('quick', `resize apply ${from} → ${target} animate=${duration > 0}`)
  if (duration <= 0) {
    applyOnce(target)
    logInfo('quick', `resize done bounds=${JSON.stringify(win.getBounds())}`)
    return
  }

  const start = Date.now()
  heightTween = setInterval(() => {
    if (!quickWindow || quickWindow.isDestroyed() || !quickWindow.isVisible()) {
      if (heightTween) clearInterval(heightTween)
      heightTween = null
      return
    }
    const t = Math.min(1, (Date.now() - start) / duration)
    const e = 1 - Math.pow(1 - t, 3)
    applyOnce(Math.round(from + (target - from) * e))
    if (t >= 1) {
      if (heightTween) clearInterval(heightTween)
      heightTween = null
    }
  }, 16)
}

/** show 之后按 currentTargetHeight 无动画对齐窗高 */
export function applyQuickHeightAfterShow(): void {
  const win = quickWindow
  if (!win || win.isDestroyed() || !win.isVisible()) return
  setQuickContentHeight(currentTargetHeight, false)
}

export function getQuickWindow(): BaseWindow | null {
  return quickWindow
}

export function getQuickWebContents() {
  return quickView?.webContents ?? null
}

// Quick 表面事件转发：sendShellEvent 对 quick-plugin-mode 额外投递到 Quick wc
//（独立 WebContents / 独立 ipcRenderer，主壳事件不会自动到达）。模块加载即注册。
setQuickEventSink((payload) => {
  const wc = quickView?.webContents
  if (!wc || wc.isDestroyed()) return
  wc.send(IpcChannels.ShellEvent, payload)
})

export function isQuickVisible(): boolean {
  return !!quickWindow && !quickWindow.isDestroyed() && quickWindow.isVisible()
}

/** 确保窗口存在；启动时可预创建（隐藏），热键只 show */
export function ensureQuickWindow(): BaseWindow {
  if (quickWindow && !quickWindow.isDestroyed()) return quickWindow
  // 插件 logo 等 enest:// 资源需在 shell 分区可用
  ensureShellSessionProtocol()

  logInfo('quick', 'ensureQuickWindow: creating BaseWindow')
  let win: BaseWindow
  try {
    win = new BaseWindow({
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
      // 真透明：roundedCorners 会在 macOS 上合成出灰底圆角矩形，必须关掉
      transparent: true,
      hasShadow: false,
      roundedCorners: false,
      backgroundColor: '#00000000',
      title: 'eNest Quick'
    })
  } catch (err) {
    logError('quick', `BaseWindow transparent failed, fallback opaque: ${(err as Error).message}`)
    win = new BaseWindow({
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
      backgroundColor: '#ffffff',
      title: 'eNest Quick'
    })
  }
  logInfo('quick', 'ensureQuickWindow: BaseWindow ok')

  if (process.platform === 'darwin') {
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  }
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
  const applyTransparentView = (): void => {
    try {
      view.setBackgroundColor('#00000000')
    } catch {
      /* 部分平台忽略 */
    }
  }
  applyTransparentView()

  win.contentView.addChildView(view)
  applyQuickBounds(win, view)
  // 渲染层延后到首次 show 再 load
  logInfo('quick', 'ensureQuickWindow: view attached (renderer lazy)')

  win.on('resize', () => {
    try {
      if (!quickWindow || !quickView) return
      applyQuickBounds(quickWindow, quickView)
      relayoutQuickPlugins?.()
    } catch (err) {
      logError('quick', `resize handler: ${(err as Error).message}`)
    }
  })

  view.webContents.on('render-process-gone', (_e, details) => {
    logError('quick', `render-process-gone: ${details.reason} exitCode=${details.exitCode}`)
  })

  view.webContents.on('did-finish-load', () => {
    lastPushedAnim = ''
    pushAnimLevel()
    applyTransparentView()
    void view.webContents
      .insertCSS(
        [
          'html,body,#root{background:transparent!important;background-color:transparent!important;}',
          'html,body{border-radius:0!important;box-shadow:none!important;}',
          'body::before,body::after{display:none!important;}'
        ].join('')
      )
      .catch(() => undefined)
  })

  // dev 模式：HMR 推不到常驻的 WebContentsView（独立页面、非主窗），改为主进程
  // 轮询 dev server 的 quick.css 版本指纹，变化即整页 reload（忽略缓存）。
  // 注意 vite 源码路径需带 /@fs 前缀，否则 SPA fallback 返回 index.html。
  if (process.env.ELECTRON_RENDERER_URL) {
    let lastFingerprint = ''
    const cssUrl = `${process.env.ELECTRON_RENDERER_URL}/@fs${join(app.getAppPath(), 'src/renderer/components/quick.css')}?direct`
    const pollTimer = setInterval(() => {
      const wc = quickView?.webContents
      if (!wc || wc.isDestroyed() || !quickWindow || quickWindow.isDestroyed()) return
      const url = wc.getURL()
      // 只在 dev URL（http）时轮询；file:// 构建版无 HMR 需求
      if (!url.startsWith('http')) return
      void fetch(`${cssUrl}&t=${Date.now()}`)
        .then((r) => r.text())
        .then((css) => {
          // vite fallback 会给 HTML；指纹对 CSS-only 内容取长度+首尾片段
          if (css.startsWith('<!DOCTYPE') || css.startsWith('<')) return
          const fp = `${css.length}:${css.slice(0, 64)}:${css.slice(-64)}`
          if (!lastFingerprint) {
            lastFingerprint = fp
            return
          }
          if (fp !== lastFingerprint) {
            lastFingerprint = fp
            logInfo('quick', 'dev css changed → reload quick renderer')
            try {
              wc.reloadIgnoringCache()
            } catch {
              /* ignore */
            }
          }
        })
        .catch(() => undefined)
    }, 2000)
    // 进程退出清理
    app.on('will-quit', () => clearInterval(pollTimer))
  }

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
            const wc = quickView?.webContents
            if (wc && !wc.isDestroyed()) wc.focus()
            return
          }
          if (quickWindow.isFocused()) return
          if (quickView?.webContents.isDevToolsOpened()) return
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
    quickWindow = null
    quickView = null
  })

  quickWindow = win
  quickView = view
  return win
}

/** 把 Quick 窗前置并拿到键盘焦点。
 * 注意：不要在 show 前 app.focus——会先把主窗设成 key window，quick 立刻 blur 被收起。 */
function presentAndFocus(win: BaseWindow): void {
  lastShowAt = Date.now()
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
    const wc = quickView?.webContents
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
      const w = quickView?.webContents
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
    const mountedHeight = quickPluginRestoreHook?.() ?? null
    currentTargetHeight = mountedHeight ?? QUICK_MIN_HEIGHT
    const wc = quickView?.webContents
    const afterPresent = (): void => {
      try {
        if (!wc || wc.isDestroyed()) return
        try {
          quickView?.setBackgroundColor('#00000000')
        } catch {
          /* ignore */
        }
        wc.focus()
        wc.send(IpcChannels.QuickShown)
        // 渲染层 effect 可能晚于 did-finish-load 才挂 onQuickShown，补推一次
        setTimeout(() => {
          try {
            const w = quickView?.webContents
            if (w && !w.isDestroyed()) w.send(IpcChannels.QuickShown)
          } catch {
            /* ignore */
          }
        }, 120)
        pushAnimLevel()
        if (mountedHeight !== null) {
          relayoutQuickPlugins?.()
        }
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
          loadQuickRenderer(quickView!)
        }
      } catch (err) {
        logError('quick', `loadQuickRenderer failed: ${(err as Error).message}`)
      }
      presentAndFocus(win)
      wc.once('did-finish-load', () => {
        try {
          if (!quickWindow || quickWindow.isDestroyed()) return
          presentAndFocus(win)
          afterPresent()
          applyQuickHeightAfterShow()
          if (mountedHeight !== null) quickPluginRestoreHook?.()
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
 * PluginHost 注入的「呼出时恢复插件挂载」回调：
 * 有挂载中的 quick 插件时重推 quick-plugin-mode 并返回目标窗高；否则返回 null（列表态）。
 * 注入的闭包读取 PluginHost 实时状态，本模块只消费返回值。
 */
let quickPluginRestoreHook: (() => number | null) | null = null

/** PluginHost 启动时注入恢复回调；传 null 清除 */
export function setQuickPluginRestoreHook(fn: (() => number | null) | null): void {
  quickPluginRestoreHook = fn
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
        presentAndFocus(win)
        const wc = quickView?.webContents
        if (wc && !wc.isDestroyed()) {
          wc.focus()
          wc.send(IpcChannels.QuickShown)
        }
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
  if (heightTween) {
    clearInterval(heightTween)
    heightTween = null
  }
  if (pendingBlurTimer) {
    clearTimeout(pendingBlurTimer)
    pendingBlurTimer = null
  }
  if (quickWindow && !quickWindow.isDestroyed()) {
    quickWindow.destroy()
  }
  quickWindow = null
  quickView = null
}
