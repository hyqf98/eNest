import { contextBridge, ipcRenderer } from 'electron'
import * as IpcChannels from '@shared/types/ipc'
import type { PanelWidgetRect } from '@shared/types/panel'

/** 区域选择 overlay 的最小桥：只上报确认/取消，不接受任何主进程命令。 */
const api = {
  confirm: (rect: PanelWidgetRect): void => { ipcRenderer.send(IpcChannels.RegionConfirm, rect) },
  cancel: (): void => { ipcRenderer.send(IpcChannels.RegionCancel) }
}
contextBridge.exposeInMainWorld('enestRegion', api)
