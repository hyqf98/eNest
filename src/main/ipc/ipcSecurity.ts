import { ipcMain, shell, type IpcMainEvent, type IpcMainInvokeEvent, type WebContents } from 'electron'
import { IpcChannels } from '@shared/types/ipc'

export type SurfaceRole = 'install' | 'notification' | 'shell' | 'quick' | 'orb' | 'dock' | 'home' | 'detached' | 'modal'
type SenderEvent = IpcMainEvent | IpcMainInvokeEvent
const surfaces = new Map<number, { contents: WebContents; role: SurfaceRole; url: string }>()
const installChannels = [IpcChannels.InstallDropState, IpcChannels.InstallDropFiles, IpcChannels.InstallSurfaceReady, IpcChannels.InstallSurfaceDismiss]
const notificationClientChannels = [IpcChannels.NotificationShow, IpcChannels.NotificationDismiss]
const notificationChannels = new Set<string>([IpcChannels.NotificationDismiss, IpcChannels.NotificationState, IpcChannels.NotificationMeasure, IpcChannels.NotificationOpenLink])
const modalChannels = new Set<string>([IpcChannels.ModalReady, IpcChannels.ModalRespond])
const accountChannels = new Set<string>([IpcChannels.ShellAccountState, IpcChannels.ShellAccountLogin, IpcChannels.ShellAccountCancel, IpcChannels.ShellAccountLogout,
  IpcChannels.ShellGithubLogin, IpcChannels.ShellGithubCancelLogin, IpcChannels.ShellGetProfile, IpcChannels.ShellGithubLogout,
  IpcChannels.ShellGithubCopyCode, IpcChannels.ShellGithubSyncState, IpcChannels.ShellGithubSyncDiscover, IpcChannels.ShellGithubSyncConnect,
  IpcChannels.ShellGithubSyncDisconnect, IpcChannels.ShellGithubSyncTransfer, IpcChannels.ShellGithubSyncCancel, IpcChannels.ShellGithubSyncAutomatic])
const appearanceWrites = new Set([
  IpcChannels.ShellUpdateThemeProfile,
  IpcChannels.ShellActivateTheme,
  IpcChannels.ShellSetAppearanceMode,
  IpcChannels.ShellSetAppearancePerformanceLimited
])
const windowChannels = [
  IpcChannels.PluginWindowState, IpcChannels.PluginWindowCommand, IpcChannels.PluginDragBegin,
  IpcChannels.PluginDragArm, IpcChannels.PluginDragUpdate, IpcChannels.PluginDragEnd, IpcChannels.PluginDragTargets
]
const detachedChannels = new Set<string>([...windowChannels, ...installChannels, ...notificationClientChannels])
const quickChannels = new Set<string>([
  ...notificationClientChannels,
  ...windowChannels,
  ...installChannels, IpcChannels.ShellGetAppearance, IpcChannels.ShellReadCustomFont,
  IpcChannels.QuickFiles,
  IpcChannels.QuickInput, IpcChannels.QuickInputContext, IpcChannels.QuickHide, IpcChannels.QuickGetLocale,
  IpcChannels.QuickSearch, IpcChannels.QuickOpen, IpcChannels.QuickThemeGetConfig, IpcChannels.QuickThemeAuthorize,
  IpcChannels.QuickProviderState, IpcChannels.QuickResize, IpcChannels.QuickGetUpdateVersion
])
const homeChannels = new Set<string>([
  IpcChannels.HomeReady,
  IpcChannels.HomeAck,
  IpcChannels.HomeGetCatalog,
  IpcChannels.HomeGetDetail,
  IpcChannels.HomeSearch,
  IpcChannels.HomeFiles,
  IpcChannels.HomeRefresh,
  IpcChannels.HomeAction,
  IpcChannels.HomeGetAppearance,
  IpcChannels.HomeGetConfig,
  IpcChannels.HomeGetTabs
])
// Classic settings dock can only read its state and request settings navigation.
const dockChannels = new Set<string>([IpcChannels.ShellGetOrbState, IpcChannels.ShellSetView])
const orbChannels = new Set<string>([
  ...windowChannels,
  IpcChannels.ShellGetOrbState, IpcChannels.ShellSetOrbRailExpanded,
  // 拖把手换边：只允许在 left/right 之间切换，不接受任意坐标。
  IpcChannels.ShellSetOrbDock,
  // 悬停名称浮层：只切换「拓宽/还原」，宽度由主进程常量决定，不接受 renderer 指定尺寸。
  IpcChannels.ShellSetOrbRailCaption,
  IpcChannels.ShellActivateRailContribution,
  IpcChannels.ShellActivatePlugin, IpcChannels.ShellClosePlugin,
  IpcChannels.ShellGoHome, IpcChannels.ShellSetView
])
/** Only window creation can register a privileged surface, never renderer-provided IDs or URLs. */
export function registerTrustedSurface(contents: WebContents, role: SurfaceRole, url: string): void {
  const wcId = contents.id
  const firstRegistration = !surfaces.has(wcId)
  surfaces.set(wcId, { contents, role, url })
  if (!firstRegistration) return
  // Privileged renderers remain on their own document; README links open in the system browser.
  contents.on('will-navigate', (event, destination) => {
    const expected = surfaces.get(wcId)?.url
    try {
      const target = new URL(destination), source = new URL(expected ?? '')
      if (target.protocol === source.protocol && target.host === source.host && target.pathname === source.pathname) return
    } catch { /* deny malformed destinations */ }
    event.preventDefault()
  })
  contents.setWindowOpenHandler(({ url: target }) => {
    try {
      const parsed = new URL(target)
      if (role === 'shell' && ['https:', 'http:', 'mailto:'].includes(parsed.protocol) && !parsed.username && !parsed.password) {
        void shell.openExternal(parsed.href).catch(() => {})
      }
    } catch { /* deny malformed destinations */ }
    return { action: 'deny' }
  })
  contents.once('destroyed', () => { if (surfaces.get(wcId)?.contents === contents) surfaces.delete(wcId) })
}

