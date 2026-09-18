/**
 * pluginPreload — 插件渲染层预加载脚本
 * 职责：通过 contextBridge 向插件页面暴露 window.enest / window.zapi API，
 * 将所有插件调用收敛到主进程的 `plugin:call` 通道（经权限校验）；
 * 订阅 `plugin:lifecycle`，暴露 onEnter / onOut / onBeforeClose / onDestroy。
 * 被 PluginHost 指定为插件 WebContentsView 的 preload。
 * 关键依赖：@shared/types/ipc（PluginCallRequest/Result）、contextBridge、ipcRenderer。
 *
 * 生命周期对标 uTools：
 * - onEnter({ code?, payload?, tabId }) ≈ utools.onPluginEnter
 * - onOut({ isKill: false })           ≈ utools.onPluginOut(false)  — 切走后台
 * - onBeforeClose({ reason })          — 销毁前（Tab 关闭 / 卸载 / 退出），可同步 flush
 * - onDestroy()                        — 关闭已开始，best-effort
 * beforeClose 的 ack 策略：等插件 onBeforeClose 回调返回的 Promise 全部 settle
 * （任一返回 Promise 即等待）；无监听器 / 纯同步回调时延迟一小窗口再 ack。
 * 主进程侧另有超时兜底，本地 cap 只防悬挂。
 */
import { contextBridge, ipcRenderer } from 'electron'
import {
  IpcChannels,
  type PluginCallRequest,
  type PluginCallResult,
  type PluginEventPayload
} from '@shared/types/ipc'
import type {
  AppLocale,
  ClipboardHistoryEntry,
  PluginCloseReason,
  PluginEnterPayload,
  PluginLifecycleMessage,
  ScreenBounds,
  ScreenCaptureResult
} from '@shared/types/plugin'
import type {
  BatchResult,
  CompletionResponse,
  DbApplyChangesInput,
  DbCompletionInput,
  DbConnectionConfig,
  DbDialectInfo,
  DbExecuteInput,
  DbImportPreviewInput,
  DbImportPreviewResult,
  DbImportRunInput,
  DbImportRunResult,
  DbSchemaTreeInput,
  DbSessionInfo,
  DbTestResult,
  QueryResult,
  SchemaObject,
  SshCompletionResult,
  SshConnectInput,
  SshExecInput,
  SshExecResult,
  SshMetricsSample,
  SshSessionInfo,
  SftpDownloadInput,
  SftpEntry,
  SftpListInput,
  SftpTransferResult,
  SftpUploadInput,
  TableDetail,
  VaultSetResult
} from '@shared/types/ssh-db'

/**
 * beforeClose ack 前的最小等待窗口：无监听器 / 纯同步回调时，
 * 给插件同步 flush（含微任务内的 send）留出的余量。
 */
const BEFORE_CLOSE_SYNC_FLUSH_MS = 50

/** ack 等待的本地上限：略大于主进程超时，仅防悬挂；主进程超时是真正的兜底 */
const BEFORE_CLOSE_ACK_LOCAL_CAP_MS = 2000

function getPluginIdFromQuery(): string {
  try {
    const search =
      (globalThis as unknown as { location?: { search?: string } }).location?.search ?? ''
    const params = new URLSearchParams(search)
    return params.get('pid') ?? ''
  } catch {
    return ''
  }
}

function getPluginIdFromArgv(): string {
  try {
    const prefix = '--enest-plugin-id='
    const hit = process.argv.find((a) => a.startsWith(prefix))
    return hit ? hit.slice(prefix.length) : ''
  } catch {
    return ''
  }
}

/** 优先从 URL query 的 pid 参数获取插件 ID，失败时从进程 argv 回退 */
function resolvePluginId(): string {
  return getPluginIdFromQuery() || getPluginIdFromArgv()
}

let cachedPluginId: string | null = null

function pluginId(): string {
  if (cachedPluginId === null) cachedPluginId = resolvePluginId()
  return cachedPluginId
}

