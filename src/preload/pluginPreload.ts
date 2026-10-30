/** Plugin-page API assembly; statically bundled into the sandboxed CJS preload. */
import { bindNativeInstallDrop } from './installDropBridge'
import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { PluginStorageOperation } from '@shared/types/storage'
import type { QuickEnterInput } from '@shared/types/quick'
import type { VaultSetResult } from '@shared/types/vault'
import type { LocalFileHandle } from '@shared/types/local-files'
import type { PluginToastOptions } from '@shared/types/notification'
import type { ShellNotice, ShellNoticeDataMap, ShellNoticeTopic, SaveRequestedEvent } from '@shared/types/notice'
import * as IpcChannels from '@shared/types/ipc'
import type { ResolvedAppearance } from '@shared/types/appearance'
import type { AppLocale, PluginPathResolveInput, PluginPathResolveResult, ScreenBounds, ScreenCaptureResult } from '@shared/types/plugin'
import type {
  Listener,
  PluginEnterEvent,
  PluginOutEvent,
  PluginBeforeCloseEvent,
  PluginModeChangeEvent,
  PluginThemeTokens,
  PluginThemeChangeEvent,
  PluginHotkeyEvent,
  PluginLocaleChangeEvent,
  PluginQuickQueryEvent,
  PluginQuickQueryItem,
  PluginQuickProviderMeta,
  PluginHotkeyRegisterResult,
  NetDataEvent,
  NetCloseEvent,
  NetChunkEvent,
  NetSocketHandle,
  NetWsEndpoint,
  NetSocketListItem,
  NetFetchResult,
  SysProcessInfo,
  SysPortInfo,
  Unsubscribe,
  EnestPluginApi
} from '@shared/types/pluginApi'
import { call, enterCodeFromQuery, pluginId } from './pluginRpc'
import { bindPluginMcpBridge, registerMcpHandlers } from './pluginMcpBridge'
import { bindPluginActivationBridge, getActivationContext, registerActivationHandlers } from './pluginActivationBridge'
import { bindPluginEventBridge, getLaunchMode, onPluginEvent, offPluginEvent } from './pluginEventBridge'

/** Toast 类型：info 默认，success/warn/error 带强调色 */
export type { PluginToastType } from '@shared/types/notification'

/** 壳统一通知类型再导出（信封 / topic 映射 / save.requested 事件） */
export type { ShellNotice, ShellNoticeDataMap, ShellNoticeTopic, SaveRequestedEvent } from '@shared/types/notice'

export type {
  PluginEnterEvent,
  PluginOutEvent,
  PluginBeforeCloseEvent,
  PluginModeChangeEvent,
  PluginThemeTokens,
  PluginThemeChangeEvent,
  PluginHotkeyEvent,
  PluginLocaleChangeEvent,
  PluginQuickQueryEvent,
  PluginQuickQueryItem,
  PluginQuickProviderMeta,
  PluginHotkeyRegisterResult,
  NetDataEvent,
  NetCloseEvent,
  NetChunkEvent,
  NetSocketHandle,
  NetWsEndpoint,
  NetSocketListItem,
  NetFetchResult,
  SysProcessInfo,
  SysPortInfo,
  EnestPluginApi
} from '@shared/types/pluginApi'

bindPluginMcpBridge()
bindPluginActivationBridge()

function subscribeToolEvent<T>(event: string, cb: (data: T) => void): Unsubscribe {
  const handler: Listener = data => cb(data as T)
  api.on(event, handler)
  return () => api.off(event, handler)
}

