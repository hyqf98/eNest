/** Public plugin-page API contracts; no runtime bridge or platform implementation. */
import type { QuickInputAction, QuickInputConfig, PluginFileSaveResult, ClipboardCapabilities, ClipboardFileInspection } from './plugin-tools'
import type { PluginStorageApi } from './storage'
import type { QuickEnterInput } from './quick'
import type { AuxiliaryApi } from './auxiliary'
import type { FileStreamsApi } from './file-stream'
import type { DeadlineTaskStart, DeadlineTaskSnapshot } from './deadline-task'
import type { VaultSetResult } from './vault'
import type { LocalFileHandle, LocalFilePickOptions, PluginInputContext } from './local-files'
import type { PluginToastOptions } from './notification'
import type { McpToolHandlers } from './mcp'
import type { PluginLaunchApi, PluginLaunchIndexEntry, PluginLaunchIndexState } from './pluginLaunch'
import type { ShellNotice, ShellNoticeDataMap, ShellNoticeTopic, SaveRequestedEvent } from './notice'
import type { ResolvedAppearance } from './appearance'
import type { HomePageRegistrationInput, HomePageRegistrationResult } from './home'
import type { ThemePackRegistrationInput } from './plugin'
import type {
  AppLocale,
  CaptureDisplay,
  PluginCloseReason,
  PluginEnterPayload,
  PluginLaunchMode,
  PluginPathResolveInput,
  PluginPathResolveResult,
  ScreenBounds,
  ScreenCaptureResult,
  SettingsSectionContribution
} from './plugin'

export type Listener = (data: unknown) => void

/** enter 事件载荷；mode = 本次进入的启动方式（quick 小窗 / shell 主窗 / panel 面板组件） */
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

export type Unsubscribe = () => void

export interface EnestPluginApi {
  launch: PluginLaunchApi
  /** Register exactly the manifest-declared tools after business initialization. */
  mcp: {
    registerHandlers(handlers: McpToolHandlers): Promise<void>
  }
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
    /** Atomically replace this plugin's durable search directory; no global query access. */
    replaceLaunchIndex(entries: PluginLaunchIndexEntry[]): Promise<{ revision: number }>
    launchIndexState(): Promise<PluginLaunchIndexState>
    markLaunchIndexDirty(): Promise<void>
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
    register(section: SettingsSectionContribution): Promise<boolean>
    get(key: string): Promise<unknown>
    set(key: string, value: unknown): Promise<boolean>
    onChange(cb: (event: { key: string; value: unknown }) => void): Unsubscribe
  }
  quickInput: {
    configure(config: QuickInputConfig): Promise<boolean>
    release(): Promise<boolean>
    escape(): Promise<boolean>
    /** 读取本次 Quick 打开注入的输入上下文（文本/图片 dataUrl/只读文件句柄）；无则 null */
    readContext(): Promise<QuickEnterInput | null>
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
  storage: PluginStorageApi
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
      /** 二进制请求体（base64）：优先于 body，解码后原样发送（multipart 上传等场景，≤8MB） */
      bodyBase64?: string
      /** 鉴权注入：主进程从本插件 vault 解引用后写入请求头，密钥不回到页面 */
      auth?: { secretRef: string; header?: string; scheme?: 'bearer' | 'raw' }
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
    /**
     * 统一路径解析：把 `~/x`、`./x`、裸相对路径与绝对路径归一成绝对路径。
     * 只做词法归一与存在性探测，不授予读写权限（真实文件访问仍需 localFiles 句柄）。
     */
    resolvePath(input: PluginPathResolveInput): Promise<PluginPathResolveResult>
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
  /** Explicit activity leases: at most 128 per runtime, 4096 globally; released with the owning runtime. */
  runtime: { acquireActivity(reason?: string): Promise<string>; releaseActivity(token: string): Promise<void> }
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
   * （桌面适配样式）/ panel = 自由面板小组件（组件适配样式）。初始值来自
   * URL ?mode=，容器迁移（固定到主窗、移入/移出面板等）时经 mode-change
   * 事件实时更新——插件据此在多套入口样式间切换。
   */
  getLaunchMode(): PluginLaunchMode
  /** 启动方式变更（quick / shell / panel 间迁移，不重载页面）；立即生效后回调 */
  onModeChange(cb: (mode: PluginLaunchMode) => void): Unsubscribe
}
