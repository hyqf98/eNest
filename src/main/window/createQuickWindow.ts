import { pathToFileURL } from 'node:url'
import { registerTrustedSurface } from '@main/ipc/ipcSecurity'
/**
 * createQuickWindow — 快捷启动独立小窗
 * 职责：创建/销毁无边框置顶 Quick BaseWindow，由透明主 renderer 绘制圆角表面，
 * 提供 toggle/hide/show 与居中定位；失焦自动隐藏。
 * 兼任 mini 插件容器：提供 getQuickPluginBounds（插件 view 铺输入条以下区域），
 * 尺寸变更联动 relayoutQuickPlugins（PluginHost 注入，避免循环依赖）。
 * 被 index.ts / quickHotkey / quickHandlers / PluginHost 调用。
 * 关键依赖：resolvePreload、logService；外观由 renderer 的权威快照同步。
 */
import { capturePasteTarget } from '@main/clipboard/nativeClipboard'
import { clearQuickInputContext } from '@main/launcher/quickInputContext'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { app, BaseWindow, screen, View, WebContentsView } from 'electron'
import {
  QUICK_BAR_AREA_H,
  QUICK_BORDER_WIDTH,
  QUICK_CORNER_RADIUS,
  QUICK_HEIGHT,
  QUICK_HOME_HEIGHT,
  QUICK_WIDTH,
  SHELL_PARTITION
} from '@shared/constants'
import { IpcChannels } from '@shared/types/ipc'
import { ensureShellSessionProtocol } from '@main/plugin/pluginProtocol'
import { registerQuickThemeWebContentsPolicy } from '@main/theme/quickThemeProtocol'
import { logError, logInfo } from '@main/logs/logService'
import { getMainWindow, keepDockIconVisible, resolvePreload, setQuickEventSink } from './createShellWindow'
import { resolveWindowIcon } from './applicationIcon'

/** Explicit shell view lets one native surface clip shell and plugin together. */
class QuickWindow extends BaseWindow {
  readonly shellView: WebContentsView
  readonly webContents: Electron.WebContents

  constructor() {
    super({
      icon: resolveWindowIcon(),
      width: QUICK_WIDTH, height: QUICK_HOME_HEIGHT, show: false, frame: false,
      resizable: false, maximizable: false, minimizable: false, fullscreenable: false,
      skipTaskbar: true, alwaysOnTop: true, transparent: true,
      // Windows 的 DWM 阴影会在透明窗口的圆角内侧留下灰色填充（白底背景上形成灰角）；
      // 圆角表面改由 CSS 内描边表现，macOS 保留系统阴影。
      hasShadow: process.platform === 'darwin',
      roundedCorners: false, backgroundColor: '#00000000', title: 'eNest Quick'
    })
    // 双保险：即使构造选项被忽略，也在创建后显式关闭 Windows 阴影。
    if (process.platform !== 'darwin') {
      try { this.setHasShadow(false) } catch { /* 旧版本无此能力时忽略 */ }
    }
    this.shellView = new WebContentsView({ webPreferences: {
      preload: resolvePreload('quickPreload.js'), contextIsolation: true,
      nodeIntegration: false, sandbox: true, partition: SHELL_PARTITION,
      // 隐藏期间仍渲染：呼出时首帧就是已清空/已更新的界面，避免露出上一次的旧帧造成二次出现。
      backgroundThrottling: false
    } })
    this.shellView.setBackgroundColor('#00000000')
    this.webContents = this.shellView.webContents
    registerQuickThemeWebContentsPolicy(this.webContents, () =>
      !this.isDestroyed() && this.isVisible() && this.isFocused())
    // BaseWindow does not own/close WebContents automatically.
    this.once('closed', () => {
      if (!this.webContents.isDestroyed()) this.webContents.close({ waitForBeforeUnload: false })
    })
  }
}

let quickWindow: QuickWindow | null = null
let quickPluginSurface: View | null = null
const quickRendererUrls = new WeakMap<QuickWindow, string>()

