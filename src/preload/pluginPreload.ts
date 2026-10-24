import { bindNativeInstallDrop } from './installDropBridge'
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
 * （任一返回 Promise 即等待）；无监听器 / 纯同步回调时在微任务检查点后 ack。
 * 主进程侧另有超时兜底，本地 cap 只防悬挂。
 */
import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { QuickInputAction, QuickInputConfig, PluginBlob, PluginFileSaveResult, ClipboardCapabilities, ClipboardFileInspection } from '@shared/types/plugin-tools'
import type { AuxiliaryApi } from '@shared/types/auxiliary'
import type { FileStreamsApi } from '@shared/types/file-stream'
import type { DeadlineTaskStart, DeadlineTaskSnapshot } from '@shared/types/deadline-task'
import type { VaultSetResult } from '@shared/types/vault'
import type { LocalFileHandle, LocalFilePickOptions, PluginInputContext } from '@shared/types/local-files'
import type { PluginToastOptions } from '@shared/types/notification'
import { BEFORE_CLOSE_ACK_LOCAL_CAP_MS, SAVE_REQUEST_ACK_LOCAL_CAP_MS } from '@shared/constants'
import type { ShellNotice, ShellNoticeDataMap, ShellNoticeTopic, SaveRequestedEvent, SaveRequestedData } from '@shared/types/notice'
import {
  IpcChannels,
  type PluginCallRequest,
  type PluginCallResult,
  type PluginEventPayload
} from '@shared/types/ipc'
import type { ResolvedAppearance } from '@shared/types/appearance'
import type { HomePageRegistrationInput, HomePageRegistrationResult } from '@shared/types/home'
import type { ThemePackRegistrationInput } from '@shared/types/plugin'
import type {
  AppLocale,
  CaptureDisplay,
  PluginCloseReason,
  PluginEnterPayload,
  PluginLifecycleMessage,
  PluginLaunchMode,
  ScreenBounds,
  ScreenCaptureResult
} from '@shared/types/plugin'

/** ack 等待的本地上限：略大于主进程超时，仅防悬挂；主进程超时是真正的兜底（配对常量在 @shared/constants） */

/** 读当前页 URL query 参数（preload 无 DOM 保证，失败返回 null） */
function getQueryParam(name: string): string | null {
  try {
    const search =
      (globalThis as unknown as { location?: { search?: string } }).location?.search ?? ''
    return new URLSearchParams(search).get(name)
  } catch {
    return null
  }
}

function getPluginIdFromQuery(): string {
  return getQueryParam('pid') ?? ''
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
  return getQueryParam('code') ?? undefined
}

/**
 * URL query 中的启动方式（?mode=quick|shell）：插件首个脚本同步读取的初始值。
 * 容器迁移不重载页面、URL 不变，运行时真值以 mode-change 事件更新后的
 * getLaunchMode() 为准。
 */
function launchModeFromQuery(): PluginLaunchMode | null {
  const mode = getQueryParam('mode')
  return mode === 'quick' || mode === 'shell' ? mode : null
}

/** 当前启动方式（mode-change 事件实时更新；缺省按 URL ?mode=，再缺省 shell） */
let currentLaunchMode: PluginLaunchMode | null = null

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
 * 同步抛错转为失败结果；返回非 Promise 的监听器不参与等待。
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
        pending.push(Promise.resolve(ret))
      }
    } catch (error) {
      pending.push(Promise.reject(error))
    }
  }
  return pending
}

/** 发送 beforeClose / save-requested ack；通道可能已随销毁关闭，失败静默（主进程有超时兜底） */
function sendBeforeCloseAck(event: 'beforeClose' | 'beforeSuspend' | 'save-requested', operationId: string, success = true): void {
  try {
    ipcRenderer.send(IpcChannels.PluginLifecycleAck, { event, operationId, success })
  } catch {
    // 通道可能已随销毁关闭
  }
}

/** Toast 类型：info 默认，success/warn/error 带强调色 */
export type { PluginToastType } from '@shared/types/notification'

/** 壳统一通知类型再导出（信封 / topic 映射 / save.requested 事件） */
export type { ShellNotice, ShellNoticeDataMap, ShellNoticeTopic, SaveRequestedEvent } from '@shared/types/notice'

