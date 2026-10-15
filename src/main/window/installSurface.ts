import { app, BaseWindow, ipcMain, WebContentsView, type IpcMainEvent, type View } from 'electron'
import { isAbsolute, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { IpcChannels, type ShellEventPayload } from '@shared/types/ipc'
import type { InstallProgressItem, InstallSurfaceState } from '@shared/types/install'
import { TITLEBAR_HEIGHT } from '@shared/constants'
import { registerTrustedSurface, assertSurfaceSender } from '@main/ipc/ipcSecurity'
import { pluginHost } from '@main/plugin/PluginHost'
import { enqueueInstall } from '@main/plugin/installQueue'
import { getMainWindow, resolvePreload, setInstallEventSink } from '@main/window/createShellWindow'
import { resolveThemeTokens } from '@main/theme/resolveThemeCss'
import { settingsStore } from '@main/settings/SettingsStore'
import { registerTransientView, raiseTransientViews } from './transientViews'

interface Surface {
  win: BaseWindow
  view: WebContentsView
  dragging: boolean
  jobs: Map<string, InstallProgressItem>
  leave?: ReturnType<typeof setTimeout>
  idle?: ReturnType<typeof setTimeout>
  terminal: Map<string, ReturnType<typeof setTimeout>>
  release: () => void
  ready: boolean
  closed: () => void
}
const surfaces = new Map<number, Surface>()
const owners = new Map<string, number>()

function contains(view: View, wcId: number): boolean {
  return view instanceof WebContentsView && view.webContents.id === wcId || view.children.some(child => contains(child, wcId))
}
function sourceWindow(event: IpcMainEvent): BaseWindow | null {
  if (!event.senderFrame || event.senderFrame !== event.sender.mainFrame || event.sender.isDestroyed()) return null
  const pluginId = pluginHost.getPluginIdByWebContentsId(event.sender.id)
  if (pluginId) return pluginHost.getContainerWindow(pluginId) ?? null
  try { assertSurfaceSender(event, IpcChannels.InstallDropState) } catch { return null }
  return BaseWindow.getAllWindows().find(win => !win.isDestroyed() && contains(win.contentView, event.sender.id)) ?? null
}
function destroy(surface: Surface): void {
  // A rejected load from a retired view can arrive after its replacement exists.
  if (surfaces.get(surface.win.id) !== surface) return
  surfaces.delete(surface.win.id)
  clearTimeout(surface.leave); clearTimeout(surface.idle)
  for (const timer of surface.terminal.values()) clearTimeout(timer)
  // A renderer failure retires only the view; pending installs still belong to
  // their live Quick/detached window when the next progress event rebuilds it.
  for (const [id, owner] of owners) {
    if (owner !== surface.win.id) continue
    const status = surface.jobs.get(id)?.status
    if (surface.win.isDestroyed() || status !== 'queued' && status !== 'active') owners.delete(id)
  }
  surface.win.removeListener('resize', surfaceLayout)
  surface.win.removeListener('closed', surface.closed)
  surface.release()
  if (!surface.win.isDestroyed()) surface.win.contentView.removeChildView(surface.view)
  if (!surface.view.webContents.isDestroyed()) surface.view.webContents.close({ waitForBeforeUnload: false })
}
function surfaceLayout(): void { for (const surface of surfaces.values()) publish(surface) }
function publish(surface: Surface): void {
  if (surface.win.isDestroyed() || surface.view.webContents.isDestroyed()) return
  // A batch can contain 16 packages. Keep every pending task reachable and place
  // active work first; trimming the Map tail hides the earliest running jobs.
  const rank = { active: 0, queued: 1, done: 2, failed: 2 }
  const jobs = [...surface.jobs.values()].sort((a, b) => rank[a.status] - rank[b.status])
  const shown = surface.dragging || jobs.length > 0
  surface.view.setVisible(shown)
  clearTimeout(surface.idle)
  if (!shown) { surface.idle = setTimeout(() => destroy(surface), 8000); return }
  const bounds = surface.win.getContentBounds()
  const width = Math.min(380, bounds.width)
  const height = Math.min(Math.max(180, 72 + Math.min(jobs.length, 4) * 99), bounds.height - TITLEBAR_HEIGHT)
  surface.view.setBounds(surface.dragging
    ? { x: 0, y: 0, width: bounds.width, height: bounds.height }
    : { x: Math.max(0, bounds.width - width - 8), y: TITLEBAR_HEIGHT + 4, width, height })
  if (surface.ready) {
    const { mode, tokens } = resolveThemeTokens()
    const state: InstallSurfaceState = { dragging: surface.dragging, jobs, theme: mode, tokens,
      animation: settingsStore.getPluginAppearance().animationLevel ?? 'medium' }
    surface.view.webContents.send(IpcChannels.InstallSurfaceState, state)
  }
  raiseTransientViews(surface.win)
}
function ensure(win: BaseWindow): Surface {
  const current = surfaces.get(win.id)
  if (current) return current
  const view = new WebContentsView({ webPreferences: { preload: resolvePreload('installPreload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false } })
  view.setBackgroundColor('#00000000')
  view.setVisible(false)
  const surface: Surface = { win, view, dragging: false, jobs: new Map(), terminal: new Map(), ready: false, closed: () => {},
    release: registerTransientView(win, view, 200) }
  surfaces.set(win.id, surface)
  win.contentView.addChildView(view)
  win.on('resize', surfaceLayout)
  surface.closed = () => destroy(surface)
  win.once('closed', surface.closed)
  const dev = process.env.ELECTRON_RENDERER_URL
  const file = join(app.getAppPath(), 'out', 'renderer', 'install-overlay.html')
  // app path is independent of the terminal working directory in packaged builds.
  const target = dev ? `${dev.replace(/\/$/, '')}/install-overlay.html` : pathToFileURL(file).href
  registerTrustedSurface(view.webContents, 'install', target)
  view.webContents.on('render-process-gone', () => destroy(surface))
  void view.webContents.loadURL(target).catch(() => destroy(surface))
  return surface
}
function finish(surface: Surface, job: InstallProgressItem): void {
  surface.jobs.set(job.id, job)
  clearTimeout(surface.terminal.get(job.id))
  // Errors remain reviewable until dismissed; successful tasks retire after their completion state.
  if (job.status === 'done') surface.terminal.set(job.id, setTimeout(() => {
    surface.jobs.delete(job.id); surface.terminal.delete(job.id); owners.delete(job.id); publish(surface)
  }, 5000))
  const ended = [...surface.jobs.values()].filter(item => item.status === 'done' || item.status === 'failed')
  for (const old of ended.slice(0, Math.max(0, ended.length - 5))) {
    clearTimeout(surface.terminal.get(old.id)); surface.terminal.delete(old.id); surface.jobs.delete(old.id); owners.delete(old.id)
  }
}
function receive(payload: ShellEventPayload): void {
  if (payload.type === 'theme-changed' || payload.type === 'settings-changed' || payload.type === 'theme-packs-changed') { surfaceLayout(); return }
  if (payload.type === 'install-queue') {
    const running = [...payload.active, ...payload.waiting]
    for (const job of running) {
      const win = BaseWindow.getAllWindows().find(win => win.id === owners.get(job.id)) ?? getMainWindow()
      if (!win || win.isDestroyed()) continue
      const surface = ensure(win)
      surface.jobs.set(job.id, { ...surface.jobs.get(job.id), ...job })
    }
    for (const surface of surfaces.values()) {
      for (const job of surface.jobs.values()) if (['queued', 'active'].includes(job.status) && !running.some(current => current.id === job.id)) surface.jobs.delete(job.id)
      publish(surface)
    }
  } else if (payload.type === 'install-progress' || payload.type === 'install-result') {
    const win = BaseWindow.getAllWindows().find(win => win.id === owners.get(payload.jobId)) ?? getMainWindow()
    if (!win || win.isDestroyed()) return
    const surface = ensure(win)
    const previous = surface.jobs.get(payload.jobId)
    if (payload.type === 'install-progress') surface.jobs.set(payload.jobId, { id: payload.jobId, name: payload.name, status: 'active', progress: payload.progress, step: payload.step })
    else finish(surface, { id: payload.jobId, name: payload.name, status: payload.ok ? 'done' : 'failed', progress: payload.ok ? 100 : previous?.progress ?? 0, error: payload.error })
    publish(surface)
  }
}
export function registerInstallSurfaceHandlers(): void {
  setInstallEventSink(receive)
  ipcMain.on(IpcChannels.InstallDropState, (event, active: unknown) => {
    const win = sourceWindow(event)
    if (!win || typeof active !== 'boolean') return
    const existing = surfaces.get(win.id)
    if (!active && existing && event.sender.id !== existing.view.webContents.id) return
    const surface = active ? ensure(win) : existing
    if (!surface) return
    clearTimeout(surface.leave)
    if (active) { surface.dragging = true; publish(surface) }
    surface.leave = setTimeout(() => { surface.dragging = false; publish(surface) }, active ? 1800 : 120)
  })
  ipcMain.on(IpcChannels.InstallDropFiles, (event, value: unknown) => {
    const win = sourceWindow(event)
    if (!win || !Array.isArray(value) || value.length > 16) return
    const paths = [...new Set(value.filter((path): path is string => typeof path === 'string' && path.length <= 4096 && isAbsolute(path) && !path.includes('\0')))]
    const surface = ensure(win)
    clearTimeout(surface.leave); surface.dragging = false
    for (const path of paths) {
      if (!/\.(zip|enestplugin)$/i.test(path)) {
        finish(surface, { id: `invalid-${Date.now()}-${surface.jobs.size}`, name: path.split(/[\\/]/).pop() || '安装包', status: 'failed', progress: 0, error: '请选择 .zip 或 .enestplugin 插件包' })
        continue
      }
      enqueueInstall(path, job => owners.set(job.id, win.id))
    }
    publish(surface)
  })
  ipcMain.on(IpcChannels.InstallSurfaceReady, event => {
    const surface = [...surfaces.values()].find(item => item.view.webContents === event.sender && event.senderFrame === event.sender.mainFrame)
    if (surface) { surface.ready = true; publish(surface) }
  })
  ipcMain.on(IpcChannels.InstallSurfaceDismiss, (event, id: unknown) => {
    const surface = [...surfaces.values()].find(item => item.view.webContents === event.sender && event.senderFrame === event.sender.mainFrame)
    if (!surface || typeof id !== 'string') return
    const item = surface.jobs.get(id)
    if (!item || !['done', 'failed'].includes(item.status)) return
    clearTimeout(surface.terminal.get(id)); surface.terminal.delete(id); surface.jobs.delete(id); owners.delete(id); publish(surface)
  })
}
