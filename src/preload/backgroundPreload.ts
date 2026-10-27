import { contextBridge, ipcRenderer } from 'electron'
import * as IpcChannels from '@shared/types/ipc'
import { BACKGROUND_MESSAGE_LIMIT, type BackgroundRequest, type BackgroundResponse } from '@shared/types/pluginBackgroundProtocol'
import type { PluginBackgroundBridge, PluginBackgroundHandlers } from '@shared/types/pluginBackground'

let handlers: PluginBackgroundHandlers | undefined
let running = 0
function bounded(value: unknown): void {
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > BACKGROUND_MESSAGE_LIMIT) throw new Error('Background message budget exceeded')
}
function invoke<T>(method: string, args: unknown[] = []): Promise<T> {
  bounded(args)
  return ipcRenderer.invoke(IpcChannels.PluginBackgroundHost, { method, args }) as Promise<T>
}
ipcRenderer.on(IpcChannels.PluginBackgroundRequest, (_event, request: BackgroundRequest) => {
  if (!handlers || !request || !Number.isSafeInteger(request.id) || running >= 8) return
  running++
  void (async () => {
    switch (request.kind) {
      case 'event': return handlers!.onEvent?.(request.event, request.data)
      case 'call': return handlers!.call(request.method, request.args)
      case 'search': return handlers!.search?.(request.query, request.limit) ?? []
      default: throw new Error('Unknown background operation')
    }
  })().then(data => {
    const response: BackgroundResponse = { id: request.id, ok: true, data }
    bounded(response)
    ipcRenderer.send(IpcChannels.PluginBackgroundResponse, response)
  }).catch(error => {
    ipcRenderer.send(IpcChannels.PluginBackgroundResponse, {
      id: request.id, ok: false, error: error instanceof Error ? error.message.slice(0, 500) : 'Background operation failed'
    } satisfies BackgroundResponse)
  }).finally(() => { running-- })
})

const api: PluginBackgroundBridge = {
  host: {
    private: {
      readDocument: key => invoke('private.readDocument', [key]),
      writeDocument: (key, value) => invoke('private.writeDocument', [key, value]),
      getBlob: id => invoke('private.getBlob', [id]),
      putBlob: input => invoke('private.putBlob', [input]),
      removeBlob: id => invoke('private.removeBlob', [id])
    },
    settings: { get: () => invoke('settings.get') },
    emit: (event, data) => invoke('emit', [event, data]),
    legacy: {
      read: source => invoke('legacy.read', [source]),
      getBlob: (source, token, name) => invoke('legacy.getBlob', [source, token, name]),
      commit: (source, token) => invoke('legacy.commit', [source, token])
    }
  },
  register(value) {
    if (handlers || !value || typeof value.call !== 'function'
      || value.onEvent !== undefined && typeof value.onEvent !== 'function'
      || value.search !== undefined && typeof value.search !== 'function') throw new Error('Invalid or repeated background registration')
    handlers = value
    void ipcRenderer.invoke(IpcChannels.PluginBackgroundReady).catch(() => { handlers = undefined })
  }
}
contextBridge.exposeInMainWorld('enestBackground', api)
