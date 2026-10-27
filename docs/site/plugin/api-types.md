# TypeScript 类型定义

本页由插件仓库的 `scripts/generate-api-types.mjs` 从壳 preload 与共享类型生成。

安装插件仓库的 `@enest/plugin-sdk`，在项目中加入 `import type {} from '@enest/plugin-sdk'` 即可获得 `window.enest` 类型。

生成：`npm run api:generate -- --host-root /path/to/eNest`；只读校验：`npm run api:check -- --host-root /path/to/eNest`。

类型不授予权限；系统能力仍由主进程验证 manifest、运行实例与用户授权。

```ts
/** Generated from the eNest preload and shared API types. Do not edit. */
export interface EnestPluginApi {
    /** Register exactly the manifest-declared tools after business initialization. */
    mcp: {
        registerHandlers(handlers: McpToolHandlers): Promise<void>;
    };
    setTitle(title: string): Promise<boolean>;
    setIcon(icon: string): Promise<boolean>;
    setBadge(badge: string | number): Promise<boolean>;
    resize(size: {
        width?: number;
        height?: number;
    }): Promise<boolean>;
    /**
     * 上报未保存数据标记（基础能力，无需声明或授权）：编辑时置 true、持久化完成后置 false。
     * 壳子更新重启前的脏检测与一键保存依赖此标记；不上报则视为无未保存数据。
     */
    setDirty(dirty: boolean): Promise<boolean>;
    /**
     * 订阅壳统一通知（ShellNotice 标准信封）：不传 topic 收全量；
     * 传 topic 只收该主题（data 按 ShellNoticeDataMap 收窄）。未知 topic 自动过滤。
     */
    onNotice(cb: (notice: ShellNotice) => void): Unsubscribe;
    onNotice<T extends ShellNoticeTopic>(topic: T, cb: (notice: ShellNotice<T>) => void): Unsubscribe;
    /**
     * 壳请求立即保存数据（save.requested 通知，更新重启 / 退出前触发）：
     * 回调里持久化并返回 Promise，settle 后自动 ack（主进程 deadlineMs 超时兜底）；保存需幂等。
     */
    onSaveRequested(cb: (event: SaveRequestedEvent) => void | Promise<unknown>): Unsubscribe;
    /** UI 命名空间：与 PLUGIN_SPEC 的 enest.ui.* 对齐 */
    ui: {
        /** Classic/orb Tab title, up to 120 characters; empty restores the manifest name. */
        setTitle(title: string): Promise<boolean>;
        /** 1–2 visible Unicode code points, never a URL/path; empty restores the package icon. */
        setIcon(icon: string): Promise<boolean>;
        /** Classic/orb badge: integer 0–999999 or text up to 8 characters; empty clears it. */
        setBadge(badge: string | number): Promise<boolean>;
        /** 兼容尺寸建议接口（CSS px）；Quick 使用固定视口，主窗由用户控制，调用成功不改变窗口尺寸。基础能力，无需声明或授权。 */
        resize(size: {
            width?: number;
            height?: number;
        }): Promise<boolean>;
        /**
         * 兼容内容高度建议（px）；Quick 与主窗均不据此改变窗口尺寸。
         * 基础能力，无需声明或授权。
         */
        setHeight(height: number): Promise<boolean>;
        /** Move this plugin's existing view to the desktop without reloading it. */
        openInShell(): Promise<boolean>;
        openSettings(): Promise<boolean>;
        /** Focused editor/terminal/overlay owns keys that Quick otherwise intercepts. */
        setInputContext(context: PluginInputContext): Promise<boolean>;
        focus(): Promise<boolean>;
        /** Return focus to the Quick global search without closing this plugin. */
        focusSearch(): Promise<boolean>;
        /**
         * 提交即收起 Quick 小窗（如回车回贴/复制完成后的「选中即走」）。
         * 仅当本插件正挂载于 Quick 容器时生效，其余容器为无操作；
         * 收起走统一隐藏语义，下次呼出仍恢复本插件。基础能力，无需声明或授权。
         */
        dismissQuick(): Promise<boolean>;
        /** 原生容器中的安全富文本通知；兼容 message/type，不需要额外授权。 */
        toast(payload: PluginToastOptions): Promise<boolean>;
        /** 读取当前主题变量（themeAware 插件可主动拉取） */
        getThemeTokens(): Promise<{
            mode: 'light' | 'dark';
            tokens: PluginThemeTokens;
        }>;
        /** 订阅主题变更；壳子 setTheme / OS 主题切换时推送 */
        onThemeChange(cb: (event: PluginThemeChangeEvent) => void): Unsubscribe;
    };
    /** 主题命名空间：enest.theme.getTokens() / register() */
    theme: {
        getTokens(): Promise<{
            mode: 'light' | 'dark';
            tokens: PluginThemeTokens;
        }>;
        /** Phase 1 read-only semantic appearance; home references are availability only. */
        getAppearance(): Promise<ResolvedAppearance>;
        /** Subscribe to semantic appearance changes; returns an unsubscribe function. */
        onAppearanceChange(cb: (appearance: ResolvedAppearance) => void): Unsubscribe;
        /**
         * 注册主题包到壳子设置 → 主题 下拉列表。
         * V1 ThemePack or ThemePackV2; source is host-bound and ignored in requests.
         */
        register(pack: ThemePackRegistrationInput): Promise<unknown>;
    };
    /** Confirm an own, installed and enabled manifest home entry; never activates it. */
    home: {
        register(contribution: HomePageRegistrationInput): Promise<HomePageRegistrationResult>;
    };
    /** 全局热键命名空间：enest.hotkey.register/unregister；需 'hotkey' 权限 */
    hotkey: {
        /**
         * 注册全局热键。成功 resolve { ok: true }；冲突（含壳子 Quick 热键 /
         * 其它插件占用 / 系统占用）resolve { ok: false, error }，不 reject。
         * 触发经 on('hotkey') 事件推送 { accelerator }。
         */
        register(accelerator: string, opts?: {
            label?: string;
        }): Promise<PluginHotkeyRegisterResult>;
        /** 注销本插件已注册的热键；未注册时也返回 ok */
        unregister(accelerator: string): Promise<boolean>;
        /** 订阅热键触发；等价 enest.on('hotkey', cb) */
        onHotkey(cb: (event: PluginHotkeyEvent) => void): Unsubscribe;
    };
    /** 多语言命名空间：读壳子界面语言并订阅变更 */
    i18n: {
        /** 当前壳子语言（settings.general.locale） */
        getLocale(): Promise<AppLocale>;
        /** 订阅语言变更；壳子设置页切换语言时推送 */
        onLocaleChange(cb: (event: PluginLocaleChangeEvent) => void): Unsubscribe;
    };
    /**
     * 贡献点命名空间（插槽化架构）：Quick 搜索 provider 运行时注册与查询回传。
     * 需声明 contribute 并取得授权：注册后会接收 Quick 全局搜索文本。
     */
    contribute: {
        /**
         * 注册 Quick 搜索 provider：注册后壳子搜索时推送 quick-query 事件，
         * 插件在 onQuickQuery 回调中计算结果并 respondQuickQuery 回传（500ms 超时丢弃）。
         */
        registerQuickProvider(meta: PluginQuickProviderMeta): Promise<{
            ok: true;
        } | {
            ok: false;
            error?: string;
        }>;
        /** 注销本插件的某个 provider */
        unregisterQuickProvider(providerId: string): Promise<boolean>;
        /** 订阅 Quick 搜索查询；等价 enest.on('quick-query', cb) */
        onQuickQuery(cb: (event: PluginQuickQueryEvent) => void): Unsubscribe;
        /** 回传查询结果（reqId 来自 onQuickQuery；items 为命令项数组） */
        respondQuickQuery(reqId: string, items: PluginQuickQueryItem[]): Promise<boolean>;
    };
    settings: {
        register(section: SettingsSectionContribution): Promise<boolean>;
        get(key: string): Promise<unknown>;
        set(key: string, value: unknown): Promise<boolean>;
        onChange(cb: (event: {
            key: string;
            value: unknown;
        }) => void): Unsubscribe;
    };
    quickInput: {
        configure(config: QuickInputConfig): Promise<boolean>;
        release(): Promise<boolean>;
        escape(): Promise<boolean>;
        /** 读取本次 Quick 打开注入的输入上下文（文本/图片 dataUrl/只读文件句柄）；无则 null */
        readContext(): Promise<QuickEnterInput | null>;
        onChange(cb: (value: string) => void): Unsubscribe;
        onAction(cb: (action: QuickInputAction) => void): Unsubscribe;
    };
    deadlineTasks: {
        start(input: DeadlineTaskStart): Promise<DeadlineTaskSnapshot>;
        get(id: string): Promise<DeadlineTaskSnapshot>;
        pause(id: string): Promise<DeadlineTaskSnapshot>;
        resume(id: string): Promise<DeadlineTaskSnapshot>;
        skip(id: string): Promise<DeadlineTaskSnapshot>;
        cancel(id: string): Promise<DeadlineTaskSnapshot>;
        onChange(cb: (event: {
            taskId: string;
        }) => void): Unsubscribe;
    };
    storage: PluginStorageApi;
    background: {
        call<T = unknown>(method: string, args?: unknown[], options?: {
            timeoutMs?: number;
        }): Promise<T>;
    };
    auxiliary: AuxiliaryApi;
    files: {
        stream: FileStreamsApi;
    };
    clipboard: {
        capabilities(): Promise<ClipboardCapabilities>;
        requestPermission(): Promise<ClipboardCapabilities>;
        readText(): Promise<string>;
        /** Host writes never feed back into the native change observer. */
        writeText(text: string, options?: {
            excludeFromHistory?: boolean;
        }): Promise<boolean>;
        readImage(): Promise<{
            dataUrl: string;
            width: number;
            height: number;
        } | null>;
        writeImage(dataUrl: string): Promise<boolean>;
        writeFiles(paths: string[]): Promise<boolean>;
        paste(): Promise<{
            pasted: boolean;
            reason?: string;
        }>;
        /** Unknown paths are not inspected; only previously user-granted targets have existence data. */
        inspectFiles(paths: string[]): Promise<ClipboardFileInspection[]>;
        /** Opens a native target-confirmation dialog before revealing the selected path. */
        revealFile(path: string): Promise<boolean>;
    };
    screen: {
        capture(opts?: {
            displayId?: number;
            bounds?: ScreenBounds;
        }): Promise<ScreenCaptureResult>;
        displays(): Promise<CaptureDisplay[]>;
    };
    net: {
        /**
         * 受控 HTTP(S) 请求：GET/POST/PUT/PATCH/DELETE/HEAD；明文 http 需 manifest
         * `net.allowInsecure`。stream:true 时立即返回元信息，响应体经 net.chunk
         * 分片推送（上限 32MB）；text/event-stream 按 data: 行转发。
         */
        fetch(req: {
            url: string;
            method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD';
            headers?: Record<string, string>;
            body?: string;
            /** 二进制请求体（base64）：优先于 body，解码后原样发送（multipart 上传等场景，≤8MB） */
            bodyBase64?: string;
            /** 鉴权注入：主进程从本插件 vault 解引用后写入请求头，密钥不回到页面 */
            auth?: {
                secretRef: string;
                header?: string;
                scheme?: 'bearer' | 'raw';
            };
            timeoutMs?: number;
            /** 流式响应 / SSE 模式（分片走 onChunk） */
            stream?: boolean;
        }): Promise<NetFetchResult>;
        websocket: {
            connect(input: {
                url: string;
                protocols?: string[];
            }): Promise<{
                socketId: string;
            }>;
            send(socketId: string, data: string, binary?: boolean): Promise<{
                sent: number;
            }>;
            close(socketId: string): Promise<boolean>;
            /** Binary messages carry base64 data; text messages carry UTF-8 text. */
            onMessage(cb: (event: {
                socketId: string;
                data: string;
                binary: boolean;
            }) => void): Unsubscribe;
            onClose(cb: (event: {
                socketId: string;
                code: number;
                reason: string;
            }) => void): Unsubscribe;
        };
        socket: {
            /**
             * 建立出站 TCP / TLS 连接（仅 outgoing）。host 可为 127.0.0.1 衔接
             * 插件私有后端打开的本地隧道口。需 net.socket 权限。
             */
            connect(input: {
                sessionId?: string;
                host: string;
                port: number;
                tls?: boolean;
                timeoutMs?: number;
            }): Promise<NetSocketHandle>;
            /** 默认 UTF-8 文本；二进制须显式指定 base64。受 1MB/s 令牌桶限速。 */
            send(socketId: string, data: string, encoding?: 'utf8' | 'base64'): Promise<{
                sent: number;
            }>;
            /** 关闭连接（插件侧主动关闭；插件关闭时宿主自动释放） */
            close(socketId: string): Promise<boolean>;
            /** 本插件全部 socket 概览（含 ws 桥端口） */
            list(): Promise<NetSocketListItem[]>;
            /**
             * 为已连接 socket 起本地 WebSocket 桥（仅 127.0.0.1 随机端口，
             * 一次性 token）：插件页内 new WebSocket(url) 直连该 TCP 流的
             * 双向二进制通道（noVNC / ironrdp-wasm 场景，避免逐帧 IPC）。
             */
            serveWs(socketId: string): Promise<NetWsEndpoint>;
        };
        /** 订阅 socket 数据分片（base64）；等价 enest.on('net.data') */
        onNetData(cb: (event: NetDataEvent) => void): Unsubscribe;
        /** 订阅 socket 关闭；等价 enest.on('net.close') */
        onNetClose(cb: (event: NetCloseEvent) => void): Unsubscribe;
        /** 订阅 fetch 流式分片 / SSE data 行；等价 enest.on('net.chunk') */
        onChunk(cb: (event: NetChunkEvent) => void): Unsubscribe;
    };
    /**
     * 本地文件改名（fs.rename 权限）：仅对 localFiles 句柄白名单内文件做
     * 同目录改名；newName 必须是纯文件名（禁路径分隔符 / .. / 盘符）。
     */
    fs: {
        /** 单文件改名；返回 { oldName, newName } */
        rename(input: {
            handleId: string;
            newName: string;
        }): Promise<{
            handleId: string;
            oldName: string;
            newName: string;
        }>;
        /** 批量改名；必须 confirmed: true（危险操作二次确认）；逐项返回 ok/error */
        renameBatch(input: {
            items: Array<{
                handleId: string;
                newName: string;
            }>;
            confirmed?: boolean;
        }): Promise<{
            results: Array<{
                handleId: string;
                oldName: string;
                newName: string;
                ok: boolean;
                error?: string;
            }>;
            succeeded: number;
            failed: number;
        }>;
    };
    /** 本机进程与端口查看（sys.inspect，1s 缓存）/ 终止（sys.control） */
    sys: {
        processes(): Promise<SysProcessInfo[]>;
        ports(): Promise<SysPortInfo[]>;
        /**
         * 结束进程：需 sys.control 权限与宿主原生确认（保护壳子进程、父进程与 PID 1）。
         * signal：TERM（缺省）/ KILL / INT。
         */
        kill(pid: number, opts?: {
            signal?: 'TERM' | 'KILL' | 'INT';
            confirmed?: boolean;
        }): Promise<boolean>;
    };
    shell: {
        saveFile(input: {
            defaultName: string;
            dataUrl: string;
        }): Promise<PluginFileSaveResult | null>;
        openExternal(url: string): Promise<boolean>;
        saveTextFile(payload: {
            defaultName?: string;
            filename?: string;
            content: string;
        }): Promise<{
            ok: boolean;
            path: string;
        } | null>;
        /**
         * 统一路径解析：把 `~/x`、`./x`、裸相对路径与绝对路径归一成绝对路径。
         * 只做词法归一与存在性探测，不授予读写权限（真实文件访问仍需 localFiles 句柄）。
         */
        resolvePath(input: PluginPathResolveInput): Promise<PluginPathResolveResult>;
    };
    notify(payload: {
        title?: string;
        body?: string;
    }): Promise<boolean>;
    /** 插件私有密钥保险库：set→secretRef；无明文 get。基础能力，无需声明或授权；系统加密不可用时保存失败。 */
    vault: {
        set(key: string, secret: string): Promise<VaultSetResult>;
        has(keyOrRef: string): Promise<boolean>;
        remove(keyOrRef: string): Promise<boolean>;
    };
    /** User-selected local file handles, isolated to the calling plugin. */
    localFiles: {
        /** Read a chosen file; UTF-8 text or a base64 data URL. Hard limit 32 MiB, two simultaneous reads. */
        read(input: {
            handleId: string;
            encoding?: 'text' | 'dataUrl';
            maxBytes?: number;
        }): Promise<string>;
        pick(options?: LocalFilePickOptions): Promise<LocalFileHandle[]>;
        /** The plugin may suggest a filename; omitted/empty uses the native dialog default. */
        pickSave(options?: {
            defaultName?: string;
        }): Promise<LocalFileHandle | null>;
        fromDrop(files: File[]): Promise<LocalFileHandle[]>;
        list(input: {
            handleId: string;
            relativePath?: string;
        }): Promise<{
            directory: LocalFileHandle;
            entries: LocalFileHandle[];
        }>;
        reveal(handleId: string): Promise<boolean>;
        prepareDrag(input: {
            handleIds: string[];
        }): Promise<{
            exportId: string;
        }>;
        startDrag(exportId: string): Promise<boolean>;
        endDrag(): Promise<boolean>;
    };
    on(event: string, cb: Listener): void;
    off(event: string, cb: Listener): void;
    // —— 生命周期（对标 uTools onPluginEnter / onPluginOut）——
    /** 进入插件：首次加载完成后 + 每次 Tab 激活；与 onOut 成对，可 pause/resume */
    onEnter(cb: (event: PluginEnterEvent) => void): Unsubscribe;
    /** 退到后台：其它 Tab 成为 active；isKill 恒 false */
    onOut(cb: (event: PluginOutEvent) => void): Unsubscribe;
    /** 即将销毁：可在此 flush 草稿；回调返回 Promise 时 preload 等其 settle 再 ack */
    onBeforeSuspend(cb: () => void | Promise<unknown>): Unsubscribe;
    /** Explicit activity leases: at most 128 per runtime, 4096 globally; released with the owning runtime. */
    runtime: {
        acquireActivity(reason?: string): Promise<string>;
        releaseActivity(token: string): Promise<void>;
    };
    /** Calls the plugin-owned Node backend after explicit backend.node consent. */
    backend: {
        call<T = unknown>(method: string, args?: unknown[], options?: {
            timeoutMs?: number;
        }): Promise<T>;
        stop(): Promise<void>;
    };
    onBeforeClose(cb: (event: PluginBeforeCloseEvent) => void | Promise<unknown>): Unsubscribe;
    /** 关闭已开始（best-effort），通常已在 beforeClose 完成清理 */
    onDestroy(cb: () => void): Unsubscribe;
    /** 当前插件 id（与 query pid 一致） */
    getPluginId(): string;
    /** URL query 中的 code；完整载荷以 onEnter 为准 */
    getEnterCode(): string | undefined;
    /**
     * 当前启动方式：quick = Quick 小窗内嵌（小窗适配样式）/ shell = 主窗大窗
     * （桌面适配样式）。初始值来自 URL ?mode=，容器迁移（固定到主窗等）时经
     * mode-change 事件实时更新——插件据此在两套入口样式间切换。
     */
    getLaunchMode(): PluginLaunchMode;
    /** 启动方式变更（quick ↔ shell 迁移，不重载页面）；立即生效后回调 */
    onModeChange(cb: (mode: PluginLaunchMode) => void): Unsubscribe;
}

/** Present only in a dedicated Home WebContentsView, never an ordinary business plugin. */
export interface EnestHomeApi {
    ready(payload?: HomeReadyPayload): Promise<void>;
    ackNavigation(payload: WorkspaceNavigationAck): Promise<void>;
    getAppearance(): Promise<HomeAppearanceSnapshot>;
    getConfig(): Promise<HomeRuntimeConfig>;
    getCatalog(): Promise<HomeCatalog>;
    getDetail(id: string): Promise<HomeDetail | null>;
    search(request: {
        query: string;
        scope?: HomeSearchScope;
        limit?: number;
    }): Promise<HomeSearchResult>;
    refresh(request?: {
        reason?: 'manual' | 'boot';
    }): Promise<HomeCatalog>;
    action(request: HomeAction): Promise<HomeActionResponse>;
    onAppearance(listener: (payload: HomeAppearanceSnapshot) => void): () => void;
    onCommand(listener: (payload: HomeCommand) => void): () => void;
}

/** The full workspace bridge. enestHome remains an alias for existing providers. */
export type EnestWorkspaceApi = EnestHomeApi;

/** Only available inside an isolated ThemePackV2.quick page, never an ordinary plugin page. */
export interface EnestQuickApi {
    ready(): void;
    getState(): Promise<QuickThemeSnapshot>;
    onState(listener: (state: QuickThemeSnapshot) => void): () => void;
    onFocus(listener: (request: {
        selectAll: boolean;
    }) => void): () => void;
    action(action: QuickThemeAction): Promise<QuickThemeActionResult>;
    state: {
        read(): Promise<QuickStateSnapshot>;
        write(value: unknown, expectedRevision: number): Promise<QuickStateSnapshot>;
    };
}

export interface ThemeChromeApi {
    getSnapshot(): Promise<ThemeChromeSnapshot>;
    onSnapshot(listener: (snapshot: ThemeChromeSnapshot) => void): () => void;
    dispatch(action: ThemeChromeAction): Promise<void>;
    /** Call only after the first usable frame; the host retains its fallback until this ACK. */
    ready(): Promise<void>;
}

/** Isolated theme settings pages never receive shellApi, raw settings, grants, tokens or account data. */
export interface EnestSettingsApi {
    ready(): void;
    getState(): Promise<ThemeSettingsSnapshot>;
    onState(listener: (snapshot: ThemeSettingsSnapshot) => void): () => void;
    action(action: ThemeSettingsAction): Promise<ThemeSettingsActionResult>;
}

export interface PluginBackgroundBridge {
    host: PluginBackgroundHost;
    /** One registration per document; operation ACK is sent only after the handler settles. */
    register(handlers: PluginBackgroundHandlers): void;
}

export interface AuxiliaryPageApi {
    getContext(): Promise<AuxiliaryContext>;
    onMessage(callback: (data: unknown) => void): () => void;
    post(data: unknown): Promise<void>;
    close(): Promise<void>;
}

export interface McpToolDeclaration {
    id: string;
    description: string;
    inputSchema: McpJsonSchema;
    title?: string;
    outputSchema?: McpJsonSchema;
    annotations?: McpToolAnnotations;
}

/** Portable MCP contracts. No SDK or Electron runtime dependency crosses this boundary. */
export type McpErrorCode = 'busy' | 'needs-consent' | 'permission-denied' | 'interaction-required' | 'not-found' | 'invalid-arguments' | 'not-ready' | 'timeout' | 'cancelled' | 'unavailable' | 'internal-error' | 'result-too-large';

/**
 * 「打开方式」贡献（manifest.contributes.openWith；open-with 插槽）。
 * 纯声明：插件只声明能处理的扩展名 / MIME / URL scheme，系统注册与文件→插件
 * 路由由壳统一负责（插件是壳内视图，OS 关联目标只能是 eNest 本体）。
 * 打开时壳以 enter.code='open-file'|'open-url' + payload{paths,url} 唤起插件。
 */
export interface OpenWithContribution {
    id: string;
    /** 小写、不含点的文件扩展名，如 'md' */
    extensions?: string[];
    /** MIME 类型，如 'text/markdown' */
    mimeTypes?: string[];
    /** URL scheme，小写不含 ://，如 'enest-md'；保留字 enest/http/https/file 与跨插件重复拒绝 */
    schemes?: string[];
    /** macOS CFBundleDocumentTypes 语义 */
    role?: 'Editor' | 'Viewer' | 'Browser';
    /** 贡献点 schema 版本；缺省视为当前版本 */
    schemaVersion?: string;
}

/**
 * 进入载荷（壳 → 插件）：双击文件 / 点击链接命中路由后，壳以
 * enter.code='open-file'|'open-url'、payload=OpenWithEnterPayload 唤起插件。
 */
export interface OpenWithEnterPayload {
    /** 绝对路径列表（展示用）；同类型多文件合并为一次进入 */
    paths?: string[];
    /** 宿主签发的只读文件句柄（插件经 localFiles.read 读取，不能拿裸路径绕开授权） */
    handles?: LocalFileHandle[];
    /** open-url 时的完整 URL */
    url?: string;
}

export type Listener = (data: unknown) => void;

/** enter 事件载荷；mode = 本次进入的启动方式（quick 小窗 / shell 主窗） */
export type PluginEnterEvent = PluginEnterPayload & {
    tabId: string;
    mode: PluginLaunchMode;
};

/** out 事件载荷；isKill 恒为 false（杀死走 beforeClose/destroy） */
export type PluginOutEvent = {
    isKill: false;
};

/** beforeClose 事件载荷 */
export type PluginBeforeCloseEvent = {
    reason: PluginCloseReason;
};

/** 主题变量集合（壳子解析后的 CSS 自定义属性值） */
export type PluginThemeTokens = Record<string, string>;

/** 主题变更事件（enest.ui.onThemeChange） */
export type PluginThemeChangeEvent = {
    mode: 'light' | 'dark';
    tokens: PluginThemeTokens;
};

/** 热键触发事件（enest.hotkey.register 的回调 / enest.on('hotkey')） */
export type PluginHotkeyEvent = {
    accelerator: string;
};

/** 语言变更事件（enest.i18n.onLocaleChange） */
export type PluginLocaleChangeEvent = {
    locale: AppLocale;
};

/** Quick 搜索查询事件（enest.contribute.onQuickQuery） */
export type PluginQuickQueryEvent = {
    reqId: string;
    query: string;
};

/** Quick provider 回传项（enest.contribute.respondQuickQuery 的 items 元素） */
export type PluginQuickQueryItem = {
    id?: string;
    title?: string;
    subtitle?: string;
    explain?: string;
    code?: string;
    /** 选择此业务结果时随 onEnter 传回；应为可通过 IPC 克隆的数据。 */
    payload?: unknown;
};

/** Quick provider 注册元数据 */
export type PluginQuickProviderMeta = {
    id: string;
    explain?: string;
    schemaVersion?: string;
};

/** hotkey.register 结果：ok=false 时 error 携带冲突/失败原因 */
export type PluginHotkeyRegisterResult = {
    ok: boolean;
    error?: string;
};

/** net.socket 数据事件（enest.net.onNetData / enest.on('net.data')） */
export type NetDataEvent = {
    socketId: string;
    /** base64 编码的分片（64KB / 20ms 双阈值节流合并） */
    chunk: string;
};

/** net.socket 关闭事件（enest.net.onNetClose / enest.on('net.close')） */
export type NetCloseEvent = {
    socketId: string;
    reason: string;
};

/** net.fetch 流式分片事件（enest.net.onChunk / enest.on('net.chunk')） */
export type NetChunkEvent = {
    reqId: string;
    /** base64（流式响应）或 utf8 文本（SSE data: 行） */
    chunk: string;
    done?: boolean;
    error?: string;
};

/** net.socket.connect 返回 */
export type NetSocketHandle = {
    socketId: string;
};

/** net.socket.serveWs 返回：插件页内 new WebSocket(url) 直连 */
export type NetWsEndpoint = {
    url: string;
    /** 一次性 token（已含在 url query；单独暴露便于自定义拼装） */
    token: string;
    port: number;
};

/** net.socket.list 条目 */
export type NetSocketListItem = {
    socketId: string;
    host: string;
    port: number;
    tls: boolean;
    sessionId?: string;
    status: string;
    openedAt: number;
    rxBytes: number;
    txBytes: number;
    ws?: {
        port: number;
        url: string;
    } | null;
};

/** net.fetch 返回（stream:true 时 body 为空、分片走 net.chunk） */
export type NetFetchResult = {
    status: number;
    headers: Record<string, string>;
    body: string;
    streamed?: boolean;
    reqId?: string;
};

/** sys.processes 条目 */
export type SysProcessInfo = {
    pid: number;
    pcpu: number;
    pmem: number;
    /** 常驻内存（KB） */
    rss: number;
    user: string;
    command: string;
};

/** sys.ports 条目 */
export type SysPortInfo = {
    command: string;
    pid: number;
    user: string;
    protocol: string;
    /** 监听地址（IPv4/IPv6 原样） */
    address: string;
    port: number;
    name: string;
};

export type Unsubscribe = () => void;

/** V1 fields remain present as a compatibility view for older consumers. */
export interface ThemePackV2 extends ThemePack {
    schemaVersion: 2;
    version: number;
    description?: string;
    variants: Record<AppearanceColorMode, ThemeVariant>;
    settings: ThemeSettingsSchema;
    /** Extra atmosphere presets usable from `background.palette`; ids never shadow host presets. */
    palettes?: ThemeBackgroundPaletteDeclaration[];
    /** Omission uses the built-in workspace; a supplied provider must support Workspace V1. */
    home?: ThemeHomeReference;
    /** Isolated Quick presentation. Omission keeps the host's built-in launcher. */
    quick?: ThemeQuickReference;
    /** Optional sandboxed navigation renderers. The host retains geometry and lifecycle. */
    chrome?: ThemeChromeReference;
    /** Optional isolated settings presentation; protected actions stay native. */
    settingsPage?: ThemeSettingsReference;
}

export interface ResolvedAppearance {
    version: 2;
    revision: number;
    theme: ThemeIdentity & {
        name: string;
        version: number;
        legacy: boolean;
    };
    requestedMode: ThemeMode;
    mode: AppearanceColorMode;
    tokens: Record<string, string>;
    fonts: AppearanceFonts;
    components: AppearanceComponents;
    background: AppearanceBackground;
    splash: AppearanceSplash;
    layout: AppearanceLayout;
    notifications: ThemeNotificationStyle;
    animation: {
        requested: AnimationLevel;
        effective: AnimationLevel;
        continuous: boolean;
    };
    home: ThemeHomeReference;
    quick?: ThemeQuickReference;
    chrome?: ThemeChromeReference;
    settingsPage?: ThemeSettingsReference;
    diagnostics: AppearanceDiagnostic[];
    /** Host-owned public font handles; no local paths or custom-font metadata. */
    resources?: {
        fonts: Array<{
            family: string;
            url: string;
        }>;
    };
}

export interface AuxiliaryApi {
    open(options: AuxiliaryOpen): Promise<{
        windowId: string;
    }>;
    send(windowId: string, data: unknown, options?: {
        visible?: boolean;
    }): Promise<void>;
    close(windowId: string): Promise<boolean>;
    list(): Promise<Array<{
        windowId: string;
        entry: string;
    }>>;
}

/** A bounded cursor also permits a plugin to import its own paused legacy state. */
export interface DeadlineTaskStart extends DeadlineTaskPlan {
    paused?: boolean;
    cursor?: {
        stepIndex: number;
        iteration: number;
        remainingMs: number;
        startedAt?: number | null;
    };
}

export interface DeadlineTaskSnapshot {
    task: DeadlineTaskState | null;
    receipts: DeadlineTaskReceipt[];
}

export interface FileStreamsApi {
    open(options: FileStreamOpen): Promise<{
        streamId: string;
    }>;
    write(streamId: string, sequence: number, bytes: ArrayBuffer): Promise<void>;
    finish(streamId: string): Promise<FileStreamResult>;
    abort(streamId: string): Promise<boolean>;
}

/** Runtime registration confirms an exact manifest declaration; source is host-bound. */
export type HomePageRegistrationInput = Omit<HomePageContribution, 'source'> & {
    source?: string;
};

export type HomePageRegistrationResult = {
    ok: true;
    contribution: HomePageContribution;
} | {
    ok: false;
    error: string;
};

/** A user-selected local file capability, scoped to the calling plugin. */
export interface LocalFileHandle {
    id: string;
    name: string;
    kind: 'file' | 'directory';
    size: number;
    displayPath: string;
}

export interface LocalFilePickOptions {
    kind?: 'file' | 'directory' | 'any';
    multiple?: boolean;
    /** Read is the default; write selection explicitly grants content changes. */
    access?: 'read' | 'write';
}

export type PluginInputContext = 'workbench' | 'terminal' | 'editor' | 'overlay';

export type McpToolHandlers = Record<string, McpToolHandler>;

/**
 * v1 已注册 topic → data 类型映射。
 * 扩展约定：topic 命名 `<域>.<节点>`；新增关键节点在此追加条目，
 * 并同步 docs/site/plugin/api.md 的「壳通知」topic 表。
 */
export interface ShellNoticeDataMap {
    /** 检查到新版本（尚未下载） */
    'update.available': {
        currentVersion: string;
        latestVersion: string;
    };
    /** 更新包下载完成，可安装 */
    'update.downloaded': {
        version: string;
    };
    /** 即将退出并安装（最后保存机会；随后 before-quit / beforeClose 还会各来一次） */
    'update.installing': {
        version: string;
    };
    /** 检查 / 下载 / 安装出错 */
    'update.error': {
        message: string;
    };
    /**
     * 壳请求插件立即保存数据（更新重启 / 退出前 / 手触发）。
     * 插件在 enest.onSaveRequested 回调里持久化并返回 Promise；
     * Promise settle 后 preload 自动 ack，主进程等待（超时兜底）。
     */
    'save.requested': {
        reason: ShellSaveReason;
        operationId: string;
        deadlineMs: number;
    };
    /** 应用即将退出（before-quit；插件随后还会收到 beforeClose(app-quit)） */
    'app.before-quit': {
        reason: string;
    };
    /** 主题 / 字体 / 动画档变更（theme 细节另见 theme-change 事件） */
    'appearance.changed': {
        kind: ShellAppearanceKind;
    };
}

/** topic 字面量联合（新增 DataMap 条目后自动收窄） */
export type ShellNoticeTopic = keyof ShellNoticeDataMap;

/** 壳统一通知信封（v1） */
export interface ShellNotice<T extends ShellNoticeTopic = ShellNoticeTopic> {
    /** 信封结构版本；插件遇到不认识的版本应忽略该通知 */
    v: 1;
    /** 会话内单调递增序号（主进程内存计数器，重启归零；仅用于排序/去重诊断） */
    seq: number;
    /** 事件产生时间（ISO 8601） */
    ts: string;
    /** 来源标识；v1 恒为 'shell'，预留给未来非壳来源 */
    source: 'shell';
    /** 通知主题（点分命名空间，如 'update.available'） */
    topic: T;
    /** 按 topic 约定的负载；未知 topic 时插件应忽略 */
    data: ShellNoticeDataMap[T];
}

/** enest.onSaveRequested 回调参数 */
export interface SaveRequestedEvent {
    reason: ShellSaveReason;
    /** 建议完成保存的时限（ms，与主进程等待窗口一致） */
    deadlineMs: number;
    /** 本次保存请求的唯一标识（诊断用） */
    operationId: string;
}

/** New and legacy toast calls share one payload and one rendering path. */
export interface PluginToastOptions extends NotificationOptions {
    /** @deprecated Use body. */
    message?: string;
    /** @deprecated Use level. */
    type?: PluginToastType;
}

export type QuickInputAction = 'next' | 'previous' | 'submit' | 'clear';

export interface QuickInputConfig {
    placeholder: string;
    value: string;
}

export interface PluginFileSaveResult {
    ok: boolean;
    path: string;
}

export interface ClipboardCapabilities {
    files: boolean;
    sourceApp: boolean;
    paste: boolean;
    permissionRequired: boolean;
    reason?: string;
}

export interface ClipboardFileInspection {
    path: string;
    exists: boolean | null;
    directory?: boolean;
}

/** 壳子支持的界面语言（settings.general.locale / enest.i18n） */
export type AppLocale = 'zh-CN' | 'en-US';

/** 屏幕区域（设备像素，相对 capture 的 display） */
export interface ScreenBounds {
    x: number;
    y: number;
    width: number;
    height: number;
}

/** 截图结果：PNG dataURL */
export interface ScreenCaptureResult {
    dataUrl: string;
    width: number;
    height: number;
    displayId?: number;
}

export interface CaptureDisplay {
    id: number;
    bounds: ScreenBounds;
    workArea: ScreenBounds;
    scaleFactor: number;
    primary: boolean;
}

/**
 * 插件布局模式，与宿主窗口位置分离：
 * - quick：Quick 小窗内嵌，渲染在输入框下方（小窗适配样式）
 * - shell：主窗大窗 Tab（桌面适配样式）
 * 不再有「大小插件」类型区分：同一插件两种入口样式并存，
 * 壳子启动时经 URL ?mode= / onEnter 载荷 / getLaunchMode() 传给插件，插件自选渲染样式。
 * 拖出独立窗口保留原模式；收回 Quick / 主窗时才切换为接收位置的模式。
 */
export type PluginLaunchMode = 'quick' | 'shell';

/** 声明式设置 section（manifest.contributes.settings；持久化，重启即显示） */
export interface SettingsSectionContribution {
    id: string;
    title: string;
    items: SettingsSectionContributionItem[];
    /** 贡献点 schema 版本；缺省视为当前版本 */
    schemaVersion?: string;
}

/** 可由主题插件动态注册的主题包（V2 完整契约见 types/appearance.ts） */
export interface ThemePack {
    id: string;
    name: string;
    /** 来源插件 id，内置为 'enest.builtin' */
    source: string;
    mode: ThemeMode;
    tokens: Record<string, string>;
    background?: BackgroundConfig;
    /** 最多 8 个声明式动效；随主题包来源注册、禁用和卸载。 */
    backgroundEffects?: BackgroundEffectDefinition[];
}

export type ThemePackRegistrationInput = Omit<ThemePack, 'source' | 'mode' | 'background'> & {
    mode?: ThemeMode;
    source?: string;
    background?: ThemePackV2['background'];
} | ThemePackV2Input;

export interface PluginPathResolveInput {
    /** 用户输入或插件配置里的路径；支持 `~`、`~/x`、`./x` 与裸相对写法 */
    input: string;
    /** 相对路径的基准，缺省 home（`./` 与裸相对路径都按此展开） */
    base?: PluginPathBase;
}

export interface PluginPathResolveResult {
    /** 归一化后的绝对路径；解析失败为 null */
    path: string | null;
    /** 输入是否本来就是绝对路径 */
    absolute: boolean;
    /** 实际使用的基准目录（home / data / cwd 之一对应的绝对路径） */
    base: string;
    /** 目标是否存在（只读探测，不创建） */
    exists: boolean;
    /** 失败原因（面向用户，可直接展示） */
    error?: string;
}

/**
 * Bounded enter input handed to a plugin with the launch.
 * Images carry full data URLs (host-validated budgets); files carry a host-minted
 * read-only handle plus display metadata — the path is informational, reading goes via handleId.
 */
export interface QuickEnterInput {
    text?: string;
    images?: Array<{
        dataUrl: string;
        width: number;
        height: number;
    }>;
    files?: Array<{
        handleId: string;
        path: string;
        name: string;
        size: number;
        kind: 'file' | 'directory';
    }>;
}

export interface PluginStorageApi extends PluginKeyValueStorageApi {
    /** @deprecated Use assets. Compatibility adapter over the same private image service. */
    blobs: PluginBlobsApi;
    assets: PluginAssetsApi;
    /** Completed private outputs created by files.stream; no raw paths are accepted. */
    files: PluginStoredFilesApi;
    /** Commit this plugin's prior queued KV writes with a SQLite FULL WAL sync. */
    flush(): Promise<PluginStorageCommitReceipt>;
    /** Atomically commit 1-100 unique-key changes together with prior queued writes. */
    commit(operations: PluginStorageOperation[]): Promise<PluginStorageCommitReceipt>;
    /** Clears persistent KV only; images, settings, session data and secrets are not removed. */
    clear(): Promise<boolean>;
    /** In-memory KV, cleared on explicit plugin close; hibernation may restore its snapshot. */
    session: PluginKeyValueStorageApi;
}

/** An opaque reference, resolvable only in the same plugin's trusted backend. */
export interface VaultSetResult {
    secretRef: string;
}

export interface HomeAppearanceSnapshot {
    appearance: HomeResolvedAppearance;
    generation?: number;
    resources?: {
        fonts: Array<{
            family: string;
            url: string;
        }>;
    };
}

export interface HomeCatalog {
    items: HomeCatalogItem[];
    revision: number;
}

export interface HomeDetail {
    pluginId: string;
    name: string;
    description?: string;
    category?: string;
    author?: string;
    version?: string;
    latestVersion?: string;
    installs?: string;
    installed?: boolean;
    enabled?: boolean;
    icon?: string | null;
    color?: string;
    glyph?: string;
    tags?: string[];
    permissions?: PluginPermission[];
    packageSize?: number;
    readmeUrl?: string;
    /** Authored README image references mapped only to declared screenshot resource slots. */
    readmeImages?: Record<string, string>;
    screenshots?: string[];
}

export interface HomeSearchResult {
    items: HomeSearchEntry[];
    revision: number;
}

export type HomeSearchScope = 'all' | 'installed' | 'market' | 'action' | 'app' | 'plugin';

export interface HomeRuntimeConfig {
    locale: 'zh-CN' | 'en-US';
    installedFirst: boolean;
    offline: boolean;
    warmInstall: boolean;
    revision: number;
}

export type HomeAction = {
    type: 'navigate';
    route: WorkspaceRoute;
} | {
    type: 'activateSearchResult';
    handle: string;
    query?: string;
} | {
    type: 'openPlugin';
    pluginId: string;
} | {
    type: 'openMarket';
    pluginId?: string;
} | {
    type: 'openSettings';
} | {
    type: 'refreshApps';
} | {
    type: 'installPlugin';
    pluginId: string;
} | {
    type: 'updatePlugin';
    pluginId: string;
} | {
    type: 'setPluginEnabled';
    pluginId: string;
    enabled: boolean;
} | {
    type: 'uninstallPlugin';
    pluginId: string;
} | {
    type: 'refreshCatalog';
    reason?: 'manual' | 'boot';
} | {
    type: 'setHomeVisible';
    visible: boolean;
};

export interface HomeActionResponse {
    ok: boolean;
    error?: string;
}

export interface HomeReadyPayload {
    revision?: number;
    workspaceVersion?: 1;
    routes?: WorkspacePage[];
}

export type HomeCommand = {
    type: 'settingsChanged';
} | {
    type: 'navigate';
    route: WorkspaceRoute;
    requestId: string;
    generation: number;
    revision: number;
} | {
    type: 'visibility';
    visible: boolean;
    revision: number;
} | {
    type: 'refresh';
    reason: 'manual' | 'boot';
    revision: number;
} | {
    type: 'openMarket';
    pluginId?: string;
    revision: number;
    generation: number;
} | {
    type: 'install';
    pluginId?: string;
    jobId?: string;
    name?: string;
    status: 'queued' | 'progress' | 'done' | 'error';
    progress?: number;
    error?: string;
};

export interface WorkspaceNavigationAck {
    generation: number;
    requestId: string;
    ok: boolean;
}

/** Bounded provider-private JSON. The host does not interpret the provider's schema. */
export interface QuickStateSnapshot {
    revision: number;
    value: unknown;
}

export interface QuickThemeSnapshot {
    version: 1;
    revision: number;
    query: string;
    filter: QuickCommandKind | null;
    searching: boolean;
    loading: boolean;
    busy: boolean;
    composing: boolean;
    error: string | null;
    items: QuickThemeItem[];
    catalog: QuickThemeCatalogItem[];
    catalogRevision: number;
    queryRevision: number;
    shown: number;
    selectedId: string | null;
    expanded: boolean;
    hiddenCount: number;
    emptyMarket: boolean;
    plugin: {
        title: string;
        loading: boolean;
        placeholder: string;
        acceptsInput: boolean;
    } | null;
    /**
     * Host-held paste context (bounded thumbnails only; full bytes stay in main).
     * Null when nothing is attached. Items ≤12.
     */
    input: {
        items: QuickImageContext[];
        hasText: boolean;
    } | null;
    appearance: QuickThemeAppearance;
    bounds: {
        width: number;
        height: number;
        inputHeight: number;
    };
    opened?: QuickThemeOpenedReceipt | null;
}

export type QuickThemeAction = {
    type: 'state-read';
} | {
    type: 'state-write';
    expectedRevision: number;
    value: unknown;
} | {
    type: 'query';
    query: string;
} | {
    type: 'filter';
    kind: QuickCommandKind | null;
} | {
    type: 'select';
    id: string;
}
/** A provider selects and orders only current catalog handles; it cannot supply launch data. */
 | {
    type: 'results';
    catalogRevision: number;
    queryRevision: number;
    items: Array<{
        id: string;
        title?: string;
        group?: string;
    }>;
    selectedId?: string | null;
    hiddenCount?: number;
    emptyMarket?: boolean;
    expanded?: boolean;
} | {
    type: 'composition';
    active: boolean;
} | {
    type: 'open';
    id: string;
    container?: 'quick' | 'shell';
} | {
    type: 'expand';
    expanded: boolean;
}
/** Request the host read clipboard image/file into the paste context; needs a one-shot native gesture. */
 | {
    type: 'paste';
}
/** Remove one paste-context entry by opaque id; omit id to clear the whole context. */
 | {
    type: 'input-clear';
    id?: string;
} | {
    type: 'open-market' | 'open-settings' | 'refresh-apps' | 'retry' | 'hide' | 'plugin-back' | 'plugin-pin' | 'plugin-focus' | 'plugin-detach';
} | {
    type: 'layout';
    columns: number;
    height: number;
} | {
    type: 'key';
    key: string;
    shift?: boolean;
    meta?: boolean;
    ctrl?: boolean;
    alt?: boolean;
};

export interface QuickThemeActionResult {
    ok: boolean;
    error?: string;
    state?: QuickStateSnapshot;
}

export interface ThemeChromeSnapshot {
    version: 1;
    surface: ThemeChromePart;
    tabStyle: TabStyle;
    view: ShellView;
    activeTabId: string | null;
    animationLevel: AnimationLevel;
    theme: {
        mode: 'light' | 'dark';
        tokens: Record<string, string>;
        /** Trusted builtin adapter only; custom chrome receives the token allowlist. */
        appearance?: ResolvedAppearance;
    };
    /** Trusted builtin adapter only; custom chrome never receives account data. */
    profile?: {
        name: string | null;
        avatar: string | null;
    } | null;
    tabs: Array<{
        id: string;
        pluginId: string;
        title: string;
        color: string;
        glyph: string;
        badge?: string;
        icon?: string | null;
        lazy?: boolean;
        crashed?: boolean;
    }>;
    contribEntries: Array<{
        id: string;
        pluginId: string;
        title: string;
        glyph: string;
        color: string;
    }>;
}

export type ThemeChromeAction = {
    type: 'home' | 'settings';
} | {
    type: 'activate';
    tabId: string;
} | {
    type: 'close';
    tabId: string;
} | {
    type: 'detach';
    tabId: string;
} | {
    type: 'reorder';
    tabId: string;
    index: number;
} | {
    type: 'contribution';
    id: string;
} | {
    type: 'expand';
    expanded: boolean;
};

export interface ThemeSettingsSnapshot {
    version: 1;
    revision: number;
    locale: 'zh-CN' | 'en-US';
    appearance: QuickThemeAppearance;
    groups: Array<{
        id: string;
        title: string;
        fields: ThemeSettingsFieldDescriptor[];
    }>;
    nativeSections: Array<{
        id: NativeSettingsSection;
        title: string;
    }>;
}

export type ThemeSettingsAction = {
    type: 'set';
    fieldId: string;
    value: ThemeSettingsValue;
} | {
    type: 'native';
    section: NativeSettingsSection;
};

export interface ThemeSettingsActionResult {
    ok: boolean;
    error?: string;
    nativeSection?: NativeSettingsSection;
}

export interface PluginBackgroundHost {
    private: {
        readDocument(key: string): Promise<unknown | null>;
        /** Atomic replacement; a successful result means durable storage, not a queued write. */
        writeDocument(key: string, value: unknown): Promise<void>;
        getBlob(id: string): Promise<{
            dataUrl: string;
            bytes: number;
        } | null>;
        /** Optional stable ID makes interrupted imports retryable without duplicating blobs. */
        putBlob(input: {
            id?: string;
            dataUrl: string;
        }): Promise<PluginBackgroundBlob>;
        removeBlob(id: string): Promise<boolean>;
    };
    settings: {
        get(): Promise<Record<string, unknown>>;
    };
    /** Event is delivered only to the same plugin's live UI. It does not wake another background. */
    emit(event: string, data?: unknown): Promise<void>;
    legacy: {
        /** Sources are fixed host migration entries, never paths supplied by a plugin. */
        read(source: string): Promise<PluginBackgroundLegacyDocument | null>;
        getBlob(source: string, token: string, name: string): Promise<{
            dataUrl: string;
            bytes: number;
        } | null>;
        /** Writes a one-way marker after the plugin has durably committed its private document. */
        commit(source: string, token: string): Promise<void>;
    };
}

export interface PluginBackgroundHandlers {
    onEvent?(event: string, data: unknown): void | Promise<void>;
    call(method: string, args: unknown[]): unknown | Promise<unknown>;
    search?(query: string, limit: number): PluginBackgroundSearchItem[] | Promise<PluginBackgroundSearchItem[]>;
}

export interface AuxiliaryContext {
    windowId: string;
    data: unknown;
    display: {
        id: number;
        x: number;
        y: number;
        width: number;
        height: number;
        scaleFactor: number;
    };
    capture?: {
        withAudio: boolean;
    };
}

/** A self-contained JSON Schema 2020-12 document; references must stay local. */
export type McpJsonSchema = Record<string, unknown>;

/** Descriptive hints only; these never grant host permissions. */
export interface McpToolAnnotations {
    title?: string;
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
}

// —— 插件生命周期（对标 uTools onPluginEnter / onPluginOut）——
/**
 * openPlugin 可选进入载荷：code 对应 feature 指令，payload 为任意透传数据；
 * input 为 Quick 粘贴上下文（文本/图片/文件），由宿主按会话预算签发。
 */
export interface PluginEnterPayload {
    code?: string;
    type?: 'text' | 'regex' | 'over' | 'img' | 'files';
    payload?: unknown;
    input?: QuickEnterInput;
}

/** 关闭原因：用户关 Tab / 卸载插件 / 应用退出 */
export type PluginCloseReason = 'tab-close' | 'uninstall' | 'app-quit';

export type AppearanceColorMode = 'light' | 'dark';

/** A pack-declared atmosphere preset; both paints are validated before the pack is accepted. */
export interface ThemeBackgroundPaletteDeclaration {
    id: string;
    name: string;
    css: string;
    swatch?: string;
}

export interface ThemeSettingsSchema {
    version: number;
    groups: Array<{
        id: string;
        title: string;
        description?: string;
        fields: ThemeSettingsField[];
    }>;
}

export interface ThemeHomeReference {
    source: string;
    id: string;
    variant: string;
}

export interface ThemeVariant {
    tokens: Partial<Record<ThemeColorToken, string>>;
    fonts: AppearanceFonts;
    components: AppearanceComponents;
    background: AppearanceBackground;
    layout: AppearanceLayout;
    /** Host-authored notification structure; omission retains host defaults. */
    notifications?: ThemeNotificationStyle;
    /** Independent startup fallback, after any shared effect/atmosphere precedence. */
    splash?: AppearanceSplash;
    animation: AnimationLevel;
}

/** Package-relative entry owned by the declaring theme. The host owns native geometry. */
export interface ThemeQuickReference {
    version: 1;
    entry: string;
}

/** Entries are assets in the declaring, installed theme package, never remote URLs. */
export interface ThemeChromeReference {
    version: 1;
    classic?: {
        entry: string;
    };
    rail?: {
        entry: string;
    };
    dock?: {
        entry: string;
    };
}

export interface ThemeSettingsReference {
    version: 1;
    entry: string;
}

/** Source is assigned by the host, never trusted from a plugin request. */
export interface ThemeIdentity {
    source: string;
    id: string;
}

export interface ThemeNotificationStyle {
    layout: 'card' | 'compact' | 'banner';
    accent: 'stripe' | 'icon' | 'none';
    radius: number;
    borderWidth: number;
    density: number;
    shadow: 'none' | 'soft' | 'raised';
}

export interface AppearanceFonts {
    body: string;
    heading: string;
    mono: string;
    scale: number;
    /** Latin precedes CJK in the composed body stack; empty slots use the authored body. */
    cjk?: string;
    latin?: string;
}

export interface AppearanceComponents {
    controlRadius: number;
    cardRadius: number;
    panelRadius: number;
    borderWidth: number;
}

export interface AppearanceLayout {
    variant: string;
    tabStyle?: TabStyle;
    /** Titlebar background opacity, 0–1; labels, icons and window controls stay opaque. */
    tabOpacity?: number;
    /** Classic titlebar collapses to an 8px host-owned reveal strip. */
    tabAutoHide?: boolean;
    density: number;
    gap: number;
    sidebarWidth: number;
    contentWidth: number;
    columns: number;
}

export interface AppearanceBackground {
    media: BackgroundConfig | null;
    effect: string;
    texture: string;
    intensity: number;
    speed: number;
    direction: number;
    /** Independent material controls; omitted V2 fields retain host defaults. */
    warmth?: number;
    grain?: number;
    scale?: number;
    wash?: number;
    kind?: ThemeBackgroundKind;
    /** Built-in preset id, or an id the active pack declared in `ThemePackV2.palettes`. */
    palette?: ThemeBackgroundPalette | (string & {});
    color?: string;
    opacity?: number;
    fit?: 'cover' | 'contain';
}

export interface AppearanceSplash {
    type: 'brand' | 'none' | 'image' | 'paper';
    media: BackgroundConfig | null;
    opacity: number;
}

export interface AppearanceDiagnostic {
    path: string;
    code: string;
    message: string;
}

/** 主题模式：浅色 / 深色 / 跟随系统 */
export type ThemeMode = 'light' | 'dark' | 'system';

/** 动画效果强度：low 几乎无动画 / medium 默认 / high 加强动效 */
export type AnimationLevel = 'low' | 'medium' | 'high';

/** Auxiliary pages are untrusted plugin assets, not additional plugin API surfaces. */
export interface AuxiliaryOpen {
    entry: string;
    data?: unknown;
    title?: string;
    bounds?: {
        x?: number;
        y?: number;
        width?: number;
        height?: number;
    };
    placement?: 'window' | 'display';
    displayId?: number;
    visible?: boolean;
    transparent?: boolean;
    resizable?: boolean;
    movable?: boolean;
    alwaysOnTop?: boolean;
    capture?: {
        displayId?: number;
        withAudio?: boolean;
    };
}

export interface DeadlineTaskPlan {
    id: string;
    steps: DeadlineTaskStep[];
    repeat?: boolean;
    autoAdvance?: boolean;
    data?: DeadlineTaskData;
}

export interface DeadlineTaskState {
    id: string;
    runId: string;
    plan: DeadlineTaskPlan;
    status: 'idle' | 'running' | 'paused' | 'completed';
    stepIndex: number;
    iteration: number;
    remainingMs: number;
    deadline: number | null;
    startedAt: number | null;
    updatedAt: number;
}

/** Execution receipts are immutable; their business meaning/edit history belongs to the plugin. */
export interface DeadlineTaskReceipt {
    id: string;
    taskId: string;
    runId: string;
    stepId: string;
    stepIndex: number;
    iteration: number;
    startedAt: number;
    endedAt: number;
    elapsedMs: number;
    outcome: 'completed' | 'skipped' | 'cancelled';
    data?: DeadlineTaskData;
    stepData?: DeadlineTaskData;
}

/** Ordered, owner-private temporary output. No arbitrary filesystem paths are accepted. */
export interface FileStreamOpen {
    /** 1..12 lowercase letters/digits; "part" is reserved for incomplete streams. */
    extension: string;
}

export interface FileStreamResult {
    /** Stable private output ID, accepted by storage.files after finish. */
    id: string;
    /** @deprecated Display-only compatibility value; use storage.files to read, remove or export. */
    path: string;
    size: number;
}

export interface HomePageContribution {
    id: string;
    source: string;
    version: number;
    /** Package-relative HTML entry. No remote URLs or traversal. */
    entry: string;
    variants: string[];
}

export type McpToolHandler = (argumentsValue: Record<string, unknown>, context: McpHandlerContext) => McpToolResult | Promise<McpToolResult>;

/**
 * 壳统一通知（ShellNotice）— 壳软件关键节点事件的标准信封。
 *
 * 设计目标：壳的所有关键节点（更新、保存、退出、外观……）按同一 JSON 结构广播，
 * 插件按 topic 订阅自己关心的通知；未来新增节点只在 ShellNoticeDataMap 上扩展，
 * 不改变信封字段。插件收到未知 topic / 未知版本时应忽略。
 *
 * 通道：主进程 → 插件 webContents（plugin:event，payload.type === 'shell-notice'）。
 * 消费：enest.onNotice(cb) / enest.onNotice(topic, cb) / enest.on('shell-notice', cb)。
 */
/** 通知触发保存的原因 */
export type ShellSaveReason = 'update' | 'app-quit' | 'manual';

/** 外观关键节点类型（appearance.changed 的 kind） */
export type ShellAppearanceKind = 'theme' | 'font' | 'animation';

export type PluginToastType = NotificationLevel;

export interface NotificationOptions {
    title?: string;
    body?: string;
    format?: NotificationFormat;
    /** Defaults to bottom-right. top remains available for older host callers. */
    position?: NotificationPosition;
    level?: NotificationLevel;
    /** 0 keeps the card until dismissed; otherwise 1500–60000 ms. */
    duration?: number;
}

/** 设置 section 贡献项：manifest、主进程设置桥和动态渲染共用。 */
export interface SettingsSectionContributionItem {
    key: string;
    /** Explicit public presentation opt-in. Text, credentials and undeclared fields remain private. */
    shareWithThemes?: boolean;
    /**
     * 控件类型（10 种）：text / string / switch / boolean / bool / select /
     * number / slider / color / page。
     * - string/bool 为 text/switch 的别名（对齐插件侧声明习惯）；
     * - slider 需 min/max/step；color 渲染颜色输入；page 打开插件内独立设置页。
     * - 非法类型渲染层回退 text。
     */
    type: string;
    label: string;
    /** type=page：打开本插件并发送入口事件；缺省 code=settings。 */
    entry?: {
        code: string;
        payload?: unknown;
    };
    default?: unknown;
    options?: Array<{
        label: string;
        value: unknown;
    }>;
    /** type=slider：范围与步长 */
    min?: number;
    max?: number;
    step?: number;
}

export interface BackgroundConfig {
    type: BackgroundType;
    /** color: hex；image/video: 本地绝对路径或 enest:// 资源 URL */
    value: string;
    /** 0–1，视频/图片透明度 */
    opacity: number;
    /** cover | contain */
    fit: 'cover' | 'contain';
}

export type BackgroundEffectDefinition = BackgroundEffectBase & ({
    renderer: 'preset';
    preset: BackgroundEffectPreset;
    /** 三个六位 hex 颜色：背景主色、次色、高光色。 */
    colors?: [
        string,
        string,
        string
    ];
    /** 速度倍率，0.25–2；缺省为 1。 */
    speed?: number;
} | {
    renderer: 'video';
    /** 仅允许本插件 enest://plugin/<id>/assets/... 的 mp4/webm。 */
    video: string;
    /** 本插件的 png/jpeg/webp/avif/gif 静态封面。 */
    poster?: string;
});

export interface ThemePackV2Input extends Omit<ThemePackV2, 'source' | 'mode'> {
    source?: string;
    mode?: ThemeMode;
}

/** 插件填写的路径基准：home=用户目录，data=该插件持久化目录，cwd=进程工作目录 */
export type PluginPathBase = 'home' | 'data' | 'cwd';

export interface PluginStoredFilesApi {
    /** UUID-ordered pages, default 100 and at most 200 entries. Pass nextCursor back unchanged. */
    list(options?: PluginStoredFileListOptions): Promise<PluginStoredFilePage>;
    get(id: string, options?: PluginStoredFileReadOptions): Promise<PluginStoredFileChunk | null>;
    /** Removes the completed private file and releases its storage quota. Missing IDs return false. */
    remove(id: string): Promise<boolean>;
    /** Native save confirmation is mandatory. Cancel returns null; no arbitrary target path is accepted. */
    export(id: string, options?: PluginStoredFileExportOptions): Promise<PluginStoredFileExportResult | null>;
}

export interface PluginAssetsApi {
    put(input: PluginAssetPutInput): Promise<PluginAssetPutResult>;
    /** Includes this plugin's legacy attachments; no startup migration is required. */
    list(): Promise<PluginAsset[]>;
    get(assetId: string): Promise<PluginAssetGetResult | null>;
    remove(assetId: string): Promise<boolean>;
    /** @deprecated Use remove(). This is an alias with identical behavior. */
    delete(assetId: string): Promise<boolean>;
}

export interface PluginBlobsApi {
    put(input: {
        dataUrl: string;
        name?: string;
    }): Promise<PluginBlob>;
    get(id: string): Promise<{
        dataUrl: string;
        bytes: number;
    } | null>;
    remove(id: string): Promise<boolean>;
}

export interface PluginKeyValueStorageApi {
    get(key: string): Promise<unknown>;
    set(key: string, value: unknown): Promise<boolean>;
    remove(key: string): Promise<boolean>;
    clear(): Promise<boolean>;
}

export type PluginStorageOperation = {
    op: 'set';
    key: string;
    value: unknown;
} | {
    op: 'remove';
    key: string;
    value?: never;
};

export interface PluginStorageCommitReceipt {
    /** Unique receipt, not a CAS token or a cross-domain transaction identifier. */
    commitId: string;
    committedAt: number;
    /** Distinct keys committed, including the plugin's previously queued changes. */
    committedKeys: number;
}

/**
 * The home renderer gets rendering values only. Theme/profile bags, custom-font
 * metadata, diagnostics, and local media paths remain host-private.
 */
export interface HomeResolvedAppearance {
    version: 2;
    revision: number;
    theme: ThemeIdentity & {
        name: string;
        version: number;
        legacy: boolean;
    };
    requestedMode: ThemeMode;
    mode: AppearanceColorMode;
    tokens: Record<string, string>;
    fonts: AppearanceFonts;
    components: {
        controlRadius: number;
        cardRadius: number;
        panelRadius: number;
        borderWidth: number;
    };
    notifications: ThemeNotificationStyle;
    background: AppearanceBackground;
    splash?: AppearanceSplash;
    layout: {
        variant: string;
        density: number;
        gap: number;
        sidebarWidth: number;
        contentWidth: number;
        columns: number;
        tabStyle?: 'classic' | 'orb';
    };
    animation: {
        requested: AnimationLevel;
        effective: AnimationLevel;
        continuous: boolean;
    };
}

export interface HomeCatalogItem {
    pluginId: string;
    name: string;
    description?: string;
    category?: string;
    author?: string;
    version?: string;
    installed?: boolean;
    enabled?: boolean;
    icon?: string | null;
    color?: string;
    glyph?: string;
    tags?: string[];
    featured?: boolean;
    screenshots?: string[];
    packageSize?: number;
    installs?: string;
    latestVersion?: string;
}

/** 宿主能力标识；基础能力直接可用，敏感能力需在 manifest 声明并取得用户授权。 */
export type PluginPermission = 'backend.node' | 'clipboard.read' | 'clipboard.write' | 'clipboard.readImage' | 'clipboard.writeImage' | 'clipboard.history' | 'clipboard.paste' | 'timer.background' | 'screen.capture' | 'screen.record' | 'pin.create' | 'net.fetch' | 'shell.openExternal' | 'storage.local' | 'notify' | 'ui.setTitle' | 'ui.setIcon' | 'ui.setBadge' | 'ui.resize' | 'ui.toast' | 'settings.register' | 'settings.page' | 'hotkey' | 'contribute' | 'vault.write' | 'db.connect' | 'db.query' | 'db.schema' | 'mw.connect' | 'mw.query' | 'mw.admin' | 'net.socket' | 'fs.rename' | 'fs.read' | 'fs.write' | 'sys.control' | 'ssh.agent' | 'sys.inspect' | 'theme';

export interface HomeSearchEntry {
    handle: string;
    kind?: 'app' | 'plugin' | 'market' | 'action';
    title: string;
    subtitle?: string;
    icon?: string | null;
    color?: string;
    glyph?: string;
    pluginId?: string;
    installed?: boolean;
    enabled?: boolean;
    disabled?: boolean;
    tags?: string[];
    aliases?: string[];
    action?: QuickActionId;
    content?: QuickContentMatch;
}

export type WorkspaceRoute = {
    page: 'catalog';
} | {
    page: 'detail';
    pluginId: string;
};

/**
 * Host-owned workspace navigation targets.
 *
 * The catalog is one surface: its internal views (marketplace / installed, category
 * filters, search scope) belong to the Home provider, not to the host route. Only real
 * navigations the host must be able to replay after a crash or provider switch live here.
 */
export type WorkspacePage = 'catalog' | 'detail';

/**
 * shared/types/quick — 快捷启动（Quick Launcher）跨进程类型
 * 职责：定义命令项、本地应用、热键配置与搜索/打开请求体。
 * 被 main/hotkey、main/launcher、quickHandlers、preload、Quick 渲染层共同引用。
 */
export type QuickCommandKind = 'app' | 'plugin' | 'action';

/**
 * Host-held paste-context entry projected into renderers and themes.
 * Full image bytes never enter the theme snapshot: thumbnails are bounded data URLs.
 */
export interface QuickImageContext {
    /** Opaque session handle; valid only until the context is cleared. */
    id: string;
    kind: 'image' | 'file' | 'directory';
    name?: string;
    size?: number;
    width?: number;
    height?: number;
    /** Bounded PNG data URL for preview (≤64 KiB). */
    thumbnail: string;
}

export interface QuickThemeAppearance {
    mode: AppearanceColorMode;
    tokens: Record<string, string>;
    fonts: AppearanceFonts;
    components: AppearanceComponents;
    animation: AnimationLevel;
    resources: {
        fonts: Array<{
            family: string;
            url: string;
        }>;
    };
}

/** A successful native launch fact, not an instruction to maintain any particular history model. */
export interface QuickThemeOpenedReceipt {
    sequence: number;
    stateKey: string;
    at: number;
    query: string;
}

/** Opaque handles expire whenever the current result set changes. No launch paths or payloads. */
export interface QuickThemeItem {
    id: string;
    kind: QuickCommandKind;
    title: string;
    subtitle: string;
    group: string;
    /** Host-published image bytes only, never filesystem or plugin package paths. */
    icon?: string;
    action?: QuickActionId;
}

/** A native directory descriptor. IDs are session capabilities, not launch targets. */
export interface QuickThemeCatalogItem extends Omit<QuickThemeItem, 'group'> {
    /** Stable opaque identity for private state, never a launch capability or local path. */
    stateKey: string;
    aliases: string[];
    content?: QuickContentMatch;
    provider?: boolean;
}

export type ShellView = 'home' | 'settings' | 'plugin';

/** Tab 呈现方式：classic 顶栏条 / orb 左侧悬浮圆形轨道 */
export type TabStyle = 'classic' | 'orb';

export type ThemeChromePart = 'classic' | 'rail' | 'dock';

export interface ThemeSettingsFieldDescriptor {
    /** Session capability; it never encodes a setting key or filesystem target. */
    id: string;
    label: string;
    type: 'switch' | 'select' | 'number' | 'color';
    value: ThemeSettingsValue;
    options?: Array<{
        label: string;
        value: ThemeSettingsValue;
    }>;
    min?: number;
    max?: number;
    step?: number;
    /** Editing another plugin's preferences always requires a native confirmation. */
    confirmation?: boolean;
}

export type NativeSettingsSection = 'general' | 'theme' | 'dev' | 'mcp' | `p:${string}`;

export type ThemeSettingsValue = string | number | boolean | null;

export interface PluginBackgroundBlob {
    id: string;
    bytes: number;
}

export interface PluginBackgroundLegacyDocument {
    /** Opaque source identity. Commit must reject a changed source. */
    token: string;
    document: string;
}

export interface PluginBackgroundSearchItem {
    id: string;
    title: string;
    subtitle?: string;
    code?: string;
    payload?: unknown;
}

export interface ThemeSettingsField {
    key: string;
    label: string;
    type: 'color' | 'slider' | 'switch' | 'select' | 'font' | 'media' | 'token';
    default: ThemeSettingValue;
    binding: ThemeSettingBinding;
    min?: number;
    max?: number;
    step?: number;
    options?: ThemeSettingOption[];
    /** Preferred widget shape; the host validates it against the field's type and binding. */
    presentation?: ThemeSettingPresentation;
    help?: string;
    visibleWhen?: {
        field: string;
        equals: string | number | boolean;
    };
}

export type ThemeColorToken = '--bg' | '--surface' | '--surface-2' | '--surface-3' | '--text' | '--text-2' | '--text-3' | '--accent' | '--ok' | '--danger' | '--border' | '--border-strong' | '--link';

export type ThemeBackgroundKind = 'none' | 'gradient' | 'color' | 'image' | 'video';

export type ThemeBackgroundPalette = 'theme' | 'dawn' | 'mint' | 'linen' | 'peach' | 'ocean' | 'forest' | 'ink';

export type DeadlineTaskData = null | boolean | number | string | DeadlineTaskData[] | {
    [key: string]: DeadlineTaskData;
};

export interface DeadlineTaskStep {
    id: string;
    durationMs: number;
    data?: DeadlineTaskData;
    notification?: {
        title: string;
        body: string;
    };
}

export interface McpToolResult {
    content: McpContentBlock[];
    /** Must be JSON-serializable. False, zero and null are meaningful results. */
    structuredContent?: unknown;
    isError?: boolean;
}

export interface McpHandlerContext {
    requestId: string;
    /** Absolute Unix time in milliseconds. */
    deadlineAt: number;
    /** Runs immediately if already cancelled; returns an unsubscribe function. */
    onCancel(callback: () => void): () => void;
}

export type NotificationLevel = 'info' | 'success' | 'warn' | 'error';

export type NotificationFormat = 'text' | 'html' | 'markdown';

export type NotificationPosition = 'top' | 'center' | 'bottom-right';

/** 背景类型：无 / 纯色 / 静态图 / 动效视频（mp4/webm，类 Wallpaper Engine） */
export type BackgroundType = 'none' | 'color' | 'image' | 'video';

/** 宿主提供的背景动效与启动 Logo 编排。插件不能注入脚本或 shader。 */
export type BackgroundEffectPreset = 'fold' | 'aurora' | 'orbit' | 'ripple' | 'tunnel';

export interface BackgroundEffectBase {
    /** 主题包内唯一的安全短 ID（字母开头，最多 48 字符）。 */
    id: string;
    name: string;
    description?: string;
    /** 启动 Logo 的编排；未指定时由宿主按背景选择。 */
    logoStyle?: BackgroundEffectPreset;
}

export interface PluginStoredFileListOptions {
    cursor?: string;
    limit?: number;
}

export interface PluginStoredFilePage {
    items: PluginStoredFile[];
    nextCursor: string | null;
}

export interface PluginStoredFileReadOptions {
    /** Nonnegative safe integer. At or beyond EOF returns an empty buffer. */
    offset?: number;
    /** 1..524288 bytes; defaults to 524288. Zero is not a valid read length. */
    length?: number;
}

export interface PluginStoredFileChunk {
    file: PluginStoredFile;
    offset: number;
    bytes: ArrayBuffer;
    nextOffset: number | null;
}

export interface PluginStoredFileExportOptions {
    defaultName?: string;
}

export interface PluginStoredFileExportResult {
    ok: true;
    path: string;
    size: number;
}

export type PluginAsset = PluginAssetMeta;

/** Supply exactly one representation; data URLs carry their own MIME type. */
export type PluginAssetPutInput = {
    name?: string;
    assetId?: string;
} & ({
    bytes: ArrayBuffer;
    mime: PluginAssetMime;
    dataUrl?: never;
} | {
    dataUrl: string;
    bytes?: never;
    mime?: never;
});

export interface PluginAssetPutResult extends PluginAsset {
    /** @deprecated Compatibility only. Render with assets.get(); this path grants no filesystem access. */
    path: string;
}

export interface PluginAssetGetResult {
    dataUrl: string;
    mime: string;
    bytes: number;
}

/** Plugin-private storage contracts; filesystem paths never grant file access. */
export interface PluginBlob {
    id: string;
    bytes: number;
}

export type QuickActionId = 'open-market' | 'open-settings' | 'refresh-apps';

export interface QuickContentMatch {
    type: QuickContentType;
    source?: string;
    flags?: string;
    minLength: number;
    maxLength?: number;
    /** img/files: lowercase extension allowlist (no dot). Empty means any supported type. */
    extensions?: string[];
    /** files only: accept directory entries. */
    allowDirectory?: boolean;
    /** files only: accepted entry count bounds (defaults 1..20). */
    minCount?: number;
    maxCount?: number;
}

export type ThemeSettingValue = string | number | boolean | BackgroundConfig | null;

/** Declarative bindings are semantic destinations, not CSS selectors or executable expressions. */
export type ThemeSettingBinding = {
    target: 'token';
    key: ThemeColorToken;
} | {
    target: 'layout';
    key: ThemeLayoutKey;
} | {
    target: 'background';
    key: ThemeBackgroundKey;
} | {
    target: 'component';
    key: ThemeComponentKey;
} | {
    target: 'font';
    key: ThemeFontKey;
} | {
    target: 'splash';
    key: ThemeSplashKey;
} | {
    target: 'notification';
    key: ThemeNotificationKey;
} | {
    target: 'animation';
    key: 'level';
};

/**
 * Declarative widget hint. The host still owns every control, its behaviour and its styles;
 * a pack only names the shape it prefers and the host falls back when the hint is unsupported.
 */
export type ThemeSettingPresentation = 'segmented' | 'cards' | 'slider-cluster';

export interface ThemeSettingOption {
    label: string;
    value: string | number | boolean;
    description?: string;
    /** Host-rendered thumbnail; omitted options render a text-only card. */
    preview?: ThemeSettingOptionPreview;
}

export type McpContentBlock = ({
    type: 'text';
    text: string;
} | {
    type: 'image';
    data: string;
    mimeType: string;
} | {
    type: 'audio';
    data: string;
    mimeType: string;
} | {
    type: 'resource_link';
    uri: string;
    name: string;
    title?: string;
    description?: string;
    mimeType?: string;
    size?: number;
} | {
    type: 'resource';
    resource: {
        uri: string;
        mimeType?: string;
    } & ({
        text: string;
    } | {
        blob: string;
    });
}) & {
    annotations?: McpContentAnnotations;
};

export interface PluginStoredFile {
    id: string;
    extension: string;
    size: number;
    createdAt: number;
}

export interface PluginAssetMeta {
    /** Opaque identifier. Pass it back unchanged, including any existing suffix. */
    assetId: string;
    name: string;
    mime: string;
    bytes: number;
    createdAt: number;
}

export type PluginAssetMime = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';

/** Validated declaration, not an evaluated match. The selected theme owns matching. */
export type QuickContentType = 'text' | 'regex' | 'over' | 'img' | 'files';

export type ThemeLayoutKey = 'density' | 'gap' | 'sidebarWidth' | 'contentWidth' | 'columns' | 'tabStyle' | ThemeTabStripKey;

export type ThemeBackgroundKey = 'texture' | 'intensity' | 'speed' | 'direction' | 'effect' | 'media' | 'warmth' | 'grain' | 'scale' | 'wash' | 'kind' | 'palette' | 'color' | 'opacity' | 'fit';

export type ThemeComponentKey = 'controlRadius' | 'cardRadius' | 'panelRadius' | 'borderWidth';

export type ThemeFontKey = 'body' | 'heading' | 'mono' | 'scale' | 'cjk' | 'latin';

export type ThemeSplashKey = 'type' | 'media' | 'opacity';

export type ThemeNotificationKey = keyof ThemeNotificationStyle;

/** A validated option thumbnail. Code is never executed; assets resolve inside the declaring plugin. */
export type ThemeSettingOptionPreview = {
    kind: 'swatch';
    stops: [
        string,
        string
    ];
} | {
    kind: 'asset';
    src: string;
};

export interface McpContentAnnotations {
    audience?: Array<'user' | 'assistant'>;
    priority?: number;
    lastModified?: string;
}

/** Options a theme can expose for the classic top tab strip. */
export type ThemeTabStripKey = 'tabOpacity' | 'tabAutoHide';

declare global { interface Window { enest: EnestPluginApi; /** @deprecated Use enest. */ zapi: EnestPluginApi; /** Dedicated workspace surfaces only. */ enestWorkspace?: EnestWorkspaceApi; /** Compatibility alias for enestWorkspace. */ enestHome?: EnestHomeApi; /** Isolated Quick theme pages only. */ enestQuick?: EnestQuickApi; /** Isolated theme chrome renderers only. */ enestChrome?: ThemeChromeApi; /** Isolated settings pages only. */ enestSettings?: EnestSettingsApi; /** Sandboxed background pages only. */ enestBackground?: PluginBackgroundBridge; /** Auxiliary pages only. */ enestAux?: AuxiliaryPageApi } }
export {}
```