/** URL query 中的 code（openPlugin 优先走 query，便于首个脚本同步读取） */
function enterCodeFromQuery(): string | undefined {
  try {
    const search =
      (globalThis as unknown as { location?: { search?: string } }).location?.search ?? ''
    return new URLSearchParams(search).get('code') ?? undefined
  } catch {
    return undefined
  }
}

/** 统一调用入口：组装 PluginCallRequest，经 IPC 发送到主进程 pluginHandlers 分发 */
async function call<T = unknown>(method: string, args: unknown[] = []): Promise<T> {
  const request: PluginCallRequest = {
    pluginId: pluginId(),
    method,
    args
  }
  const result = (await ipcRenderer.invoke(IpcChannels.PluginCall, request)) as PluginCallResult
  if (!result?.ok) {
    throw new Error(result?.error || 'plugin call failed')
  }
  return result.data as T
}

type Listener = (data: unknown) => void
const listeners = new Map<string, Set<Listener>>()

function emit(event: string, data: unknown): void {
  const set = listeners.get(event)
  if (!set) return
  for (const cb of set) {
    try {
      cb(data)
    } catch {
      // 插件回调抛错不应影响其它监听器
    }
  }
}

/**
 * 派发事件并收集监听器返回的 thenable（Promise）。
 * 回调抛错被吞（与 emit 一致）；返回非 Promise 的监听器不参与等待。
 */
function emitAndCollectPromises(event: string, data: unknown): Promise<unknown>[] {
  const set = listeners.get(event)
  if (!set) return []
  const pending: Promise<unknown>[] = []
  for (const cb of set) {
    try {
      const ret = cb(data) as unknown
      if (
        ret !== null &&
        typeof ret === 'object' &&
        typeof (ret as Promise<unknown>).then === 'function'
      ) {
        pending.push(Promise.resolve(ret).catch(() => undefined))
      }
    } catch {
      // 插件回调抛错不应影响其它监听器，也不阻塞 ack
    }
  }
  return pending
}

/** 发送 beforeClose ack；通道可能已随销毁关闭，失败静默（主进程有超时兜底） */
function sendBeforeCloseAck(): void {
  try {
    ipcRenderer.send(IpcChannels.PluginLifecycleAck, { event: 'beforeClose' })
  } catch {
    // 通道可能已随销毁关闭
  }
}

/** Toast 类型：info 默认，success/warn/error 带强调色 */
export type PluginToastType = 'info' | 'success' | 'warn' | 'error'

/** enter 事件载荷 */
export type PluginEnterEvent = PluginEnterPayload & { tabId: string }
/** out 事件载荷；isKill 恒为 false（杀死走 beforeClose/destroy） */
export type PluginOutEvent = { isKill: false }
/** beforeClose 事件载荷 */
export type PluginBeforeCloseEvent = { reason: PluginCloseReason }

/** 主题 Token 集合（壳子解析后的 CSS 自定义属性值） */
export type PluginThemeTokens = Record<string, string>

/** 主题变更事件（enest.ui.onThemeChange） */
export type PluginThemeChangeEvent = {
  mode: 'light' | 'dark'
  tokens: PluginThemeTokens
}

/** 热键触发事件（enest.hotkey.register 的回调 / enest.on('hotkey')） */
export type PluginHotkeyEvent = {
  accelerator: string
}

/** 语言变更事件（enest.i18n.onLocaleChange） */
export type PluginLocaleChangeEvent = {
  locale: AppLocale
}

/** Quick 搜索查询事件（enest.contribute.onQuickQuery） */
export type PluginQuickQueryEvent = {
  reqId: string
  query: string
}

/** Quick provider 回传项（enest.contribute.respondQuickQuery 的 items 元素） */
export type PluginQuickQueryItem = {
  id?: string
  title?: string
  subtitle?: string
  explain?: string
  code?: string
}

/** Quick provider 注册元数据 */
export type PluginQuickProviderMeta = {
  id: string
  explain?: string
  schemaVersion?: string
}

/** hotkey.register 结果：ok=false 时 error 携带冲突/失败原因 */
export type PluginHotkeyRegisterResult = {
  ok: boolean
  error?: string
}

