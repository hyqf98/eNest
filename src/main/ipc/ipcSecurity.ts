import { ipcMain, shell, type IpcMainEvent, type IpcMainInvokeEvent, type WebContents } from 'electron'
import { IpcChannels } from '@shared/types/ipc'

export type SurfaceRole = 'shell' | 'quick' | 'orb' | 'detached'
type SenderEvent = IpcMainEvent | IpcMainInvokeEvent
const surfaces = new Map<number, { contents: WebContents; role: SurfaceRole; url: string }>()
const sharedReads = [IpcChannels.ShellGetTheme, IpcChannels.ShellGetSettings, IpcChannels.ShellReadCustomFont]
const windowChannels = [
  IpcChannels.PluginWindowState, IpcChannels.PluginWindowCommand, IpcChannels.PluginDragBegin,
  IpcChannels.PluginDragArm, IpcChannels.PluginDragUpdate, IpcChannels.PluginDragEnd, IpcChannels.PluginDragTargets
]
const detachedChannels = new Set<string>(windowChannels)
const quickChannels = new Set<string>([
  ...windowChannels,
  ...sharedReads, IpcChannels.QuickInput, IpcChannels.QuickToggle, IpcChannels.QuickHide,
  IpcChannels.QuickSearch, IpcChannels.QuickOpen, IpcChannels.QuickGetConfig,
  IpcChannels.QuickResize, IpcChannels.ShellSetView, IpcChannels.ShellGetPlugins,
  IpcChannels.ShellActivatePlugin, IpcChannels.ShellOpenPlugin
])
const orbChannels = new Set<string>([
  ...windowChannels,
  ...sharedReads, IpcChannels.ShellGetOrbState, IpcChannels.ShellSetOrbRailExpanded,
  IpcChannels.ShellActivatePlugin, IpcChannels.ShellOpenPlugin, IpcChannels.ShellClosePlugin,
  IpcChannels.ShellGoHome, IpcChannels.ShellSetView, IpcChannels.WindowMinimize,
  IpcChannels.WindowMaximize, IpcChannels.WindowClose
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
  if (surface.role === 'quick' && !quickChannels.has(channel) || surface.role === 'orb' && !orbChannels.has(channel) || surface.role === 'detached' && !detachedChannels.has(channel)) {
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
