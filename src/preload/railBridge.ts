import { ipcRenderer } from 'electron'
import { IpcChannels } from '@shared/types/ipc'
import type { NativeShellApi, RAIL_METHODS } from '@shared/types/shellApi'
import { expectOk } from './shellIpcResult'
import { dockBridge } from './dockBridge'

export const railBridge = {
  ...dockBridge,
  goHome: () => expectOk(ipcRenderer.invoke(IpcChannels.ShellGoHome)),
  activatePlugin: (tabId: string) =>
    expectOk(ipcRenderer.invoke(IpcChannels.ShellActivatePlugin, tabId)),
  closePlugin: (tabId: string) =>
    expectOk(ipcRenderer.invoke(IpcChannels.ShellClosePlugin, tabId)),
  setOrbRailExpanded: (expanded: boolean) =>
    expectOk(ipcRenderer.invoke(IpcChannels.ShellSetOrbRailExpanded, expanded)),
  setOrbDock: (dock: 'left' | 'right') =>
    expectOk(ipcRenderer.invoke(IpcChannels.ShellSetOrbDock, dock)),
  setOrbRailCaption: (open: boolean) =>
    expectOk(ipcRenderer.invoke(IpcChannels.ShellSetOrbRailCaption, open)),
  activateRailContribution: id => ipcRenderer.invoke(IpcChannels.ShellActivateRailContribution, id)
} satisfies Pick<NativeShellApi, typeof RAIL_METHODS[number]>