type Unsubscribe = () => void

export interface EnestPluginApi {
  setTitle(title: string): Promise<boolean>
  setIcon(icon: string): Promise<boolean>
  setBadge(badge: string | number): Promise<boolean>
  resize(size: { width?: number; height?: number }): Promise<boolean>
  /** UI 命名空间：与 PLUGIN_SPEC 的 enest.ui.* 对齐 */
  ui: {
    setTitle(title: string): Promise<boolean>
    setIcon(icon: string): Promise<boolean>
    setBadge(badge: string | number): Promise<boolean>
    resize(size: { width?: number; height?: number }): Promise<boolean>
    /**
     * 期望内容高度（px）：Quick 内嵌容器据此调小窗高度；主窗 Tab 场景仅记录。
     * 需 ui.resize 权限。
     */
    setHeight(height: number): Promise<boolean>
    /** 由壳子 Toast 统一渲染的轻提示；与 notify（系统通知）分工 */
    toast(payload: { message: string; type?: PluginToastType }): Promise<boolean>
    /** 读取当前主题 Token（themeAware 插件可主动拉取） */
    getThemeTokens(): Promise<{ mode: 'light' | 'dark'; tokens: PluginThemeTokens }>
    /** 订阅主题变更；壳子 setTheme / OS 主题切换时推送 */
    onThemeChange(cb: (event: PluginThemeChangeEvent) => void): Unsubscribe
  }
  /** 主题命名空间：enest.theme.getTokens() / register() */
  theme: {
    getTokens(): Promise<{ mode: 'light' | 'dark'; tokens: PluginThemeTokens }>
    /**
     * 注册主题包到壳子设置 → 主题 下拉列表。
     * ThemePack: { id, name, mode, tokens, source?, background? }
     */
    register(pack: {
      id: string
      name: string
      mode?: 'light' | 'dark' | 'system'
      tokens: Record<string, string>
      source?: string
      background?: {
        type: 'none' | 'color' | 'image' | 'video'
        value: string
        opacity?: number
        fit?: 'cover' | 'contain'
      }
    }): Promise<unknown>
  }
  /** 全局热键命名空间：enest.hotkey.register/unregister；需 'hotkey' 权限 */
  hotkey: {
    /**
     * 注册全局热键。成功 resolve { ok: true }；冲突（含壳子 Quick 热键 /
     * 其它插件占用 / 系统占用）resolve { ok: false, error }，不 reject。
     * 触发经 on('hotkey') 事件推送 { accelerator }。
     */
    register(
      accelerator: string,
      opts?: { label?: string }
    ): Promise<PluginHotkeyRegisterResult>
    /** 注销本插件已注册的热键；未注册时也返回 ok */
    unregister(accelerator: string): Promise<boolean>
    /** 订阅热键触发；等价 enest.on('hotkey', cb) */
    onHotkey(cb: (event: PluginHotkeyEvent) => void): Unsubscribe
  }
  /** 多语言命名空间：读壳子界面语言并订阅变更 */
  i18n: {
    /** 当前壳子语言（settings.general.locale） */
    getLocale(): Promise<AppLocale>
    /** 订阅语言变更；壳子设置页切换语言时推送 */
    onLocaleChange(cb: (event: PluginLocaleChangeEvent) => void): Unsubscribe
  }
  /**
   * 贡献点命名空间（插槽化架构）：Quick 搜索 provider 运行时注册与查询回传。
   * 需 manifest permissions 声明 'contribute'。
   */
  contribute: {
    /**
     * 注册 Quick 搜索 provider：注册后壳子搜索时推送 quick-query 事件，
     * 插件在 onQuickQuery 回调中计算结果并 respondQuickQuery 回传（500ms 超时丢弃）。
     */
    registerQuickProvider(meta: PluginQuickProviderMeta): Promise<
      { ok: true } | { ok: false; error?: string }
    >
    /** 注销本插件的某个 provider */
    unregisterQuickProvider(providerId: string): Promise<boolean>
    /** 订阅 Quick 搜索查询；等价 enest.on('quick-query', cb) */
    onQuickQuery(cb: (event: PluginQuickQueryEvent) => void): Unsubscribe
    /** 回传查询结果（reqId 来自 onQuickQuery；items 为命令项数组） */
    respondQuickQuery(reqId: string, items: PluginQuickQueryItem[]): Promise<boolean>
  }
  settings: {
    register(section: {
      id: string
      title: string
      items: Array<{ key: string; type: string; label: string; default?: unknown }>
    }): Promise<boolean>
    get(key: string): Promise<unknown>
    set(key: string, value: unknown): Promise<boolean>
  }
  storage: {
    get(key: string): Promise<unknown>
    set(key: string, value: unknown): Promise<boolean>
    remove(key: string): Promise<boolean>
    clear(): Promise<boolean>
    /** 会话态 KV：主进程内存，插件关闭 / 应用退出即清空，不落盘 */
    session: {
      get(key: string): Promise<unknown>
      set(key: string, value: unknown): Promise<boolean>
      remove(key: string): Promise<boolean>
      clear(): Promise<boolean>
    }
  }
  clipboard: {
    readText(): Promise<string>
    writeText(text: string): Promise<boolean>
    readImage(): Promise<{ dataUrl: string; width: number; height: number } | null>
    writeImage(dataUrl: string): Promise<boolean>
    history: {
      list(opts?: { limit?: number }): Promise<ClipboardHistoryEntry[]>
      get(id: string): Promise<(ClipboardHistoryEntry & { dataUrl?: string }) | null>
      remove(id: string): Promise<boolean>
      clear(): Promise<boolean>
      togglePin(id: string): Promise<ClipboardHistoryEntry>
    }
  }
  screen: {
    capture(opts?: { displayId?: number; bounds?: ScreenBounds }): Promise<ScreenCaptureResult>
    selectRegion(): Promise<ScreenBounds | null>
    record: {
      start(opts?: {
        bounds?: ScreenBounds
        withAudio?: boolean
        displayId?: number
      }): Promise<{ sessionId: string }>
      stop(sessionId: string): Promise<{ path: string; size: number; durationMs: number }>
      cancel(sessionId: string): Promise<boolean>
    }
  }
  pin: {
    open(payload: {
      dataUrl?: string
      path?: string
      x?: number
      y?: number
      width?: number
      title?: string
    }): Promise<{ pinId: string }>
    close(pinId: string): Promise<boolean>
    closeAll(): Promise<number>
    list(): Promise<Array<{ pinId: string }>>
  }
  net: {
    fetch(req: {
      url: string
      method?: 'GET' | 'POST'
      headers?: Record<string, string>
      body?: string
      timeoutMs?: number
    }): Promise<{ status: number; headers: Record<string, string>; body: string }>
  }
  shell: {
    openExternal(url: string): Promise<boolean>
    saveTextFile(payload: {
      defaultName?: string
      filename?: string
      content: string
    }): Promise<{ ok: boolean; path: string } | null>
  }
  notify(payload: { title?: string; body?: string }): Promise<boolean>
  /** 密钥保险库：set→secretRef；无明文 get。需 vault.write */
  vault: {
    set(key: string, secret: string): Promise<VaultSetResult>
    has(keyOrRef: string): Promise<boolean>
    remove(keyOrRef: string): Promise<boolean>
  }
  /** SSH 运行时：session / exec / metrics / completion / sftp */
  ssh: {
    connect(input: SshConnectInput): Promise<SshSessionInfo>
    write(sessionId: string, data: string): Promise<boolean>
    resize(sessionId: string, cols: number, rows: number): Promise<boolean>
    disconnect(sessionId: string): Promise<boolean>
    listSessions(): Promise<SshSessionInfo[]>
    exec(input: SshExecInput): Promise<SshExecResult>
    metrics: {
      /** 支持位置参数 (sessionId, intervalMs?) 或对象形 { sessionId, intervalMs? } */
      start(
        sessionIdOrOpts: string | { sessionId: string; intervalMs?: number },
        intervalMs?: number
      ): Promise<{ ok: boolean; intervalMs: number }>
      stop(sessionId: string | { sessionId: string }): Promise<boolean>
      latest(sessionId: string | { sessionId: string }): Promise<SshMetricsSample | null>
    }
    completion: {
      suggest(input: {
        sessionId: string
        line: string
        cursor?: number
        history?: string[]
        snippets?: Array<{ title: string; command: string }>
      }): Promise<SshCompletionResult>
    }
    sftp: {
      list(input: SftpListInput): Promise<SftpEntry[]>
      download(input: SftpDownloadInput): Promise<SftpTransferResult>
      upload(input: SftpUploadInput): Promise<SftpTransferResult>
    }
    pickLocalFile(opts?: {
      properties?: Array<'openFile' | 'openDirectory'>
      /** 插件兼容别名：file / dir|directory|folder */
      mode?: 'file' | 'dir' | 'directory' | 'folder'
    }): Promise<string | null>
  }
  /** 数据库运行时：驱动会话 / 查询 / 补全 / schema / applyChanges / 导入 */
  db: {
    test(config: DbConnectionConfig): Promise<DbTestResult>
    open(
      input: { config: DbConnectionConfig; sessionKey?: string } | DbConnectionConfig
    ): Promise<DbSessionInfo>
    close(sessionKey: string): Promise<boolean>
    listSessions(): Promise<DbSessionInfo[]>
    pickSqliteFile(): Promise<string | null>
    pickImportFile(): Promise<string | null>
    execute(input: DbExecuteInput): Promise<QueryResult>
    explain(input: { sessionKey: string; sql: string }): Promise<QueryResult>
    cancel(sessionKey: string | { sessionKey?: string }): Promise<boolean>
    applyChanges(input: DbApplyChangesInput): Promise<BatchResult>
    importPreview(input: DbImportPreviewInput): Promise<DbImportPreviewResult>
    importRun(input: DbImportRunInput): Promise<DbImportRunResult>
    schema: {
      tree(input: DbSchemaTreeInput & { node?: unknown }): Promise<SchemaObject[]>
      describe(input: {
        sessionKey: string
        database?: string
        schema?: string
        table: string
      }): Promise<TableDetail>
      ddl(input: {
        sessionKey: string
        database?: string
        schema?: string
        table: string
      }): Promise<string>
    }
    completion: ((input: DbCompletionInput) => Promise<CompletionResponse>) & {
      suggest(input: DbCompletionInput): Promise<CompletionResponse>
    }
    dialects: {
      list(): Promise<DbDialectInfo[]>
    }
  }
  on(event: string, cb: Listener): void
  off(event: string, cb: Listener): void

