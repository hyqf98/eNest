import { contextBridge, ipcRenderer } from 'electron'
import { ThemeChromeChannels, type ThemeChromeApi, type ThemeChromeSnapshot } from '@shared/types/themeChrome'

const api: ThemeChromeApi = {
  getSnapshot: () => ipcRenderer.invoke(ThemeChromeChannels.Snapshot),
  onSnapshot: listener => {
    const receive = (_event: Electron.IpcRendererEvent, value: ThemeChromeSnapshot): void => listener(value)
    ipcRenderer.on(ThemeChromeChannels.Changed, receive)
    return () => { ipcRenderer.removeListener(ThemeChromeChannels.Changed, receive) }
  },
  dispatch: action => ipcRenderer.invoke(ThemeChromeChannels.Action, action),
  ready: () => ipcRenderer.invoke(ThemeChromeChannels.Ready)
}
contextBridge.exposeInMainWorld('enestChrome', api)