/** enter 事件载荷；mode = 本次进入的启动方式（quick 小窗 / shell 主窗） */
export type PluginEnterEvent = PluginEnterPayload & {
  tabId: string
  mode: PluginLaunchMode
}
/** out 事件载荷；isKill 恒为 false（杀死走 beforeClose/destroy） */
export type PluginOutEvent = { isKill: false }
/** beforeClose 事件载荷 */
export type PluginBeforeCloseEvent = { reason: PluginCloseReason }

/** 启动方式变更事件（quick ↔ shell 容器迁移，不重载页面） */
export type PluginModeChangeEvent = { mode: PluginLaunchMode }

/** 主题变量集合（壳子解析后的 CSS 自定义属性值） */
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
  /** 选择此业务结果时随 onEnter 传回；应为可通过 IPC 克隆的数据。 */
  payload?: unknown
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

/** net.socket 数据事件（enest.net.onNetData / enest.on('net.data')） */
export type NetDataEvent = {
  socketId: string
  /** base64 编码的分片（64KB / 20ms 双阈值节流合并） */
  chunk: string
}

/** net.socket 关闭事件（enest.net.onNetClose / enest.on('net.close')） */
export type NetCloseEvent = {
  socketId: string
  reason: string
}

/** net.fetch 流式分片事件（enest.net.onChunk / enest.on('net.chunk')） */
export type NetChunkEvent = {
  reqId: string
  /** base64（流式响应）或 utf8 文本（SSE data: 行） */
  chunk: string
  done?: boolean
  error?: string
}

/** net.socket.connect 返回 */
export type NetSocketHandle = {
  socketId: string
}

/** net.socket.serveWs 返回：插件页内 new WebSocket(url) 直连 */
export type NetWsEndpoint = {
  url: string
  /** 一次性 token（已含在 url query；单独暴露便于自定义拼装） */
  token: string
  port: number
}

/** net.socket.list 条目 */
export type NetSocketListItem = {
  socketId: string
  host: string
  port: number
  tls: boolean
  sessionId?: string
  status: string
  openedAt: number
  rxBytes: number
  txBytes: number
  ws?: { port: number; url: string } | null
}

/** net.fetch 返回（stream:true 时 body 为空、分片走 net.chunk） */
export type NetFetchResult = {
  status: number
  headers: Record<string, string>
  body: string
  streamed?: boolean
  reqId?: string
}

/** sys.processes 条目 */
export type SysProcessInfo = {
  pid: number
  pcpu: number
  pmem: number
  /** 常驻内存（KB） */
  rss: number
  user: string
  command: string
}

/** sys.ports 条目 */
export type SysPortInfo = {
  command: string
  pid: number
  user: string
  protocol: string
  /** 监听地址（IPv4/IPv6 原样） */
  address: string
  port: number
  name: string
}

type Unsubscribe = () => void