/** 圆角矩形 → 原生窗口区域（每像素一条横向矩形带，四角平滑内收）。 */
function roundedShapeRects(width: number, height: number, radius: number): Electron.Rectangle[] {
  const r = Math.max(0, Math.min(Math.round(radius), Math.floor(Math.min(width, height) / 2)))
  if (r <= 0) return [{ x: 0, y: 0, width, height }]
  const rects: Electron.Rectangle[] = []
  if (height - 2 * r > 0) rects.push({ x: 0, y: r, width, height: height - 2 * r })
  for (let y = 0; y < r; y++) {
    const dy = r - y - 0.5
    const inset = Math.round(r - Math.sqrt(Math.max(0, r * r - dy * dy)))
    const stripWidth = width - inset * 2
    if (stripWidth <= 0) continue
    rects.push({ x: inset, y, width: stripWidth, height: 1 })
    rects.push({ x: inset, y: height - 1 - y, width: stripWidth, height: 1 })
  }
  return rects
}

/**
 * Windows：把原生窗口裁成与 CSS 外壳一致的圆角矩形。
 * 否则 DWM 阴影会透过 CSS 透明的四个角画在背景上——白底时就是一圈灰角。
 */
function applyQuickWindowShape(win: QuickWindow): void {
  if (process.platform !== 'win32') return
  try {
    const { width, height } = win.getContentBounds()
    win.setShape(roundedShapeRects(width, height, QUICK_CORNER_RADIUS))
  } catch { /* 旧版本或不支持的桌面组合忽略 */ }
}

/** One native outer contour; the plugin's own top edge must stay square. */
export function getQuickPluginParent(): View | null { return quickPluginSurface }

function layoutQuickContents(): void {
  if (!quickWindow || quickWindow.isDestroyed()) return
  const { width, height } = quickWindow.getContentBounds()
  applyQuickWindowShape(quickWindow)
  quickWindow.shellView.setBounds({ x: 0, y: 0, width, height })
  layoutQuickSurface()
}

function layoutQuickSurface(): void {
  if (!quickWindow || quickWindow.isDestroyed() || !quickPluginSurface) return
  const { width, height } = quickWindow.getContentBounds()
  // 搜索与插件始终共用完整表面，切换时不能从输入条高度重新裁切展开。
  quickPluginSurface.setBounds({ x: 0, y: 0, width, height })
}

export function finishQuickPluginReveal(): void {
  layoutQuickSurface()
}

let currentTargetHeight = QUICK_HOME_HEIGHT
const WORK_AREA_INSET = 16
/** blur 宽限截止：在此之前只抢焦点、不 hide */
let blurGuardUntil = 0
/** toggle 防抖 */
let lastToggleAt = 0
let showRevision = 0
let mainActivationGuardUntil = 0
/** 待执行的 blur-hide 定时器 */
let pendingBlurTimer: ReturnType<typeof setTimeout> | null = null
const TOGGLE_DEBOUNCE_MS = 260
/** 呼出后保护期：show/app 激活/IME 会抢焦点，期内 blur 只回焦不收起 */
const SHOW_BLUR_GRACE_MS = 900
const nativeInteractions = new Set<symbol>()

/** Native dialogs and drag sessions temporarily own focus; never steal it back. */
export function acquireQuickInteraction(): () => void {
  const token = Symbol('native-interaction')
  nativeInteractions.add(token)
  if (pendingBlurTimer) clearTimeout(pendingBlurTimer)
  pendingBlurTimer = null
  let released = false
  return () => {
    if (released) return
    released = true
    nativeInteractions.delete(token)
    if (nativeInteractions.size === 0) blurGuardUntil = Date.now() + 250
  }
}

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
    : { width: QUICK_WIDTH, height: currentTargetHeight }
  return {
    x: QUICK_BORDER_WIDTH,
    y: QUICK_BAR_AREA_H,
    width: Math.max(0, bounds.width - QUICK_BORDER_WIDTH * 2),
    height: Math.max(0, bounds.height - QUICK_BAR_AREA_H - QUICK_BORDER_WIDTH)
  }
}

function loadQuickRenderer(win: QuickWindow): void {
  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (devUrl) {
    const url = new URL('quick.html', devUrl.endsWith('/') ? devUrl : `${devUrl}/`)
    quickRendererUrls.set(win, url.href)
    registerTrustedSurface(win.webContents, 'quick', url.href)
    void win.webContents.loadURL(url.href).catch(error => logError('quick', `renderer load failed: ${String(error)}`))
  } else {
    const file = join(app.getAppPath(), 'out', 'renderer', 'quick.html')
    const url = pathToFileURL(file)
    quickRendererUrls.set(win, url.href)
    registerTrustedSurface(win.webContents, 'quick', pathToFileURL(file).href)
    void win.webContents.loadFile(file).catch(error => logError('quick', `renderer load failed: ${String(error)}`))
  }
}

