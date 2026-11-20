import { contextBridge } from 'electron'
import { dockBridge } from './dockBridge'

contextBridge.exposeInMainWorld('enestBuiltinChrome', dockBridge)