export interface EnestPluginApi {
  setTitle(title: string): Promise<boolean>
  setIcon(icon: string): Promise<boolean>
  setBadge(badge: string | number): Promise<boolean>
  resize(size: { width?: number; height?: number }): Promise<boolean>
  /**
   * 上报未保存数据标记（基础能力，无需声明或授权）：编辑时置 true、持久化完成后置 false。
   * 壳子更新重启前的脏检测与一键保存依赖此标记；不上报则视为无未保存数据。
   */
  setDirty(dirty: boolean): Promise<boolean>
  /**
   * 订阅壳统一通知（ShellNotice 标准信封）：不传 topic 收全量；
   * 传 topic 只收该主题（data 按 ShellNoticeDataMap 收窄）。未知 topic 自动过滤。
   */
  onNotice(cb: (notice: ShellNotice) => void): Unsubscribe
  onNotice<T extends ShellNoticeTopic>(topic: T, cb: (notice: ShellNotice<T>) => void): Unsubscribe
  /**
   * 壳请求立即保存数据（save.requested 通知，更新重启 / 退出前触发）：
   * 回调里持久化并返回 Promise，settle 后自动 ack（主进程 deadlineMs 超时兜底）；保存需幂等。
   */
  onSaveRequested(cb: (event: SaveRequestedEvent) => void | Promise<unknown>): Unsubscribe
  /** UI 命名空间：与 PLUGIN_SPEC 的 enest.ui.* 对齐 */
  ui: {
    /** Classic/orb Tab title, up to 120 characters; empty restores the manifest name. */
    setTitle(title: string): Promise<boolean>
    /** 1–2 visible Unicode code points, never a URL/path; empty restores the package icon. */
    setIcon(icon: string): Promise<boolean>
    /** Classic/orb badge: integer 0–999999 or text up to 8 characters; empty clears it. */
    setBadge(badge: string | number): Promise<boolean>
    /** 兼容尺寸建议接口（CSS px）；Quick 使用固定视口，主窗由用户控制，调用成功不改变窗口尺寸。基础能力，无需声明或授权。 */
    resize(size: { width?: number; height?: number }): Promise<boolean>
    /**
     * 兼容内容高度建议（px）；Quick 与主窗均不据此改变窗口尺寸。
     * 基础能力，无需声明或授权。
     */
    setHeight(height: number): Promise<boolean>
    /** Move this plugin's existing view to the desktop without reloading it. */
    openInShell(): Promise<boolean>
    openSettings(): Promise<boolean>
    /** Focused editor/terminal/overlay owns keys that Quick otherwise intercepts. */
    setInputContext(context: PluginInputContext): Promise<boolean>
    focus(): Promise<boolean>
    /** Return focus to the Quick global search without closing this plugin. */
    focusSearch(): Promise<boolean>
    /**
     * 提交即收起 Quick 小窗（如回车回贴/复制完成后的「选中即走」）。
     * 仅当本插件正挂载于 Quick 容器时生效，其余容器为无操作；
     * 收起走统一隐藏语义，下次呼出仍恢复本插件。基础能力，无需声明或授权。
     */
    dismissQuick(): Promise<boolean>
    /** 原生容器中的安全富文本通知；兼容 message/type，不需要额外授权。 */
    toast(payload: PluginToastOptions): Promise<boolean>
    /** 读取当前主题变量（themeAware 插件可主动拉取） */
    getThemeTokens(): Promise<{ mode: 'light' | 'dark'; tokens: PluginThemeTokens }>
    /** 订阅主题变更；壳子 setTheme / OS 主题切换时推送 */
    onThemeChange(cb: (event: PluginThemeChangeEvent) => void): Unsubscribe
  }
  /** 主题命名空间：enest.theme.getTokens() / register() */
  theme: {
    getTokens(): Promise<{ mode: 'light' | 'dark'; tokens: PluginThemeTokens }>
    /** Phase 1 read-only semantic appearance; home references are availability only. */
    getAppearance(): Promise<ResolvedAppearance>
    /** Subscribe to semantic appearance changes; returns an unsubscribe function. */
    onAppearanceChange(cb: (appearance: ResolvedAppearance) => void): Unsubscribe
    /**
     * 注册主题包到壳子设置 → 主题 下拉列表。
     * V1 ThemePack or ThemePackV2; source is host-bound and ignored in requests.
     */
    register(pack: ThemePackRegistrationInput): Promise<unknown>
  }
  /** Confirm an own, installed and enabled manifest home entry; never activates it. */
  home: {
    register(contribution: HomePageRegistrationInput): Promise<HomePageRegistrationResult>
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
   * 需声明 contribute 并取得授权：注册后会接收 Quick 全局搜索文本。
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
      items: Array<{ key: string; type: string; label: string; default?: unknown; entry?: { code: string; payload?: unknown }; options?: Array<{ label: string; value: unknown }>; min?: number; max?: number; step?: number }>
    }): Promise<boolean>
    get(key: string): Promise<unknown>
    set(key: string, value: unknown): Promise<boolean>
    onChange(cb: (event: { key: string; value: unknown }) => void): Unsubscribe
  }
  quickInput: {
    configure(config: QuickInputConfig): Promise<boolean>
    release(): Promise<boolean>
    escape(): Promise<boolean>
    onChange(cb: (value: string) => void): Unsubscribe
    onAction(cb: (action: QuickInputAction) => void): Unsubscribe
  }
  deadlineTasks: {
    start(input: DeadlineTaskStart): Promise<DeadlineTaskSnapshot>
    get(id: string): Promise<DeadlineTaskSnapshot>
    pause(id: string): Promise<DeadlineTaskSnapshot>
    resume(id: string): Promise<DeadlineTaskSnapshot>
    skip(id: string): Promise<DeadlineTaskSnapshot>
    cancel(id: string): Promise<DeadlineTaskSnapshot>
    onChange(cb: (event: { taskId: string }) => void): Unsubscribe
  }
  storage: {
    blobs: {
      put(input: { dataUrl: string; name?: string }): Promise<PluginBlob>
      get(id: string): Promise<{ dataUrl: string; bytes: number } | null>
      remove(id: string): Promise<boolean>
    }
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
  background: {
    call<T = unknown>(method: string, args?: unknown[], options?: { timeoutMs?: number }): Promise<T>
  }
  auxiliary: AuxiliaryApi
  files: { stream: FileStreamsApi }
  clipboard: {
    capabilities(): Promise<ClipboardCapabilities>
    requestPermission(): Promise<ClipboardCapabilities>
    readText(): Promise<string>
    /** Host writes never feed back into the native change observer. */
    writeText(text: string, options?: { excludeFromHistory?: boolean }): Promise<boolean>
    readImage(): Promise<{ dataUrl: string; width: number; height: number } | null>
    writeImage(dataUrl: string): Promise<boolean>
    writeFiles(paths: string[]): Promise<boolean>
    paste(): Promise<{ pasted: boolean; reason?: string }>
    /** Unknown paths are not inspected; only previously user-granted targets have existence data. */
    inspectFiles(paths: string[]): Promise<ClipboardFileInspection[]>
    /** Opens a native target-confirmation dialog before revealing the selected path. */
    revealFile(path: string): Promise<boolean>
  }
  screen: {
    capture(opts?: { displayId?: number; bounds?: ScreenBounds }): Promise<ScreenCaptureResult>
    displays(): Promise<CaptureDisplay[]>
  }
  net: {
    /**
     * 受控 HTTP(S) 请求：GET/POST/PUT/PATCH/DELETE/HEAD；明文 http 需 manifest
     * `net.allowInsecure`。stream:true 时立即返回元信息，响应体经 net.chunk
     * 分片推送（上限 32MB）；text/event-stream 按 data: 行转发。
     */
    fetch(req: {
      url: string
      method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD'
      headers?: Record<string, string>
      body?: string
      timeoutMs?: number
      /** 流式响应 / SSE 模式（分片走 onChunk） */
      stream?: boolean
    }): Promise<NetFetchResult>
    websocket: {
      connect(input: { url: string; protocols?: string[] }): Promise<{ socketId: string }>
      send(socketId: string, data: string, binary?: boolean): Promise<{ sent: number }>
      close(socketId: string): Promise<boolean>
      /** Binary messages carry base64 data; text messages carry UTF-8 text. */
      onMessage(cb: (event: { socketId: string; data: string; binary: boolean }) => void): Unsubscribe
      onClose(cb: (event: { socketId: string; code: number; reason: string }) => void): Unsubscribe
    }
    socket: {
      /**
       * 建立出站 TCP / TLS 连接（仅 outgoing）。host 可为 127.0.0.1 衔接
       * 插件私有后端打开的本地隧道口。需 net.socket 权限。
       */
      connect(input: {
        sessionId?: string
        host: string
        port: number
        tls?: boolean
        timeoutMs?: number
      }): Promise<NetSocketHandle>
      /** 默认 UTF-8 文本；二进制须显式指定 base64。受 1MB/s 令牌桶限速。 */
      send(socketId: string, data: string, encoding?: 'utf8' | 'base64'): Promise<{ sent: number }>
      /** 关闭连接（插件侧主动关闭；插件关闭时宿主自动释放） */
      close(socketId: string): Promise<boolean>
      /** 本插件全部 socket 概览（含 ws 桥端口） */
      list(): Promise<NetSocketListItem[]>
      /**
       * 为已连接 socket 起本地 WebSocket 桥（仅 127.0.0.1 随机端口，
       * 一次性 token）：插件页内 new WebSocket(url) 直连该 TCP 流的
       * 双向二进制通道（noVNC / ironrdp-wasm 场景，避免逐帧 IPC）。
       */
      serveWs(socketId: string): Promise<NetWsEndpoint>
    }
    /** 订阅 socket 数据分片（base64）；等价 enest.on('net.data') */
    onNetData(cb: (event: NetDataEvent) => void): Unsubscribe
    /** 订阅 socket 关闭；等价 enest.on('net.close') */
    onNetClose(cb: (event: NetCloseEvent) => void): Unsubscribe
    /** 订阅 fetch 流式分片 / SSE data 行；等价 enest.on('net.chunk') */
    onChunk(cb: (event: NetChunkEvent) => void): Unsubscribe
  }
  /**
   * 本地文件改名（fs.rename 权限）：仅对 localFiles 句柄白名单内文件做
   * 同目录改名；newName 必须是纯文件名（禁路径分隔符 / .. / 盘符）。
   */
  fs: {
    /** 单文件改名；返回 { oldName, newName } */
    rename(input: { handleId: string; newName: string }): Promise<{ handleId: string; oldName: string; newName: string }>
    /** 批量改名；必须 confirmed: true（危险操作二次确认）；逐项返回 ok/error */
    renameBatch(input: {
      items: Array<{ handleId: string; newName: string }>
      confirmed?: boolean
    }): Promise<{
      results: Array<{ handleId: string; oldName: string; newName: string; ok: boolean; error?: string }>
      succeeded: number
      failed: number
    }>
  }
  /** 本机进程与端口查看（sys.inspect，1s 缓存）/ 终止（sys.control） */
  sys: {
    processes(): Promise<SysProcessInfo[]>
    ports(): Promise<SysPortInfo[]>
    /**
     * 结束进程：需 sys.control 权限与宿主原生确认（保护壳子进程、父进程与 PID 1）。
     * signal：TERM（缺省）/ KILL / INT。
     */
    kill(pid: number, opts?: { signal?: 'TERM' | 'KILL' | 'INT'; confirmed?: boolean }): Promise<boolean>
  }
  shell: {
    saveFile(input: { defaultName: string; dataUrl: string }): Promise<PluginFileSaveResult | null>
    openExternal(url: string): Promise<boolean>
    saveTextFile(payload: {
      defaultName?: string
      filename?: string
      content: string
    }): Promise<{ ok: boolean; path: string } | null>
  }
  notify(payload: { title?: string; body?: string }): Promise<boolean>
  /** 插件私有密钥保险库：set→secretRef；无明文 get。基础能力，无需声明或授权；系统加密不可用时保存失败。 */
  vault: {
    set(key: string, secret: string): Promise<VaultSetResult>
    has(keyOrRef: string): Promise<boolean>
    remove(keyOrRef: string): Promise<boolean>
  }
  /** User-selected local file handles, isolated to the calling plugin. */
  localFiles: {
    /** Read a chosen file; UTF-8 text or a base64 data URL. Hard limit 32 MiB, two simultaneous reads. */
    read(input: { handleId: string; encoding?: 'text' | 'dataUrl'; maxBytes?: number }): Promise<string>
    pick(options?: LocalFilePickOptions): Promise<LocalFileHandle[]>
    /** The plugin may suggest a filename; omitted/empty uses the native dialog default. */
    pickSave(options?: { defaultName?: string }): Promise<LocalFileHandle | null>
    fromDrop(files: File[]): Promise<LocalFileHandle[]>
    list(input: { handleId: string; relativePath?: string }): Promise<{ directory: LocalFileHandle; entries: LocalFileHandle[] }>
    reveal(handleId: string): Promise<boolean>
    prepareDrag(input: { handleIds: string[] }): Promise<{ exportId: string }>
    startDrag(exportId: string): Promise<boolean>
    endDrag(): Promise<boolean>
  }
  on(event: string, cb: Listener): void
  off(event: string, cb: Listener): void

  // —— 生命周期（对标 uTools onPluginEnter / onPluginOut）——
  /** 进入插件：首次加载完成后 + 每次 Tab 激活；与 onOut 成对，可 pause/resume */
  onEnter(cb: (event: PluginEnterEvent) => void): Unsubscribe
  /** 退到后台：其它 Tab 成为 active；isKill 恒 false */
  onOut(cb: (event: PluginOutEvent) => void): Unsubscribe
  /** 即将销毁：可在此 flush 草稿；回调返回 Promise 时 preload 等其 settle 再 ack */
  onBeforeSuspend(cb: () => void | Promise<unknown>): Unsubscribe
  runtime: { acquireActivity(reason: string): Promise<string>; releaseActivity(token: string): Promise<void> }
  /** Calls the plugin-owned Node backend after explicit backend.node consent. */
  backend: {
    call<T = unknown>(method: string, args?: unknown[], options?: { timeoutMs?: number }): Promise<T>
    stop(): Promise<void>
  }
  onBeforeClose(cb: (event: PluginBeforeCloseEvent) => void | Promise<unknown>): Unsubscribe
  /** 关闭已开始（best-effort），通常已在 beforeClose 完成清理 */
  onDestroy(cb: () => void): Unsubscribe
  /** 当前插件 id（与 query pid 一致） */
  getPluginId(): string
  /** URL query 中的 code；完整载荷以 onEnter 为准 */
  getEnterCode(): string | undefined
  /**
   * 当前启动方式：quick = Quick 小窗内嵌（小窗适配样式）/ shell = 主窗大窗
   * （桌面适配样式）。初始值来自 URL ?mode=，容器迁移（固定到主窗等）时经
   * mode-change 事件实时更新——插件据此在两套入口样式间切换。
   */
  getLaunchMode(): PluginLaunchMode
  /** 启动方式变更（quick ↔ shell 迁移，不重载页面）；立即生效后回调 */
  onModeChange(cb: (mode: PluginLaunchMode) => void): Unsubscribe
}