function isQuickRendererReady(win: QuickWindow): boolean {
  const expected = quickRendererUrls.get(win)
  return !!expected && !win.webContents.isDestroyed() && !win.webContents.isLoadingMainFrame() && win.webContents.getURL() === expected
}

/** 窗口不得越过当前屏幕工作区；小屏幕仍允许完整显示搜索栏。 */
function clampQuickSize(workArea: Electron.Rectangle): { width: number; height: number } {
  return {
    width: Math.min(QUICK_WIDTH, Math.max(1, workArea.width - WORK_AREA_INSET * 2)),
    height: Math.min(currentTargetHeight, Math.max(1, workArea.height - WORK_AREA_INSET * 2))
  }
}

/** 在光标所在显示器的上三分之一居中放置，较高内容向上避让屏幕边缘。 */
function positionOnCursorScreen(win: QuickWindow): void {
  const { workArea } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  const size = clampQuickSize(workArea)
  const x = Math.round(workArea.x + (workArea.width - size.width) / 2)
  const y = Math.round(Math.max(workArea.y + WORK_AREA_INSET,
    Math.min(workArea.y + workArea.height * 0.22, workArea.y + workArea.height - size.height - WORK_AREA_INSET)))
  win.setBounds({ x, y, ...size })
}

/**
 * 壳决定高度：默认两行，搜索按内容伸缩，插件使用统一展开高度。
 * 宽度始终固定；插件 manifest 和 ui.resize 不参与这里的尺寸决策。
 */
export function setQuickContentSize(size: { width?: number; height?: number }): void {
  if (Number.isFinite(size.height) && size.height! > 0) {
    currentTargetHeight = Math.min(QUICK_HEIGHT, Math.max(QUICK_BAR_AREA_H + QUICK_BORDER_WIDTH, Math.round(size.height!)))
  }
  const win = quickWindow
  if (!win || win.isDestroyed() || !win.isVisible()) return
  const bounds = win.getBounds()
  const { workArea } = screen.getDisplayMatching(bounds)
  const target = clampQuickSize(workArea)
  const x = Math.round(Math.max(workArea.x + WORK_AREA_INSET, Math.min(
    bounds.x + (bounds.width - target.width) / 2,
    workArea.x + workArea.width - target.width - WORK_AREA_INSET)))
  const y = Math.round(Math.max(workArea.y + WORK_AREA_INSET, Math.min(
    bounds.y, workArea.y + workArea.height - target.height - WORK_AREA_INSET)))
  if (bounds.width === target.width && bounds.height === target.height && bounds.x === x && bounds.y === y) return
  try {
    win.setBounds({ x, y, ...target })
    layoutQuickContents()
    relayoutQuickPlugins?.()
  } catch (err) {
    logError('quick', `resize failed: ${(err as Error).message}`)
  }
}

export function setQuickContentHeight(height: number, _animate?: boolean): void {
  // 仅列表态接收 renderer 测量；quickHandlers 会拦截插件态的迟到请求。
  if (!Number.isFinite(height) || height <= 0) return
  setQuickContentSize({ height })
}

/** show 后再对齐子视图，兼容跨显示器工作区变化。 */
export function applyQuickHeightAfterShow(): void {
  const win = quickWindow
  if (!win || win.isDestroyed() || !win.isVisible()) return
  setQuickContentSize({})
  layoutQuickContents()
  relayoutQuickPlugins?.()
}

export function getQuickWindow(): QuickWindow | null {
  return quickWindow
}

export function getQuickWebContents() {
  return quickWindow?.webContents ?? null
}

// Quick 表面事件转发：sendShellEvent 对 quick-plugin-mode 额外投递到 Quick wc
//（独立 WebContents / 独立 ipcRenderer，主壳事件不会自动到达）。
// 本模块与 createShellWindow 经 PluginHost 等成环，环内模块体的先后顺序由打包器
// 决定；微任务在整个模块图求值后才执行，避免 sink 目标 let 处于 TDZ。
queueMicrotask(() => {
  setQuickEventSink((payload) => {
    const wc = quickWindow?.webContents
    if (!wc || wc.isDestroyed()) return
    wc.send(IpcChannels.ShellEvent, payload)
  })
})

