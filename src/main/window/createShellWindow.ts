import { pathToFileURL } from 'node:url'
import { registerTrustedSurface } from '@main/ipc/ipcSecurity'
/**
 * createShellWindow — 壳子窗口创建与管理
 * 职责：创建无边框主窗口，挂载 shell WebContentsView，管理预加载脚本路径解析与事件推送。
 * 被 index.ts 在 app.whenReady 后调用；PluginHost / pluginHandlers 通过 sendShellEvent 推送事件。
 * 关键依赖：@shared/constants（分区与尺寸）、shellPreload（渲染层桥接）。
 */
import { join } from 'node:path'
import {
  app,
  type BaseWindow,
  WebContentsView,
  type Rectangle,
  type WebContents
} from 'electron'
import { APP_NAME, SHELL_PARTITION, TITLEBAR_HEIGHT, TITLEBAR_REVEAL_HEIGHT, PLUGIN_BAR_HEIGHT, pluginChromeBarHeight } from '@shared/constants'
import { IpcChannels, type ShellEventPayload } from '@shared/types/ipc'
import { readMainWindowState, trackMainWindowState } from '@main/window/mainWindowState'
import { devShortcutAction, toggleDevTools } from '@main/dev/devShortcuts'
import { registerThemeSettingsPolicy } from '@main/theme/themeSettingsSurface'
import { resolveThemeTokens } from '@main/theme/resolveThemeCss'
import { markStartupPhase } from '@main/logs/startupTiming'
import { logWarn } from '@main/logs/logService'
import { resolveWindowIcon } from './applicationIcon'
import { createDesktopWindow, setDesktopWindowBackground } from './desktopWindowFrame'

let mainWindow: BaseWindow | null = null
let shellView: WebContentsView | null = null
let pendingDockShow: Promise<void> | null = null

/**
 * 原生窗口持有外轮廓，子视图加载、切换或重绘时露出的底色仍须跟随主题。
 */
function resolveWindowBackgroundColor(): string {
  const { appearance, tokens } = resolveThemeTokens('auto')
  const bg = appearance?.tokens['--bg'] ?? tokens['--bg']
  // 只接受纯色；渐变/图片交给 DOM 层，窗口退回该模式的表面色。
  if (typeof bg === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(bg.trim())) return bg.trim()
  return appearance?.mode === 'dark' ? '#182126' : '#f6f8fa'
}

/** 主题/外观变更时同步窗口底色，避免圆角外露出上一套主题的颜色。 */
export function syncShellWindowBackground(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  try { setDesktopWindowBackground(mainWindow, resolveWindowBackgroundColor()) }
  catch { /* 窗口正在销毁时忽略 */ }
}

/** All isolated worlds load independently bundled CommonJS preloads. */
export function resolvePreload(name: string): string {
  return join(app.getAppPath(), 'out', 'preload', name.replace(/\.(js|mjs|cjs)$/, '.cjs'))
}

/**
 * 主窗隐藏后保住 macOS 的 Dock 项；返回 Dock 是否作为可用入口。
 *
 * 「关闭到托盘」把主窗 hide 掉，app 随即没有可见窗口；macOS 会顺手把 Dock 项
 * 也收走，用户从 Dock 找不到 eNest，只能记着热键。关闭到托盘的本意是"后台常驻"，
 * 所以这里显式把图标要回来——`dock.show()` 在没有窗口时也能让 app 留在 Dock 上。
 * 呼出 Quick / 重新显示主窗时系统会自然恢复，不需要反向调用 `dock.hide()`。
 *
 * 非 darwin 平台没有 Dock，返回 false 让调用方改用托盘。
 */
export function keepDockIconVisible(): boolean {
  if (process.platform !== 'darwin') return false
  const dock = app.dock
  if (!dock) return false
  try {
    if (dock.isVisible() || pendingDockShow) return true
    pendingDockShow = dock.show()
      .catch(error => logWarn('main', `cannot show Dock icon: ${String(error)}`))
      .finally(() => { pendingDockShow = null })
    return true
  } catch { return false }
}

function loadRenderer(view: WebContentsView): void {
  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (devUrl) {
    registerTrustedSurface(view.webContents, 'shell', devUrl)
    void view.webContents.loadURL(devUrl)
  } else {
    const file = join(app.getAppPath(), 'out', 'renderer', 'index.html')
    registerTrustedSurface(view.webContents, 'shell', pathToFileURL(file).href)
    void view.webContents.loadFile(file)
  }
}

