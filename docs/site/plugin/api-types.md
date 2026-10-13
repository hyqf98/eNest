# TypeScript 类型定义

!> **本文件由 `scripts/generate-api-types.mjs` 生成，勿手改。**
> 上游源：`src/preload/pluginPreload.ts`（`EnestPluginApi` 及其本地类型）+ `src/shared/types/plugin.ts` / `src/shared/types/ssh-db.ts`（共享类型）。
> 生成时间：**2026-10-13 05:36:15 UTC** · 重新生成：`node scripts/generate-api-types.mjs`
>
> 推荐直接安装 [`@enest/plugin-sdk`](../../../packages/plugin-sdk/README.md)（含本 d.ts + manifest 校验 CLI）；
> 也可将下方声明保存为项目内 `enest-api.d.ts`，经 `/// <reference path="./enest-api.d.ts" />` 引入。

在 TypeScript 插件工程中引用下列类型描述 `window.enest` / `window.zapi`，避免手写 `any`。

## 类型声明（enest-api.d.ts）

```ts
/**
 * eNest 插件运行时 API 类型 —— 自动生成，勿手改。
 * 由 scripts/generate-api-types.mjs 从 src/preload/pluginPreload.ts 提取。
 * 生成时间：2026-10-13 05:36:15 UTC
 * 重新生成：node scripts/generate-api-types.mjs
 */

// 主接口：与壳子 preload 实际注入的 window.enest 严格一致
export interface EnestPluginApi {
    setTitle(title: string): Promise<boolean>;
    setIcon(icon: string): Promise<boolean>;
    setBadge(badge: string | number): Promise<boolean>;
    resize(size: {
        width?: number;
        height?: number;
    }): Promise<boolean>;
    /** UI 命名空间：与 PLUGIN_SPEC 的 enest.ui.* 对齐 */
    ui: {
        setTitle(title: string): Promise<boolean>;
        setIcon(icon: string): Promise<boolean>;
        setBadge(badge: string | number): Promise<boolean>;
        /** 内容区尺寸建议（CSS px）；Quick 即时调整，主窗仅记录并保持用户窗口尺寸。需 ui.resize 权限。 */
        resize(size: {
            width?: number;
            height?: number;
        }): Promise<boolean>;
        /**
         * 期望内容高度（px）：Quick 内嵌容器据此调小窗高度；主窗 Tab 场景仅记录。
         * 需 ui.resize 权限。
         */
        setHeight(height: number): Promise<boolean>;
        /** 由壳子 Toast 统一渲染的轻提示；与 notify（系统通知）分工 */
        toast(payload: {
            message: string;
            type?: PluginToastType;
        }): Promise<boolean>;
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
        /**
         * 注册主题包到壳子设置 → 主题 下拉列表。
         * ThemePack: { id, name, mode, tokens, source?, background? }
         */
        register(pack: {
            id: string;
            name: string;
            mode?: 'light' | 'dark' | 'system';
            tokens: Record<string, string>;
            source?: string;
            background?: {
                type: 'none' | 'color' | 'image' | 'video';
                value: string;
                opacity?: number;
                fit?: 'cover' | 'contain';
            };
        }): Promise<unknown>;
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
     * 需 manifest permissions 声明 'contribute'。
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
            }>;
        }): Promise<boolean>;
        get(key: string): Promise<unknown>;
        set(key: string, value: unknown): Promise<boolean>;
    };
    storage: {
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
        readText(): Promise<string>;
        writeText(text: string): Promise<boolean>;
        readImage(): Promise<{
            dataUrl: string;
            width: number;
            height: number;
        } | null>;
        writeImage(dataUrl: string): Promise<boolean>;
        history: {
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
        fetch(req: {
            url: string;
            method?: 'GET' | 'POST';
            headers?: Record<string, string>;
            body?: string;
            timeoutMs?: number;
        }): Promise<{
            status: number;
            headers: Record<string, string>;
            body: string;
        }>;
    };
    shell: {
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
    /** 密钥保险库：set→secretRef；无明文 get。需 vault.write */
    vault: {
        set(key: string, secret: string): Promise<VaultSetResult>;
        has(keyOrRef: string): Promise<boolean>;
        remove(keyOrRef: string): Promise<boolean>;
    };
    /** SSH 运行时：session / exec / metrics / completion / sftp */
    ssh: {
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
        pickLocalFile(opts?: {
            properties?: Array<'openFile' | 'openDirectory'>;
            /** 插件兼容别名：file / dir|directory|folder */
            mode?: 'file' | 'dir' | 'directory' | 'folder';
        }): Promise<string | null>;
    };
    /** 数据库运行时：驱动会话 / 查询 / 补全 / schema / applyChanges / 导入 */
    db: {
        test(config: DbConnectionConfig): Promise<DbTestResult>;
        open(input: {
            config: DbConnectionConfig;
            sessionKey?: string;
        } | DbConnectionConfig): Promise<DbSessionInfo>;
        close(sessionKey: string): Promise<boolean>;
        listSessions(): Promise<DbSessionInfo[]>;
        pickSqliteFile(): Promise<string | null>;
        pickImportFile(): Promise<string | null>;
        execute(input: DbExecuteInput): Promise<QueryResult>;
        explain(input: {
            sessionKey: string;
            sql: string;
        }): Promise<QueryResult>;
        cancel(sessionKey: string | {
            sessionKey?: string;
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
    on(event: string, cb: Listener): void;
    off(event: string, cb: Listener): void;
    // —— 生命周期（对标 uTools onPluginEnter / onPluginOut）——
    /** 进入插件：首次加载完成后 + 每次 Tab 激活；与 onOut 成对，可 pause/resume */
    onEnter(cb: (event: PluginEnterEvent) => void): Unsubscribe;
    /** 退到后台：其它 Tab 成为 active；isKill 恒 false */
    onOut(cb: (event: PluginOutEvent) => void): Unsubscribe;
    /** 即将销毁：可在此 flush 草稿；回调返回 Promise 时 preload 等其 settle 再 ack */
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

// —— Listener（src/preload/pluginPreload.ts）——

export type Listener = (data: unknown) => void;

// —— PluginToastType（src/preload/pluginPreload.ts）——

/** Toast 类型：info 默认，success/warn/error 带强调色 */
export type PluginToastType = 'info' | 'success' | 'warn' | 'error';

// —— PluginEnterEvent（src/preload/pluginPreload.ts）——

/** enter 事件载荷；mode = 本次进入的启动方式（quick 小窗 / shell 主窗） */
export type PluginEnterEvent = PluginEnterPayload & {
    tabId: string;
    mode: PluginLaunchMode;
};

// —— PluginOutEvent（src/preload/pluginPreload.ts）——

/** out 事件载荷；isKill 恒为 false（杀死走 beforeClose/destroy） */
export type PluginOutEvent = {
    isKill: false;
};

// —— PluginBeforeCloseEvent（src/preload/pluginPreload.ts）——

/** beforeClose 事件载荷 */
export type PluginBeforeCloseEvent = {
    reason: PluginCloseReason;
};

// —— PluginThemeTokens（src/preload/pluginPreload.ts）——

/** 主题变量集合（壳子解析后的 CSS 自定义属性值） */
export type PluginThemeTokens = Record<string, string>;

// —— PluginThemeChangeEvent（src/preload/pluginPreload.ts）——

/** 主题变更事件（enest.ui.onThemeChange） */
export type PluginThemeChangeEvent = {
    mode: 'light' | 'dark';
    tokens: PluginThemeTokens;
};

// —— PluginHotkeyEvent（src/preload/pluginPreload.ts）——

/** 热键触发事件（enest.hotkey.register 的回调 / enest.on('hotkey')） */
export type PluginHotkeyEvent = {
    accelerator: string;
};

// —— PluginLocaleChangeEvent（src/preload/pluginPreload.ts）——

/** 语言变更事件（enest.i18n.onLocaleChange） */
export type PluginLocaleChangeEvent = {
    locale: AppLocale;
};

// —— PluginQuickQueryEvent（src/preload/pluginPreload.ts）——

/** Quick 搜索查询事件（enest.contribute.onQuickQuery） */
export type PluginQuickQueryEvent = {
    reqId: string;
    query: string;
};

// —— PluginQuickQueryItem（src/preload/pluginPreload.ts）——

/** Quick provider 回传项（enest.contribute.respondQuickQuery 的 items 元素） */
export type PluginQuickQueryItem = {
    id?: string;
    title?: string;
    subtitle?: string;
    explain?: string;
    code?: string;
};

// —— PluginQuickProviderMeta（src/preload/pluginPreload.ts）——

/** Quick provider 注册元数据 */
export type PluginQuickProviderMeta = {
    id: string;
    explain?: string;
    schemaVersion?: string;
};

// —— SshTransferEvent（src/preload/pluginPreload.ts）——

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

// —— PluginHotkeyRegisterResult（src/preload/pluginPreload.ts）——

/** hotkey.register 结果：ok=false 时 error 携带冲突/失败原因 */
export type PluginHotkeyRegisterResult = {
    ok: boolean;
    error?: string;
};

// —— Unsubscribe（src/preload/pluginPreload.ts）——

export type Unsubscribe = () => void;

// —— AppLocale（src/shared/types/plugin.ts）——

/** 壳子支持的界面语言（settings.general.locale / enest.i18n） */
export type AppLocale = 'zh-CN' | 'en-US';

// —— ScreenBounds（src/shared/types/plugin.ts）——

/** 屏幕区域（设备像素，相对 capture 的 display） */
export interface ScreenBounds {
    x: number;
    y: number;
    width: number;
    height: number;
}

// —— ScreenCaptureResult（src/shared/types/plugin.ts）——

/** 截图结果：PNG dataURL */
export interface ScreenCaptureResult {
    dataUrl: string;
    width: number;
    height: number;
}

// —— ClipboardHistoryEntry（src/shared/types/plugin.ts）——

/** 剪贴板历史条目（list 不含完整二进制；get 返回完整字段） */
export interface ClipboardHistoryEntry {
    id: string;
    type: 'text' | 'image';
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

// —— PluginLaunchMode（src/shared/types/plugin.ts）——

/**
 * 插件启动方式（= 运行时挂载容器）：
 * - quick：Quick 小窗内嵌，渲染在输入框下方（小窗适配样式）
 * - shell：主窗大窗 Tab（桌面适配样式）
 * 不再有「大小插件」类型区分：同一插件两种入口样式并存，
 * 壳子启动时经 URL ?mode= / onEnter 载荷 / getLaunchMode() 传给插件，插件自选渲染样式。
 */
export type PluginLaunchMode = 'quick' | 'shell';

// —— ThemePack（src/shared/types/plugin.ts）——

/** 可由主题插件动态注册的主题包 */
export interface ThemePack {
    id: string;
    name: string;
    /** 来源插件 id，内置为 'enest.builtin' */
    source: string;
    mode: ThemeMode;
    tokens: Record<string, string>;
    background?: BackgroundConfig;
}

// —— VaultSetResult（src/shared/types/ssh-db.ts）——

/** SSH / Database 插件宿主 API 共享类型（Spec docs/compose/spec/ssh-db-plugins.md） */
// —— Vault ——
export interface VaultSetResult {
    secretRef: string;
}

// —— SshConnectInput（src/shared/types/ssh-db.ts）——

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
    privateKeyPath?: string;
    jump?: SshJumpConfig | null;
    keepAliveSec?: number;
    timeoutMs?: number;
    cols?: number;
    rows?: number;
    term?: string;
    env?: string;
}

// —— SshSessionInfo（src/shared/types/ssh-db.ts）——

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

// —— SshExecInput（src/shared/types/ssh-db.ts）——

export interface SshExecInput extends Partial<SshConnectInput> {
    sessionId?: string;
    command?: string;
    cmd?: string;
    timeoutMs?: number;
}

// —— SshExecResult（src/shared/types/ssh-db.ts）——

export interface SshExecResult {
    stdout: string;
    stderr: string;
    exitCode: number | null;
    durationMs: number;
}

// —— SshMetricsSample（src/shared/types/ssh-db.ts）——

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

// —— SshCompletionResult（src/shared/types/ssh-db.ts）——

export interface SshCompletionResult {
    items: SshCompletionItem[];
    danger?: string | null;
    word?: string;
}

// —— SftpListInput（src/shared/types/ssh-db.ts）——

export interface SftpListInput {
    sessionId?: string;
    path?: string;
    host?: string;
    port?: number;
    username?: string;
    authType?: SshAuthType;
    secretRef?: string;
    ephemeralSecret?: string;
    privateKeyPath?: string;
}

// —— SftpEntry（src/shared/types/ssh-db.ts）——

export interface SftpEntry {
    name: string;
    type: 'file' | 'dir' | 'other';
    size: number;
    mtime: number;
}

// —— SftpDownloadInput（src/shared/types/ssh-db.ts）——

export interface SftpDownloadInput extends SftpListInput {
    remotePath?: string;
    localPath?: string;
}

// —— SftpUploadInput（src/shared/types/ssh-db.ts）——

export interface SftpUploadInput extends SftpListInput {
    localPath?: string;
    remotePath?: string;
}

// —— SftpTransferResult（src/shared/types/ssh-db.ts）——

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

// —— DbConnectionConfig（src/shared/types/ssh-db.ts）——

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
    filePath?: string;
    sqlitePath?: string;
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

// —— DbTestResult（src/shared/types/ssh-db.ts）——

export interface DbTestResult {
    ok: boolean;
    message: string;
    version?: string;
    latencyMs?: number;
}

// —— DbSessionInfo（src/shared/types/ssh-db.ts）——

export interface DbSessionInfo {
    sessionKey: string;
    driver: DbDriverId;
    host?: string;
    database?: string;
    filePath?: string;
    readOnly?: boolean;
    openedAt: number;
    connectionId?: string;
}

// —— DbExecuteInput（src/shared/types/ssh-db.ts）——

export interface DbExecuteInput {
    sessionKey: string;
    sql: string;
    maxRows?: number;
    timeoutMs?: number;
    /** prod / 保护连接写操作确认（Spec DB-B5） */
    confirmed?: boolean;
    params?: unknown[] | Record<string, unknown>;
}

// —— BatchResult（src/shared/types/ssh-db.ts）——

export interface BatchResult {
    ok: boolean;
    results: BatchResultItem[];
    durationMs: number;
}

// —— DbApplyChangesInput（src/shared/types/ssh-db.ts）——

export interface DbApplyChangesInput {
    sessionKey: string;
    changes: RowChange[];
    mode?: 'stop-on-error' | 'continue';
    confirmed?: boolean;
}

// —— QueryResult（src/shared/types/ssh-db.ts）——

export interface QueryResult {
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

// —— DbSchemaTreeInput（src/shared/types/ssh-db.ts）——

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

// —— SchemaObject（src/shared/types/ssh-db.ts）——

export interface SchemaObject {
    name: string;
    type: 'database' | 'schema' | 'table' | 'view' | 'measurement' | 'supertable' | 'column' | 'other';
    database?: string;
    schema?: string;
    comment?: string;
    children?: SchemaObject[];
    column?: DbColumnMeta;
}

// —— TableDetail（src/shared/types/ssh-db.ts）——

export interface TableDetail {
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
    comment?: string;
    ddl?: string;
}

// —— CompletionResponse（src/shared/types/ssh-db.ts）——

export interface CompletionResponse {
    replace: {
        from: number;
        to: number;
    };
    items: CompletionItem[];
    isIncomplete?: boolean;
}

// —— DbCompletionInput（src/shared/types/ssh-db.ts）——

export interface DbCompletionInput {
    sessionKey: string;
    sql: string;
    cursor?: number;
    database?: string;
    schema?: string;
    usageBoost?: Record<string, number>;
}

// —— DbDialectInfo（src/shared/types/ssh-db.ts）——

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

// —— DbImportPreviewInput（src/shared/types/ssh-db.ts）——

export interface DbImportPreviewInput {
    sessionKey: string;
    table: TableRef;
    csvText?: string;
    /** 仅允许宿主 picker 白名单路径 */
    filePath?: string;
    options?: {
        delimiter?: string;
        hasHeader?: boolean;
        columns?: string[];
        sampleRows?: number;
    };
}

// —— DbImportPreviewResult（src/shared/types/ssh-db.ts）——

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

// —— DbImportRunInput（src/shared/types/ssh-db.ts）——

export interface DbImportRunInput {
    sessionKey: string;
    table: TableRef;
    csvText?: string;
    /** 仅允许宿主 picker 选中的路径 */
    filePath?: string;
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

// —— DbImportRunResult（src/shared/types/ssh-db.ts）——

export interface DbImportRunResult {
    ok: boolean;
    inserted: number;
    failed: number;
    errors?: string[];
    durationMs: number;
}

// —— PluginEnterPayload（src/shared/types/plugin.ts）——

// —— 插件生命周期（对标 uTools onPluginEnter / onPluginOut）——
/** openPlugin 可选进入载荷：code 对应 feature 指令，payload 为任意透传数据 */
export interface PluginEnterPayload {
    code?: string;
    payload?: unknown;
}

// —— PluginCloseReason（src/shared/types/plugin.ts）——

/** 关闭原因：用户关 Tab / 卸载插件 / 应用退出 */
export type PluginCloseReason = 'tab-close' | 'uninstall' | 'app-quit';

// —— ThemeMode（src/shared/types/plugin.ts）——

/** 主题模式：浅色 / 深色 / 跟随系统 */
export type ThemeMode = 'light' | 'dark' | 'system';

// —— BackgroundConfig（src/shared/types/plugin.ts）——

export interface BackgroundConfig {
    type: BackgroundType;
    /** color: hex；image/video: 本地绝对路径或 enest:// 资源 URL */
    value: string;
    /** 0–1，视频/图片透明度 */
    opacity: number;
    /** cover | contain */
    fit: 'cover' | 'contain';
}

// —— SshAuthType（src/shared/types/ssh-db.ts）——

// —— SSH ——
export type SshAuthType = 'password' | 'key' | 'agent';

// —— SshJumpConfig（src/shared/types/ssh-db.ts）——

export interface SshJumpConfig {
    host: string;
    port?: number;
    username: string;
    authType?: SshAuthType;
    privateKeyPath?: string;
    secretRef?: string;
    ephemeralSecret?: string;
}

// —— SshCompletionItem（src/shared/types/ssh-db.ts）——

export interface SshCompletionItem {
    label: string;
    kind: SshCompletionKind;
    detail?: string;
    insertText: string;
    sortText: string;
    /** 危险命令说明；true/字符串均可能 */
    dangerous?: boolean | string | null;
}

// —— DbDriverId（src/shared/types/ssh-db.ts）——

// —— Database ——
export type DbDriverId = 'mysql' | 'sqlite' | 'influxdb' | 'timescale' | 'tdengine';

// —— BatchResultItem（src/shared/types/ssh-db.ts）——

export interface BatchResultItem {
    index: number;
    ok: boolean;
    affected?: number;
    error?: string;
    sql?: string;
}

// —— RowChange（src/shared/types/ssh-db.ts）——

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

// —— QueryResultColumn（src/shared/types/ssh-db.ts）——

export interface QueryResultColumn {
    name: string;
    dataType?: string;
    nullable?: boolean;
    primaryKey?: boolean;
}

// —— DbColumnMeta（src/shared/types/ssh-db.ts）——

export interface DbColumnMeta {
    name: string;
    type?: string;
    dataType?: string;
    nullable?: boolean;
    default?: unknown;
    key?: string;
    primaryKey?: boolean;
    comment?: string;
    pk?: boolean;
}

// —— CompletionItem（src/shared/types/ssh-db.ts）——

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

// —— DbDialect（src/shared/types/ssh-db.ts）——

export type DbDialect = 'mysql' | 'sqlite' | 'postgres' | 'influxql' | 'tdengine' | string;

// —— TableRef（src/shared/types/ssh-db.ts）——

export interface TableRef {
    database?: string;
    schema?: string;
    table: string;
}

// —— BackgroundType（src/shared/types/plugin.ts）——

/** 背景类型：无 / 纯色 / 静态图 / 动效视频（mp4/webm，类 Wallpaper Engine） */
export type BackgroundType = 'none' | 'color' | 'image' | 'video';

// —— SshCompletionKind（src/shared/types/ssh-db.ts）——

export type SshCompletionKind = 'cmd' | 'flag' | 'path' | 'history' | 'snippet';

// —— CompletionItemKind（src/shared/types/ssh-db.ts）——

export type CompletionItemKind = 'keyword' | 'table' | 'view' | 'column' | 'function' | 'database' | 'schema' | 'snippet' | 'alias' | 'measurement';

// —— window 全局挂载 ——
// preload 同时暴露 enest 与 zapi 两个全局名（同一对象）；
// zapi 为 @deprecated 历史别名，保留兼容，计划 v2 移除。示例统一使用 enest.*。
declare global {
  interface Window {
    /** eNest 插件 API（正式命名） */
    enest: EnestPluginApi
    /** @deprecated 历史别名，与 window.enest 同一对象；计划 v2 移除 */
    zapi: EnestPluginApi
  }
}

export {}
```

## 使用示例

```ts
/// <reference path="./enest-api.d.ts" />

async function boot() {
  const api = window.enest
  await api.ui.setTitle('我的插件')
  await api.ui.toast({ message: 'API 就绪', type: 'success' })
}

void boot()
```

## 全局挂载说明

| 全局名 | 说明 |
|--------|------|
| `window.enest` | 正式命名，推荐使用 |
| `window.zapi` | `@deprecated` 历史别名，与 `window.enest` 同一对象；保留兼容，计划 v2 移除 |

## 与权限的关系

类型只描述「有哪些方法」；能否调用成功取决于 `plugin.json` 的 `permissions`。未声明权限时对应 Promise 会 reject，错误文案见 [错误码](errors.md)。
