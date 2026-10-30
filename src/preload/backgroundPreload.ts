import { contextBridge, ipcRenderer } from 'electron'
import * as IpcChannels from '@shared/types/ipc'
import { BACKGROUND_MESSAGE_LIMIT, type BackgroundRequest, type BackgroundResponse } from '@shared/types/pluginBackgroundProtocol'
import type { PluginBackgroundBridge, PluginBackgroundHandlers } from '@shared/types/pluginBackground'

let handlers: PluginBackgroundHandlers | undefined
let running = 0
const searches = new Map<number, { cancelled: boolean; callbacks: Set<() => void> }>()
function bounded(value: unknown): void {
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > BACKGROUND_MESSAGE_LIMIT) throw new Error('Background message budget exceeded')
}
function invoke<T>(method: string, args: unknown[] = []): Promise<T> {
  bounded(args)
  return ipcRenderer.invoke(IpcChannels.PluginBackgroundHost, { method, args }) as Promise<T>
}
ipcRenderer.on(IpcChannels.PluginBackgroundRequest, (_event, request: BackgroundRequest) => {
  if (request?.kind === 'cancel-search') {
    const search = searches.get(request.id)
    if (!search || search.cancelled) return
    search.cancelled = true
    for (const callback of search.callbacks) { try { callback() } catch { /* Cancellation does not imply settlement. */ } }
    search.callbacks.clear()
    return
  }
  if (!handlers || !request || !Number.isSafeInteger(request.id) || running >= 8) return
  running++
  void (async () => {
    switch (request.kind) {
      case 'event': return handlers!.onEvent?.(request.event, request.data)
      case 'call': return handlers!.call(request.method, request.args)
      case 'search': {
        const state = { cancelled: Date.now() >= (request.deadlineAt ?? Infinity), callbacks: new Set<() => void>() }
        searches.set(request.id, state)
        const onCancel = (callback: () => void) => {
          if (typeof callback !== 'function') throw new TypeError('Cancellation callback required')
          if (state.cancelled) callback(); else state.callbacks.add(callback)
          return () => { state.callbacks.delete(callback) }
        }
        const isAborted = () => state.cancelled || Date.now() >= (request.deadlineAt ?? Infinity)
        const signal = { isAborted, throwIfAborted: () => { if (isAborted()) throw new Error('Search cancelled') }, onAbort: onCancel }
        signal.throwIfAborted()
        return handlers!.search?.(request.query, request.limit, { requestId: request.id, deadlineAt: request.deadlineAt ?? Date.now() + 750, signal, onCancel }) ?? []
      }
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
  }).finally(() => { searches.delete(request.id); running-- })
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