  // —— 生命周期（对标 uTools onPluginEnter / onPluginOut）——
  /** 进入插件：首次加载完成后 + 每次 Tab 激活；与 onOut 成对，可 pause/resume */
  onEnter(cb: (event: PluginEnterEvent) => void): Unsubscribe
  /** 退到后台：其它 Tab 成为 active；isKill 恒 false */
  onOut(cb: (event: PluginOutEvent) => void): Unsubscribe
  /** 即将销毁：可在此 flush 草稿；回调返回 Promise 时 preload 等其 settle 再 ack */
  onBeforeClose(cb: (event: PluginBeforeCloseEvent) => void | Promise<unknown>): Unsubscribe
  /** 关闭已开始（best-effort），通常已在 beforeClose 完成清理 */
  onDestroy(cb: () => void): Unsubscribe
  /** 当前插件 id（与 query pid 一致） */
  getPluginId(): string
  /** URL query 中的 code；完整载荷以 onEnter 为准 */
  getEnterCode(): string | undefined
}

const api: EnestPluginApi = {
  setTitle: (title: string) => call<boolean>('ui.setTitle', [title]),
  setIcon: (icon: string) => call<boolean>('ui.setIcon', [icon]),
  setBadge: (badge: string | number) => call<boolean>('ui.setBadge', [badge]),
  resize: (size: { width?: number; height?: number }) => call<boolean>('ui.resize', [size]),
  ui: {
    setTitle: (title: string) => call<boolean>('ui.setTitle', [title]),
    setIcon: (icon: string) => call<boolean>('ui.setIcon', [icon]),
    setBadge: (badge: string | number) => call<boolean>('ui.setBadge', [badge]),
    resize: (size: { width?: number; height?: number }) => call<boolean>('ui.resize', [size]),
    setHeight: (height: number) => call<boolean>('ui.setHeight', [height]),
    toast: (payload: { message: string; type?: PluginToastType }) =>
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
    // 注册主题包 → 主进程 themePackRegistry，壳子设置页主题下拉即时刷新
    register: (pack) => call('theme.register', [pack]),
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
    set: (key: string, value: unknown) => call<boolean>('settings.set', [key, value])
  },
  storage: {
    get: (key: string) => call<unknown>('storage.get', [key]),
    set: (key: string, value: unknown) => call<boolean>('storage.set', [key, value]),
    remove: (key: string) => call<boolean>('storage.remove', [key]),
    clear: () => call<boolean>('storage.clear'),
    session: {
      get: (key: string) => call<unknown>('storage.session.get', [key]),
      set: (key: string, value: unknown) => call<boolean>('storage.session.set', [key, value]),
      remove: (key: string) => call<boolean>('storage.session.remove', [key]),
      clear: () => call<boolean>('storage.session.clear')
    }
  },
  clipboard: {
    readText: () => call<string>('clipboard.readText'),
    writeText: (text: string) => call<boolean>('clipboard.writeText', [text]),
    readImage: () => call<{ dataUrl: string; width: number; height: number } | null>('clipboard.readImage'),
    writeImage: (dataUrl: string) => call<boolean>('clipboard.writeImage', [dataUrl]),
    history: {
      list: (opts?: { limit?: number }) => call<ClipboardHistoryEntry[]>('clipboard.history.list', [opts]),
      get: (id: string) =>
        call<(ClipboardHistoryEntry & { dataUrl?: string }) | null>('clipboard.history.get', [id]),
      remove: (id: string) => call<boolean>('clipboard.history.remove', [id]),
      clear: () => call<boolean>('clipboard.history.clear'),
      togglePin: (id: string) => call<ClipboardHistoryEntry>('clipboard.history.togglePin', [id])
    }
  },
  screen: {
    capture: (opts?: { displayId?: number; bounds?: ScreenBounds }) =>
      call<ScreenCaptureResult>('screen.capture', [opts]),
    selectRegion: () => call<ScreenBounds | null>('screen.selectRegion'),
    record: {
      start: (opts?: { bounds?: ScreenBounds; withAudio?: boolean; displayId?: number }) =>
        call<{ sessionId: string }>('screen.record.start', [opts]),
      stop: (sessionId: string) =>
        call<{ path: string; size: number; durationMs: number }>('screen.record.stop', [sessionId]),
      cancel: (sessionId: string) => call<boolean>('screen.record.cancel', [sessionId])
    }
  },
  pin: {
    open: (payload: {
      dataUrl?: string
      path?: string
      x?: number
      y?: number
      width?: number
      title?: string
    }) => call<{ pinId: string }>('pin.open', [payload]),
    close: (pinId: string) => call<boolean>('pin.close', [pinId]),
    closeAll: () => call<number>('pin.closeAll'),
    list: () => call<Array<{ pinId: string }>>('pin.list')
  },
  net: {
    fetch: (req: {
      url: string
      method?: 'GET' | 'POST'
      headers?: Record<string, string>
      body?: string
      timeoutMs?: number
    }) =>
      call<{ status: number; headers: Record<string, string>; body: string }>('net.fetch', [req])
  },
  shell: {
    openExternal: (url: string) => call<boolean>('shell.openExternal', [url]),
    /** 导出落盘：系统保存对话框 + 写文件 */
    saveTextFile: (payload: { defaultName?: string; filename?: string; content: string }) =>
      call<{ ok: boolean; path: string } | null>('shell.saveTextFile', [payload])
  },
  notify: (payload: { title?: string; body?: string }) => call<boolean>('notify', [payload]),
  vault: {
    set: (key: string, secret: string) => call<VaultSetResult>('vault.set', [key, secret]),
    has: (keyOrRef: string) => call<boolean>('vault.has', [keyOrRef]),
    remove: (keyOrRef: string) => call<boolean>('vault.remove', [keyOrRef])
  },
  ssh: {
    connect: (input: SshConnectInput) => call<SshSessionInfo>('ssh.connect', [input]),
    write: (sessionId: string, data: string) => call<boolean>('ssh.write', [sessionId, data]),
    resize: (sessionId: string, cols: number, rows: number) =>
      call<boolean>('ssh.resize', [sessionId, cols, rows]),
    disconnect: (sessionId: string) => call<boolean>('ssh.disconnect', [sessionId]),
    listSessions: () => call<SshSessionInfo[]>('ssh.listSessions'),
    exec: (input: SshExecInput) => call<SshExecResult>('ssh.exec', [input]),
    metrics: {
      start: (sessionIdOrOpts: string | { sessionId: string; intervalMs?: number }, intervalMs?: number) => {
        if (sessionIdOrOpts && typeof sessionIdOrOpts === 'object') {
          return call<{ ok: boolean; intervalMs: number }>('ssh.metrics.start', [sessionIdOrOpts])
        }
        return call<{ ok: boolean; intervalMs: number }>('ssh.metrics.start', [
          sessionIdOrOpts,
          intervalMs
        ])
      },
      stop: (sessionId: string | { sessionId: string }) =>
        call<boolean>('ssh.metrics.stop', [sessionId]),
      latest: (sessionId: string | { sessionId: string }) =>
        call<SshMetricsSample | null>('ssh.metrics.latest', [sessionId])
    },
    completion: {
      suggest: (input: {
        sessionId: string
        line: string
        cursor?: number
        history?: string[]
        snippets?: Array<{ title: string; command: string }>
      }) => call<SshCompletionResult>('ssh.completion.suggest', [input])
    },
    sftp: {
      list: (input: SftpListInput) => call<SftpEntry[]>('ssh.sftp.list', [input]),
      download: (input: SftpDownloadInput) => call<SftpTransferResult>('ssh.sftp.download', [input]),
      upload: (input: SftpUploadInput) => call<SftpTransferResult>('ssh.sftp.upload', [input])
    },
    pickLocalFile: (opts?: { properties?: Array<'openFile' | 'openDirectory'> }) =>
      call<string | null>('ssh.pickLocalFile', [opts])
  },
  db: {
    test: (config: DbConnectionConfig) => call<DbTestResult>('db.test', [config]),
    open: (input: { config: DbConnectionConfig; sessionKey?: string } | DbConnectionConfig) =>
      call<DbSessionInfo>('db.open', [input]),
    close: (sessionKey: string) => call<boolean>('db.close', [sessionKey]),
    listSessions: () => call<DbSessionInfo[]>('db.listSessions'),
    pickSqliteFile: () => call<string | null>('db.pickSqliteFile'),
    pickImportFile: () => call<string | null>('db.pickImportFile'),
    execute: (input: DbExecuteInput) => call<QueryResult>('db.execute', [input]),
    explain: (input: { sessionKey: string; sql: string }) => call<QueryResult>('db.explain', [input]),
    cancel: (sessionKey: string | { sessionKey?: string }) =>
      call<boolean>('db.cancel', [sessionKey]),
    applyChanges: (input: DbApplyChangesInput) => call<BatchResult>('db.applyChanges', [input]),
    importPreview: (input: DbImportPreviewInput) => call<DbImportPreviewResult>('db.importPreview', [input]),
    importRun: (input: DbImportRunInput) => call<DbImportRunResult>('db.importRun', [input]),
    schema: {
      tree: (input: DbSchemaTreeInput & { node?: unknown }) =>
        call<SchemaObject[]>('db.schema.tree', [input]),
      describe: (input: {
        sessionKey: string
        database?: string
        schema?: string
        table: string
      }) => call<TableDetail>('db.schema.describe', [input]),
      ddl: (input: {
        sessionKey: string
        database?: string
        schema?: string
        table: string
      }) => call<string>('db.schema.ddl', [input])
    },
    /** completion 同时支持 completion(req) 与 completion.suggest(req) */
    completion: Object.assign(
      (input: DbCompletionInput) => call<CompletionResponse>('db.completion.suggest', [input]),
      {
        suggest: (input: DbCompletionInput) =>
          call<CompletionResponse>('db.completion.suggest', [input])
      }
    ),
    dialects: {
      list: () => call<DbDialectInfo[]>('db.dialects.list')
    }
  },
  on(event: string, cb: Listener) {
    if (!listeners.has(event)) listeners.set(event, new Set())
    listeners.get(event)!.add(cb)
  },
  off(event: string, cb: Listener) {
    listeners.get(event)?.delete(cb)
  },

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
  getEnterCode: () => enterCodeFromQuery()
}

