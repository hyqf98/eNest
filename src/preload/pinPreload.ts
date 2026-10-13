/**
 * pinPreload — 贴图窗预加载：关闭按钮回主进程
 */
import { contextBridge, ipcRenderer } from 'electron'
import { IpcChannels } from '@shared/types/ipc'

contextBridge.exposeInMainWorld('pinCtl', {
  close() {
    ipcRenderer.send(IpcChannels.PluginPinClose)
  }
})