export function isQuickVisible(): boolean {
  return !!quickWindow && !quickWindow.isDestroyed() && quickWindow.isVisible()
}

/** Native Quick focus changes are not requests to open the desktop window. */
export function shouldSuppressMainWindowActivation(): boolean {
  return isQuickVisible() || Date.now() < mainActivationGuardUntil
}

function guardMainWindowActivation(): void {
  mainActivationGuardUntil = Date.now() + SHOW_BLUR_GRACE_MS
}

/** 确保窗口存在；启动时可预创建（隐藏），热键只 show */
export function ensureQuickWindow(): QuickWindow {
  if (quickWindow && !quickWindow.isDestroyed()) return quickWindow
  // 插件 logo 等 enest:// 资源需在 shell 分区可用
  ensureShellSessionProtocol()

  logInfo('quick', 'ensureQuickWindow: creating BaseWindow')
  const win = new QuickWindow()
  // Force a compositor layer even though no blur is applied: without a layer,
  // View border paths do not reliably clip descendant WebContentsViews on macOS.
  const surface = new View()
  surface.setBackgroundBlur(0)
  surface.setBorderRadius(QUICK_CORNER_RADIUS)
  surface.addChildView(win.shellView)
  win.contentView.addChildView(surface)
  quickPluginSurface = surface
  logInfo('quick', 'ensureQuickWindow: BaseWindow ok (renderer lazy)')

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
      layoutQuickContents()
      relayoutQuickPlugins?.()
    } catch (err) {
      logError('quick', `resize handler: ${(err as Error).message}`)
    }
  })

  const fitWorkArea = (): void => setQuickContentSize({})
  screen.on('display-metrics-changed', fitWorkArea)
  screen.on('display-removed', fitWorkArea)

  win.webContents.on('render-process-gone', (_e, details) => {
    logError('quick', `render-process-gone: ${details.reason} exitCode=${details.exitCode}`)
  })

  win.on('blur', () => {
    try {
      if (quickWindow !== win || win.isDestroyed()) return
      const revision = showRevision
      if (pendingBlurTimer) {
        clearTimeout(pendingBlurTimer)
        pendingBlurTimer = null
      }
      pendingBlurTimer = setTimeout(() => {
        try {
          pendingBlurTimer = null
          if (revision !== showRevision || quickWindow !== win || win.isDestroyed()) return
          if (!quickWindow.isVisible()) return
          if (nativeInteractions.size > 0) return
          if (quickWindow.isFocused()) return
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
          if (quickWindow.webContents.isDevToolsOpened()) return
          logInfo(
            'quick',
            `blur → hide visible=${quickWindow.isVisible()} focused=${quickWindow.isFocused()}`
          )
          hideQuickWindow('blur')
        } catch (err) {
          logError('quick', `blur-hide failed: ${(err as Error).message}`)
        }
      }, 160)
    } catch (err) {
      logError('quick', `blur handler: ${(err as Error).message}`)
    }
  })

  win.on('close', () => quickPluginHiddenHook?.())
  win.on('closed', () => {
    screen.removeListener('display-metrics-changed', fitWorkArea)
    screen.removeListener('display-removed', fitWorkArea)
    quickPluginSurface = null
    if (pendingBlurTimer) clearTimeout(pendingBlurTimer)
    pendingBlurTimer = null
    quickWindow = null
    nativeInteractions.clear()
  })

  quickWindow = win
  layoutQuickContents()
  return win
}

/** 前置并聚焦 Quick；完整呈现时才定位和 show，复焦保留当前位置和尺寸。
 * 注意：不要在 show 前 app.focus——会先把主窗设成 key window，quick 立刻 blur 被收起。 */