function applyShellBounds(win: BaseWindow, view: WebContentsView): void {
  const b = win.getContentBounds()
  view.setBounds({ x: 0, y: 0, width: b.width, height: b.height })
}

/** 创建无边框圆角壳子主窗口并挂载 shell WebContentsView，窗口就绪后显示 */
export function createShellWindow(): BaseWindow {
  const restored = readMainWindowState()
  const win = createDesktopWindow({
    width: 1200,
    height: 800,
    ...restored?.bounds,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: resolveWindowBackgroundColor(),
    icon: resolveWindowIcon(),
    title: APP_NAME
  })
  win.once('show', () => markStartupPhase('shell-window-shown'))

  const view = new WebContentsView({
    webPreferences: {
      preload: resolvePreload('shellPreload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      partition: SHELL_PARTITION // 与插件分区隔离，避免数据串扰
    }
  })

  const contents = view.webContents
  win.contentView.addChildView(view)
  applyShellBounds(win, view)
  loadRenderer(view)
  registerThemeSettingsPolicy(contents)

  // 壳 UI 持焦时的调试快捷键（与 dev 插件 view 内一致）：F12/⌘⌥I/Ctrl+Shift+I toggle 壳 DevTools；
  // ⌘/Ctrl+R 重载当前激活的 dev 插件（无 dev 插件时无操作，不刷新壳）。
  contents.on('before-input-event', (event, input) => {
    const action = devShortcutAction(input)
    if (!action) return
    event.preventDefault()
    if (action === 'devtools') {
      toggleDevTools(contents)
      return
    }
    void Promise.all([
      import('@main/plugin/PluginHost'),
      import('@main/plugin/PluginRegistry')
    ]).then(([{ pluginHost }, { pluginRegistry }]) => {
      const active = pluginHost.getActive()
      if (active && pluginRegistry.get(active)?.dev) pluginHost.reloadPlugin(active)
    })
  })

  win.on('resize', () => {
    if (!mainWindow || !shellView) return
    applyShellBounds(mainWindow, shellView)
  })

  contents.once('did-finish-load', () => {
    if (win.isDestroyed()) return
    markStartupPhase('shell-did-finish-load')
    if (restored?.maximized) win.maximize()
    win.show()
    trackMainWindowState(win)
  })

  win.on('closed', () => {
    // BaseWindow 不负责销毁子 WebContents；摘引用前显式结束 renderer。
    if (!contents.isDestroyed()) contents.close({ waitForBeforeUnload: false })
    setPluginTopInset(0)
    mainWindow = null
    shellView = null
  })

  mainWindow = win
  shellView = view
  return win
}

export function getMainWindow(): BaseWindow | null {
  return mainWindow
}

export function getShellWebContents(): WebContents | null {
  return shellView?.webContents ?? null
}

export function getShellBounds(): Rectangle {
  if (!mainWindow) return { x: 0, y: 0, width: 1200, height: 800 }
  return mainWindow.getContentBounds()
}

/**
 * 插件内容区左侧 inset：orb 模式为圆轨留通道，classic 为 0。
 * 由 shell:set-plugin-inset 在 tabStyle 切换 / 圆轨展开时更新。
 */
let pluginLeftInset = 0

export function setPluginLeftInset(px: number): void {
  pluginLeftInset = Math.max(0, Math.round(px))
}

export function getPluginLeftInset(): number {
  return pluginLeftInset
}

/** 让出的标题栏高度，必须保留 shell 的顶部鼠标唤出区。 */
let pluginTopInset = 0

export function setPluginTopInset(px: number): void {
  const next = Number.isFinite(px)
    ? Math.min(TITLEBAR_HEIGHT - TITLEBAR_REVEAL_HEIGHT, Math.max(0, Math.round(px)))
    : 0
  if (process.platform === 'darwin' && (next === 0) !== (pluginTopInset === 0) && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setWindowButtonVisibility(next === 0)
  }
  pluginTopInset = next
}

export function getPluginTopInset(): number {
  return pluginTopInset
}

/**
 * 获取插件内容区边界：扣除标题栏、插件条高度与左侧 orb 通道。
 * @param chromeBarHeight 插件条像素高；由 active 插件 manifest.ui.chrome 决定（default 48 / minimal 28 / none 0）
 */
export function getPluginContentBounds(chromeBarHeight: number = PLUGIN_BAR_HEIGHT): Rectangle {
  const b = getShellBounds()
  // pluginTopInset 表示“标题栏让出的高度”，因此从顶部基准里扣掉。
  const top = TITLEBAR_HEIGHT - pluginTopInset + Math.max(0, chromeBarHeight)
  const left = pluginLeftInset
  return {
    x: left,
    y: top,
    width: Math.max(0, b.width - left),
    height: Math.max(0, b.height - top)
  }
}

/** 按 chrome 模式取内容区边界（便捷封装） */
export function getPluginContentBoundsForChrome(
  chrome: 'default' | 'minimal' | 'none' | undefined
): Rectangle {
  return getPluginContentBounds(pluginChromeBarHeight(chrome))
}

/**
 * Quick 表面事件转发钩子：Quick 小窗是独立 WebContents（独立 ipcRenderer），
 * quick-plugin-mode 等事件若只发主壳 wc，Quick 页面永远收不到（mini 插件态
 * 顶栏不渲染）。由 createQuickWindow 注入，避免本模块反向 import 成环。
 */
let quickEventSink: ((payload: ShellEventPayload) => void) | null = null

/** 注册/清除 Quick 表面事件接收器（createQuickWindow 模块初始化时调用） */
export function setQuickEventSink(fn: ((payload: ShellEventPayload) => void) | null): void {
  quickEventSink = fn
}

export function sendQuickEvent(payload: ShellEventPayload): void {
  try { quickEventSink?.(payload) } catch { /* Quick wc 可能正在销毁 */ }
}

/**
 * 向壳子渲染进程推送 shell:event 事件，窗口已销毁时静默忽略。
 * Quick 插件态、目录与共享外观额外转发给 Quick 小窗 wc。
 */
let detachedAppearanceSink: (() => void) | null = null
export function setDetachedAppearanceSink(sink: (() => void) | null): void { detachedAppearanceSink = sink }
let notificationAppearanceSink: (() => void) | null = null
export function setNotificationAppearanceSink(sink: () => void): void { notificationAppearanceSink = sink }
const appearanceSettings = new Set(['locale', 'animationLevel', 'fontFamily', 'fontFamilyEn', 'fontSizeScale', 'customFonts'])

let installEventSink: ((payload: ShellEventPayload) => void) | null = null
export function setInstallEventSink(sink: (payload: ShellEventPayload) => void): void { installEventSink = sink }
let homeEventSink: ((payload: ShellEventPayload) => void) | null = null
export function setHomeEventSink(sink: ((payload: ShellEventPayload) => void) | null): void { homeEventSink = sink }
let modalEventSink: ((payload: ShellEventPayload) => void) | null = null
export function setModalEventSink(sink: (payload: ShellEventPayload) => void): void { modalEventSink = sink }

export function sendShellEvent(payload: ShellEventPayload): void {
  try { homeEventSink?.(payload) } catch { /* home retirement must not interrupt the host event */ }
  try { installEventSink?.(payload) } catch { /* transient UI must not interrupt installation */ }
  try { modalEventSink?.(payload) } catch { /* modal retirement must not interrupt the host */ }
  if (payload.type === 'appearance-changed' || payload.type === 'theme-changed' || payload.type === 'theme-packs-changed' || payload.type === 'settings-changed' && payload.generalKeys.some(key => appearanceSettings.has(key))) {
    try { detachedAppearanceSink?.() } catch { /* independent chrome may be retiring */ }
    try { notificationAppearanceSink?.() } catch { /* notifications may be retiring */ }
    syncShellWindowBackground()
  }
  const wc = getShellWebContents()
  if (wc && !wc.isDestroyed()) wc.send(IpcChannels.ShellEvent, payload)
  // Quick 是独立文档，只同步自身插件态、目录与共享外观；不转发主窗口的 Tab 状态。
  if (
    payload.type === 'quick-plugin-mode' ||
    payload.type === 'plugin-ready' ||
    payload.type === 'plugin-error' ||
    payload.type === 'quick-input' ||
    payload.type === 'quick-focus-search' ||
    payload.type === 'plugins-changed' ||
    payload.type === 'plugin-launch-changed' ||
    payload.type === 'launch-directory-changed' ||
    payload.type === 'theme-changed' ||
    payload.type === 'theme-packs-changed' ||
    payload.type === 'appearance-changed' ||
    payload.type === 'settings-changed'
  ) {
    sendQuickEvent(payload)
  }
}
