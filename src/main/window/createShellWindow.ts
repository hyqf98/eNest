/**
 * createShellWindow — 壳子窗口创建与管理
 * 职责：创建无边框主窗口，挂载 shell WebContentsView，管理预加载脚本路径解析与事件推送。
 * 被 index.ts 在 app.whenReady 后调用；PluginHost / pluginHandlers 通过 sendShellEvent 推送事件。
 * 关键依赖：@shared/constants（分区与尺寸）、shellPreload（渲染层桥接）。
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  app,
  BaseWindow,
  nativeImage,
  WebContentsView,
  type Rectangle,
  type WebContents
} from 'electron'
import { SHELL_PARTITION, TITLEBAR_HEIGHT, PLUGIN_BAR_HEIGHT, pluginChromeBarHeight } from '@shared/constants'
import { IpcChannels, type ShellEventPayload } from '@shared/types/ipc'

let mainWindow: BaseWindow | null = null
let shellView: WebContentsView | null = null

/** 解析 preload 脚本路径：开发与打包环境的扩展名不同（.js → .mjs） */
export function resolvePreload(name: string): string {
  const file = name.endsWith('.js') ? name.replace(/\.js$/, '.mjs') : name
  return join(app.getAppPath(), 'out', 'preload', file)
}

/** 解析 icons 根目录列表：开发路径优先，打包后走 process.resourcesPath */
function iconRoots(): string[] {
  return [
    join(app.getAppPath(), 'assets', 'icons'),
    process.resourcesPath ? join(process.resourcesPath, 'icons') : ''
  ].filter(Boolean)
}

/** 窗口 icon：必须是 PNG/ICO（Electron 不接受 ICNS，会 throw） */
function resolveWindowIcon(): string | undefined {
  const png = 'enest-icon-256.png'
  for (const root of iconRoots()) {
    const p = join(root, png)
    if (existsSync(p)) return p
  }
  return undefined
}

/**
 * macOS Dock 运行时图标。
 * 注意：dock.setIcon(PNG) 不会套用 App Icon 824/1024 网格边距，
 * 若用带大透明边的打包图标，Dock 里会显得比其它 App 小。
 * 因此运行时优先使用几乎铺满画布的 dock-runtime.png。
 */
function applyDockIcon(): void {
  if (process.platform !== 'darwin' || !app.dock) return
  const names = ['dock-runtime.png', 'enest-icon-256.png']
  for (const root of iconRoots()) {
    for (const name of names) {
      const p = join(root, name)
      if (!existsSync(p)) continue
      try {
        const img = nativeImage.createFromPath(p)
        if (img.isEmpty()) continue
        app.dock.setIcon(img)
        return
      } catch (err) {
        console.warn('[enest] dock icon failed', p, (err as Error).message)
      }
    }
  }
}

function loadRenderer(view: WebContentsView): void {
  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (devUrl) {
    void view.webContents.loadURL(devUrl)
  } else {
    void view.webContents.loadFile(join(app.getAppPath(), 'out', 'renderer', 'index.html'))
  }
}

function applyShellBounds(win: BaseWindow, view: WebContentsView): void {
  const b = win.getContentBounds()
  view.setBounds({ x: 0, y: 0, width: b.width, height: b.height })
}

/** 创建无边框圆角壳子主窗口并挂载 shell WebContentsView，窗口就绪后显示 */
export function createShellWindow(): BaseWindow {
  const windowIcon = resolveWindowIcon()
  const win = new BaseWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    show: false,
    frame: false,
    roundedCorners: true,
    hasShadow: true,
    backgroundColor: '#011517',
    ...(windowIcon ? { icon: windowIcon } : {}),
    title: 'eNest'
  })

  // Dock 单独设置；不可把 icns 传给 BrowserWindow/BaseWindow.icon
  applyDockIcon()

  const view = new WebContentsView({
    webPreferences: {
      preload: resolvePreload('shellPreload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // preload 需要访问 ipcRenderer，故不启用沙箱
      partition: SHELL_PARTITION // 与插件分区隔离，避免数据串扰
    }
  })

  win.contentView.addChildView(view)
  applyShellBounds(win, view)
  loadRenderer(view)

  win.on('resize', () => {
    if (!mainWindow || !shellView) return
    applyShellBounds(mainWindow, shellView)
  })

  view.webContents.once('did-finish-load', () => {
    win.show()
  })

  win.on('closed', () => {
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

export function getShellView(): WebContentsView | null {
  return shellView
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

/**
 * 获取插件内容区边界：扣除标题栏、插件条高度与左侧 orb 通道。
 * @param chromeBarHeight 插件条像素高；由 active 插件 manifest.ui.chrome 决定（default 48 / minimal 28 / none 0）
 */
export function getPluginContentBounds(chromeBarHeight: number = PLUGIN_BAR_HEIGHT): Rectangle {
  const b = getShellBounds()
  const top = TITLEBAR_HEIGHT + Math.max(0, chromeBarHeight)
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

/**
 * 向壳子渲染进程推送 shell:event 事件，窗口已销毁时静默忽略。
 * Quick 表面事件（quick-plugin-mode）额外转发给 Quick 小窗 wc。
 */
export function sendShellEvent(payload: ShellEventPayload): void {
  const wc = getShellWebContents()
  if (!wc || wc.isDestroyed()) return
  wc.send(IpcChannels.ShellEvent, payload)
  if (payload.type === 'quick-plugin-mode') {
    try {
      quickEventSink?.(payload)
    } catch {
      /* Quick wc 可能正在销毁 */
    }
  }
}
