/**
 * regionSelection — 全屏框选一块屏幕区域
 * 职责：为每个显示器铺一层全屏透明置顶窗口，用户拖出矩形后返回屏幕绝对坐标。
 * 关键约束：
 *  - 只绘制选区，不读取屏幕像素，也不申请屏幕录制权限。
 *  - 每个 overlay 注册为独立受信 surface（role = 'region'），IPC 通道显式白名单。
 *  - 结果以 display 本地 DIP 换算回屏幕绝对坐标，避免多屏与缩放错位。
 *  - v1 不做冻结背景：暗化遮罩已足够表达「框选」语义，且避免多 MB data URL 注入的转义风险。
 * 被 PanelManager 调用；自身不持有面板状态。
 */
import { app, BaseWindow, screen, WebContentsView } from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { SHELL_PARTITION } from '@shared/constants'
import { IpcChannels } from '@shared/types/ipc'
import { PANEL_MIN_HEIGHT, PANEL_MIN_WIDTH, type PanelBounds } from '@shared/types/panel'
import { onShellIpc, registerTrustedSurface, revokeTrustedSurface } from '@main/ipc/ipcSecurity'
import { resolvePreload } from '@main/window/createShellWindow'
import { logWarn } from '@main/logs/logService'

const SELECTION_TIMEOUT_MS = 120_000

interface Overlay {
  window: BaseWindow
  view: WebContentsView
  displayId: number
  origin: { x: number; y: number }
}

interface Session {
  overlays: Overlay[]
  settled: boolean
  resolve: (bounds: PanelBounds | null) => void
  timer: ReturnType<typeof setTimeout>
  removeListeners: () => void
}

let session: Session | null = null
let registered = false

function overlayUrl(display: Electron.Display): string {
  const dev = process.env.ELECTRON_RENDERER_URL
  const base = dev
    ? new URL('region-overlay.html', dev.replace(/\/?$/, '/'))
    : pathToFileURL(join(app.getAppPath(), 'out', 'renderer', 'region-overlay.html'))
  base.searchParams.set('displayId', String(display.id))
  base.searchParams.set('width', String(Math.round(display.bounds.width)))
  base.searchParams.set('height', String(Math.round(display.bounds.height)))
  base.searchParams.set('minWidth', String(PANEL_MIN_WIDTH))
  base.searchParams.set('minHeight', String(PANEL_MIN_HEIGHT))
  return base.href
}

function dispose(s: Session, result: PanelBounds | null): void {
  if (s.settled) return
  s.settled = true
  clearTimeout(s.timer)
  s.removeListeners()
  if (session === s) session = null
  for (const overlay of s.overlays) {
    revokeTrustedSurface(overlay.view.webContents)
    if (!overlay.view.webContents.isDestroyed()) overlay.view.webContents.close({ waitForBeforeUnload: false })
    if (!overlay.window.isDestroyed()) overlay.window.destroy()
  }
  s.resolve(result)
}

function validSelection(raw: unknown): { x: number; y: number; width: number; height: number } | null {
  if (!raw || typeof raw !== 'object') return null
  const input = raw as Record<string, unknown>
  const values = ['x', 'y', 'width', 'height'].map(key => input[key])
  if (!values.every(value => typeof value === 'number' && Number.isFinite(value))) return null
  const [x, y, width, height] = values as number[]
  if (width < PANEL_MIN_WIDTH || height < PANEL_MIN_HEIGHT) return null
  if (Math.abs(x) > 100_000 || Math.abs(y) > 100_000 || width > 100_000 || height > 100_000) return null
  return { x, y, width, height }
}

/**
 * 让用户框选一块区域。
 * 返回屏幕绝对 DIP 矩形；取消、超时或任何异常都返回 null。
 */
