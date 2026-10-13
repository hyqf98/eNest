/**
 * recorderPreload — 隐藏录制窗预加载
 * 将 MediaRecorder 产生的 ArrayBuffer 分片送回主进程落盘。
 */
import { contextBridge, ipcRenderer } from 'electron'
import { IpcChannels } from '@shared/types/ipc'

contextBridge.exposeInMainWorld('recorderBridge', {
  started() {
    ipcRenderer.send(IpcChannels.PluginRecorderStarted)
  },
  failed(message: string) {
    ipcRenderer.send(IpcChannels.PluginRecorderFailed, String(message ?? 'unknown'))
  },
  audioUnavailable(message: string) {
    ipcRenderer.send(IpcChannels.PluginRecorderAudioUnavailable, String(message ?? 'unknown'))
  },
  chunk(buf: ArrayBuffer) {
    ipcRenderer.send(IpcChannels.PluginRecorderChunk, buf)
  },
  stopped() {
    ipcRenderer.send(IpcChannels.PluginRecorderStopped)
  }
})
