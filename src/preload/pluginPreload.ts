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
import type { QuickInputAction, QuickInputConfig, PluginBlob, PluginFileSaveResult, ClipboardCapabilities, ClipboardQuery } from '@shared/types/plugin-tools'
import type { FocusTimerOptions, FocusTimerSnapshot, FocusTimerRecordPatch } from '@shared/types/focus-timer'
import type { LocalFileHandle, LocalFilePickOptions, PluginInputContext } from '@shared/types/local-files'
import type { PluginToastOptions } from '@shared/types/notification'
import type { SshWorkbenchRequest } from '@shared/types/ssh-workbench'
import type { DbWorkbenchRequest } from '@shared/types/db-workbench'
import type { MwWorkbenchRequest } from '@shared/types/mw-workbench'
import type { DshWorkbenchEvent, DshWorkbenchRequest } from '@shared/types/dsh-workbench'
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
  ClipboardHistoryEntry,
  PluginCloseReason,
  PluginEnterPayload,
  PluginLifecycleMessage,
  PluginLaunchMode,
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

/** SFTP 传输进度事件（enest.ssh.onSshTransfer / enest.on('ssh.transfer')） */
export type SshTransferEvent = {
  sessionId: string
  direction: 'upload' | 'download'
  path: string
  transferred: number
  /** 0 表示未知（预取大小失败） */
  total: number
  done?: boolean
  error?: string
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

/** lan.share 状态（start/status/list 返回；files 不含宿主侧路径） */
export type LanShareStatus = {
  shareId: string
  port: number
  /** 6 位数字取件码 */
  code: string
  files: Array<{ id: string; name: string; size: number }>
  /** 本机内网 IPv4 列表（内网段优先），供展示与生成二维码 */
  ips: string[]
  startedAt: number
  expiresAt: number
  stopped?: boolean
  stopReason?: string
  activeConnections: number
  downloads: number
}

/** lan.request 下载请求日志事件（enest.net.share.onRequest） */
export type LanRequestEvent = {
  shareId: string
  file: string
  ip: string
  ts: number
}

/** lan.stopped 分享关停事件（enest.net.share.onStopped） */
export type LanStoppedEvent = {
  shareId: string
  reason: string
}

/** agent.apps 条目 */
export type AgentAppInfo = {
  app: string
  name: string
  configPaths: string[]
  installed: boolean
  active: boolean
}

/** agent.read 返回 */
export type AgentConfigSnapshot = {
  app: string
  files: Array<{ path: string; content: string; parsed: unknown; exists: boolean }>
  active: boolean
  readAt: number
}

/** agent.write 载荷：changes 为「文件内顶层键 → 新值」映射（最小侵入合并） */
export type AgentWriteInput = {
  app: string
  changes: Record<string, unknown>
  confirmed?: boolean
}

/** agent.write 返回 */
export type AgentWriteResult = {
  ok: boolean
  app: string
  written: string[]
  backupId: string
}

/** agent.backups 条目 */
export type AgentBackupInfo = {
  id: string
  app: string
  createdAt: number
  files: string[]
}

/** agent.sessions.list 条目文件 */
export type AgentSessionFile = {
  file: string
  path: string
  bytes: number
  modifiedAt: number
  project?: string
}

/** agent.sessions.list 返回（每个会话根目录一条） */
export type AgentSessionsListResult = {
  app: string
  root: string
  files: AgentSessionFile[]
  truncated: boolean
}

/** agent.sessions.read 单行（json 解析失败为 null） */
export type AgentSessionLine = {
  n: number
  json: unknown
  raw: string
  truncated: boolean
}

/** agent.sessions.read 返回 */
export type AgentSessionsReadResult = {
  app: string
  file: string
  path: string
  bytes: number
  readBytes: number
  truncated: boolean
  lines: AgentSessionLine[]
}

/** agent.listAssets 条目 */
export type AgentAssetEntry = {
  name: string
  isDir: boolean
  size: number
  modifiedAt: number
}

/** agent.listAssets 返回 */
export type AgentListAssetsResult = {
  app: string
  root: string
  path: string
  entries: AgentAssetEntry[]
  truncated: boolean
}

/** agent.writeAssets 单文件载荷（contentText / contentBase64 二选一） */
export type AgentAssetInput = {
  path: string
  contentText?: string
  contentBase64?: string
}

/** agent.writeAssets 载荷（宿主权限校验后落盘） */
export type AgentWriteAssetsInput = {
  app: string
  assets: AgentAssetInput[]
  confirmed?: boolean
}

/** agent.writeAssets 返回 */
export type AgentWriteAssetsResult = {
  ok: boolean
  app: string
  written: string[]
  /** 覆盖了已存在文件时的快照 id（未覆盖为 null） */
  backupId: string | null
}

/** agent.deleteAssets 载荷 */
export type AgentDeleteAssetsInput = {
  app: string
  paths: string[]
  confirmed?: boolean
}

/** agent.deleteAssets 返回 */
export type AgentDeleteAssetsResult = {
  ok: boolean
  app: string
  deleted: string[]
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
  focusTimer: {
    start(options: Partial<FocusTimerOptions>): Promise<FocusTimerSnapshot>
    get(): Promise<FocusTimerSnapshot>
    pause(): Promise<FocusTimerSnapshot>
    resume(): Promise<FocusTimerSnapshot>
    skip(): Promise<FocusTimerSnapshot>
    stop(): Promise<FocusTimerSnapshot>
    updateRecord(recordId: string, patch: FocusTimerRecordPatch): Promise<FocusTimerSnapshot>
    onChange(cb: (snapshot: FocusTimerSnapshot) => void): Unsubscribe
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
  clipboard: {
    capabilities(): Promise<ClipboardCapabilities>
    requestPermission(): Promise<ClipboardCapabilities>
    readText(): Promise<string>
    /** excludeFromHistory protects this write from eNest's own history collector. */
    writeText(text: string, options?: { excludeFromHistory?: boolean }): Promise<boolean>
    readImage(): Promise<{ dataUrl: string; width: number; height: number } | null>
    writeImage(dataUrl: string): Promise<boolean>
    history: {
      query(options?: ClipboardQuery): Promise<{ items: ClipboardHistoryEntry[]; total: number; nextCursor: number | null }>
      copy(id: string, options?: { plainText?: boolean; paths?: boolean }): Promise<boolean>
      paste(id: string): Promise<{ pasted: boolean; reason?: string }>
      reveal(id: string, fileIndex?: number): Promise<boolean>
      onChange(cb: () => void): Unsubscribe
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
       * ssh.workbench tunnel.open 打开的本地隧道口。需 net.socket 权限。
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
    /**
     * 局域网传件（lan.share 权限）：起限时 http 下载服务（0.0.0.0 随机端口，
     * 局域网可见——手机扫码即下），6 位数字取件码门禁、文件白名单、
     * 只读 GET（Range 支持）、并发连接上限、到期自动关停。
     */
    share: {
      /** 起分享：files 仅支持经用户选择的句柄 {handleId}；minutes 1–120（缺省 10） */
      start(input: {
        files: Array<{ handleId: string; name?: string }>
        minutes?: number
      }): Promise<LanShareStatus>
      /** 查单个分享状态 */
      status(shareId: string): Promise<LanShareStatus>
      /** 本插件全部分享 */
      list(): Promise<LanShareStatus[]>
      /** 手动停止 */
      stop(shareId: string): Promise<boolean>
      /** 订阅下载请求日志（文件/ip/时间）；等价 enest.on('lan.request') */
      onRequest(cb: (event: LanRequestEvent) => void): Unsubscribe
      /** 订阅分享关停（到期 / stop / 插件关闭）；等价 enest.on('lan.stopped') */
      onStopped(cb: (event: LanStoppedEvent) => void): Unsubscribe
    }
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
  /**
   * AI CLI 配置白名单读写（config.agent 权限）：
   * 10 个应用的 adapter（路径白名单硬编码）；写前自动快照（保留 20 份）。
   */
  agent: {
    /** 可用应用 + 探测到的安装状态 */
    apps(): Promise<AgentAppInfo[]>
    /** 读配置原文与解析结果（不修改） */
    read(app: string): Promise<AgentConfigSnapshot>
    /**
     * 最小侵入写入：只替换给定顶层键（TOML/JSON 分别处理，保留注释与其余内容）；
     * 写前自动快照。changes[filePath?] 按 app 主配置文件定位。
     */
    write(input: AgentWriteInput): Promise<AgentWriteResult>
    /** 某应用的快照列表（时间倒序） */
    backups(app: string): Promise<AgentBackupInfo[]>
    /** 从快照恢复 */
    restore(input: { app: string; id: string }): Promise<boolean>
    /** 会话日志只读：白名单目录下 jsonl 文件清单（大小+mtime，mtime 倒序） */
    sessions: {
      list(app: string): Promise<AgentSessionsListResult[]>
      /** 逐行读会话文件（默认上限 512KB/文件；尾半行丢弃） */
      read(input: { app: string; file: string; maxBytes?: number }): Promise<AgentSessionsReadResult>
    }
    /** 资产通道：列白名单应用数据目录（如 codex 的 pets/；path 空串列根） */
    listAssets(input: { app: string; path?: string }): Promise<AgentListAssetsResult>
    /** 资产通道：写资产文件（宿主权限校验后落盘，覆盖前自动快照） */
    writeAssets(input: AgentWriteAssetsInput): Promise<AgentWriteAssetsResult>
    /** 资产通道：删除资产文件 / 目录（宿主原生确认后执行，不可恢复） */
    deleteAssets(input: AgentDeleteAssetsInput): Promise<AgentDeleteAssetsResult>
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
  /** SSH 运行时：session / exec / metrics / completion / sftp */
  localFiles: {
    /** Read a chosen file; UTF-8 text or a base64 data URL. Hard limit 32 MiB, two simultaneous reads. */
    read(input: { handleId: string; encoding?: 'text' | 'dataUrl'; maxBytes?: number }): Promise<string>
    pick(options?: LocalFilePickOptions): Promise<LocalFileHandle[]>
    pickSave(options?: { defaultName?: string }): Promise<LocalFileHandle | null>
    fromDrop(files: File[]): Promise<LocalFileHandle[]>
    list(input: { handleId: string; relativePath?: string }): Promise<{ directory: LocalFileHandle; entries: LocalFileHandle[] }>
    reveal(handleId: string): Promise<boolean>
    prepareDrag(input: { handleIds: string[] }): Promise<{ exportId: string }>
    startDrag(exportId: string): Promise<boolean>
    endDrag(): Promise<boolean>
  }
  ssh: {
    workbench(request: SshWorkbenchRequest): Promise<unknown>
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
        cwd?: string
        history?: string[]
        snippets?: Array<{ title: string; command: string }>
      }): Promise<SshCompletionResult>
    }
    sftp: {
      list(input: SftpListInput): Promise<SftpEntry[]>
      download(input: SftpDownloadInput): Promise<SftpTransferResult>
      upload(input: SftpUploadInput): Promise<SftpTransferResult>
      mkdir(sessionId: string, path: string): Promise<boolean>
      rename(sessionId: string, path: string, newPath: string): Promise<boolean>
      delete(sessionId: string, path: string, recursive?: boolean): Promise<boolean>
      chmod(sessionId: string, path: string, mode: number | string): Promise<boolean>
    }
    /** 订阅 SFTP 传输进度（download/upload 过程推送）；等价 enest.on('ssh.transfer') */
    onSshTransfer(cb: (event: SshTransferEvent) => void): Unsubscribe
    pickLocalFile(opts?: LocalFilePickOptions): Promise<LocalFileHandle | null>
  }
  /** 数据库运行时：驱动会话 / 查询 / 补全 / schema / applyChanges / 导入 */
  db: {
    workbench(request: DbWorkbenchRequest): Promise<unknown>
    test(config: DbConnectionConfig): Promise<DbTestResult>
    open(
      input: { config: DbConnectionConfig; sessionKey?: string } | DbConnectionConfig
    ): Promise<DbSessionInfo>
    close(sessionKey: string): Promise<boolean>
    listSessions(): Promise<DbSessionInfo[]>
    pickSqliteFile(options?: { createIfMissing?: boolean; readOnly?: boolean }): Promise<LocalFileHandle | null>
    pickImportFile(): Promise<LocalFileHandle | null>
    execute(input: DbExecuteInput): Promise<QueryResult>
    explain(input: { sessionKey: string; sql: string }): Promise<QueryResult>
    cancel(sessionKey: string | { sessionKey?: string; executionId?: string }): Promise<boolean>
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
  /** 中间件控制台运行时：连接 / 浏览 / 变更（kafka / rabbitmq / mqtt / rocketmq） */
  mw: {
    workbench(request: MwWorkbenchRequest): Promise<unknown>
  }
  /** DSH 驾驶舱运行时：runtime 探测 / web+sdk 进程 / profile / 备份 / 热更新 */
  dsh: {
    workbench(request: DshWorkbenchRequest): Promise<unknown>
    /** dsh:* 事件（web-ready/web-port/sdk-notify/runtime-progress…）；等价 on('dsh.event') */
    onDshEvent(cb: (event: DshWorkbenchEvent) => void): Unsubscribe
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
  backend: { call<T = unknown>(method: string, args?: unknown[]): Promise<T> }
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
  focusTimer: {
    start: options => call('focusTimer.start', [options]),
    get: () => call('focusTimer.get'),
    pause: () => call('focusTimer.pause'),
    resume: () => call('focusTimer.resume'),
    skip: () => call('focusTimer.skip'),
    stop: () => call('focusTimer.stop'),
    updateRecord: (recordId, patch) => call('focusTimer.updateRecord', [recordId, patch]),
    onChange: cb => subscribeToolEvent('focus-timer-change', cb)
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
  clipboard: {
    capabilities: () => call('clipboard.capabilities'),
    requestPermission: () => call('clipboard.requestPermission'),
    readText: () => call<string>('clipboard.readText'),
    writeText: (text, options) => call<boolean>('clipboard.writeText', [text, options]),
    readImage: () => call<{ dataUrl: string; width: number; height: number } | null>('clipboard.readImage'),
    writeImage: (dataUrl: string) => call<boolean>('clipboard.writeImage', [dataUrl]),
    history: {
      query: options => call('clipboard.history.query', [options]),
      copy: (id, options) => call('clipboard.history.copy', [id, options]),
      paste: id => call('clipboard.history.paste', [id]),
      reveal: (id, fileIndex) => call('clipboard.history.reveal', [id, fileIndex]),
      onChange: cb => subscribeToolEvent('clipboard-history-change', cb),
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
    share: {
      start: (input: {
        files: Array<{ handleId: string; name?: string }>
        minutes?: number
      }) => call<LanShareStatus>('lan.share.start', [input]),
      status: (shareId: string) => call<LanShareStatus>('lan.share.status', [shareId]),
      list: () => call<LanShareStatus[]>('lan.share.list'),
      stop: (shareId: string) => call<boolean>('lan.share.stop', [shareId]),
      onRequest(cb) {
        const handler: Listener = (data) => {
          const p = data as LanRequestEvent
          if (p && typeof p === 'object' && typeof p.shareId === 'string' && typeof p.file === 'string') cb(p)
        }
        api.on('lan.request', handler)
        return () => api.off('lan.request', handler)
      },
      onStopped(cb) {
        const handler: Listener = (data) => {
          const p = data as LanStoppedEvent
          if (p && typeof p === 'object' && typeof p.shareId === 'string' && typeof p.reason === 'string') cb(p)
        }
        api.on('lan.stopped', handler)
        return () => api.off('lan.stopped', handler)
      }
    }
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
  agent: {
    apps: () => call<AgentAppInfo[]>('agent.apps'),
    read: (app: string) => call<AgentConfigSnapshot>('agent.read', [app]),
    write: (input: AgentWriteInput) => call<AgentWriteResult>('agent.write', [input]),
    backups: (app: string) => call<AgentBackupInfo[]>('agent.backups', [app]),
    restore: (input: { app: string; id: string }) => call<boolean>('agent.restore', [input]),
    sessions: {
      list: (app: string) => call<AgentSessionsListResult[]>('agent.sessions.list', [app]),
      read: (input: { app: string; file: string; maxBytes?: number }) =>
        call<AgentSessionsReadResult>('agent.sessions.read', [input])
    },
    /** 资产通道：列白名单应用数据目录（如 codex 的 pets/） */
    listAssets: (input: { app: string; path?: string }) =>
      call<AgentListAssetsResult>('agent.listAssets', [input]),
    /** 资产通道：写资产文件（宿主权限校验后落盘，覆盖前自动快照） */
    writeAssets: (input: AgentWriteAssetsInput) =>
      call<AgentWriteAssetsResult>('agent.writeAssets', [input]),
    /** 资产通道：删除资产文件 / 目录（宿主原生确认后执行） */
    deleteAssets: (input: AgentDeleteAssetsInput) =>
      call<AgentDeleteAssetsResult>('agent.deleteAssets', [input])
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
  ssh: {
    workbench: (request) => call('ssh.workbench', [request]),
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
      upload: (input: SftpUploadInput) => call<SftpTransferResult>('ssh.sftp.upload', [input]),
      mkdir: (sessionId: string, path: string) =>
        call<boolean>('ssh.sftp.mkdir', [sessionId, path]),
      rename: (sessionId: string, path: string, newPath: string) =>
        call<boolean>('ssh.sftp.rename', [sessionId, path, newPath]),
      delete: (sessionId: string, path: string, recursive?: boolean) =>
        call<boolean>('ssh.sftp.delete', [sessionId, path, recursive]),
      chmod: (sessionId: string, path: string, mode: number | string) =>
        call<boolean>('ssh.sftp.chmod', [sessionId, path, mode])
    },
    onSshTransfer(cb) {
      const handler: Listener = (data) => {
        const p = data as SshTransferEvent
        if (
          p &&
          typeof p === 'object' &&
          typeof p.sessionId === 'string' &&
          (p.direction === 'upload' || p.direction === 'download')
        ) {
          cb(p)
        }
      }
      api.on('ssh.transfer', handler)
      return () => api.off('ssh.transfer', handler)
    },
    pickLocalFile: (opts?: LocalFilePickOptions) => call<LocalFileHandle | null>('ssh.pickLocalFile', [opts])
  },
  db: {
    workbench: (request) => call('db.workbench', [request]),
    test: (config: DbConnectionConfig) => call<DbTestResult>('db.test', [config]),
    open: (input: { config: DbConnectionConfig; sessionKey?: string } | DbConnectionConfig) =>
      call<DbSessionInfo>('db.open', [input]),
    close: (sessionKey: string) => call<boolean>('db.close', [sessionKey]),
    listSessions: () => call<DbSessionInfo[]>('db.listSessions'),
    pickSqliteFile: (options) => call<LocalFileHandle | null>('db.pickSqliteFile', [options ?? {}]),
    pickImportFile: () => call<LocalFileHandle | null>('db.pickImportFile'),
    execute: (input: DbExecuteInput) => call<QueryResult>('db.execute', [input]),
    explain: (input: { sessionKey: string; sql: string }) => call<QueryResult>('db.explain', [input]),
    cancel: (sessionKey: string | { sessionKey?: string; executionId?: string }) =>
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
  mw: {
    /** 中间件控制台统一入口；事件流经 on('mw.data'|'mw.error') */
    workbench: (request: MwWorkbenchRequest) => call('mw.workbench', [request])
  },
  dsh: {
    /** DSH 统一入口；事件流经 onDshEvent / on('dsh.event') */
    workbench: (request: DshWorkbenchRequest) => call('dsh.workbench', [request]),
    onDshEvent: (cb: (event: DshWorkbenchEvent) => void): Unsubscribe => {
      const wrapped = ((payload: unknown) => cb(payload as DshWorkbenchEvent)) as Listener
      if (!listeners.has('dsh.event')) listeners.set('dsh.event', new Set())
      listeners.get('dsh.event')!.add(wrapped)
      return () => {
        listeners.get('dsh.event')?.delete(wrapped)
      }
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
  runtime: { acquireActivity: (reason) => call<string>('runtime.acquire', [reason]), releaseActivity: (token) => call<void>('runtime.release', [token]) },
  backend: { call: (method, args = []) => call('backend.call', [method, args]) },
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
    case 'backend.event': {
      emit('backend.event', { event: payload.event, data: payload.data })
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
    case 'clipboard-history-change': {
      emit(payload.type, undefined)
      break
    }
    case 'focus-timer-change': {
      emit(payload.type, payload.snapshot)
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
    case 'dsh.event': {
      // DSH 驾驶舱事件：enest.dsh.onDshEvent / enest.on('dsh.event')
      emit('dsh.event', payload.event)
      break
    }
    case 'ssh.data':
    case 'ssh.exit':
    case 'ssh.error':
    case 'ssh.auth':
    case 'ssh.metrics': {
      // SSH 会话事件：enest.on('ssh.data'|'ssh.exit'|'ssh.error'|'ssh.metrics')
      emit(payload.type, payload)
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
    case 'ssh.transfer': {
      // SFTP 传输进度：enest.ssh.onSshTransfer / enest.on('ssh.transfer')
      emit('ssh.transfer', {
        sessionId: payload.sessionId,
        direction: payload.direction,
        path: payload.path,
        transferred: payload.transferred,
        total: payload.total,
        ...(payload.done !== undefined ? { done: payload.done } : {}),
        ...(payload.error !== undefined ? { error: payload.error } : {})
      } satisfies SshTransferEvent)
      break
    }
    case 'lan.request': {
      // 局域网传件下载请求：enest.net.share.onRequest / enest.on('lan.request')
      emit('lan.request', {
        shareId: payload.shareId,
        file: payload.file,
        ip: payload.ip,
        ts: payload.ts
      } satisfies LanRequestEvent)
      break
    }
    case 'lan.stopped': {
      // 分享关停（到期 / stop / 插件关闭）：enest.net.share.onStopped / enest.on('lan.stopped')
      emit('lan.stopped', { shareId: payload.shareId, reason: payload.reason } satisfies LanStoppedEvent)
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
    case 'mw.data':
    case 'mw.error':
      emit(payload.type, payload)
      break
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
