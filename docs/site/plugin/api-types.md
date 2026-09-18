# TypeScript 类型定义

!> **本文件由 `scripts/generate-api-types.mjs` 生成，勿手改。**
> 上游源：`src/preload/pluginPreload.ts`（`EnestPluginApi` 及其本地类型）+ `src/shared/types/plugin.ts`（共享类型）。
> 生成时间：**2026-09-17 12:19:58 UTC** · 重新生成：`node scripts/generate-api-types.mjs`
>
> 推荐直接安装 [`@enest/plugin-sdk`](../../../packages/plugin-sdk/README.md)（含本 d.ts + manifest 校验 CLI）；
> 也可将下方声明保存为项目内 `enest-api.d.ts`，经 `/// <reference path="./enest-api.d.ts" />` 引入。

在 TypeScript 插件工程中引用下列类型描述 `window.enest` / `window.zapi`，避免手写 `any`。

## 类型声明（enest-api.d.ts）

```ts
/**
 * eNest 插件运行时 API 类型 —— 自动生成，勿手改。
 * 由 scripts/generate-api-types.mjs 从 src/preload/pluginPreload.ts 提取。
 * 生成时间：2026-09-17 12:19:58 UTC
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
        /** 读取当前主题 Token（themeAware 插件可主动拉取） */
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
    };
    notify(payload: {
        title?: string;
        body?: string;
    }): Promise<boolean>;
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
}

// —— Listener（src/preload/pluginPreload.ts）——

export type Listener = (data: unknown) => void;

// —— PluginToastType（src/preload/pluginPreload.ts）——

export /** Toast 类型：info 默认，success/warn/error 带强调色 */
type PluginToastType = 'info' | 'success' | 'warn' | 'error';

// —— PluginEnterEvent（src/preload/pluginPreload.ts）——

export /** enter 事件载荷 */
type PluginEnterEvent = PluginEnterPayload & {
    tabId: string;
};

// —— PluginOutEvent（src/preload/pluginPreload.ts）——

export /** out 事件载荷；isKill 恒为 false（杀死走 beforeClose/destroy） */
type PluginOutEvent = {
    isKill: false;
};

// —— PluginBeforeCloseEvent（src/preload/pluginPreload.ts）——

export /** beforeClose 事件载荷 */
type PluginBeforeCloseEvent = {
    reason: PluginCloseReason;
};

// —— PluginThemeTokens（src/preload/pluginPreload.ts）——

export /** 主题 Token 集合（壳子解析后的 CSS 自定义属性值） */
type PluginThemeTokens = Record<string, string>;

// —— PluginThemeChangeEvent（src/preload/pluginPreload.ts）——

export /** 主题变更事件（enest.ui.onThemeChange） */
type PluginThemeChangeEvent = {
    mode: 'light' | 'dark';
    tokens: PluginThemeTokens;
};

// —— PluginHotkeyEvent（src/preload/pluginPreload.ts）——

export /** 热键触发事件（enest.hotkey.register 的回调 / enest.on('hotkey')） */
type PluginHotkeyEvent = {
    accelerator: string;
};

// —— PluginLocaleChangeEvent（src/preload/pluginPreload.ts）——

export /** 语言变更事件（enest.i18n.onLocaleChange） */
type PluginLocaleChangeEvent = {
    locale: AppLocale;
};

// —— PluginQuickQueryEvent（src/preload/pluginPreload.ts）——

export /** Quick 搜索查询事件（enest.contribute.onQuickQuery） */
type PluginQuickQueryEvent = {
    reqId: string;
    query: string;
};

// —— PluginQuickQueryItem（src/preload/pluginPreload.ts）——

export /** Quick provider 回传项（enest.contribute.respondQuickQuery 的 items 元素） */
type PluginQuickQueryItem = {
    id?: string;
    title?: string;
    subtitle?: string;
    explain?: string;
    code?: string;
};

// —— PluginQuickProviderMeta（src/preload/pluginPreload.ts）——

export /** Quick provider 注册元数据 */
type PluginQuickProviderMeta = {
    id: string;
    explain?: string;
    schemaVersion?: string;
};

// —— PluginHotkeyRegisterResult（src/preload/pluginPreload.ts）——

export /** hotkey.register 结果：ok=false 时 error 携带冲突/失败原因 */
type PluginHotkeyRegisterResult = {
    ok: boolean;
    error?: string;
};

// —— Unsubscribe（src/preload/pluginPreload.ts）——

export type Unsubscribe = () => void;

// —— AppLocale（src/shared/types/plugin.ts）——

export /** 壳子支持的界面语言（settings.general.locale / enest.i18n） */
type AppLocale = 'zh-CN' | 'en-US';

// —— ScreenBounds（src/shared/types/plugin.ts）——

export /** 屏幕区域（设备像素，相对 capture 的 display） */
interface ScreenBounds {
    x: number;
    y: number;
    width: number;
    height: number;
}

// —— ScreenCaptureResult（src/shared/types/plugin.ts）——

export /** 截图结果：PNG dataURL */
interface ScreenCaptureResult {
    dataUrl: string;
    width: number;
    height: number;
}

// —— ClipboardHistoryEntry（src/shared/types/plugin.ts）——

export /** 剪贴板历史条目（list 不含完整二进制；get 返回完整字段） */
interface ClipboardHistoryEntry {
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

// —— ThemePack（src/shared/types/plugin.ts）——

export /** 可由主题插件动态注册的主题包 */
interface ThemePack {
    id: string;
    name: string;
    /** 来源插件 id，内置为 'enest.builtin' */
    source: string;
    mode: ThemeMode;
    tokens: Record<string, string>;
    background?: BackgroundConfig;
}

// —— PluginEnterPayload（src/shared/types/plugin.ts）——

export // —— 插件生命周期（对标 uTools onPluginEnter / onPluginOut）——
/** openPlugin 可选进入载荷：code 对应 feature 指令，payload 为任意透传数据 */
export interface PluginEnterPayload {
    code?: string;
    payload?: unknown;
}

// —— PluginCloseReason（src/shared/types/plugin.ts）——

export /** 关闭原因：用户关 Tab / 卸载插件 / 应用退出 */
type PluginCloseReason = 'tab-close' | 'uninstall' | 'app-quit';

// —— ThemeMode（src/shared/types/plugin.ts）——

export /** 主题模式：浅色 / 深色 / 跟随系统 */
type ThemeMode = 'light' | 'dark' | 'system';

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

// —— BackgroundType（src/shared/types/plugin.ts）——

export /** 背景类型：无 / 纯色 / 静态图 / 动效视频（mp4/webm，类 Wallpaper Engine） */
type BackgroundType = 'none' | 'color' | 'image' | 'video';

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
