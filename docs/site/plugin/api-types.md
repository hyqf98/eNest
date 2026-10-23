# TypeScript 类型定义

本页由插件仓库的 `scripts/generate-api-types.mjs` 从壳 preload 与共享类型生成。

安装插件仓库的 `@enest/plugin-sdk`，在项目中加入 `import type {} from '@enest/plugin-sdk'` 即可获得 `window.enest` 类型。

生成：`npm run api:generate -- --host-root /path/to/eNest`；只读校验：`npm run api:check -- --host-root /path/to/eNest`。

类型不授予权限；系统能力仍由主进程验证 manifest、运行实例与用户授权。

```ts
/** Generated from the eNest preload and shared API types. Do not edit. */
export interface EnestPluginApi {
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
        register(section: {
            id: string;
            title: string;
            items: Array<{
                key: string;
                type: string;
                label: string;
                default?: unknown;
                entry?: {
                    code: string;
                    payload?: unknown;
                };
                options?: Array<{
                    label: string;
                    value: unknown;
                }>;
                min?: number;
                max?: number;
                step?: number;
            }>;
        }): Promise<boolean>;
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
        onChange(cb: (value: string) => void): Unsubscribe;
        onAction(cb: (action: QuickInputAction) => void): Unsubscribe;
    };
    focusTimer: {
        start(options: Partial<FocusTimerOptions>): Promise<FocusTimerSnapshot>;
        get(): Promise<FocusTimerSnapshot>;
        pause(): Promise<FocusTimerSnapshot>;
        resume(): Promise<FocusTimerSnapshot>;
        skip(): Promise<FocusTimerSnapshot>;
        stop(): Promise<FocusTimerSnapshot>;
        updateRecord(recordId: string, patch: FocusTimerRecordPatch): Promise<FocusTimerSnapshot>;
        onChange(cb: (snapshot: FocusTimerSnapshot) => void): Unsubscribe;
    };
    storage: {
        blobs: {
            put(input: {
                dataUrl: string;
                name?: string;
            }): Promise<PluginBlob>;
            get(id: string): Promise<{
                dataUrl: string;
                bytes: number;
            } | null>;
            remove(id: string): Promise<boolean>;
        };
        get(key: string): Promise<unknown>;
        set(key: string, value: unknown): Promise<boolean>;
        remove(key: string): Promise<boolean>;
        clear(): Promise<boolean>;
        /** 会话态 KV：主进程内存，插件关闭 / 应用退出即清空，不落盘 */
        session: {
            get(key: string): Promise<unknown>;
            set(key: string, value: unknown): Promise<boolean>;
            remove(key: string): Promise<boolean>;
            clear(): Promise<boolean>;
        };
    };
    clipboard: {
        capabilities(): Promise<ClipboardCapabilities>;
        requestPermission(): Promise<ClipboardCapabilities>;
        readText(): Promise<string>;
        /** excludeFromHistory protects this write from eNest's own history collector. */
        writeText(text: string, options?: {
            excludeFromHistory?: boolean;
        }): Promise<boolean>;
        readImage(): Promise<{
            dataUrl: string;
            width: number;
            height: number;
        } | null>;
        writeImage(dataUrl: string): Promise<boolean>;
        history: {
            query(options?: ClipboardQuery): Promise<{
                items: ClipboardHistoryEntry[];
                total: number;
                nextCursor: number | null;
            }>;
            copy(id: string, options?: {
                plainText?: boolean;
                paths?: boolean;
            }): Promise<boolean>;
            paste(id: string): Promise<{
                pasted: boolean;
                reason?: string;
            }>;
            reveal(id: string, fileIndex?: number): Promise<boolean>;
            onChange(cb: () => void): Unsubscribe;
            list(opts?: {
                limit?: number;
            }): Promise<ClipboardHistoryEntry[]>;
            get(id: string): Promise<(ClipboardHistoryEntry & {
                dataUrl?: string;
            }) | null>;
            remove(id: string): Promise<boolean>;
            clear(): Promise<boolean>;
            togglePin(id: string): Promise<ClipboardHistoryEntry>;
        };
    };
    screen: {
        capture(opts?: {
            displayId?: number;
            bounds?: ScreenBounds;
        }): Promise<ScreenCaptureResult>;
        selectRegion(): Promise<ScreenBounds | null>;
        record: {
            start(opts?: {
                bounds?: ScreenBounds;
                withAudio?: boolean;
                displayId?: number;
            }): Promise<{
                sessionId: string;
            }>;
            stop(sessionId: string): Promise<{
                path: string;
                size: number;
                durationMs: number;
            }>;
            cancel(sessionId: string): Promise<boolean>;
        };
    };
    pin: {
        open(payload: {
            dataUrl?: string;
            path?: string;
            x?: number;
            y?: number;
            width?: number;
            title?: string;
        }): Promise<{
            pinId: string;
        }>;
        close(pinId: string): Promise<boolean>;
        closeAll(): Promise<number>;
        list(): Promise<Array<{
            pinId: string;
        }>>;
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
             * ssh.workbench tunnel.open 打开的本地隧道口。需 net.socket 权限。
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
        /**
         * 局域网传件（lan.share 权限）：起限时 http 下载服务（0.0.0.0 随机端口，
         * 局域网可见——手机扫码即下），6 位数字取件码门禁、文件白名单、
         * 只读 GET（Range 支持）、并发连接上限、到期自动关停。
         */
        share: {
            /** 起分享：files 仅支持经用户选择的句柄 {handleId}；minutes 1–120（缺省 10） */
            start(input: {
                files: Array<{
                    handleId: string;
                    name?: string;
                }>;
                minutes?: number;
            }): Promise<LanShareStatus>;
            /** 查单个分享状态 */
            status(shareId: string): Promise<LanShareStatus>;
            /** 本插件全部分享 */
            list(): Promise<LanShareStatus[]>;
            /** 手动停止 */
            stop(shareId: string): Promise<boolean>;
            /** 订阅下载请求日志（文件/ip/时间）；等价 enest.on('lan.request') */
            onRequest(cb: (event: LanRequestEvent) => void): Unsubscribe;
            /** 订阅分享关停（到期 / stop / 插件关闭）；等价 enest.on('lan.stopped') */
            onStopped(cb: (event: LanStoppedEvent) => void): Unsubscribe;
        };
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
    /**
     * AI CLI 配置白名单读写（config.agent 权限）：
     * 10 个应用的 adapter（路径白名单硬编码）；写前自动快照（保留 20 份）。
     */
    agent: {
        /** 可用应用 + 探测到的安装状态 */
        apps(): Promise<AgentAppInfo[]>;
        /** 读配置原文与解析结果（不修改） */
        read(app: string): Promise<AgentConfigSnapshot>;
        /**
         * 最小侵入写入：只替换给定顶层键（TOML/JSON 分别处理，保留注释与其余内容）；
         * 写前自动快照。changes[filePath?] 按 app 主配置文件定位。
         */
        write(input: AgentWriteInput): Promise<AgentWriteResult>;
        /** 某应用的快照列表（时间倒序） */
        backups(app: string): Promise<AgentBackupInfo[]>;
        /** 从快照恢复 */
        restore(input: {
            app: string;
            id: string;
        }): Promise<boolean>;
        /** 会话日志只读：白名单目录下 jsonl 文件清单（大小+mtime，mtime 倒序） */
        sessions: {
            list(app: string): Promise<AgentSessionsListResult[]>;
            /** 逐行读会话文件（默认上限 512KB/文件；尾半行丢弃） */
            read(input: {
                app: string;
                file: string;
                maxBytes?: number;
            }): Promise<AgentSessionsReadResult>;
        };
        /** 资产通道：列白名单应用数据目录（如 codex 的 pets/；path 空串列根） */
        listAssets(input: {
            app: string;
            path?: string;
        }): Promise<AgentListAssetsResult>;
        /** 资产通道：写资产文件（宿主权限校验后落盘，覆盖前自动快照） */
        writeAssets(input: AgentWriteAssetsInput): Promise<AgentWriteAssetsResult>;
        /** 资产通道：删除资产文件 / 目录（宿主原生确认后执行，不可恢复） */
        deleteAssets(input: AgentDeleteAssetsInput): Promise<AgentDeleteAssetsResult>;
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
    /** SSH 运行时：session / exec / metrics / completion / sftp */
    localFiles: {
        /** Read a chosen file; UTF-8 text or a base64 data URL. Hard limit 32 MiB, two simultaneous reads. */
        read(input: {
            handleId: string;
            encoding?: 'text' | 'dataUrl';
            maxBytes?: number;
        }): Promise<string>;
        pick(options?: LocalFilePickOptions): Promise<LocalFileHandle[]>;
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
    ssh: {
        workbench(request: SshWorkbenchRequest): Promise<unknown>;
        connect(input: SshConnectInput): Promise<SshSessionInfo>;
        write(sessionId: string, data: string): Promise<boolean>;
        resize(sessionId: string, cols: number, rows: number): Promise<boolean>;
        disconnect(sessionId: string): Promise<boolean>;
        listSessions(): Promise<SshSessionInfo[]>;
        exec(input: SshExecInput): Promise<SshExecResult>;
        metrics: {
            /** 支持位置参数 (sessionId, intervalMs?) 或对象形 { sessionId, intervalMs? } */
            start(sessionIdOrOpts: string | {
                sessionId: string;
                intervalMs?: number;
            }, intervalMs?: number): Promise<{
                ok: boolean;
                intervalMs: number;
            }>;
            stop(sessionId: string | {
                sessionId: string;
            }): Promise<boolean>;
            latest(sessionId: string | {
                sessionId: string;
            }): Promise<SshMetricsSample | null>;
        };
        completion: {
            suggest(input: {
                sessionId: string;
                line: string;
                cursor?: number;
                cwd?: string;
                history?: string[];
                snippets?: Array<{
                    title: string;
                    command: string;
                }>;
            }): Promise<SshCompletionResult>;
        };
        sftp: {
            list(input: SftpListInput): Promise<SftpEntry[]>;
            download(input: SftpDownloadInput): Promise<SftpTransferResult>;
            upload(input: SftpUploadInput): Promise<SftpTransferResult>;
            mkdir(sessionId: string, path: string): Promise<boolean>;
            rename(sessionId: string, path: string, newPath: string): Promise<boolean>;
            delete(sessionId: string, path: string, recursive?: boolean): Promise<boolean>;
            chmod(sessionId: string, path: string, mode: number | string): Promise<boolean>;
        };
        /** 订阅 SFTP 传输进度（download/upload 过程推送）；等价 enest.on('ssh.transfer') */
        onSshTransfer(cb: (event: SshTransferEvent) => void): Unsubscribe;
        pickLocalFile(opts?: LocalFilePickOptions): Promise<LocalFileHandle | null>;
    };
    /** 数据库运行时：驱动会话 / 查询 / 补全 / schema / applyChanges / 导入 */
    db: {
        workbench(request: DbWorkbenchRequest): Promise<unknown>;
        test(config: DbConnectionConfig): Promise<DbTestResult>;
        open(input: {
            config: DbConnectionConfig;
            sessionKey?: string;
        } | DbConnectionConfig): Promise<DbSessionInfo>;
        close(sessionKey: string): Promise<boolean>;
        listSessions(): Promise<DbSessionInfo[]>;
        pickSqliteFile(options?: {
            createIfMissing?: boolean;
            readOnly?: boolean;
        }): Promise<LocalFileHandle | null>;
        pickImportFile(): Promise<LocalFileHandle | null>;
        execute(input: DbExecuteInput): Promise<QueryResult>;
        explain(input: {
            sessionKey: string;
            sql: string;
        }): Promise<QueryResult>;
        cancel(sessionKey: string | {
            sessionKey?: string;
            executionId?: string;
        }): Promise<boolean>;
        applyChanges(input: DbApplyChangesInput): Promise<BatchResult>;
        importPreview(input: DbImportPreviewInput): Promise<DbImportPreviewResult>;
        importRun(input: DbImportRunInput): Promise<DbImportRunResult>;
        schema: {
            tree(input: DbSchemaTreeInput & {
                node?: unknown;
            }): Promise<SchemaObject[]>;
            describe(input: {
                sessionKey: string;
                database?: string;
                schema?: string;
                table: string;
            }): Promise<TableDetail>;
            ddl(input: {
                sessionKey: string;
                database?: string;
                schema?: string;
                table: string;
            }): Promise<string>;
        };
        completion: ((input: DbCompletionInput) => Promise<CompletionResponse>) & {
            suggest(input: DbCompletionInput): Promise<CompletionResponse>;
        };
        dialects: {
            list(): Promise<DbDialectInfo[]>;
        };
    };
    /** 中间件控制台运行时：连接 / 浏览 / 变更（kafka / rabbitmq / mqtt / rocketmq） */
    mw: {
        workbench(request: MwWorkbenchRequest): Promise<unknown>;
    };
    /** DSH 驾驶舱运行时：runtime 探测 / web+sdk 进程 / profile / 备份 / 热更新 */
    dsh: {
        workbench(request: DshWorkbenchRequest): Promise<unknown>;
        /** dsh:* 事件（web-ready/web-port/sdk-notify/runtime-progress…）；等价 on('dsh.event') */
        onDshEvent(cb: (event: DshWorkbenchEvent) => void): Unsubscribe;
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
    runtime: {
        acquireActivity(reason: string): Promise<string>;
        releaseActivity(token: string): Promise<void>;
    };
    /** Calls the plugin-owned Node backend after explicit backend.node consent. */
    backend: {
        call<T = unknown>(method: string, args?: unknown[]): Promise<T>;
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

/** SFTP 传输进度事件（enest.ssh.onSshTransfer / enest.on('ssh.transfer')） */
export type SshTransferEvent = {
    sessionId: string;
    direction: 'upload' | 'download';
    path: string;
    transferred: number;
    /** 0 表示未知（预取大小失败） */
    total: number;
    done?: boolean;
    error?: string;
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

/** lan.share 状态（start/status/list 返回；files 不含宿主侧路径） */
export type LanShareStatus = {
    shareId: string;
    port: number;
    /** 6 位数字取件码 */
    code: string;
    files: Array<{
        id: string;
        name: string;
        size: number;
    }>;
    /** 本机内网 IPv4 列表（内网段优先），供展示与生成二维码 */
    ips: string[];
    startedAt: number;
    expiresAt: number;
    stopped?: boolean;
    stopReason?: string;
    activeConnections: number;
    downloads: number;
};

/** lan.request 下载请求日志事件（enest.net.share.onRequest） */
export type LanRequestEvent = {
    shareId: string;
    file: string;
    ip: string;
    ts: number;
};

/** lan.stopped 分享关停事件（enest.net.share.onStopped） */
export type LanStoppedEvent = {
    shareId: string;
    reason: string;
};

/** agent.apps 条目 */
export type AgentAppInfo = {
    app: string;
    name: string;
    configPaths: string[];
    installed: boolean;
    active: boolean;
};

/** agent.read 返回 */
export type AgentConfigSnapshot = {
    app: string;
    files: Array<{
        path: string;
        content: string;
        parsed: unknown;
        exists: boolean;
    }>;
    active: boolean;
    readAt: number;
};

/** agent.write 载荷：changes 为「文件内顶层键 → 新值」映射（最小侵入合并） */
export type AgentWriteInput = {
    app: string;
    changes: Record<string, unknown>;
    confirmed?: boolean;
};

/** agent.write 返回 */
export type AgentWriteResult = {
    ok: boolean;
    app: string;
    written: string[];
    backupId: string;
};

/** agent.backups 条目 */
export type AgentBackupInfo = {
    id: string;
    app: string;
    createdAt: number;
    files: string[];
};

/** agent.sessions.list 返回（每个会话根目录一条） */
export type AgentSessionsListResult = {
    app: string;
    root: string;
    files: AgentSessionFile[];
    truncated: boolean;
};

/** agent.sessions.read 返回 */
export type AgentSessionsReadResult = {
    app: string;
    file: string;
    path: string;
    bytes: number;
    readBytes: number;
    truncated: boolean;
    lines: AgentSessionLine[];
};

/** agent.listAssets 返回 */
export type AgentListAssetsResult = {
    app: string;
    root: string;
    path: string;
    entries: AgentAssetEntry[];
    truncated: boolean;
};

/** agent.writeAssets 载荷（宿主权限校验后落盘） */
export type AgentWriteAssetsInput = {
    app: string;
    assets: AgentAssetInput[];
    confirmed?: boolean;
};

/** agent.writeAssets 返回 */
export type AgentWriteAssetsResult = {
    ok: boolean;
    app: string;
    written: string[];
    /** 覆盖了已存在文件时的快照 id（未覆盖为 null） */
    backupId: string | null;
};

/** agent.deleteAssets 载荷 */
export type AgentDeleteAssetsInput = {
    app: string;
    paths: string[];
    confirmed?: boolean;
};

/** agent.deleteAssets 返回 */
export type AgentDeleteAssetsResult = {
    ok: boolean;
    app: string;
    deleted: string[];
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
    diagnostics: AppearanceDiagnostic[];
    /** Host-owned public font handles; no local paths or custom-font metadata. */
    resources?: {
        fonts: Array<{
            family: string;
            url: string;
        }>;
    };
}

export type DbWorkbenchRequest = {
    action: 'drivers.list';
    input?: Record<string, never>;
} | {
    action: 'browse';
    input: {
        sessionKey: string;
        table: TableRef;
        maxRows?: number;
        surface?: 'quick' | 'shell';
    };
} | {
    action: 'redis.scan';
    input: {
        sessionKey: string;
        cursor?: string;
        match?: string;
        count?: number;
    };
} | {
    action: 'table.page';
    input: DbTablePage & {
        sessionKey: string;
        surface?: 'quick' | 'shell';
    };
} | {
    action: 'table.design.preview';
    input: {
        sessionKey: string;
        design: DbTableDesign;
    };
} | {
    action: 'table.design.apply';
    input: {
        sessionKey: string;
        design: DbTableDesign;
        confirmed?: boolean;
    };
} | {
    action: 'execute';
    input: DbWorkbenchExecuteInput;
} | {
    action: 'cancel';
    input: {
        sessionKey: string;
        executionId?: string;
    };
} | {
    action: 'transaction';
    input: {
        sessionKey: string;
        operation: 'begin' | 'commit' | 'rollback';
    };
} | {
    action: 'inspect';
    input: {
        sessionKey: string;
        kind: DbInspectionKind;
    };
} | {
    action: 'compare';
    input: DbCompareInput;
} | {
    action: 'test';
    input: DbConnectionConfig;
};

// —— 事件（dsh:event 推送）——
export type DshWorkbenchEvent = {
    type: 'web-ready';
    port: number;
    readyUrl?: string;
} | {
    type: 'web-port';
    port: number;
    readyUrl?: string;
    retries: number;
} | {
    type: 'web-exit';
    code: number | null;
    lastError?: string;
} | {
    type: 'web-stderr';
    tail: string;
} | {
    type: 'sdk-exit';
    code: number | null;
    lastError?: string;
} | {
    type: 'sdk-notify';
    method: string;
    params: Record<string, unknown>;
} | {
    type: 'runtime-progress';
    phase: string;
    detail?: string;
    percent?: number;
};

// —— workbench action 契约（权限映射见 main/dsh/workbench.ts）——
export type DshWorkbenchRequest =
// dsh.connect（只读）
{
    action: 'runtime.detect';
    input?: Record<string, never>;
} | {
    action: 'runtime.status';
    input?: Record<string, never>;
} | {
    action: 'sessions.list';
    input?: {
        limit?: number;
    };
} | {
    action: 'sessions.read';
    input: {
        sessionId: string;
        maxEvents?: number;
    };
} | {
    action: 'settings.get';
    input?: Record<string, never>;
} | {
    action: 'profiles.list';
    input?: Record<string, never>;
} | {
    action: 'backup.list';
    input?: Record<string, never>;
} | {
    action: 'runtime.versions.list';
    input?: Record<string, never>;
} | {
    action: 'runtime.versions.available';
    input?: {
        limit?: number;
    };
} | {
    action: 'rpc.call';
    input: {
        method: 'session/wait' | 'session/working-directory/get';
        params: Record<string, unknown>;
    };
} | {
    action: 'logs.tail';
    input: {
        kind: 'web' | 'sdk';
        lines?: number;
    };
}
// dsh.chat（会话写）
 | {
    action: 'sdk.start';
    input?: DshSdkStartInput;
} | {
    action: 'sdk.stop';
    input?: Record<string, never>;
} | {
    action: 'rpc.write';
    input: {
        method: 'session/prompt' | 'session/working-directory/set';
        params: Record<string, unknown>;
    };
}
// dsh.admin（进程/profile/备份/热更新）
 | {
    action: 'web.start';
    input?: {
        profile?: string;
        port?: number;
    };
} | {
    action: 'web.stop';
    input?: Record<string, never>;
} | {
    action: 'web.restart';
    input?: {
        profile?: string;
        port?: number;
    };
} | {
    action: 'sdk.restart';
    input?: DshSdkStartInput;
} | {
    action: 'settings.update';
    input: Partial<DshWorkbenchSettings>;
}
/** 显式编辑读取包含 profile 密钥，不能降为 connect。 */
 | {
    action: 'profiles.read';
    input: {
        name: string;
    };
} | {
    action: 'profiles.create';
    input: {
        name: string;
        template: DshProfileTemplate;
    };
} | {
    action: 'profiles.update';
    input: DshProfileUpdateInput;
} | {
    action: 'profiles.sync';
    input: {
        source: string;
        target: string;
        scope?: 'environment' | 'configuration';
    };
} | {
    action: 'environment.reset';
    input: DshEnvironmentResetInput;
} | {
    action: 'profiles.delete';
    input: {
        name: string;
        backupFirst?: boolean;
    };
} | {
    action: 'profiles.backup';
    input: {
        name: string;
    };
} | {
    action: 'profiles.restore';
    input: {
        backupId: string;
    };
} | {
    action: 'backup.create';
    input?: {
        label?: string;
    };
} | {
    action: 'backup.restore';
    input: {
        backupId: string;
    };
} | {
    action: 'backup.delete';
    input: {
        backupId: string;
    };
} | {
    action: 'runtime.download';
    input: {
        version: string;
    };
} | {
    action: 'runtime.activate';
    input: {
        version: string;
        source?: 'data' | 'bundled' | 'system';
    };
} | {
    action: 'runtime.remove';
    input: {
        version: string;
    };
} | {
    action: 'upgrade.oneClick';
    input: {
        version: string;
    };
};

/** Persistent main-process focus timer. Durations are milliseconds in snapshots. */
export interface FocusTimerOptions {
    focusMin: number;
    breakMin: number;
    longBreakMin: number;
    longBreakEvery: number;
    autoStart: boolean;
    task: string;
    notify: boolean;
}

export interface FocusTimerSnapshot {
    state: FocusTimerState;
    records: FocusTimerRecord[];
}

export interface FocusTimerRecordPatch {
    task?: string;
    durationMs?: number;
    counted?: boolean;
    deleted?: boolean;
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

// —— workbench action 契约（权限映射见 main/middleware/workbench.ts）——
export type MwWorkbenchRequest =
// mw.connect
{
    action: 'kinds.list';
    input?: Record<string, never>;
} | {
    action: 'test';
    input: {
        config: MwConnectionConfig;
    };
} | {
    action: 'session.open';
    input: {
        sessionKey: string;
        config: MwConnectionConfig;
    };
} | {
    action: 'session.close';
    input: {
        sessionKey: string;
    };
} | {
    action: 'session.list';
    input?: Record<string, never>;
}
// mw.query
 | {
    action: 'overview';
    input: {
        sessionKey: string;
    };
} | {
    action: 'topics.list';
    input: {
        sessionKey: string;
        search?: string;
        includeInternal?: boolean;
    };
} | {
    action: 'topic.describe';
    input: {
        sessionKey: string;
        topic: string;
    };
} | {
    action: 'exchanges.list';
    input: {
        sessionKey: string;
        search?: string;
    };
} | {
    action: 'bindings.list';
    input: {
        sessionKey: string;
        source?: string;
        destination?: string;
    };
} | {
    action: 'groups.list';
    input: {
        sessionKey: string;
        search?: string;
    };
} | {
    action: 'group.describe';
    input: {
        sessionKey: string;
        groupId: string;
    };
} | {
    action: 'clients.list';
    input: {
        sessionKey: string;
        search?: string;
    };
} | {
    action: 'messages.query';
    input: MwMessageQueryInput & {
        sessionKey: string;
    };
} | {
    action: 'messages.get';
    input: {
        sessionKey: string;
        topic: string;
        messageId?: string;
        partition?: number;
        offset?: number;
    };
} | {
    action: 'tail.start';
    input: {
        sessionKey: string;
        tailId: string;
        topic: string;
        filter?: string;
    };
} | {
    action: 'tail.stop';
    input: {
        sessionKey: string;
        tailId: string;
    };
} | {
    action: 'configs.describe';
    input: {
        sessionKey: string;
        topic: string;
    };
} | {
    action: 'trace.message';
    input: {
        sessionKey: string;
        key: string;
    };
} | {
    action: 'retained.list';
    input: {
        sessionKey: string;
        search?: string;
    };
}
// mw.admin（连接级 readOnly 时宿主直接拒绝）
 | {
    action: 'topic.create';
    input: {
        sessionKey: string;
        topic: MwTopicCreateInput;
    };
} | {
    action: 'topic.update';
    input: {
        sessionKey: string;
        name: string;
        attrs: Partial<MwTopicCreateInput>;
    };
} | {
    action: 'topic.delete';
    input: {
        sessionKey: string;
        name: string;
    };
} | {
    action: 'topic.purge';
    input: {
        sessionKey: string;
        name: string;
    };
} | {
    action: 'partitions.grow';
    input: {
        sessionKey: string;
        topic: string;
        count: number;
    };
} | {
    action: 'exchange.create';
    input: {
        sessionKey: string;
        exchange: {
            name: string;
            type: string;
            durable?: boolean;
            autoDelete?: boolean;
            arguments?: Record<string, unknown>;
        };
    };
} | {
    action: 'exchange.delete';
    input: {
        sessionKey: string;
        name: string;
    };
} | {
    action: 'binding.create';
    input: {
        sessionKey: string;
        binding: MwBindingCreateInput;
    };
} | {
    action: 'binding.delete';
    input: {
        sessionKey: string;
        source: string;
        destination: string;
        propertiesKey: string;
    };
} | {
    action: 'group.resetOffsets';
    input: {
        sessionKey: string;
    } & MwGroupResetInput;
} | {
    action: 'client.kick';
    input: {
        sessionKey: string;
        clientId: string;
    };
} | {
    action: 'messages.send';
    input: MwMessageSendInput & {
        sessionKey: string;
    };
} | {
    action: 'messages.resend';
    input: {
        sessionKey: string;
        message: MwMessage;
        targetTopic?: string;
    };
} | {
    action: 'configs.alter';
    input: {
        sessionKey: string;
        topic: string;
        configs: Record<string, string>;
    };
} | {
    action: 'retained.delete';
    input: {
        sessionKey: string;
        topic: string;
    };
};

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

export interface PluginBlob {
    id: string;
    bytes: number;
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

export interface ClipboardQuery {
    query?: string;
    type?: 'text' | 'image' | 'files';
    pinned?: boolean;
    cursor?: number;
    limit?: number;
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
}

/** 剪贴板历史条目（list 不含完整二进制；get 返回完整字段） */
export interface ClipboardHistoryEntry {
    id: string;
    type: 'text' | 'image' | 'files';
    files?: ClipboardFile[];
    sourceApp?: ClipboardSourceApp;
    /** 文本截断或图片尺寸摘要，用于列表展示 */
    preview: string;
    text?: string;
    hasImage?: boolean;
    width?: number;
    height?: number;
    ts: number;
    pinned: boolean;
    bytes?: number;
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

/** SSH / Database 插件宿主 API 共享类型（Spec docs/compose/spec/ssh-db-plugins.md） */
// —— Vault ——
export interface VaultSetResult {
    secretRef: string;
}

/** ssh.connect 入参：密钥走 secretRef / ephemeralSecret / password（一次性） */
export interface SshConnectInput {
    profileId?: string;
    host: string;
    port?: number;
    username: string;
    authType?: SshAuthType;
    secretRef?: string;
    ephemeralSecret?: string;
    /** 插件 UI 一次性口令别名，等价 ephemeralSecret */
    password?: string;
    privateKeyHandleId?: string;
    jump?: SshJumpConfig | null;
    /** Explicit proxy; omitted means direct TCP, independent of shell HTTP proxy. */
    proxy?: SshProxyConfig;
    /** Ordered jump chain, from the local-facing bastion to the target. Max 8. */
    jumps?: SshJumpConfig[];
    keepAliveSec?: number;
    timeoutMs?: number;
    cols?: number;
    rows?: number;
    term?: string;
    env?: string;
}

export interface SshSessionInfo {
    sessionId: string;
    profileId?: string;
    host: string;
    port?: number;
    username?: string;
    status?: string;
    connectedAt?: number;
    fingerprint?: string;
    serverIdent?: string;
    cols?: number;
    rows?: number;
}

export interface SshExecInput extends Partial<SshConnectInput> {
    sessionId?: string;
    command?: string;
    cmd?: string;
    timeoutMs?: number;
}

export interface SshExecResult {
    stdout: string;
    stderr: string;
    exitCode: number | null;
    durationMs: number;
}

export interface SshMetricsSample {
    ts: number;
    cpuPercent?: number;
    memUsed?: number;
    memTotal?: number;
    memPercent?: number;
    load1?: number;
    disks?: Array<{
        mount: string;
        usedPercent: number;
        used?: number;
        total?: number;
    }>;
    net?: Array<{
        iface: string;
        rxKbps: number;
        txKbps: number;
    }>;
    uptimeSec?: number;
    topProcesses?: Array<{
        pid: number;
        cpuPercent?: number;
        memPercent?: number;
        command: string;
    }>;
    error?: string;
}

export interface SshCompletionResult {
    items: SshCompletionItem[];
    danger?: string | null;
    word?: string;
}

export interface SftpListInput {
    sessionId?: string;
    path?: string;
    host?: string;
    port?: number;
    username?: string;
    authType?: SshAuthType;
    secretRef?: string;
    ephemeralSecret?: string;
    privateKeyHandleId?: string;
}

export interface SftpEntry {
    name: string;
    type: 'file' | 'dir' | 'other';
    size: number;
    mtime: number;
}

export interface SftpDownloadInput extends SftpListInput {
    remotePath?: string;
    localDirectoryHandleId: string;
}

export interface SftpUploadInput extends SftpListInput {
    localHandleId: string;
    remotePath?: string;
}

export interface SftpTransferResult {
    ok: boolean;
    path?: string;
    remotePath?: string;
    localPath?: string;
    size?: number;
    bytes?: number;
    message?: string;
    error?: string;
}

export interface DbConnectionConfig {
    driver: DbDriverId;
    host?: string;
    port?: number;
    database?: string;
    username?: string;
    secretRef?: string;
    ephemeralSecret?: string;
    connectionId?: string;
    env?: string;
    readOnly?: boolean;
    /** sqlite / 用户文件库（不是壳子 enest.db） */
    fileHandleId?: string;
    createIfMissing?: boolean;
    /** influxdb */
    org?: string;
    bucket?: string;
    /** 通用选项 */
    options?: {
        readOnly?: boolean;
        requireConfirm?: boolean;
        charset?: string;
        ssl?: boolean;
        schema?: string;
        env?: string;
        createIfMissing?: boolean;
        file?: string;
        org?: string;
        bucket?: string;
        [key: string]: unknown;
    };
}

export interface DbTestResult {
    ok: boolean;
    message: string;
    version?: string;
    latencyMs?: number;
}

export interface DbSessionInfo {
    sessionKey: string;
    driver: DbDriverId;
    host?: string;
    database?: string;
    filePath?: string;
    readOnly?: boolean;
    openedAt: number;
    connectionId?: string;
    transactionActive?: boolean;
}

export interface DbExecuteInput {
    executionId?: string;
    surface?: 'quick' | 'shell';
    sessionKey: string;
    sql: string;
    maxRows?: number;
    timeoutMs?: number;
    /** prod / 保护连接写操作确认（Spec DB-B5） */
    confirmed?: boolean;
    params?: unknown[] | Record<string, unknown>;
}

export interface BatchResult {
    ok: boolean;
    results: BatchResultItem[];
    durationMs: number;
}

export interface DbApplyChangesInput {
    sessionKey: string;
    changes: RowChange[];
    mode?: 'stop-on-error' | 'continue';
    confirmed?: boolean;
}

export interface QueryResult {
    editable?: boolean;
    transactionActive?: boolean;
    executionId?: string;
    results?: QueryResult[];
    format?: 'table' | 'document' | 'key-value';
    columns: QueryResultColumn[];
    rows: unknown[][];
    rowCount: number;
    affectedRows?: number;
    durationMs: number;
    truncated?: boolean;
    messages?: string[];
    warnings?: string[];
    rowIdentity?: {
        keyColumns: string[];
        keys: unknown[][];
    };
    sql?: string;
    error?: string;
}

export interface DbSchemaTreeInput {
    sessionKey: string;
    parent?: string;
    database?: string;
    schema?: string;
    table?: string;
    filter?: string;
    node?: {
        type?: string;
        database?: string;
        schema?: string;
        table?: string;
    };
}

export interface SchemaObject {
    name: string;
    type: 'database' | 'schema' | 'table' | 'view' | 'measurement' | 'supertable' | 'collection' | 'key' | 'column' | 'other';
    database?: string;
    schema?: string;
    comment?: string;
    children?: SchemaObject[];
    column?: DbColumnMeta;
}

export interface TableDetail {
    metadata?: Record<string, unknown>;
    name?: string;
    table?: string;
    schema?: string;
    database?: string;
    columns: DbColumnMeta[];
    primaryKey?: string[];
    indexes?: Array<{
        name: string;
        columns: string[];
        unique?: boolean;
    }>;
    foreignKeys?: Array<{
        name: string;
        columns: string[];
        referencedTable: string;
        referencedSchema?: string;
        referencedColumns: string[];
    }>;
    comment?: string;
    ddl?: string;
}

export interface CompletionResponse {
    replace: {
        from: number;
        to: number;
    };
    items: CompletionItem[];
    isIncomplete?: boolean;
}

export interface DbCompletionInput {
    sessionKey: string;
    sql: string;
    cursor?: number;
    database?: string;
    schema?: string;
    usageBoost?: Record<string, number>;
}

export interface DbDialectInfo {
    id: DbDriverId | string;
    label: string;
    dialect: DbDialect;
    defaultPort?: number;
    keywords?: string[];
    keywordsSample?: string[];
    functions?: Array<{
        name: string;
        signature?: string;
        doc?: string;
        kind?: string;
    }>;
    snippets?: Array<{
        prefix?: string;
        body?: string;
        detail?: string;
        name?: string;
        label?: string;
        sql?: string;
        text?: string;
    }>;
    [key: string]: unknown;
}

export interface DbImportPreviewInput {
    sessionKey: string;
    table: TableRef;
    csvText?: string;
    /** Host-selected file capability, valid only in the current runtime. */
    fileHandleId?: string;
    options?: {
        delimiter?: string;
        hasHeader?: boolean;
        columns?: string[];
        sampleRows?: number;
    };
}

export interface DbImportPreviewResult {
    columns: string[];
    sampleRows: string[][];
    totalRowsEstimate: number;
    mappedColumns: Array<{
        source: string;
        target: string;
    }>;
    sqlPreview: string[];
}

export interface DbImportRunInput {
    sessionKey: string;
    table: TableRef;
    csvText?: string;
    /** Host-selected file capability, valid only in the current runtime. */
    fileHandleId?: string;
    options?: {
        delimiter?: string;
        hasHeader?: boolean;
        columns?: string[];
        conflict?: 'insert' | 'upsert' | 'skip';
        sampleRows?: number;
    };
    /** prod / 保护连接写入确认 */
    confirmed?: boolean;
}

export interface DbImportRunResult {
    ok: boolean;
    inserted: number;
    failed: number;
    errors?: string[];
    durationMs: number;
}

export interface SshWorkbenchRequest {
    action: string;
    sessionId?: string;
    sourceSessionId?: string;
    path?: string;
    paths?: string[];
    destination?: string;
    content?: string;
    expectedMtime?: number;
    pid?: number;
    startTime?: string;
    signal?: 'TERM' | 'KILL';
    name?: string;
    operation?: string;
    confirmed?: boolean;
    entries?: Array<{
        path: string;
        name: string;
    }>;
    id?: string;
    localPort?: number;
    remoteHost?: string;
    remotePort?: number;
    direction?: 'local' | 'remote';
    overwrite?: boolean;
    localHandleId?: string;
    expectedHash?: string;
    answers?: string[];
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

export interface QuickThemeSnapshot {
    version: 1;
    revision: number;
    query: string;
    filter: QuickCommandKind | null;
    searching: boolean;
    loading: boolean;
    busy: boolean;
    error: string | null;
    items: QuickThemeItem[];
    selectedId: string | null;
    expanded: boolean;
    hiddenCount: number;
    emptyMarket: boolean;
    plugin: {
        title: string;
        loading: boolean;
        placeholder: string;
    } | null;
    appearance: QuickThemeAppearance;
    bounds: {
        width: number;
        height: number;
        inputHeight: number;
    };
}

export type QuickThemeAction = {
    type: 'query';
    query: string;
} | {
    type: 'filter';
    kind: QuickCommandKind | null;
} | {
    type: 'select';
    id: string;
} | {
    type: 'open';
    id: string;
    container?: 'quick' | 'shell';
} | {
    type: 'expand';
    expanded: boolean;
} | {
    type: 'open-market' | 'hide' | 'plugin-back' | 'plugin-pin' | 'plugin-focus';
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
}

// —— 插件生命周期（对标 uTools onPluginEnter / onPluginOut）——
/** openPlugin 可选进入载荷：code 对应 feature 指令，payload 为任意透传数据 */
export interface PluginEnterPayload {
    code?: string;
    type?: 'text' | 'regex' | 'over';
    payload?: unknown;
}

/** 关闭原因：用户关 Tab / 卸载插件 / 应用退出 */
export type PluginCloseReason = 'tab-close' | 'uninstall' | 'app-quit';

/** agent.sessions.list 条目文件 */
export type AgentSessionFile = {
    file: string;
    path: string;
    bytes: number;
    modifiedAt: number;
    project?: string;
};

/** agent.sessions.read 单行（json 解析失败为 null） */
export type AgentSessionLine = {
    n: number;
    json: unknown;
    raw: string;
    truncated: boolean;
};

/** agent.listAssets 条目 */
export type AgentAssetEntry = {
    name: string;
    isDir: boolean;
    size: number;
    modifiedAt: number;
};

/** agent.writeAssets 单文件载荷（contentText / contentBase64 二选一） */
export type AgentAssetInput = {
    path: string;
    contentText?: string;
    contentBase64?: string;
};

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

export interface DbTablePage {
    table: TableRef;
    offset?: number;
    limit?: number;
    columns?: string[];
    filters?: DbTableFilter[];
    order?: Array<{
        column: string;
        direction: 'asc' | 'desc';
    }>;
}

export type DbTableDesign = {
    operation: 'create-table';
    table: TableRef;
    columns: DbDesignColumn[];
    primaryKey?: string[];
    foreignKeys?: DbDesignForeignKey[];
} | {
    operation: 'add-column';
    table: TableRef;
    column: DbDesignColumn;
} | {
    operation: 'rename-column';
    table: TableRef;
    column: string;
    newName: string;
} | {
    operation: 'drop-column';
    table: TableRef;
    column: string;
} | {
    operation: 'create-index';
    table: TableRef;
    name: string;
    columns: string[];
    unique?: boolean;
} | {
    operation: 'drop-index';
    table: TableRef;
    name: string;
};

export interface DbWorkbenchExecuteInput extends DbExecuteInput {
    executionId?: string;
    /** Quick rejects writes and limits returned rows to 200. */
    surface?: 'quick' | 'shell';
}

export type DbInspectionKind = 'client' | 'sessions' | 'resources' | 'locks' | 'queries' | 'jobs';

export interface DbCompareInput {
    left: {
        sessionKey: string;
        sql: string;
    };
    right: {
        sessionKey: string;
        sql: string;
    };
    keyColumns: string[];
    /** Key names refer to left columns. Explicit mappings define the compared projection. */
    columnMappings?: Array<{
        left: string;
        right: string;
        rule?: DbCompareValueRule;
    }>;
    defaultRule?: DbCompareValueRule;
    maxRows?: number;
}

export interface TableRef {
    database?: string;
    schema?: string;
    table: string;
}

// —— SDK JSON-RPC（stdio 换行协议；方法集见 @deepseek-ai/dsh-sdk-protocol）——
export interface DshSdkStartInput {
    /** 未指定时使用持久化设置选定的 SDK profile。 */
    profile?: string;
    /** 记录在 SDK 会话头的工作目录；未指定时使用隔离 DSH_HOME。 */
    cwd?: string;
    /** 模型路由（provider + model；需先在完全体 Settings→Models 配置凭据） */
    provider?: string;
    model?: string;
    reasoningEffort?: string;
    maxTokens?: number;
}

// —— profile 管理 ——
export type DshProfileTemplate = 'web' | 'headless' | 'sdk' | 'sdk-minimal' | 'acp';

/** 宿主拥有的启动选择，不是 DSH 全局环境变量或原生 profile 字段。 */
export interface DshWorkbenchSettings {
    webProfile: string;
    sdkProfile: string;
    webPortPolicy: 'auto' | 'fixed';
    /** 固定策略下使用；自动策略仍保留上次配置值。 */
    webPort: number;
}

export interface DshProfileUpdateInput {
    name: string;
    bundles: string[];
    patch: string;
    environment: Record<string, string>;
}

export interface DshEnvironmentResetInput {
    /** 默认 config 保留所有会话/存储；home 明确清空隔离 home（含会话）。 */
    scope: 'config' | 'home';
    backup: true;
    /** 必须与 scope 精确匹配，不接受布尔式确认。 */
    confirmation: 'RESET CONFIG' | 'RESET HOME';
}

export interface FocusTimerState {
    status: 'idle' | 'running' | 'paused';
    phase: FocusTimerPhase;
    remainingMs: number;
    deadline: number | null;
    startedAt: number | null;
    cycle: number;
    options: FocusTimerOptions;
}

export interface FocusTimerRecord {
    id: string;
    phase: FocusTimerPhase;
    task: string;
    startedAt: number;
    endedAt: number;
    durationMs: number;
    outcome: 'completed' | 'skipped' | 'stopped';
    counted: boolean;
}

export interface HomePageContribution {
    id: string;
    source: string;
    version: number;
    /** Package-relative HTML entry. No remote URLs or traversal. */
    entry: string;
    variants: string[];
}

export interface MwConnectionConfig {
    kind: MwKind;
    name?: string;
    env?: 'dev' | 'test' | 'staging' | 'prod';
    /** 连接级只读：宿主侧拦截全部变更类 action */
    readOnly?: boolean;
    note?: string;
    /** 凭据：vault 引用（主进程解析为 ephemeralSecret 后传入 UtilityProcess） */
    secretRef?: string;
    ephemeralSecret?: string;
    // —— kafka ——
    bootstrapServers?: string;
    saslMechanism?: 'none' | 'plain' | 'scram-sha-256' | 'scram-sha-512' | 'oauthbearer';
    tls?: boolean;
    tlsRejectUnauthorized?: boolean;
    // —— rabbitmq ——
    managementUrl?: string;
    vhost?: string;
    username?: string;
    // —— mqtt ——
    brokerUrl?: string;
    clientId?: string;
    emqx?: MwEmqxMgmt;
    // —— rocketmq ——
    dashboardUrl?: string;
    /** 透传扩展（如 kafka clientId、mqtt keepalive 等） */
    options?: Record<string, unknown>;
}

/** 统一消息信封：四类中间件的浏览/重发/监听共用 */
export interface MwMessage {
    messageId?: string;
    topic: string;
    /** kafka 分区；rocketmq 队列号；rmq/mqtt 无 */
    partition?: number;
    offset?: number;
    timestamp: number;
    key?: string;
    payload: string;
    payloadEncoding?: 'utf8' | 'base64';
    payloadType?: 'json' | 'text' | 'binary';
    headers?: Record<string, string>;
    properties?: Record<string, string>;
    redelivered?: boolean;
    payloadBytes?: number;
    /** 各家特有字段（rocketmq 重试次数/出生地、rmq routing_key、mqtt retain/qos…） */
    extras?: Record<string, string | number | boolean>;
}

// —— 各 action 的输入类型 ——
export interface MwTopicCreateInput {
    name: string;
    partitions?: number;
    replicationFactor?: number;
    configs?: Record<string, string>;
    durable?: boolean;
    autoDelete?: boolean;
    /** rmq exchange type（direct/topic/fanout/headers）或 rocketmq 类型（NORMAL/FIFO/DELAY/TRANSACTION） */
    type?: string;
    /** rocketmq 队列数 */
    queueNum?: number;
    arguments?: Record<string, unknown>;
}

export interface MwMessageQueryInput {
    topic: string;
    partition?: number;
    from: 'earliest' | 'latest' | 'offset' | 'timestamp' | 'key' | 'id';
    key?: string;
    messageId?: string;
    offset?: number;
    timestamp?: number;
    max?: number;
    keyContains?: string;
    /** quick 模式强制上限 200 */
    surface?: 'quick' | 'shell';
}

export interface MwMessageSendInput {
    topic: string;
    payload: string;
    payloadEncoding?: 'utf8' | 'base64';
    key?: string;
    partition?: number;
    headers?: Record<string, string>;
    /** rmq 发布走交换机时 topic 填 exchange，此字段为 routing key */
    routingKey?: string;
    properties?: Record<string, string>;
    qos?: 0 | 1 | 2;
    retain?: boolean;
}

export interface MwGroupResetInput {
    groupId: string;
    topic: string;
    partition?: number;
    to: 'earliest' | 'latest' | 'timestamp' | 'offset';
    timestamp?: number;
    offset?: number;
}

export interface MwBindingCreateInput {
    source: string;
    destination: string;
    /** destinationType 仅 rmq 生效 */
    destinationType?: 'queue' | 'exchange';
    routingKey?: string;
    arguments?: Record<string, unknown>;
}

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

export interface ClipboardSourceApp {
    name: string;
    id?: string;
    evidence: 'owner';
}

export interface ClipboardFile {
    name: string;
    path: string;
    exists?: boolean;
    directory?: boolean;
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

// —— SSH ——
export type SshAuthType = 'password' | 'key' | 'agent' | 'keyboard-interactive';

/** Per-connection TCP transport. Only the first SSH hop uses this proxy. */
export interface SshProxyConfig {
    type: 'http-connect' | 'socks5';
    host: string;
    port: number;
    username?: string;
    /** Proxy password is kept in the requesting plugin's vault. */
    secretRef?: string;
    /** One-off test credential, never saved with the profile. */
    ephemeralSecret?: string;
}

export interface SshJumpConfig {
    host: string;
    port?: number;
    username: string;
    authType?: SshAuthType;
    privateKeyHandleId?: string;
    secretRef?: string;
    ephemeralSecret?: string;
}

export interface SshCompletionItem {
    label: string;
    kind: SshCompletionKind;
    detail?: string;
    insertText: string;
    sortText: string;
    /** 危险命令说明；true/字符串均可能 */
    dangerous?: boolean | string | null;
}

// —— Database ——
export type DbDriverId = 'mysql' | 'mariadb' | 'postgres' | 'sqlite' | 'influxdb' | 'influxdb1' | 'influxdb3' | 'timescale' | 'tdengine' | 'mongodb' | 'redis' | 'clickhouse' | 'mssql' | 'duckdb' | 'oracle' | 'cassandra' | 'scylladb' | 'neo4j' | 'elasticsearch' | 'opensearch' | 'tidb' | 'oceanbase' | 'cockroachdb' | 'yugabytedb' | 'questdb' | 'doris' | 'starrocks';

export interface BatchResultItem {
    index: number;
    ok: boolean;
    affected?: number;
    error?: string;
    sql?: string;
}

export type RowChange = {
    type: 'update';
    table: TableRef;
    key: Record<string, unknown>;
    set: Record<string, unknown>;
    original?: Record<string, unknown>;
} | {
    type: 'insert';
    table: TableRef;
    values: Record<string, unknown>;
} | {
    type: 'delete';
    table: TableRef;
    key: Record<string, unknown>;
};

export interface QueryResultColumn {
    name: string;
    dataType?: string;
    nullable?: boolean;
    primaryKey?: boolean;
}

export interface DbColumnMeta {
    name: string;
    type?: string;
    dataType?: string;
    nullable?: boolean;
    default?: unknown;
    defaultValue?: unknown;
    key?: string;
    primaryKey?: boolean;
    comment?: string;
    pk?: boolean;
}

export interface CompletionItem {
    label: string;
    kind: CompletionItemKind;
    detail?: string;
    doc?: string;
    insertText: string;
    sortText: string;
    filterText?: string;
    owner?: string;
    /** 前缀/子序列匹配的区间（label 内 0-based，字符下标数组），供前端高亮 */
    matchRanges?: number[];
}

export type DbDialect = 'mysql' | 'sqlite' | 'postgres' | 'influxql' | 'tdengine' | string;

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
export type PluginPermission = 'backend.node' | 'clipboard.read' | 'clipboard.write' | 'clipboard.readImage' | 'clipboard.writeImage' | 'clipboard.history' | 'clipboard.paste' | 'timer.background' | 'screen.capture' | 'screen.record' | 'pin.create' | 'net.fetch' | 'shell.openExternal' | 'storage.local' | 'notify' | 'ui.setTitle' | 'ui.setIcon' | 'ui.setBadge' | 'ui.resize' | 'ui.toast' | 'settings.register' | 'settings.page' | 'hotkey' | 'contribute' | 'vault.write' | 'ssh.session' | 'ssh.exec' | 'ssh.sftp' | 'db.connect' | 'db.query' | 'db.schema' | 'mw.connect' | 'mw.query' | 'mw.admin' | 'dsh.connect' | 'dsh.chat' | 'dsh.admin' | 'net.socket' | 'lan.share' | 'fs.rename' | 'fs.read' | 'fs.write' | 'sys.control' | 'ssh.agent' | 'config.agent.read' | 'config.agent.write' | 'sys.inspect' | 'theme';

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

/** Opaque handles expire whenever the current result set changes. No launch paths or payloads. */
export interface QuickThemeItem {
    id: string;
    kind: QuickCommandKind;
    title: string;
    subtitle: string;
    group: string;
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

/** Tab 呈现方式：classic 顶栏条 / orb 左侧悬浮圆形轨道 */
export type TabStyle = 'classic' | 'orb';

export type ThemeBackgroundKind = 'none' | 'gradient' | 'color' | 'image' | 'video';

export type ThemeBackgroundPalette = 'theme' | 'dawn' | 'mint' | 'linen' | 'peach' | 'ocean' | 'forest' | 'ink';

export interface DbTableFilter {
    column: string;
    operator: 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'contains' | 'in' | 'is-null' | 'not-null';
    value?: DbScalar | DbScalar[];
}

export interface DbDesignColumn {
    name: string;
    type: 'integer' | 'bigint' | 'decimal' | 'float' | 'varchar' | 'text' | 'boolean' | 'date' | 'timestamp' | 'json' | 'uuid' | 'binary';
    length?: number;
    precision?: number;
    scale?: number;
    nullable?: boolean;
    autoIncrement?: boolean;
    default?: {
        kind: 'literal';
        value: DbScalar;
    } | {
        kind: 'expression';
        value: 'CURRENT_TIMESTAMP' | 'CURRENT_DATE' | 'CURRENT_TIME';
    };
}

export interface DbDesignForeignKey {
    name?: string;
    columns: string[];
    references: TableRef;
    referencedColumns: string[];
    onDelete?: 'NO ACTION' | 'RESTRICT' | 'CASCADE' | 'SET NULL';
}

export type DbCompareValueRule = 'strict' | 'text' | 'numeric' | 'json';

export type FocusTimerPhase = 'focus' | 'break' | 'longBreak';

/** 中间件控制台（mw.*）工作台类型：连接配置、能力描述符、统一消息模型与 workbench action 契约。
 * 与 db-workbench.ts 同构：action 判别联合 + 每插件 UtilityProcess 内执行。 */
export type MwKind = 'kafka' | 'rabbitmq' | 'mqtt' | 'rocketmq';

/** EMQX 管理面适配（mqtt 连接的可选增强） */
export interface MwEmqxMgmt {
    enabled: boolean;
    /** auto = 先探 v5(18083 /api/v5) 再探 v4(8081 /api/v4) */
    version: 'auto' | 'v4' | 'v5';
    apiUrl?: string;
    apiKey?: string;
    apiSecretRef?: string;
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

export type SshCompletionKind = 'cmd' | 'flag' | 'path' | 'history' | 'snippet';

export type CompletionItemKind = 'keyword' | 'table' | 'view' | 'column' | 'function' | 'database' | 'schema' | 'snippet' | 'alias' | 'measurement';

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

export type DbScalar = string | number | boolean | null;

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

/** Options a theme can expose for the classic top tab strip. */
export type ThemeTabStripKey = 'tabOpacity' | 'tabAutoHide';

declare global { interface Window { enest: EnestPluginApi; /** @deprecated Use enest. */ zapi: EnestPluginApi; /** Dedicated workspace surfaces only. */ enestWorkspace?: EnestWorkspaceApi; /** Compatibility alias for enestWorkspace. */ enestHome?: EnestHomeApi; /** Isolated Quick theme pages only. */ enestQuick?: EnestQuickApi } }
export {}
```
