import { app, BaseWindow, shell, WebContentsView, webContents, type WebContents, type View, type WebPreferences } from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { SHELL_PARTITION } from '@shared/constants'
import { IpcChannels } from '@shared/types/ipc'
import type { NativeModalAction, NativeModalRequest, NativeModalState, ConfirmationOptions, OpenWithChoiceOption } from '@shared/types/modal'
import { handleShellIpc, onShellIpc, registerTrustedSurface, revokeTrustedSurface } from '@main/ipc/ipcSecurity'
import { getAppearance } from '@main/theme/appearanceService'
import { settingsStore } from '@main/settings/SettingsStore'
import { pluginHost } from '@main/plugin/PluginHost'
import { checkForUpdates, downloadUpdate, getUpdateState, quitAndInstallUpdate } from '@main/update/updateService'
import { getMainWindow, resolvePreload, setModalEventSink } from './createShellWindow'
import { registerTransientView, raiseTransientViews } from './transientViews'
import { suspendOrbRailViews } from './orbRailViews'
import { trackNativeInteraction } from '@main/plugin/pluginInteractionPolicy'

interface Modal {
  win: BaseWindow
  owner: WebContents
  view: WebContentsView
  state: NativeModalState
  previous: WebContents | null
  ready: boolean
  shown: boolean
  closed: boolean
  release(): void
  resumeChrome(): void
  settle(value: boolean): void
  layout(): void
  cancel(): void
  timer: ReturnType<typeof setTimeout>
}
const modals = new Map<number, Modal>()
let sequence = 0
let registered = false

function contains(view: View, wc: WebContents): boolean {
  return view instanceof WebContentsView && view.webContents === wc || view.children.some(child => contains(child, wc))
}
function visiblyContains(view: View, wc: WebContents): boolean {
  if (!view.getVisible()) return false
  return view instanceof WebContentsView && view.webContents === wc || view.children.some(child => visiblyContains(child, wc))
}
function options(raw: unknown): ConfirmationOptions {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid confirmation')
  const input = raw as Record<string, unknown>
  if (Object.keys(input).some(key => !['title', 'message', 'confirmLabel', 'danger'].includes(key))) throw new Error('Invalid confirmation field')
  for (const key of ['title', 'message', 'confirmLabel']) {
    if (typeof input[key] !== 'string' || !(input[key] as string).trim() || (input[key] as string).length > (key === 'message' ? 4000 : 120) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(input[key] as string)) throw new Error('Invalid confirmation text')
  }
  if (input.danger !== undefined && typeof input.danger !== 'boolean') throw new Error('Invalid confirmation danger flag')
  return { title: input.title as string, message: input.message as string, confirmLabel: input.confirmLabel as string, danger: input.danger === true }
}
function choiceOptions(raw: unknown): { title: string; message: string; value: string; choices: OpenWithChoiceOption[] } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid open-with choice')
  const input = raw as Record<string, unknown>
  const text = (key: string, max = 120): string => {
    const value = input[key]
    if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f]/.test(value)) throw new Error('Invalid open-with choice text')
    return value
  }
  const choices = input.choices
  if (!Array.isArray(choices) || !choices.length || choices.length > 8) throw new Error('Invalid open-with choices')
  const parsed: OpenWithChoiceOption[] = choices.map(item => {
    const entry = item as Record<string, unknown>
    if (!entry || typeof entry.pluginId !== 'string' || !entry.pluginId || typeof entry.pluginName !== 'string' || !entry.pluginName) {
      throw new Error('Invalid open-with choice entry')
    }
    return {
      pluginId: entry.pluginId, pluginName: entry.pluginName,
      icon: typeof entry.icon === 'string' ? entry.icon : undefined,
      glyph: typeof entry.glyph === 'string' ? entry.glyph : undefined,
      color: typeof entry.color === 'string' ? entry.color : undefined
    }
  })
  return { title: text('title'), message: text('message', 4000), value: text('value', 200), choices: parsed }
}
function publish(modal: Modal): void {
  if (modal.closed || modal.view.webContents.isDestroyed()) return
  modal.state.appearance = getAppearance()
  if (modal.state.kind === 'update') modal.state.update = getUpdateState()
  if (modal.ready) modal.view.webContents.send(IpcChannels.ModalState, modal.state)
  modal.layout()
  raiseTransientViews(modal.win)
}
function finish(modal: Modal, confirmed: boolean): void {
  if (modal.closed) return
  modal.closed = true
  modals.delete(modal.win.id)
  clearTimeout(modal.timer)
  modal.owner.removeListener('destroyed', modal.cancel)
  modal.win.removeListener('closed', modal.cancel)
  modal.win.removeListener('resize', modal.layout)
  modal.release()
  if (!modal.win.isDestroyed()) modal.win.contentView.removeChildView(modal.view)
  const wc = modal.view.webContents
  revokeTrustedSurface(wc)
  if (!wc.isDestroyed()) wc.close({ waitForBeforeUnload: false })
  modal.resumeChrome()
  if (!modal.win.isDestroyed() && modal.win.isVisible()) {
    const target = modal.previous && !modal.previous.isDestroyed() && visiblyContains(modal.win.contentView, modal.previous) ? modal.previous : modal.owner
    if (!target.isDestroyed() && visiblyContains(modal.win.contentView, target)) target.focus()
  }
  modal.settle(confirmed)
}

