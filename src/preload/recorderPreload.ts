/**
 * recorderPreload — 隐藏录制窗预加载
 * 将 MediaRecorder 产生的 ArrayBuffer 分片送回主进程落盘。
 */
import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('recorderBridge', {
  started() {
    ipcRenderer.send('plugin:recorder-started')
  },
  failed(message: string) {
    ipcRenderer.send('plugin:recorder-failed', String(message ?? 'unknown'))
  },
  audioUnavailable(message: string) {
    ipcRenderer.send('plugin:recorder-audio-unavailable', String(message ?? 'unknown'))
  },
  chunk(buf: ArrayBuffer) {
    ipcRenderer.send('plugin:recorder-chunk', buf)
  },
  stopped() {
    ipcRenderer.send('plugin:recorder-stopped')
  }
})
