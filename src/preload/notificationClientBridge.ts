import { contextBridge, ipcRenderer } from 'electron'
import * as IpcChannels from '@shared/types/ipc'
import type { NotificationClientApi } from '@shared/types/notification'

export function exposeNotificationClient(): void {
  const api: NotificationClientApi = {
    show: options => ipcRenderer.invoke(IpcChannels.NotificationShow, options),
    dismiss: id => ipcRenderer.invoke(IpcChannels.NotificationDismiss, id)
  }
  contextBridge.exposeInMainWorld('enestNotifications', api)
}