/** Host-owned native modal layer, never DOM above an untrusted native view. */
export function openNativeModal(owner: WebContents, request: NativeModalRequest, out?: { picked?: string }): Promise<boolean> {
  const win = BaseWindow.getAllWindows().find(item => !item.isDestroyed() && contains(item.contentView, owner))
  if (!win || modals.has(win.id)) return Promise.resolve(false)
  const confirmation = request.kind === 'confirm' ? options(request.options) : undefined
  const openWith = request.kind === 'open-with-choice' ? choiceOptions(request.options) : undefined
  const preferences: WebPreferences & { backgroundColor?: string } = {
    backgroundColor: '#00000000', preload: resolvePreload('modalPreload.cjs'),
    sandbox: true, contextIsolation: true, nodeIntegration: false, partition: SHELL_PARTITION,
  }
  const view = new WebContentsView({ webPreferences: preferences })
  view.setBackgroundColor('#00000000')
  view.setVisible(false)
  return trackNativeInteraction(new Promise<boolean>(settle => {
    const focused = webContents.getFocusedWebContents()
    const modal: Modal = {
      win, owner, view, ready: false, shown: false, closed: false, settle,
      previous: focused && contains(win.contentView, focused) ? focused : owner,
      state: { id: ++sequence, kind: request.kind, options: confirmation, openWith: openWith ? { value: openWith.value, choices: openWith.choices } : undefined, update: request.kind === 'update' ? getUpdateState() : undefined,
        dirtyItems: request.kind === 'update' ? pluginHost.getDirtySnapshot() : [], saving: false,
        locale: settingsStore.getAll().general.locale === 'en-US' ? 'en-US' : 'zh-CN', appearance: getAppearance() },
      release: registerTransientView(win, view, 300),
      resumeChrome: win === getMainWindow() ? suspendOrbRailViews() : () => {},
      layout: () => { if (!win.isDestroyed() && !view.webContents.isDestroyed()) { const { width, height } = win.getContentBounds(); view.setBounds({ x: 0, y: 0, width, height }) } },
      cancel: () => finish(modal, false),
      // 选择类对话框给用户留足考虑时间；确认/更新类维持快速超时
      timer: setTimeout(() => finish(modal, false), request.kind === 'open-with-choice' ? 120_000 : 8000)
    }
    modals.set(win.id, modal)
    if (out) {
      const inner = modal.settle
      modal.settle = (value: boolean) => {
        if (modal.state.openWithPicked) out.picked = modal.state.openWithPicked
        inner(value)
      }
    }
    win.contentView.addChildView(view)
    win.on('resize', modal.layout)
    win.once('closed', modal.cancel)
    owner.once('destroyed', modal.cancel)
    view.webContents.once('render-process-gone', modal.cancel)
    view.webContents.once('destroyed', modal.cancel)
    modal.layout()
    const dev = process.env.ELECTRON_RENDERER_URL
    const target = dev ? `${dev.replace(/\/$/, '')}/modal-overlay.html` : pathToFileURL(join(app.getAppPath(), 'out/renderer/modal-overlay.html')).href
    registerTrustedSurface(view.webContents, 'modal', target)
    void view.webContents.loadURL(target).catch(modal.cancel)
  }))
}

