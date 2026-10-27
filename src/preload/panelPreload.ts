import { contextBridge, ipcRenderer } from 'electron'
import * as IpcChannels from '@shared/types/ipc'
import type { PluginDragFeedback, PluginDropTarget } from '@shared/types/plugin-window'
import type { PanelCandidate, PanelCommand, PanelDragFeedback, PanelState, PanelSurfaceApi } from '@shared/types/panel'

/**
 * 面板 chrome 桥：状态读取、统一命令入口、拖动反馈、外部拖入落点注册。
 * 所有入参校验在主进程 panelHandlers 完成；这里不做业务判断。
 */
interface PanelCommandResult { ok: boolean; error?: string; state?: PanelState; candidates?: PanelCandidate[] }

const api: PanelSurfaceApi = {
  getState: () => ipcRenderer.invoke(IpcChannels.PanelGetState) as Promise<PanelState | null>,
  command: command => ipcRenderer.invoke(IpcChannels.PanelCommand, command) as Promise<PanelCommandResult>,
  dragTick: () => { ipcRenderer.send(IpcChannels.PanelDragTick) },
  onState: listener => {
    const handle = (_event: Electron.IpcRendererEvent, state: PanelState): void => listener(state)
    ipcRenderer.on(IpcChannels.PanelState, handle)
    return () => { ipcRenderer.removeListener(IpcChannels.PanelState, handle) }
  },
  onDrag: listener => {
    const handle = (_event: Electron.IpcRendererEvent, feedback: PanelDragFeedback): void => listener(feedback)
    ipcRenderer.on(IpcChannels.PanelDrag, handle)
    return () => { ipcRenderer.removeListener(IpcChannels.PanelDrag, handle) }
  },
  /**
   * 声明本面板内容区为插件拖入目标。
   * 主进程据此把拖拽反馈推给面板（落点高亮），并在松手时按落点坐标嵌入组件。
   */
  setDropTarget: (target: PluginDropTarget | null) => {
    ipcRenderer.send(IpcChannels.PluginDragTargets, target ? [target] : [])
  },
  onPluginDrag: listener => {
    const handle = (_event: Electron.IpcRendererEvent, feedback: PluginDragFeedback): void => listener(feedback)
    ipcRenderer.on(IpcChannels.PluginDragEvent, handle)
    return () => { ipcRenderer.removeListener(IpcChannels.PluginDragEvent, handle) }
  }
}
contextBridge.exposeInMainWorld('enestPanel', api)
export type { PanelCommand }
