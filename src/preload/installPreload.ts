import { contextBridge, ipcRenderer } from 'electron'
import * as IpcChannels from '@shared/types/ipc'
import type { InstallSurfaceState } from '@shared/types/install'
import { bindNativeInstallDrop } from './installDropBridge'

bindNativeInstallDrop()
contextBridge.exposeInMainWorld('enestInstall', {
  ready: () => ipcRenderer.send(IpcChannels.InstallSurfaceReady),
  dismiss: (jobId: string) => ipcRenderer.send(IpcChannels.InstallSurfaceDismiss, jobId),
  onState: (listener: (state: InstallSurfaceState) => void) => {
    const handle = (_event: Electron.IpcRendererEvent, state: InstallSurfaceState) => listener(state)
    ipcRenderer.on(IpcChannels.InstallSurfaceState, handle)
    return () => ipcRenderer.removeListener(IpcChannels.InstallSurfaceState, handle)
  }
})
