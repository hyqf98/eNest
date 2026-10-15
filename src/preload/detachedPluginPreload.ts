import { exposePluginWindowBridge } from './pluginWindowBridge'

// Detached windows intentionally receive no shell settings or plugin-management API.
exposePluginWindowBridge()