const api: EnestPluginApi = {
  launch: { getContext: getActivationContext, registerHandlers: registerActivationHandlers },
  mcp: { registerHandlers: registerMcpHandlers },
  setTitle: (title: string) => call<boolean>('ui.setTitle', [title]),
  setIcon: (icon: string) => call<boolean>('ui.setIcon', [icon]),
  setBadge: (badge: string | number) => call<boolean>('ui.setBadge', [badge]),
  resize: (size: { width?: number; height?: number }) => call<boolean>('ui.resize', [size]),
  setDirty: (dirty: boolean) => call<boolean>('state.setDirty', [dirty]),
  onNotice(
    topicOrCb: string | ((notice: ShellNotice) => void),
    maybeCb?: (notice: ShellNotice) => void
  ): Unsubscribe {
    const topic = typeof topicOrCb === 'string' ? topicOrCb : null
    const cb = typeof topicOrCb === 'string' ? maybeCb : topicOrCb
    if (typeof cb !== 'function') return () => {}
    const handler: Listener = (data) => {
      const notice = data as ShellNotice
      if (!notice || typeof notice !== 'object' || typeof notice.topic !== 'string') return
      if (topic === null || notice.topic === topic) cb(notice)
    }
    api.on('shell-notice', handler)
    return () => api.off('shell-notice', handler)
  },
  onSaveRequested(cb) {
    const handler: Listener = (data) => cb(data as SaveRequestedEvent)
    api.on('save-requested', handler)
    return () => api.off('save-requested', handler)
  },
  ui: {
    setTitle: (title: string) => call<boolean>('ui.setTitle', [title]),
    setIcon: (icon: string) => call<boolean>('ui.setIcon', [icon]),
    setBadge: (badge: string | number) => call<boolean>('ui.setBadge', [badge]),
    resize: (size: { width?: number; height?: number }) => call<boolean>('ui.resize', [size]),
    setHeight: (height: number) => call<boolean>('ui.setHeight', [height]),
    openInShell: () => call<boolean>('ui.openInShell', []),
    openSettings: () => call<boolean>('ui.openSettings'),
    setInputContext: (context) => call<boolean>('ui.setInputContext', [context]),
    focus: () => call<boolean>('ui.focus', []),
    focusSearch: () => call<boolean>('ui.focusSearch', []),
    dismissQuick: () => call<boolean>('ui.dismissQuick', []),
    toast: (payload: PluginToastOptions) =>
      call<boolean>('ui.toast', [payload]),
    getThemeTokens: () =>
      call<{ mode: 'light' | 'dark'; tokens: PluginThemeTokens }>('theme.getTokens'),
    onThemeChange(cb) {
      const handler: Listener = (data) => {
        const p = data as PluginThemeChangeEvent
        if (p && typeof p === 'object' && 'tokens' in p) cb(p)
      }
      api.on('theme-change', handler)
      return () => api.off('theme-change', handler)
    }
  },
  theme: {
    // 规范入口：enest.theme.getTokens()；ui.getThemeTokens 为兼容别名
    getTokens: () =>
      call<{ mode: 'light' | 'dark'; tokens: PluginThemeTokens }>('theme.getTokens'),
    getAppearance: () => call<ResolvedAppearance>('theme.getAppearance'),
    onAppearanceChange(cb) {
      const handler: Listener = (data) => {
        const wrapper = data as { appearance?: ResolvedAppearance }
        if (wrapper?.appearance?.version === 2) cb(wrapper.appearance)
      }
      api.on('appearance-change', handler)
      return () => api.off('appearance-change', handler)
    },
    // 注册主题包 → 主进程 themePackRegistry，壳子设置页主题下拉即时刷新
    register: (pack) => call('theme.register', [pack]),
  },
  home: {
    register: contribution => ipcRenderer.invoke(IpcChannels.PluginHomeRegister, contribution),
  },
  hotkey: {
    register: (accelerator: string, opts?: { label?: string }) =>
      call<PluginHotkeyRegisterResult>('hotkey.register', [accelerator, opts]),
    unregister: (accelerator: string) => call<boolean>('hotkey.unregister', [accelerator]),
    onHotkey(cb) {
      const handler: Listener = (data) => {
        const p = data as PluginHotkeyEvent
        if (p && typeof p === 'object' && typeof p.accelerator === 'string') cb(p)
      }
      api.on('hotkey', handler)
      return () => api.off('hotkey', handler)
    }
  },
  i18n: {
    getLocale: () => call<AppLocale>('i18n.getLocale'),
    onLocaleChange(cb) {
      const handler: Listener = (data) => {
        const p = data as PluginLocaleChangeEvent
        if (p && typeof p === 'object' && (p.locale === 'zh-CN' || p.locale === 'en-US')) {
          cb(p)
        }
      }
      api.on('locale-change', handler)
      return () => api.off('locale-change', handler)
    }
  },
  contribute: {
    replaceLaunchIndex: entries => call('contribute.replaceLaunchIndex', [entries]),
    launchIndexState: () => call('contribute.launchIndexState'),
    markLaunchIndexDirty: () => call('contribute.markLaunchIndexDirty'),
    registerQuickProvider: (meta: PluginQuickProviderMeta) =>
      call<{ ok: true } | { ok: false; error?: string }>('contribute.registerQuickProvider', [meta]),
    unregisterQuickProvider: (providerId: string) =>
      call<boolean>('contribute.unregisterQuickProvider', [providerId]),
    onQuickQuery(cb) {
      const handler: Listener = (data) => {
        const p = data as PluginQuickQueryEvent
        if (p && typeof p === 'object' && typeof p.reqId === 'string') cb(p)
      }
      api.on('quick-query', handler)
      return () => api.off('quick-query', handler)
    },
    respondQuickQuery: (reqId: string, items: PluginQuickQueryItem[]) =>
      call<boolean>('contribute.respondQuickQuery', [reqId, items])
  },
  settings: {
    register: (section) => call<boolean>('settings.register', [section]),
    get: (key: string) => call<unknown>('settings.get', [key]),
    set: (key: string, value: unknown) => call<boolean>('settings.set', [key, value]),
    onChange: cb => subscribeToolEvent('settings-change', cb)
  },
  quickInput: {
    configure: config => call('quickInput.configure', [config]),
    release: () => call('quickInput.release'),
    escape: () => call('quickInput.escape'),
    readContext: () => call<QuickEnterInput | null>('quickInput.readContext'),
    onChange: cb => subscribeToolEvent('quick-input-change', cb),
    onAction: cb => subscribeToolEvent('quick-input-action', cb)
  },
  deadlineTasks: {
    start: input => call('deadlineTasks.start', [input]),
    get: id => call('deadlineTasks.get', [id]),
    pause: id => call('deadlineTasks.pause', [id]),
    resume: id => call('deadlineTasks.resume', [id]),
    skip: id => call('deadlineTasks.skip', [id]),
    cancel: id => call('deadlineTasks.cancel', [id]),
    onChange: cb => subscribeToolEvent('deadline-task-change', cb)
  },
  storage: {
    files: {
      list: options => call('storage.files.list', [options]),
      get: (id, options) => call('storage.files.get', [id, options]),
      remove: id => call('storage.files.remove', [id]),
      export: (id, options) => call('storage.files.export', [id, options])
    },
    blobs: {
      put: input => call('storage.blobs.put', [input]),
      get: id => call('storage.blobs.get', [id]),
      remove: id => call('storage.blobs.remove', [id])
    },
    assets: {
      put: input => call('storage.assets.put', [input]),
      list: () => call('storage.assets.list', []),
      get: assetId => call('storage.assets.get', [assetId]),
      remove: assetId => call('storage.assets.remove', [assetId]),
      delete: assetId => call('storage.assets.delete', [assetId])
    },
    get: (key: string) => call<unknown>('storage.get', [key]),
    set: (key: string, value: unknown) => call<boolean>('storage.set', [key, value]),
    flush: () => call('storage.flush'),
    commit: (operations: PluginStorageOperation[]) => call('storage.commit', [operations]),
    remove: (key: string) => call<boolean>('storage.remove', [key]),
    clear: () => call<boolean>('storage.clear'),
    session: {
      get: (key: string) => call<unknown>('storage.session.get', [key]),
      set: (key: string, value: unknown) => call<boolean>('storage.session.set', [key, value]),
      remove: (key: string) => call<boolean>('storage.session.remove', [key]),
      clear: () => call<boolean>('storage.session.clear')
    }
  },
  background: {
    call: (method, args = [], options) => call('background.call', [method, args, options])
  },
  auxiliary: {
    open: options => call('auxiliary.open', [options]),
    send: (id, data, options) => call('auxiliary.send', [id, data, options]),
    close: id => call('auxiliary.close', [id]),
    list: () => call('auxiliary.list')
  },
  files: {
    stream: {
      open: options => call('files.stream.open', [options]),
      write: (id, sequence, bytes) => call('files.stream.write', [id, sequence, bytes]),
      finish: id => call('files.stream.finish', [id]),
      abort: id => call('files.stream.abort', [id])
    }
  },
  clipboard: {
    capabilities: () => call('clipboard.capabilities'),
    requestPermission: () => call('clipboard.requestPermission'),
    readText: () => call<string>('clipboard.readText'),
    writeText: (text, options) => call<boolean>('clipboard.writeText', [text, options]),
    readImage: () => call<{ dataUrl: string; width: number; height: number } | null>('clipboard.readImage'),
    writeImage: (dataUrl: string) => call<boolean>('clipboard.writeImage', [dataUrl]),
    writeFiles: paths => call('clipboard.writeFiles', [paths]),
    paste: () => call('clipboard.paste'),
    inspectFiles: paths => call('clipboard.inspectFiles', [paths]),
    revealFile: path => call('clipboard.revealFile', [path])
  },
  screen: {
    capture: (opts?: { displayId?: number; bounds?: ScreenBounds }) =>
      call<ScreenCaptureResult>('screen.capture', [opts]),
    displays: () => call('screen.displays')
  },
  net: {
    fetch: (req: {
      url: string
      method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD'
      headers?: Record<string, string>
      body?: string
      bodyBase64?: string
      auth?: { secretRef: string; header?: string; scheme?: 'bearer' | 'raw' }
      timeoutMs?: number
      stream?: boolean
    }) => call<NetFetchResult>('net.fetch', [req]),
    websocket: {
      connect: input => call<{ socketId: string }>('net.websocket.connect', [input]),
      send: (socketId, data, binary = false) => call<{ sent: number }>('net.websocket.send', [socketId, data, binary]),
      close: socketId => call<boolean>('net.websocket.close', [socketId]),
      onMessage(cb) {
        const handler: Listener = data => cb(data as { socketId: string; data: string; binary: boolean })
        api.on('net.websocket.message', handler)
        return () => api.off('net.websocket.message', handler)
      },
      onClose(cb) {
        const handler: Listener = data => cb(data as { socketId: string; code: number; reason: string })
        api.on('net.websocket.close', handler)
        return () => api.off('net.websocket.close', handler)
      }
    },
    socket: {
      connect: (input: {
        sessionId?: string
        host: string
        port: number
        tls?: boolean
        timeoutMs?: number
      }) => call<NetSocketHandle>('net.socket.connect', [input]),
      send: (socketId, data, encoding = 'utf8') =>
        call<{ sent: number }>('net.socket.send', [socketId, data, encoding]),
      close: (socketId: string) => call<boolean>('net.socket.close', [socketId]),
      list: () => call<NetSocketListItem[]>('net.socket.list'),
      serveWs: (socketId: string) => call<NetWsEndpoint>('net.socket.serveWs', [socketId])
    },
    onNetData(cb) {
      const handler: Listener = (data) => {
        const p = data as NetDataEvent
        if (p && typeof p === 'object' && typeof p.socketId === 'string' && typeof p.chunk === 'string') cb(p)
      }
      api.on('net.data', handler)
      return () => api.off('net.data', handler)
    },
    onNetClose(cb) {
      const handler: Listener = (data) => {
        const p = data as NetCloseEvent
        if (p && typeof p === 'object' && typeof p.socketId === 'string') cb(p)
      }
      api.on('net.close', handler)
      return () => api.off('net.close', handler)
    },
    onChunk(cb) {
      const handler: Listener = (data) => {
        const p = data as NetChunkEvent
        if (p && typeof p === 'object' && typeof p.reqId === 'string') cb(p)
      }
      api.on('net.chunk', handler)
      return () => api.off('net.chunk', handler)
    },
  },
  fs: {
    rename: (input: { handleId: string; newName: string }) =>
      call<{ handleId: string; oldName: string; newName: string }>('fs.rename', [input]),
    renameBatch: (input: {
      items: Array<{ handleId: string; newName: string }>
      confirmed?: boolean
    }) =>
      call<{
        results: Array<{ handleId: string; oldName: string; newName: string; ok: boolean; error?: string }>
        succeeded: number
        failed: number
      }>('fs.renameBatch', [input])
  },
  sys: {
    processes: () => call<SysProcessInfo[]>('sys.processes'),
    ports: () => call<SysPortInfo[]>('sys.ports'),
    kill: (pid: number, opts?: { signal?: 'TERM' | 'KILL' | 'INT'; confirmed?: boolean }) =>
      call<boolean>('sys.kill', [pid, opts?.signal ?? 'TERM', opts?.confirmed === true])
  },
  shell: {
    saveFile: input => call('shell.saveFile', [input]),
    openExternal: (url: string) => call<boolean>('shell.openExternal', [url]),
    /** 导出落盘：系统保存对话框 + 写文件 */
    saveTextFile: (payload: { defaultName?: string; filename?: string; content: string }) =>
      call<{ ok: boolean; path: string } | null>('shell.saveTextFile', [payload]),
    /** 统一路径解析：`~/x`、`./x`、裸相对与绝对路径归一成绝对路径 */
    resolvePath: (input: PluginPathResolveInput) =>
      call<PluginPathResolveResult>('shell.resolvePath', [input])
  },
  notify: (payload: { title?: string; body?: string }) => call<boolean>('notify', [payload]),
  vault: {
    set: (key: string, secret: string) => call<VaultSetResult>('vault.set', [key, secret]),
    has: (keyOrRef: string) => call<boolean>('vault.has', [keyOrRef]),
    remove: (keyOrRef: string) => call<boolean>('vault.remove', [keyOrRef])
  },
  localFiles: {
    read: input => call<string>('localFiles.read', [input]),
    pick: (options) => call<LocalFileHandle[]>('localFiles.pick', [options ?? {}]),
    pickSave: (options) => call<LocalFileHandle | null>('localFiles.pickSave', [options ?? {}]),
    fromDrop: (files) => {
      const paths = Array.from(files).map((file) => webUtils.getPathForFile(file))
      if (paths.some((path) => !path)) return Promise.reject(new Error('only files dragged from this computer are supported'))
      return call<LocalFileHandle[]>('localFiles.fromDrop', [paths])
    },
    list: (input) => call('localFiles.list', [input]),
    reveal: (handleId) => call('localFiles.reveal', [handleId]),
    prepareDrag: (input) => call('localFiles.prepareDrag', [input]),
    startDrag: (exportId) => call('localFiles.startDrag', [exportId]),
    endDrag: () => call('localFiles.endDrag', [])
  },
  on: onPluginEvent,
  off: offPluginEvent,

  onEnter(cb) {
    const handler: Listener = (data) => cb(data as PluginEnterEvent)
    api.on('enter', handler)
    return () => api.off('enter', handler)
  },
  onOut(cb) {
    const handler: Listener = (data) => cb(data as PluginOutEvent)
    api.on('out', handler)
    return () => api.off('out', handler)
  },
  runtime: { acquireActivity: (reason) => call<string>('runtime.acquire', [reason]), releaseActivity: (token) => call<void>('runtime.release', [token]) },
  backend: { call: (method, args = [], options = {}) => call('backend.call', [method, args, options]), stop: () => call('backend.stop') },
  onBeforeSuspend(cb) {
    api.on('beforeSuspend', cb)
    return () => api.off('beforeSuspend', cb)
  },
  onBeforeClose(cb) {
    // 透传 cb 的返回值：返回 Promise 时 dispatch 侧据此等待 settle 再 ack
    const handler: Listener = (data) => cb(data as PluginBeforeCloseEvent)
    api.on('beforeClose', handler)
    return () => api.off('beforeClose', handler)
  },
  onDestroy(cb) {
    const handler: Listener = () => cb()
    api.on('destroy', handler)
    return () => api.off('destroy', handler)
  },
  getPluginId: () => pluginId(),
  getEnterCode: () => enterCodeFromQuery(),
  getLaunchMode,
  onModeChange(cb) {
    const handler: Listener = (data) => cb((data as PluginModeChangeEvent).mode)
    api.on('mode-change', handler)
    return () => api.off('mode-change', handler)
  }
}

bindPluginEventBridge()

// 同时暴露 enest 与 zapi 两个全局名，兼容不同插件 SDK 期望
const dragEvents = globalThis as unknown as { addEventListener?: (type: string, listener: () => void, capture?: boolean) => void }
dragEvents.addEventListener?.('dragend', () => { void api.localFiles.endDrag().catch(() => {}) }, true)
contextBridge.exposeInMainWorld('enest', api)
contextBridge.exposeInMainWorld('zapi', api)
// Capture package drops without exposing an install API to plugin JavaScript.
bindNativeInstallDrop(true)