export function revokeTrustedSurface(contents: WebContents): void {
  if (surfaces.get(contents.id)?.contents === contents) surfaces.delete(contents.id)
}

export function assertSurfaceSender(event: SenderEvent, channel: string): void {
  const surface = surfaces.get(event.sender.id)
  if (!surface || surface.contents !== event.sender || event.sender.isDestroyed() || !event.senderFrame || event.senderFrame !== event.sender.mainFrame) {
    throw new Error('IPC denied: untrusted surface or frame')
  }
  const expected = new URL(surface.url)
  const actual = new URL(event.senderFrame.url)
  if (actual.protocol !== expected.protocol || actual.host !== expected.host || actual.pathname !== expected.pathname || actual.username || actual.password) {
    throw new Error('IPC denied: unexpected document')
  }
  if (surface.role === 'install' && !(installChannels as readonly string[]).includes(channel)) throw new Error('IPC denied: install surface capability')
  if (surface.role === 'notification' && !notificationChannels.has(channel)) throw new Error('IPC denied: notification surface capability')
  if (appearanceWrites.has(channel as never) && surface.role !== 'shell') throw new Error('IPC denied: appearance write capability')
  if (accountChannels.has(channel) && surface.role !== 'shell') throw new Error('IPC denied: account capability')
  if (
    surface.role === 'quick' && !quickChannels.has(channel) ||
    surface.role === 'orb' && !orbChannels.has(channel) ||
    surface.role === 'dock' && !dockChannels.has(channel) ||
    surface.role === 'home' && !homeChannels.has(channel) ||
    surface.role === 'detached' && !detachedChannels.has(channel)
    || surface.role === 'modal' && !modalChannels.has(channel)
  ) {
    throw new Error('IPC denied: surface capability')
  }
}

export function handleShellIpc(channel: string, listener: Parameters<typeof ipcMain.handle>[1]): void {
  ipcMain.handle(channel, (event, ...args) => { assertSurfaceSender(event, channel); return listener(event, ...args) })
}
export function onShellIpc(channel: string, listener: (event: IpcMainEvent, ...args: any[]) => void): void {
  ipcMain.on(channel, (event, ...args) => {
    try { assertSurfaceSender(event, channel) } catch { return }
    listener(event, ...args)
  })
}

/** Identity lookup is used only after assertSurfaceSender has verified the current frame. */
export function getTrustedSurfaceRole(wcId: number): SurfaceRole | null { return surfaces.get(wcId)?.role ?? null }
