import type { WebContents } from 'electron'
import { IpcChannels } from '@shared/types/ipc'
import type { PluginShortcutInput } from '@shared/types/shortcuts'
import { handleShellIpc } from './ipcSecurity'
import { getMainWindow } from '@main/window/createShellWindow'
import { isShortcutCaptureActiveForOwner, onHotkeyRegistryChange } from '@main/hotkey/hotkeyRegistry'
import {
  getPluginShortcuts, savePluginShortcut, removePluginShortcut, probePluginShortcut,
  launchPluginShortcut, beginShortcutCapture, endShortcutCapture, endShortcutCapturesForOwner
} from '@main/hotkey/pluginShortcuts'

/** Capture leases belong to the trusted shell document, never to a renderer-provided ID. */
const captureDocuments = new WeakMap<WebContents, () => void>()

export function registerShortcutHandlers(): void {
  handleShellIpc(IpcChannels.ShellGetPluginShortcuts, () => getPluginShortcuts())
  handleShellIpc(IpcChannels.ShellSavePluginShortcut, (_event, input: PluginShortcutInput) => savePluginShortcut(input))
  handleShellIpc(IpcChannels.ShellRemovePluginShortcut, (_event, id: string) => removePluginShortcut(id))
  handleShellIpc(IpcChannels.ShellProbePluginShortcut, (_event, accelerator: string, excludeId?: string) => probePluginShortcut(accelerator, excludeId))
  handleShellIpc(IpcChannels.ShellLaunchPluginShortcut, (_event, id: string) => launchPluginShortcut(id))
  handleShellIpc(IpcChannels.ShellBeginShortcutCapture, event => {
    const sender = event.sender
    const win = getMainWindow()
    if (!win || win.isDestroyed() || !win.isFocused() || !sender.isFocused()) {
      throw new Error('请先聚焦快捷键设置页')
    }
    if (!captureDocuments.has(sender)) {
      let menuIgnored = false
      const syncMenu = () => {
        if (sender.isDestroyed()) return
        const capturing = isShortcutCaptureActiveForOwner(sender.id)
        if (menuIgnored === capturing) return
        sender.setIgnoreMenuShortcuts(capturing)
        menuIgnored = capturing
      }
      captureDocuments.set(sender, syncMenu)
      const offRegistry = onHotkeyRegistryChange(syncMenu)
      const release = () => endShortcutCapturesForOwner(sender.id)
      sender.on('blur', release)
      sender.on('did-start-navigation', release)
      sender.on('render-process-gone', release)
      win.on('blur', release)
      win.on('hide', release)
      sender.once('destroyed', () => {
        release()
        offRegistry()
        captureDocuments.delete(sender)
        win.removeListener('blur', release)
        win.removeListener('hide', release)
      })
    }
    try {
      const token = beginShortcutCapture(sender.id)
      // Fail capture if the native menu guard could not be applied; do not let Cmd+Q/W escape recording.
      captureDocuments.get(sender)!()
      return { token }
    } catch (error) {
      endShortcutCapturesForOwner(sender.id)
      throw error
    }
  })
  handleShellIpc(IpcChannels.ShellEndShortcutCapture, (event, token: string) => endShortcutCapture(token, event.sender.id))
}
