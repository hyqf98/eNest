import { contextBridge, ipcRenderer } from 'electron'
import * as IpcChannels from '@shared/types/ipc'
import type {
  HomeAction,
  HomeActionResponse,
  HomeAppearanceSnapshot,
  HomeCatalog,
  HomeCommand,
  HomeDetail,
  EnestHomeApi,
  HomeEventData,
  HomeReadyPayload,
  HomeRuntimeConfig,
  HomeSearchRequest,
  HomeSearchResult,
  HomeTabsSnapshot
} from '@shared/types/home'
import type { WorkspaceNavigationAck } from '@shared/types/workspace'
import type { SearchFiles } from '@shared/types/fileSearch'

const api: EnestHomeApi = {
  openFileSearch: () => ipcRenderer.invoke(IpcChannels.HomeFiles, { operation: 'present' }),
  ready(payload: HomeReadyPayload = {}): Promise<void> {
    return ipcRenderer.invoke(IpcChannels.HomeReady, payload)
  },
  ackNavigation(payload: WorkspaceNavigationAck): Promise<void> {
    return ipcRenderer.invoke(IpcChannels.HomeAck, payload)
  },
  getAppearance(): Promise<HomeAppearanceSnapshot> {
    return ipcRenderer.invoke(IpcChannels.HomeGetAppearance)
  },
  getConfig(): Promise<HomeRuntimeConfig> {
    return ipcRenderer.invoke(IpcChannels.HomeGetConfig)
  },
  getCatalog(): Promise<HomeCatalog> {
    return ipcRenderer.invoke(IpcChannels.HomeGetCatalog)
  },
  getDetail(id: string): Promise<HomeDetail | null> {
    return ipcRenderer.invoke(IpcChannels.HomeGetDetail, id)
  },
  search(request: HomeSearchRequest): Promise<HomeSearchResult> {
    return ipcRenderer.invoke(IpcChannels.HomeSearch, request)
  },
  refresh(request: { reason?: 'manual' | 'boot' } = {}): Promise<HomeCatalog> {
    return ipcRenderer.invoke(IpcChannels.HomeRefresh, request)
  },
  action(request: HomeAction): Promise<HomeActionResponse> {
    return ipcRenderer.invoke(IpcChannels.HomeAction, request)
  },
  getTabs(): Promise<HomeTabsSnapshot> {
    return ipcRenderer.invoke(IpcChannels.HomeGetTabs)
  },
  onTabs(listener: (payload: HomeTabsSnapshot) => void): () => void {
    const handler = (_event: unknown, data: HomeEventData): void => {
      if (data?.tabs) listener(data.tabs)
    }
    ipcRenderer.on(IpcChannels.HomeEvent, handler)
    return () => { ipcRenderer.removeListener(IpcChannels.HomeEvent, handler) }
  },
  onAppearance(listener: (payload: HomeAppearanceSnapshot) => void): () => void {
    const handler = (_event: unknown, data: HomeEventData): void => {
      if (data?.appearance?.appearance) {
        listener(data.appearance)
      }
    }
    ipcRenderer.on(IpcChannels.HomeEvent, handler)
    return () => { ipcRenderer.removeListener(IpcChannels.HomeEvent, handler) }
  },
  onCommand(listener: (payload: HomeCommand) => void): () => void {
    const handler = (_event: unknown, data: HomeEventData): void => {
      if (data?.command) {
        listener(data.command)
      }
    }
    ipcRenderer.on(IpcChannels.HomeEvent, handler)
    return () => { ipcRenderer.removeListener(IpcChannels.HomeEvent, handler) }
  }
}

contextBridge.exposeInMainWorld('enestHome', api)
contextBridge.exposeInMainWorld('enestWorkspace', api)
if (process.argv.includes('--enest-builtin-workspace')) {
  const searchFiles: SearchFiles = request => ipcRenderer.invoke(IpcChannels.HomeFiles, request)
  contextBridge.exposeInMainWorld('enestWorkspaceFiles', { searchFiles })
}