function subscribeToolEvent<T>(event: string, cb: (data: T) => void): Unsubscribe {
  const handler: Listener = data => cb(data as T)
  api.on(event, handler)
  return () => api.off(event, handler)
}

const api: EnestPluginApi = {
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
    blobs: {
      put: input => call('storage.blobs.put', [input]),
      get: id => call('storage.blobs.get', [id]),
      remove: id => call('storage.blobs.remove', [id])
    },
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
      call<{ ok: boolean; path: string } | null>('shell.saveTextFile', [payload])
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
  getLaunchMode: () => currentLaunchMode ?? launchModeFromQuery() ?? 'shell',
  onModeChange(cb) {
    const handler: Listener = (data) => cb((data as PluginModeChangeEvent).mode)
    api.on('mode-change', handler)
    return () => api.off('mode-change', handler)
  }
}

// 订阅主进程生命周期推送，派发到 onEnter / onOut / onBeforeClose / onDestroy
ipcRenderer.on(IpcChannels.PluginLifecycle, (_e, message: PluginLifecycleMessage) => {
  if (!message || typeof message !== 'object') return
  switch (message.event) {
    case 'enter':
      emit('enter', {
        tabId: message.tabId,
        mode: message.mode ?? 'shell',
        code: message.code,
        type: message.type,
        payload: message.payload
      } satisfies PluginEnterEvent)
      break
    case 'out':
      emit('out', { isKill: false } satisfies PluginOutEvent)
      break
    case 'beforeSuspend':
    case 'beforeClose': {
      // 等插件回调返回的 Promise settle 后再 ack；无监听器 / 纯同步回调时
      // 用微任务确认（同步 IPC 已按序发出），避免隐藏页 timer 节流。主进程另有超时兜底。
      const pending = emitAndCollectPromises(message.event, message.event === 'beforeClose' ? { reason: message.reason } satisfies PluginBeforeCloseEvent : undefined)
      let acked = false
      const ackOnce = (success = true) => {
        if (acked) return
        acked = true
        sendBeforeCloseAck(message.event, message.operationId, success)
      }
      if (pending.length > 0) {
        // 任一 handler 返回 Promise 即等待全部 settle；本地 cap 防悬挂
        const cap = setTimeout(() => ackOnce(false), BEFORE_CLOSE_ACK_LOCAL_CAP_MS)
        Promise.allSettled(pending).then((results) => {
          clearTimeout(cap)
          ackOnce(results.every((result) => result.status === 'fulfilled'))
        })
      } else {
        queueMicrotask(() => ackOnce())
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
  switch (payload.type) {
    case 'backend.event':
    case 'background.event': {
      emit(payload.type, { event: payload.event, data: payload.data })
      break
    }
    case 'auxiliary.message': {
      emit(payload.type, { windowId: payload.windowId, data: payload.data })
      break
    }
    case 'auxiliary.closed': {
      emit(payload.type, { windowId: payload.windowId })
      break
    }
    case 'quick-input-change': {
      emit(payload.type, payload.value)
      break
    }
    case 'quick-input-action': {
      emit(payload.type, payload.action)
      break
    }
    case 'settings-change': {
      emit(payload.type, { key: payload.key, value: payload.value })
      break
    }
    case 'deadline-task-change': {
      emit(payload.type, { taskId: payload.taskId })
      break
    }
    case 'theme-change': {
      emit('theme-change', { mode: payload.mode, tokens: payload.tokens })
      break
    }
    case 'appearance-change': {
      emit('appearance-change', { appearance: payload.appearance })
      break
    }
    case 'hotkey': {
      emit('hotkey', { accelerator: payload.accelerator } satisfies PluginHotkeyEvent)
      break
    }
    case 'locale-change': {
      emit('locale-change', { locale: payload.locale } satisfies PluginLocaleChangeEvent)
      break
    }
    case 'mode-change': {
      // 启动方式变更（quick ↔ shell 迁移不重载）：更新真值并通知插件切换入口样式
      currentLaunchMode = payload.mode
      emit('mode-change', { mode: payload.mode } satisfies PluginModeChangeEvent)
      break
    }
    case 'quick-query': {
      // Quick 搜索 provider 查询：enest.contribute.onQuickQuery / enest.on('quick-query')
      emit('quick-query', { reqId: payload.reqId, query: payload.query })
      break
    }
    case 'net.data': {
      // net.socket 数据分片：enest.net.onNetData / enest.on('net.data')
      emit('net.data', { socketId: payload.socketId, chunk: payload.chunk } satisfies NetDataEvent)
      break
    }
    case 'net.close': {
      // net.socket 关闭：enest.net.onNetClose / enest.on('net.close')
      emit('net.close', { socketId: payload.socketId, reason: payload.reason } satisfies NetCloseEvent)
      break
    }
    case 'net.chunk': {
      // net.fetch 流式分片 / SSE 行：enest.net.onChunk / enest.on('net.chunk')
      emit('net.chunk', {
        reqId: payload.reqId,
        chunk: payload.chunk,
        ...(payload.done !== undefined ? { done: payload.done } : {}),
        ...(payload.error !== undefined ? { error: payload.error } : {})
      } satisfies NetChunkEvent)
      break
    }
    case 'shell-notice': {
      // 壳统一通知：enest.onNotice / enest.on('shell-notice')；save.requested 带确认语义
      emit('shell-notice', payload.notice)
      if (payload.notice?.topic === 'save.requested') {
        const data = payload.notice.data as SaveRequestedData
        // 与 beforeClose 同款 ack：等 save-requested 回调返回的 Promise settle 后上报
        const pending = emitAndCollectPromises('save-requested', {
          reason: data.reason,
          deadlineMs: data.deadlineMs,
          operationId: data.operationId
        } satisfies SaveRequestedEvent)
        let acked = false
        const ackOnce = (success = true) => {
          if (acked) return
          acked = true
          sendBeforeCloseAck('save-requested', data.operationId, success)
        }
        if (pending.length > 0) {
          const cap = setTimeout(() => ackOnce(false), SAVE_REQUEST_ACK_LOCAL_CAP_MS)
          Promise.allSettled(pending).then((results) => {
            clearTimeout(cap)
            ackOnce(results.every((result) => result.status === 'fulfilled'))
          })
        } else {
          queueMicrotask(() => ackOnce())
        }
      }
      break
    }
    case 'net.websocket.message':
      emit(payload.type, { socketId: payload.socketId, data: payload.data, binary: payload.binary })
      break
    case 'net.websocket.close':
      emit(payload.type, { socketId: payload.socketId, code: payload.code, reason: payload.reason })
      break
    default: {
      // Every declared host event must have a bridge; unknown runtime payloads are ignored.
      const unhandled: never = payload
      void unhandled
    }
  }
})

// 同时暴露 enest 与 zapi 两个全局名，兼容不同插件 SDK 期望
const dragEvents = globalThis as unknown as { addEventListener?: (type: string, listener: () => void, capture?: boolean) => void }
dragEvents.addEventListener?.('dragend', () => { void api.localFiles.endDrag().catch(() => {}) }, true)
contextBridge.exposeInMainWorld('enest', api)
contextBridge.exposeInMainWorld('zapi', api)

// Capture package drops without exposing an install API to plugin JavaScript.
bindNativeInstallDrop(true)
