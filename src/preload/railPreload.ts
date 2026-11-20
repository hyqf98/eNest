import { contextBridge } from 'electron'
import { railBridge } from './railBridge'
import { exposePluginWindowBridge } from './pluginWindowBridge'

contextBridge.exposeInMainWorld('enestBuiltinChrome', railBridge)
exposePluginWindowBridge()
