/**
 * 托盘常驻（Windows / Linux 的「最小化到托盘」实质入口）。
 *
 * macOS 上 `closeBehavior = 'minimize-tray'` 用的是 `app.dock`——Dock 图标本身就是
 * 恢复入口，点它就能把窗口要回来。Windows / Linux 没有等价物：窗口 hide 之后
 * 任务栏项也一起消失，用户只能记着热键，否则应用等于"消失"。
 * 这个模块补上那条入口：关窗到后台时挂一个托盘图标，点它/菜单项就能回到主窗。
 */
import { Menu, Tray, nativeImage } from 'electron'
import { logWarn } from '@main/logs/logService'
import { resolveWindowIcon } from './applicationIcon'

let tray: Tray | null = null
/** 由宿主注入：点托盘时把主窗显示出来（不直接 import，避免模块环）。 */
let restoreWindow: (() => void) | null = null
/** 由宿主注入：从托盘菜单真正退出（要走 shuttingDown 流程，不能裸调 app.quit）。 */
let quitApp: (() => void) | null = null

export function updateTrayIcon(icon: string): void {
  if (!tray || tray.isDestroyed()) return
  try { tray.setImage(icon) } catch (error) { logWarn('main', `cannot update tray icon: ${String(error)}`) }
}

function buildMenu(): Menu {
  return Menu.buildFromTemplate([
    { label: '显示 eNest', click: () => restoreWindow?.() },
    { type: 'separator' },
    { label: '退出 eNest', click: () => quitApp?.() }
  ])
}

/**
 * 挂上托盘图标；返回是否真的挂上了。
 *
 * 调用方（关闭按钮 / window-all-closed）用它决定关窗行为：托盘挂不上时
 * hide 之后用户就没有任何恢复入口了，那种情况下必须降级成「最小化」，
 * 至少任务栏/Dock 里还留着一项。
 *
 * 幂等：托盘常驻，不随窗口 show/hide 反复创建销毁
 * （Windows 反复 new Tray 会留残影图标，Linux 会让 AppIndicator 重排）。
 */
export function ensureTray(): boolean {
  if (process.platform === 'darwin') return true   // macOS 用 Dock，本身就是入口
  if (tray && !tray.isDestroyed()) return true
  const path = resolveWindowIcon()
  if (!path) {
    logWarn('main', 'tray icon unavailable; skip tray registration')
    return false
  }
  try {
    const image = nativeImage.createFromPath(path)
    if (image.isEmpty()) throw new Error('empty tray icon')
    tray = new Tray(image)
    tray.setToolTip('eNest')
    tray.setContextMenu(buildMenu())
    // Windows：双击托盘图标回到窗口；Linux 很多桌面只响应菜单，所以菜单里也放一份。
    tray.on('double-click', () => restoreWindow?.())
    tray.on('click', () => {
      if (process.platform !== 'win32') restoreWindow?.()
    })
    return true
  } catch (error) {
    logWarn('main', `tray registration failed: ${(error as Error).message}`)
    tray = null
    return false
  }
}

export function destroyTray(): void {
  if (!tray) return
  try { tray.destroy() } catch { /* 退出流程里可能已释放 */ }
  tray = null
}

export function setTrayHandlers(handlers: { restore: () => void; quit: () => void }): void {
  restoreWindow = handlers.restore
  quitApp = handlers.quit
}
