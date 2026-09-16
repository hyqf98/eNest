/**
 * createShellWindow — 壳子窗口创建与管理
 * 职责：创建无边框主窗口，挂载 shell WebContentsView，管理预加载脚本路径解析与事件推送。
 * 被 index.ts 在 app.whenReady 后调用；PluginHost / pluginHandlers 通过 sendShellEvent 推送事件。
 * 关键依赖：@shared/constants（分区与尺寸）、shellPreload（渲染层桥接）。
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { app, BaseWindow, WebContentsView, type Rectangle, type WebContents } from 'electron'
import { SHELL_PARTITION, TITLEBAR_HEIGHT, PLUGIN_BAR_HEIGHT, pluginChromeBarHeight } from '@shared/constants'
import { IpcChannels, type ShellEventPayload } from '@shared/types/ipc'

let mainWindow: BaseWindow | null = null
let shellView: WebContentsView | null = null

/** 解析 preload 脚本路径：开发与打包环境的扩展名不同（.js → .mjs） */
export function resolvePreload(name: string): string {
  const file = name.endsWith('.js') ? name.replace(/\.js$/, '.mjs') : name
  return join(app.getAppPath(), 'out', 'preload', file)
}

/** 应用图标路径（assets/icons，随 extraResources 打包） */
function resolveAppIcon(): string {
  const name = 'enest-icon-256.png'
  const candidates = [
    join(app.getAppPath(), 'assets', 'icons', name),
    process.resourcesPath ? join(process.resourcesPath, 'icons', name) : ''
  ].filter(Boolean)
  for (const p of candidates) {
    try {
      if (existsSync(p)) return p
    } catch {
      /* ignore */
    }
  }
  return join(app.getAppPath(), 'assets', 'icons', name)
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
    icon: resolveAppIcon(),
    title: 'eNest'
  })

  // macOS Dock / 任务栏图标
  if (process.platform === 'darwin') {
    app.dock?.setIcon(resolveAppIcon())
  }

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
 * 获取插件内容区边界：扣除标题栏与插件条高度。
 * @param chromeBarHeight 插件条像素高；由 active 插件 manifest.ui.chrome 决定（default 48 / minimal 28 / none 0）
 */
export function getPluginContentBounds(chromeBarHeight: number = PLUGIN_BAR_HEIGHT): Rectangle {
  const b = getShellBounds()
  const top = TITLEBAR_HEIGHT + Math.max(0, chromeBarHeight)
  return {
    x: 0,
    y: top,
    width: b.width,
    height: Math.max(0, b.height - top)
  }
}

/** 按 chrome 模式取内容区边界（便捷封装） */
export function getPluginContentBoundsForChrome(
  chrome: 'default' | 'minimal' | 'none' | undefined
): Rectangle {
  return getPluginContentBounds(pluginChromeBarHeight(chrome))
}

/** 向壳子渲染进程推送 shell:event 事件，窗口已销毁时静默忽略 */
export function sendShellEvent(payload: ShellEventPayload): void {
  const wc = getShellWebContents()
  if (!wc || wc.isDestroyed()) return
  wc.send(IpcChannels.ShellEvent, payload)
}
