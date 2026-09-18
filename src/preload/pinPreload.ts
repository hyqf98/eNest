/**
 * pinPreload — 贴图窗预加载：关闭按钮回主进程
 */
import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('pinCtl', {
  close() {
    ipcRenderer.send('plugin:pin-close')
  }
})