function presentAndFocus(win: QuickWindow, options: { refocusOnly?: boolean; commit?: () => void } = {}): boolean {
  const revision = showRevision
  // Guard before show: macOS may activate the app before Quick reports visible.
  guardMainWindowActivation()
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

  if (!options.refocusOnly) {
    keepDockIconVisible()
    step('position', () => positionOnCursorScreen(win))
    // Windows：先无激活显示再单独 focus，避开 show() 自带的激活动画/首次合成，
    // 否则透明窗口会先以未合成帧出现一次再正确显示（一次呼出看起来出现两次）。
    step('show', () => process.platform === 'win32' ? win.showInactive() : win.show())
  }
  if (win.isDestroyed() || !win.isVisible()) return false
  step('moveTop', () => win.moveTop())
  // 注：不要在 show 后立刻 setAlwaysOnTop(level)——macOS 26/27 对刚显示的透明窗重设
  // level 会触发原生崩溃（SIGTRAP 无 JS 日志）；创建时已设 alwaysOnTop，无需重申。
  step('focusWin', () => win.focus())
  step('focusWc', () => {
    const wc = win.webContents
    if (!wc.isDestroyed()) wc.focus()
  })
  logInfo('quick', `present done visible=${win.isVisible()} bounds=${JSON.stringify(win.getBounds())}`)

  // macOS：app 激活时主窗可能抢 key，保护期内重试把焦点钉回 Quick
  const retryFocus = (tag: string): void => {
    try {
      if (revision !== showRevision || quickWindow !== win || win.isDestroyed()) return
      if (!quickWindow.isVisible()) return
      if (nativeInteractions.size > 0) return
      if (quickWindow.isFocused()) return
      if (Date.now() > blurGuardUntil) return
      win.focus()
      const wc = win.webContents
      if (!wc.isDestroyed()) wc.focus()
      logInfo('quick', `refocus after show (${tag})`)
    } catch (err) {
      logError('quick', `refocus failed (${tag}): ${(err as Error).message}`)
    }
  }
  setTimeout(() => retryFocus('90ms'), 90)
  setTimeout(() => retryFocus('280ms'), 280)
  options.commit?.()
  step('minimizeMain', () => {
    const main = getMainWindow()
    if (main && !main.isDestroyed() && main.isVisible() && !main.isMinimized()) main.minimize()
  })
  return true
}

export function getQuickShowRevision(): number { return showRevision }

/** 临时诊断（ENEST_QUICK_DEBUG=1）：把带 alpha 的 Quick 画面写到临时目录，用于定位透明圆角问题。 */
function captureDebugFrame(win: QuickWindow): void {
  if (process.env.ENEST_QUICK_DEBUG !== '1') return
  setTimeout(() => {
    if (win.isDestroyed() || !win.isVisible()) return
    void win.webContents.capturePage().then(image => {
      try { writeFileSync(join(tmpdir(), 'enest-quick-frame.png'), image.toPNG()) } catch { /* 诊断输出失败不影响运行 */ }
    }).catch(() => undefined)
  }, 500)
}

function waitForQuickRenderer(win: QuickWindow, resolve: (ready: boolean) => void, timeoutMs?: number): void {
  const wc = win.webContents
  let settled = false
  const finish = (ready: boolean) => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    wc.removeListener('did-finish-load', loaded)
    wc.removeListener('did-stop-loading', loaded)
    wc.removeListener('did-fail-load', failed)
    wc.removeListener('destroyed', destroyed)
    resolve(ready)
  }
  // A fresh WebContents can finish its initial about:blank document while the
  // requested renderer is still navigating. Only the destination document is ready.
  const loaded = () => { if (isQuickRendererReady(win)) finish(true) }
  const failed = (_event: unknown, _code: number, _description: string, _url: string, isMainFrame: boolean) => { if (isMainFrame) finish(false) }
  const destroyed = () => finish(false)
  const timer = timeoutMs === undefined ? undefined : setTimeout(() => finish(false), timeoutMs)
  wc.on('did-finish-load', loaded)
  wc.on('did-stop-loading', loaded)
  wc.on('did-fail-load', failed)
  wc.once('destroyed', destroyed)
  try { if (!quickRendererUrls.has(win) || !wc.isLoadingMainFrame()) loadQuickRenderer(win) }
  catch { finish(false) }
}

