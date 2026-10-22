import { contextBridge, ipcRenderer } from 'electron'
import { IpcChannels } from '@shared/types/ipc'
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
  HomeSearchScope,
  HomeSearchResult
} from '@shared/types/home'
import type { WorkspaceNavigationAck } from '@shared/types/workspace'

const api: EnestHomeApi = {
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
  search(request: { query: string; scope?: HomeSearchScope; limit?: number }): Promise<HomeSearchResult> {
    return ipcRenderer.invoke(IpcChannels.HomeSearch, request)
  },
  refresh(request: { reason?: 'manual' | 'boot' } = {}): Promise<HomeCatalog> {
    return ipcRenderer.invoke(IpcChannels.HomeRefresh, request)
  },
  action(request: HomeAction): Promise<HomeActionResponse> {
    return ipcRenderer.invoke(IpcChannels.HomeAction, request)
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
