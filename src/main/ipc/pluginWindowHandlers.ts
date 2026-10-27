import { IpcChannels } from '@shared/types/ipc'
import type { PluginWindowCommand } from '@shared/types/plugin-window'
import { handleShellIpc, onShellIpc } from '@main/ipc/ipcSecurity'
import { pluginHost } from '@main/plugin/PluginHost'
import { getQuickInputState, handleQuickInput } from '@main/plugin/quickInputService'
import { getDetachedState, getDetachedWindow, getPluginForDetachedSender, toggleDetachedAlwaysOnTop } from '@main/window/detachedPluginWindows'
import {
  armPluginWindowDrag, beginPluginWindowDrag, canSurfaceManagePlugin, endPluginWindowDrag,
  registerPluginDropTargets, updatePluginWindowDrag
} from '@main/window/pluginWindowDrag'

/** Every instance target is derived from the registered sender; no arbitrary window IDs cross IPC. */
export function registerPluginWindowHandlers(): void {
  handleShellIpc(IpcChannels.PluginWindowState, event => {
    const id = getPluginForDetachedSender(event.sender.id)
    if (!id) return null
    const state = getDetachedState(id)
    return state ? { ...state, input: getQuickInputState(id) } : null
  })
  handleShellIpc(IpcChannels.PluginWindowCommand, async (event, command: PluginWindowCommand) => {
    try {
      if (!command || typeof command !== 'object' || typeof command.action !== 'string') throw new Error('Invalid window command')
      if (command.action === 'detach' || command.action === 'dock') {
        if (!canSurfaceManagePlugin(event.sender.id, command.pluginId)) throw new Error('Plugin does not belong to this surface')
        if (command.action === 'detach') await pluginHost.detachPlugin(command.pluginId)
        else {
          if (command.target !== 'shell' && command.target !== 'quick') throw new Error('Invalid dock target')
          if (command.index !== undefined && (!Number.isSafeInteger(command.index) || command.index < 0 || command.index > 10000)) throw new Error('Invalid insertion index')
          await pluginHost.dockPlugin(command.pluginId, command.target, command.index)
        }
        return { ok: true }
      }
      const id = getPluginForDetachedSender(event.sender.id)
      if (!id || !canSurfaceManagePlugin(event.sender.id, id)) throw new Error('Independent window sender required')
      const win = getDetachedWindow(id)
      if (!win || win.isDestroyed()) throw new Error('Window is closed')
      switch (command.action) {
        case 'activate': await pluginHost.openPlugin(id, undefined, { trustedUserNavigation: true }); break
        case 'toggle-always-on-top': toggleDetachedAlwaysOnTop(id); break
        case 'minimize': win.minimize(); break
        case 'maximize': if (win.isMaximized()) win.unmaximize(); else win.maximize(); break
        case 'close': win.close(); break
        case 'retry': await pluginHost.reloadPlugin(id); break
        case 'focus-plugin': return { ok: pluginHost.focusPlugin(id) }
        case 'focus-search': return { ok: pluginHost.focusSearch(id) }
        case 'input': {
          if (!command.message || command.message.pluginId !== id || !Number.isSafeInteger(command.message.generation)) throw new Error('Input owner mismatch')
          return { ok: handleQuickInput(command.message) }
        }
        case 'input-tab': {
          if (!pluginHost.isQuickInputOwner(id)) return { ok: false }
          const contents = pluginHost.getWebContents(id)
          if (!contents || contents.isDestroyed()) return { ok: false }
          contents.focus()
          const modifiers: Array<'shift'> = command.shift === true ? ['shift'] : []
          contents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab', modifiers })
          contents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab', modifiers })
          break
        }
        default: throw new Error('Unsupported window command')
      }
      return { ok: true }
    } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } }
  })
  onShellIpc(IpcChannels.PluginDragArm, (event, pluginId: string | null) => {
    if (pluginId === null || typeof pluginId === 'string') armPluginWindowDrag(event.sender.id, pluginId)
  })
  handleShellIpc(IpcChannels.PluginDragBegin, (event, pluginId: string) => beginPluginWindowDrag(event.sender.id, pluginId))
  onShellIpc(IpcChannels.PluginDragUpdate, (event, token: string) => { if (typeof token === 'string') updatePluginWindowDrag(event.sender.id, token) })
  handleShellIpc(IpcChannels.PluginDragEnd, (event, token: string, cancel?: boolean) => {
    if (typeof token !== 'string') return
    return endPluginWindowDrag(event.sender.id, token, cancel === true)
  })
  onShellIpc(IpcChannels.PluginDragTargets, (event, targets: unknown) => registerPluginDropTargets(event.sender, targets))
}
