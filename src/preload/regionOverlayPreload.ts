/**
 * regionOverlayPreload — 区域选择遮罩预加载
 * 向遮罩页暴露 confirm/cancel，经 IPC 回主进程 screenService。
 */
import { contextBridge, ipcRenderer } from 'electron'
import type { ScreenBounds } from '@shared/types/plugin'

contextBridge.exposeInMainWorld('regionOverlay', {
  confirm(bounds: ScreenBounds) {
    ipcRenderer.send('plugin:region-confirm', bounds)
  },
  cancel() {
    ipcRenderer.send('plugin:region-cancel')
  }
})