export async function selectRegion(): Promise<PanelBounds | null> {
  if (session) return null
  const displays = screen.getAllDisplays()
  if (!displays.length) return null

  return new Promise<PanelBounds | null>(resolve => {
    const overlays: Overlay[] = []
    const s: Session = {
      overlays,
      settled: false,
      resolve,
      timer: setTimeout(() => dispose(s, null), SELECTION_TIMEOUT_MS),
      removeListeners: () => {}
    }
    s.timer.unref?.()
    session = s
    const cancelForDisplays = (): void => dispose(s, null)
    screen.on('display-removed', cancelForDisplays)
    screen.on('display-metrics-changed', cancelForDisplays)
    s.removeListeners = () => {
      screen.removeListener('display-removed', cancelForDisplays)
      screen.removeListener('display-metrics-changed', cancelForDisplays)
    }

    let pendingShows = displays.length
    const reveal = (): void => {
      if (s.settled) return
      for (const overlay of overlays) {
        if (overlay.window.isDestroyed() || overlay.view.webContents.isDestroyed()) continue
        overlay.window.show()
      }
      // 主显示器优先获得焦点，方便直接用键盘取消。
      const primaryId = screen.getPrimaryDisplay().id
      const primary = overlays.find(overlay => overlay.displayId === primaryId) ?? overlays[0]
      primary?.window.focus()
    }

    try {
      for (const display of displays) {
        const { x, y, width, height } = display.bounds
        const win = new BaseWindow({
          x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height),
          show: false, frame: false, transparent: true, hasShadow: false, resizable: false, movable: false,
          minimizable: false, maximizable: false, fullscreenable: false, skipTaskbar: true, alwaysOnTop: true,
          backgroundColor: '#00000000'
        })
        let view: WebContentsView
        try {
          view = new WebContentsView({
            webPreferences: {
              preload: resolvePreload('regionPreload.js'), partition: SHELL_PARTITION,
              contextIsolation: true, nodeIntegration: false, sandbox: true
            }
          })
        } catch (error) {
          win.destroy()
          throw error
        }
        const overlay: Overlay = {
          window: win, view, displayId: display.id, origin: { x: Math.round(x), y: Math.round(y) }
        }
        overlays.push(overlay)
        view.setBackgroundColor('#00000000')
        win.contentView.addChildView(view)
        view.setBounds({ x: 0, y: 0, width: Math.round(width), height: Math.round(height) })
        // macOS 上覆盖菜单栏与全屏空间；其他平台该调用是 no-op。
        if (process.platform === 'darwin') win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
        // level 只在创建后设一次：show 之后重设 level 在 macOS 26/27 会崩溃（见 createQuickWindow 同类告警）。
        win.setAlwaysOnTop(true, 'screen-saver')
        win.once('closed', () => { if (!s.settled) dispose(s, null) })
        view.webContents.once('render-process-gone', () => { if (!s.settled) dispose(s, null) })
        const url = overlayUrl(display)
        registerTrustedSurface(view.webContents, 'region', url)
        void view.webContents.loadURL(url).then(() => {
          if (s.settled) return
          pendingShows -= 1
          if (pendingShows <= 0) reveal()
        }).catch(error => {
          logWarn('panel', `region overlay load failed: ${String(error)}`)
          if (!s.settled) dispose(s, null)
        })
      }
    } catch (error) {
      logWarn('panel', `region overlay creation failed: ${String(error)}`)
      dispose(s, null)
    }
  })
}

export function registerRegionSurfaceHandlers(): void {
  if (registered) return
  registered = true

  onShellIpc(IpcChannels.RegionConfirm, (event, raw: unknown) => {
    const s = session
    if (!s || s.settled) return
    const overlay = s.overlays.find(item => item.view.webContents === event.sender)
    if (!overlay) return
    const selection = validSelection(raw)
    if (!selection) return
    // 本地 DIP → 屏幕绝对 DIP
    dispose(s, {
      x: overlay.origin.x + Math.round(selection.x),
      y: overlay.origin.y + Math.round(selection.y),
      width: Math.round(selection.width),
      height: Math.round(selection.height),
      displayId: overlay.displayId
    })
  })

  onShellIpc(IpcChannels.RegionCancel, (event) => {
    const s = session
    if (!s || s.settled) return
    if (!s.overlays.some(item => item.view.webContents === event.sender)) return
    dispose(s, null)
  })
}

/** 主进程直接取消（例如退出、开关关闭、窗口失焦兜底）。 */
export function cancelRegionSelection(): void {
  if (session) dispose(session, null)
}

export function isSelectingRegion(): boolean {
  return session !== null
}
