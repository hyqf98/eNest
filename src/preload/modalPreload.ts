import { contextBridge, ipcRenderer } from 'electron'
import * as IpcChannels from '@shared/types/ipc'
import type { NativeModalApi, NativeModalState } from '@shared/types/modal'

const api: NativeModalApi = {
  ready: painted => ipcRenderer.send(IpcChannels.ModalReady, painted),
  respond: (id, action) => ipcRenderer.send(IpcChannels.ModalRespond, id, action),
  onState: listener => {
    const handle = (_event: Electron.IpcRendererEvent, state: NativeModalState): void => listener(state)
    ipcRenderer.on(IpcChannels.ModalState, handle)
    return () => { ipcRenderer.removeListener(IpcChannels.ModalState, handle) }
  }
}
contextBridge.exposeInMainWorld('enestModal', api)
