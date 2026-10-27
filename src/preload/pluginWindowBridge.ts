import { contextBridge, ipcRenderer } from 'electron'
import * as IpcChannels from '@shared/types/ipc'
import type { PluginDragFeedback, PluginWindowEvent, PluginWindowsApi } from '@shared/types/plugin-window'

/** The same narrow capability bridge is used by shell chrome and detached chrome. */
export function exposePluginWindowBridge(): void {
  const api: PluginWindowsApi = {
    armDrag: pluginId => ipcRenderer.send(IpcChannels.PluginDragArm, pluginId),
    getState: () => ipcRenderer.invoke(IpcChannels.PluginWindowState),
    command: command => ipcRenderer.invoke(IpcChannels.PluginWindowCommand, command),
    beginDrag: pluginId => ipcRenderer.invoke(IpcChannels.PluginDragBegin, pluginId),
    updateDrag: token => ipcRenderer.send(IpcChannels.PluginDragUpdate, token),
    endDrag: (token, cancel = false) => ipcRenderer.invoke(IpcChannels.PluginDragEnd, token, cancel),
    targets: targets => ipcRenderer.send(IpcChannels.PluginDragTargets, targets),
    onDrag(callback) {
      const listener = (_: Electron.IpcRendererEvent, event: PluginDragFeedback) => callback(event)
      ipcRenderer.on(IpcChannels.PluginDragEvent, listener)
      return () => ipcRenderer.removeListener(IpcChannels.PluginDragEvent, listener)
    },
    onEvent(callback) {
      const listener = (_: Electron.IpcRendererEvent, event: PluginWindowEvent) => callback(event)
      ipcRenderer.on(IpcChannels.PluginWindowEvent, listener)
      return () => ipcRenderer.removeListener(IpcChannels.PluginWindowEvent, listener)
    }
  }
  contextBridge.exposeInMainWorld('enestWindows', api)
}
