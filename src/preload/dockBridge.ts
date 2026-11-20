import { ipcRenderer } from 'electron'
import { IpcChannels } from '@shared/types/ipc'
import type { NativeShellApi, DOCK_METHODS } from '@shared/types/shellApi'
import type { OrbEventPayload, OrbRailState } from '@shared/types/ipc'
import { expectOk } from './shellIpcResult'
import type { Unsubscribe } from '@shared/types/pluginApi'

export const dockBridge = {
  getOrbState: () =>
    ipcRenderer.invoke(IpcChannels.ShellGetOrbState) as Promise<OrbRailState>,
  onOrbEvent(cb): Unsubscribe {
    const handler = (
      _e: Electron.IpcRendererEvent,
      payload: OrbEventPayload
    ) => cb(payload)
    ipcRenderer.on(IpcChannels.ShellOrbEvent, handler)
    return () => ipcRenderer.removeListener(IpcChannels.ShellOrbEvent, handler)
  },
  setShellView: (view: string) =>
    expectOk(ipcRenderer.invoke(IpcChannels.ShellSetView, view))
} satisfies Pick<NativeShellApi, typeof DOCK_METHODS[number]>