/** Prepare a docking destination without resetting its owner or changing native focus. */
export async function prepareQuickWindowForPlugin(canPrepare: () => boolean = () => true): Promise<boolean> {
  if (!canPrepare()) return false
  const revision = showRevision
  const win = ensureQuickWindow(), wc = win.webContents
  const current = () => revision === showRevision && canPrepare() && quickWindow === win && !win.isDestroyed() && !wc.isDestroyed()
  if (!current()) return false
  if (isQuickRendererReady(win)) return true
  const ready = await new Promise<boolean>(resolve => waitForQuickRenderer(win, resolve, 5000))
  return ready && current()
}

/** Commit relocation only after native presentation succeeds; never resets the owner. */
export function presentQuickWindowForPlugin(commit?: () => void): boolean {
  const win = quickWindow
  if (!win || win.isDestroyed() || !isQuickRendererReady(win)) return false
  const wasVisible = win.isVisible()
  if (!wasVisible) ++showRevision
  try {
    return presentAndFocus(win, { commit: () => {
      if (!wasVisible) win.webContents.send(IpcChannels.QuickShown)
      commit?.()
    } })
  } catch (error) {
    if (!wasVisible && !win.isDestroyed()) {
      guardMainWindowActivation()
      win.hide()
    }
    throw error
  }
}

export async function showQuickWindow(canShow: () => boolean = () => true): Promise<boolean> {
  if (!canShow()) return false
  logInfo('quick', 'showQuickWindow enter')
  const revision = ++showRevision
  if (!isQuickVisible()) await capturePasteTarget()
  if (revision !== showRevision || !canShow()) return false
  try {
    const win = ensureQuickWindow()
    logInfo('quick', `ensureQuickWindow ok destroyed=${win.isDestroyed()}`)
    // 未 Esc 退场的上次插件优先恢复（PluginHost 的启动事务负责呈现）；
    // 不可恢复时由编排回调内部重置回两行常用项，避免闪过上次插件的展开高度。
    if (quickPluginSummonHook) {
      const restored = await quickPluginSummonHook(() => revision === showRevision && canShow())
      if (restored) {
        logInfo('quick', 'summon restored last quick plugin')
        return true
      }
      if (revision !== showRevision || !canShow()) return false
    }
    currentTargetHeight = QUICK_HOME_HEIGHT
    const wc = win.webContents
    if (wc.isDestroyed()) return false
    const present = () => presentAndFocus(win, { commit: () => {
      wc.send(IpcChannels.QuickShown)
      applyQuickHeightAfterShow()
      captureDebugFrame(win)
    } })
    if (isQuickRendererReady(win)) return present()
    waitForQuickRenderer(win, ready => {
      if (!ready || revision !== showRevision || !canShow() || quickWindow !== win || win.isDestroyed()) return
      try { present() }
      catch (err) { logError('quick', `show-after-load failed: ${(err as Error).stack || String(err)}`) }
    })
  } catch (err) {
    const stack = (err as Error).stack || String(err)
    logError('quick', `show failed: ${stack}`)
    console.error('[quick] show failed:', stack)
    try {
      destroyQuickWindow()
    } catch {
      /* ignore */
    }
    return false
  }
  return true
}

/**
 * PluginHost 注入的「呼出编排」回调：未 Esc 退场的上次挂载插件优先恢复
 * （呈现由其内部启动事务完成），否则重置回空搜索态。返回 true = 已恢复。
 */
let quickPluginSummonHook: ((canProceed: () => boolean) => Promise<boolean>) | null = null

/** PluginHost 启动时注入呼出编排回调；传 null 清除 */
export function setQuickPluginSummonHook(fn: ((canProceed: () => boolean) => Promise<boolean>) | null): void {
  quickPluginSummonHook = fn
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
  showRevision++
  // 隐藏即放弃本次粘贴上下文：图片字节与文件路径不跨呼出保留。
  clearQuickInputContext()
  // The delayed activate event from ordering Quick out must not reopen main.
  guardMainWindowActivation()
  blurGuardUntil = 0
  if (pendingBlurTimer) clearTimeout(pendingBlurTimer)
  pendingBlurTimer = null
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
        presentAndFocus(win, { refocusOnly: true })
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
  showRevision++
  if (pendingBlurTimer) {
    clearTimeout(pendingBlurTimer)
    pendingBlurTimer = null
  }
  if (quickWindow && !quickWindow.isDestroyed()) {
    quickWindow.destroy()
  }
  quickWindow = null
}