async function respond(modal: Modal, action: NativeModalAction): Promise<void> {
  if (modal.closed || modal.state.saving) return
  if (action === 'cancel') { finish(modal, false); return }
  if (modal.state.kind === 'confirm') { if (action === 'confirm') finish(modal, true); return }
  if (modal.state.kind === 'open-with-choice') {
    const match = /^open-with:(.+)$/.exec(action)
    if (match && modal.state.openWith?.choices.some(item => item.pluginId === match[1])) {
      modal.state.openWithPicked = match[1]
      finish(modal, true)
    }
    return
  }
  if (action === 'release') { await shell.openExternal('https://github.com/hyqf98/eNest/releases'); return }
  const status = getUpdateState().status
  if (action === 'download' && status === 'available') await downloadUpdate()
  else if (action === 'retry' && status === 'error') await checkForUpdates()
  else if (action === 'install' && status === 'downloaded') {
    modal.state.saving = true
    modal.state.dirtyItems = pluginHost.getDirtySnapshot()
    publish(modal)
    try {
      const summary = await pluginHost.requestSaveAll('update')
      if (summary.timedOut) throw new Error('部分插件未完成保存。请先处理未保存内容，再重试安装。')
      if (modal.closed) return
      const result = await quitAndInstallUpdate()
      if (result.status === 'error') throw new Error(result.error || '安装失败')
    } catch (error) {
      modal.state.saving = false
      modal.state.error = error instanceof Error ? error.message : '保存或安装失败'
    }
  }
  publish(modal)
}

export function registerModalSurfaceHandlers(): void {
  if (registered) return
  registered = true
  setModalEventSink(event => {
    if (event.type === 'appearance-changed' || event.type === 'update-status' || event.type === 'settings-changed') for (const modal of modals.values()) publish(modal)
  })
  handleShellIpc(IpcChannels.ModalOpen, (event, request: NativeModalRequest) => {
    if (!request || typeof request !== 'object' || !['confirm', 'update', 'open-with-choice'].includes(request.kind)) throw new Error('Invalid modal request')
    return openNativeModal(event.sender, request)
  })
  onShellIpc(IpcChannels.ModalReady, (event, painted?: { id?: unknown; revision?: unknown }) => {
    const modal = [...modals.values()].find(item => item.view.webContents === event.sender)
    if (!modal || modal.closed || modal.shown) return
    if (painted === undefined) {
      if (modal.ready) return
      modal.ready = true
      publish(modal)
      return
    }
    if (!modal.ready || painted?.id !== modal.state.id || painted.revision !== modal.state.appearance.revision) return
    modal.shown = true
    clearTimeout(modal.timer)
    modal.view.setVisible(true)
    modal.view.webContents.focus()
    raiseTransientViews(modal.win)
  })
  onShellIpc(IpcChannels.ModalRespond, (event, id: unknown, action: NativeModalAction) => {
    const modal = [...modals.values()].find(item => item.view.webContents === event.sender && item.state.id === id)
    if (!modal?.shown || (!['confirm', 'cancel', 'download', 'retry', 'install', 'release'].includes(action) && !/^open-with:.+$/.test(action))) return
    void respond(modal, action).catch(error => {
      if (modal.closed) return
      modal.state.error = error instanceof Error ? error.message : '操作失败'
      publish(modal)
    })
  })
}
