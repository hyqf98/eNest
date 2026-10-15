import { exposePluginWindowBridge } from './pluginWindowBridge'
import { exposeNotificationClient } from './notificationClientBridge'
import { bindNativeInstallDrop } from './installDropBridge'

// Detached windows intentionally receive no shell settings or plugin-management API.
exposePluginWindowBridge()
exposeNotificationClient()
bindNativeInstallDrop()
