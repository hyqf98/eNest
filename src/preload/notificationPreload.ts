import { contextBridge, ipcRenderer } from 'electron'
import { IpcChannels } from '@shared/types/ipc'
import type { NotificationOverlayApi, NotificationOverlayState } from '@shared/types/notification'

const api: NotificationOverlayApi = {
  getState: () => ipcRenderer.invoke(IpcChannels.NotificationState),
  onState(listener) {
    const handler = (_event: Electron.IpcRendererEvent, state: NotificationOverlayState) => listener(state)
    ipcRenderer.on(IpcChannels.NotificationState, handler)
    return () => ipcRenderer.removeListener(IpcChannels.NotificationState, handler)
  },
  dismiss: id => ipcRenderer.invoke(IpcChannels.NotificationDismiss, id),
  measure: height => ipcRenderer.send(IpcChannels.NotificationMeasure, height),
  openLink: url => ipcRenderer.invoke(IpcChannels.NotificationOpenLink, url)
}
contextBridge.exposeInMainWorld('enestNotificationOverlay', api)
