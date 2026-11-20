import { ipcRenderer } from 'electron'
import { IpcChannels } from '@shared/types/ipc'
import type { NativeShellApi, QUICK_HOST_METHODS } from '@shared/types/shellApi'
import type { QuickInputMessage } from '@shared/types/plugin-tools'
import type { ShellEventPayload } from '@shared/types/ipc'
import type { AppearanceSnapshot } from '@shared/types/appearance'
import type { QuickCommandKind, QuickInputContextRequest, QuickInputContextResult, QuickOpenRequest, QuickOpenResult, QuickSearchResult } from '@shared/types/quick'
import type { Unsubscribe } from '@shared/types/pluginApi'

export const quickControllerBridge = {
  getAppearance: () => ipcRenderer.invoke(IpcChannels.ShellGetAppearance) as Promise<AppearanceSnapshot>,
  readCustomFont: (fileName: string) =>
    ipcRenderer.invoke(IpcChannels.ShellReadCustomFont, fileName) as Promise<{
      ok: boolean
      dataBase64?: string
      error?: string
    }>,
  onEvent(cb: (payload: ShellEventPayload) => void): Unsubscribe {
    const handler = (_e: Electron.IpcRendererEvent, payload: ShellEventPayload) => cb(payload)
    ipcRenderer.on(IpcChannels.ShellEvent, handler)
    return () => ipcRenderer.removeListener(IpcChannels.ShellEvent, handler)
  },
  onQuickShown(cb: () => void): Unsubscribe {
    const handler = () => cb()
    ipcRenderer.on(IpcChannels.QuickShown, handler)
    return () => ipcRenderer.removeListener(IpcChannels.QuickShown, handler)
  },
  onQuickThemeKey(cb) {
    const handler = (_event: unknown, data: { key: string; meta?: boolean; ctrl?: boolean; alt?: boolean; shift?: boolean }) => cb(data)
    ipcRenderer.on(IpcChannels.QuickThemeKey, handler)
    return () => ipcRenderer.removeListener(IpcChannels.QuickThemeKey, handler)
  },
  quickSearch: (query: string, limit?: number, kind?: QuickCommandKind, phase?: import('@shared/types/quick').QuickSearchPhase, ids?: string[]) =>
    ipcRenderer.invoke(IpcChannels.QuickSearch, { query, limit, kind, phase, ids }) as Promise<QuickSearchResult>,
  quickOpen: (req: QuickOpenRequest) =>
    ipcRenderer.invoke(IpcChannels.QuickOpen, req) as Promise<QuickOpenResult>,
  quickHide: () => {
    ipcRenderer.invoke(IpcChannels.QuickHide).catch(() => undefined)
  },
  quickResize: (height: number, animate?: boolean) => {
    ipcRenderer.send(IpcChannels.QuickResize, { height, animate })
  },
  quickInput: (message?: QuickInputMessage) => ipcRenderer.invoke(IpcChannels.QuickInput, message),
  quickInputContext: (request: QuickInputContextRequest) => ipcRenderer.invoke(IpcChannels.QuickInputContext, request) as Promise<QuickInputContextResult>,
  quickGetTheme: () => ipcRenderer.invoke(IpcChannels.QuickThemeGetConfig),
  quickAuthorizeTheme: key => ipcRenderer.invoke(IpcChannels.QuickThemeAuthorize, key),
  quickProviderState: request => ipcRenderer.invoke(IpcChannels.QuickProviderState, request)
} satisfies Pick<NativeShellApi, typeof QUICK_HOST_METHODS[number]>
