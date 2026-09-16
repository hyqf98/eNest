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
 * beforeClose 收到后 preload 会自动回 ack（主进程最多等 300ms）。
 */
import { contextBridge, ipcRenderer } from 'electron'
import {
  IpcChannels,
  type PluginCallRequest,
  type PluginCallResult,
  type PluginEventPayload
} from '@shared/types/ipc'
import type {
  PluginCloseReason,
  PluginEnterPayload,
  PluginLifecycleMessage
} from '@shared/types/plugin'

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
  }
  shell: {
    openExternal(url: string): Promise<boolean>
  }
  notify(payload: { title?: string; body?: string }): Promise<boolean>
  on(event: string, cb: Listener): void
  off(event: string, cb: Listener): void

  // —— 生命周期（对标 uTools onPluginEnter / onPluginOut）——
  /** 进入插件：首次加载完成后 + 每次 Tab 激活；与 onOut 成对，可 pause/resume */
  onEnter(cb: (event: PluginEnterEvent) => void): Unsubscribe
  /** 退到后台：其它 Tab 成为 active；isKill 恒 false */
  onOut(cb: (event: PluginOutEvent) => void): Unsubscribe
  /** 即将销毁：可在此 flush 草稿；preload 会自动回 ack，主进程最多等 300ms */
  onBeforeClose(cb: (event: PluginBeforeCloseEvent) => void): Unsubscribe
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
    writeText: (text: string) => call<boolean>('clipboard.writeText', [text])
  },
  shell: {
    openExternal: (url: string) => call<boolean>('shell.openExternal', [url])
  },
  notify: (payload: { title?: string; body?: string }) => call<boolean>('notify', [payload]),
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
      emit('beforeClose', { reason: message.reason } satisfies PluginBeforeCloseEvent)
      // 自动 ack：插件同步回调跑完即确认；异步 flush 需在 300ms 内自行完成
      try {
        ipcRenderer.send(IpcChannels.PluginLifecycleAck, { event: 'beforeClose' })
      } catch {
        // 通道可能已随销毁关闭
      }
      break
    }
    case 'destroy':
      emit('destroy', undefined)
      break
  }
})

// 主题变更广播（PluginHost.broadcastTheme → PluginEvent 通道）
ipcRenderer.on(IpcChannels.PluginEvent, (_e, payload: PluginEventPayload) => {
  if (payload && payload.type === 'theme-change') {
    emit('theme-change', { mode: payload.mode, tokens: payload.tokens })
  }
})

// 同时暴露 enest 与 zapi 两个全局名，兼容不同插件 SDK 期望
contextBridge.exposeInMainWorld('enest', api)
contextBridge.exposeInMainWorld('zapi', api)