// 订阅主进程生命周期推送，派发到 onEnter / onOut / onBeforeClose / onDestroy
ipcRenderer.on(IpcChannels.PluginLifecycle, (_e, message: PluginLifecycleMessage) => {
  if (!message || typeof message !== 'object') return
  switch (message.event) {
    case 'enter':
      emit('enter', {
        tabId: message.tabId,
        code: message.code,
        payload: message.payload
      } satisfies PluginEnterEvent)
      break
    case 'out':
      emit('out', { isKill: false } satisfies PluginOutEvent)
      break
    case 'beforeClose': {
      // 等插件回调返回的 Promise settle 后再 ack；无监听器 / 纯同步回调时
      // 延迟一个小窗口（给同步 flush 留余量）。主进程另有超时兜底。
      const pending = emitAndCollectPromises('beforeClose', {
        reason: message.reason
      } satisfies PluginBeforeCloseEvent)
      let acked = false
      const ackOnce = () => {
        if (acked) return
        acked = true
        sendBeforeCloseAck()
      }
      if (pending.length > 0) {
        // 任一 handler 返回 Promise 即等待全部 settle；本地 cap 防悬挂
        const cap = setTimeout(ackOnce, BEFORE_CLOSE_ACK_LOCAL_CAP_MS)
        Promise.all(pending).then(() => {
          clearTimeout(cap)
          ackOnce()
        })
      } else {
        setTimeout(ackOnce, BEFORE_CLOSE_SYNC_FLUSH_MS)
      }
      break
    }
    case 'destroy':
      emit('destroy', undefined)
      break
  }
})

