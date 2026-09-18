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
import { logError } from '../logs/logService'
import { settingsStore } from '../settings/SettingsStore'
import { resolvePreload, setQuickEventSink } from './createShellWindow'

let quickWindow: BaseWindow | null = null
let quickView: WebContentsView | null = null
let lastPushedAnim = ''
let heightTween: ReturnType<typeof setInterval> | null = null
let currentTargetHeight = QUICK_MIN_HEIGHT

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
 * animate=false 立即设置；否则短 tween，避免生硬跳变。
 * 每次实际高度变化都会联动 relayoutQuickPlugins（插件 view bounds 跟随窗高）。
 */
export function setQuickContentHeight(height: number, animate = true): void {
  const win = quickWindow
  if (!win || win.isDestroyed()) return
  const target = Math.round(Math.min(QUICK_MAX_HEIGHT, Math.max(QUICK_MIN_HEIGHT, height)))
  currentTargetHeight = target
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
  if (!animate) {
    win.setBounds({ x: b.x, y: b.y, width: b.width, height: target })
    relayoutQuickPlugins?.()
    return
  }
  const duration = 180
  const start = Date.now()
  heightTween = setInterval(() => {
    if (!quickWindow || quickWindow.isDestroyed()) {
      if (heightTween) clearInterval(heightTween)
      heightTween = null
      return
    }
    const t = Math.min(1, (Date.now() - start) / duration)
    // ease-out cubic
    const e = 1 - Math.pow(1 - t, 3)
    const h = Math.round(from + (target - from) * e)
    const cur = quickWindow.getBounds()
    quickWindow.setBounds({ x: cur.x, y: cur.y, width: cur.width, height: h })
    // 插件 view bounds 随 tween 每帧联动（内容超出时插件内部滚动，view 高度恒贴窗底）
    relayoutQuickPlugins?.()
    if (t >= 1) {
      if (heightTween) clearInterval(heightTween)
      heightTween = null
    }
  }, 16)
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

/** 确保窗口存在；首次创建后隐藏等待呼出 */
export function ensureQuickWindow(): BaseWindow {
  if (quickWindow && !quickWindow.isDestroyed()) return quickWindow
  // 插件 logo 等 enest:// 资源需在 shell 分区可用
  ensureShellSessionProtocol()

  const win = new BaseWindow({
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
  // 视图本身也透明，避免 WebContents 默认白底
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
  loadQuickRenderer(view)

  win.on('resize', () => {
    if (!quickWindow || !quickView) return
    applyQuickBounds(quickWindow, quickView)
    // 插件 view bounds 跟随（系统级 resize 与程序 setBounds 均触发）
    relayoutQuickPlugins?.()
  })

  view.webContents.on('did-finish-load', () => {
    lastPushedAnim = ''
    pushAnimLevel()
    applyTransparentView()
    // 强制页面底透明，压过 base.css / 主题水合写入的 --bg
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

  // 失焦隐藏：命令面交互完自动收起，不销毁进程
  win.on('blur', () => {
    if (!quickWindow || quickWindow.isDestroyed()) return
    // 录制快捷键或 DevTools 时可能瞬时 blur，延迟判断仍失焦则 hide
    setTimeout(() => {
      if (!quickWindow || quickWindow.isDestroyed()) return
      if (!quickWindow.isFocused() && !quickView?.webContents.isDevToolsOpened()) {
        quickWindow.hide()
        // 与 hideQuickWindow 同语义：挂载插件退 background + 休眠计时
        quickPluginHiddenHook?.()
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
  try {
    const win = ensureQuickWindow()
    // 挂载中的插件：恢复插件态高度并重推模式事件；无则列表态胶囊
    const mountedHeight = quickPluginRestoreHook?.() ?? null
    currentTargetHeight = mountedHeight ?? QUICK_MIN_HEIGHT
    positionOnCursorScreen(win)
    const wc = quickView?.webContents
    const focusSearch = (): void => {
      if (!wc || wc.isDestroyed()) return
      // 每次呼出再压一次视图底色，避免合成层残留灰底
      try {
        quickView?.setBackgroundColor('#00000000')
      } catch {
        /* ignore */
      }
      wc.focus()
      wc.send(IpcChannels.QuickShown)
      pushAnimLevel()
      if (mountedHeight !== null) {
        // 插件 view bounds 对齐恢复后的窗高
        relayoutQuickPlugins?.()
      }
    }
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
        // 冷启动竞态兜底：restore hook 在页面 load 完成前就把 quick-plugin-mode
        // 发给了本 wc（渲染层尚未挂监听而丢事件）——load 完成后重推一次（幂等）
        if (mountedHeight !== null) quickPluginRestoreHook?.()
      })
      win.show()
    } else {
      win.show()
      win.focus()
    }
  } catch (err) {
    // 透明窗创建失败时清理，下次热键可重试
    logError('quick', `show failed: ${(err as Error).message}`)
    destroyQuickWindow()
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

export function hideQuickWindow(): void {
  if (quickWindow && !quickWindow.isDestroyed() && quickWindow.isVisible()) {
    quickWindow.hide()
    // 插件态：隐藏 ≠ 关闭——退 background 计休眠，view 留在（已不可见的）contentView 上
    quickPluginHiddenHook?.()
  }
}

export function toggleQuickWindow(): void {
  if (isQuickVisible()) hideQuickWindow()
  else showQuickWindow()
}

export function destroyQuickWindow(): void {
  if (heightTween) {
    clearInterval(heightTween)
    heightTween = null
  }
  if (quickWindow && !quickWindow.isDestroyed()) {
    quickWindow.destroy()
  }
  quickWindow = null
  quickView = null
}
