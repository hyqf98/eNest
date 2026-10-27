import { contextBridge, ipcRenderer } from 'electron'
import * as IpcChannels from '@shared/types/ipc'
import type { AuxiliaryPageApi } from '@shared/types/auxiliary'

const api: AuxiliaryPageApi = {
  getContext: () => ipcRenderer.invoke(IpcChannels.AuxiliaryContext),
  onMessage: callback => {
    const listener = (_event: Electron.IpcRendererEvent, data: unknown): void => callback(data)
    ipcRenderer.on(IpcChannels.AuxiliaryMessage, listener)
    return () => ipcRenderer.removeListener(IpcChannels.AuxiliaryMessage, listener)
  },
  post: data => ipcRenderer.invoke(IpcChannels.AuxiliaryPost, data),
  close: () => ipcRenderer.invoke(IpcChannels.AuxiliaryClose)
}
contextBridge.exposeInMainWorld('enestAux', api)
