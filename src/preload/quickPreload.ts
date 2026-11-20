import { contextBridge, ipcRenderer } from 'electron'
import { IpcChannels } from '@shared/types/ipc'
import type { QuickHostBridge } from '@shared/types/shellApi'
import { quickControllerBridge } from './quickControllerBridge'
import { bindNativeInstallDrop } from './installDropBridge'
import { exposePluginWindowBridge } from './pluginWindowBridge'
import { exposeNotificationClient } from './notificationClientBridge'

contextBridge.exposeInMainWorld('enestQuickHost', {
  ...quickControllerBridge, getLocale: () => ipcRenderer.invoke(IpcChannels.QuickGetLocale)
} satisfies QuickHostBridge)
exposePluginWindowBridge()
exposeNotificationClient()
bindNativeInstallDrop()
contextBridge.exposeInMainWorld('enestInstallNative', true)