// 主题/热键/语言/Quick 查询广播（PluginHost.broadcastTheme 等 → PluginEvent 通道）
ipcRenderer.on(IpcChannels.PluginEvent, (_e, payload: PluginEventPayload) => {
  if (!payload || typeof payload !== 'object') return
  if (payload.type === 'theme-change') {
    emit('theme-change', { mode: payload.mode, tokens: payload.tokens })
  } else if (payload.type === 'hotkey') {
    emit('hotkey', { accelerator: payload.accelerator } satisfies PluginHotkeyEvent)
  } else if (payload.type === 'locale-change') {
    emit('locale-change', { locale: payload.locale } satisfies PluginLocaleChangeEvent)
  } else if (payload.type === 'quick-query') {
    // Quick 搜索 provider 查询：enest.contribute.onQuickQuery / enest.on('quick-query')
    emit('quick-query', { reqId: payload.reqId, query: payload.query })
  } else if (
    payload.type === 'ssh.data' ||
    payload.type === 'ssh.exit' ||
    payload.type === 'ssh.error' ||
    payload.type === 'ssh.metrics'
  ) {
    // SSH 会话事件：enest.on('ssh.data'|'ssh.exit'|'ssh.error'|'ssh.metrics')
    emit(payload.type, payload)
  }
})

// 同时暴露 enest 与 zapi 两个全局名，兼容不同插件 SDK 期望
contextBridge.exposeInMainWorld('enest', api)
contextBridge.exposeInMainWorld('zapi', api)
