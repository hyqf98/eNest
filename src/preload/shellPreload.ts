import { contextBridge } from 'electron'
import { shellBridge } from './shellBridge'
import { bindNativeInstallDrop } from './installDropBridge'
import { exposeNotificationClient } from './notificationClientBridge'
import { exposePluginWindowBridge } from './pluginWindowBridge'

contextBridge.exposeInMainWorld('enestShell', shellBridge)
exposePluginWindowBridge()
exposeNotificationClient()
bindNativeInstallDrop()
contextBridge.exposeInMainWorld('enestInstallNative', true)
