# TypeScript 类型

`window.enest`（别名 `window.zapi`）的完整接口声明，与 `src/preload/pluginPreload.ts` 导出的 `EnestPluginApi` 对齐。

---

## 快速使用

在插件项目中新建 `enest.d.ts`：

```ts
/// <reference path="./enest.d.ts" />

const api = window.enest
await api?.ui.setTitle('Hello')
```

或从源码拷贝接口：

```text
src/preload/pluginPreload.ts  →  export interface EnestPluginApi
```

---

## window.enest 完整接口

```ts
/** 主题 Token 集合（壳子解析后的 CSS 自定义属性值） */
export type PluginThemeTokens = Record<string, string>

/** Toast 类型：info 默认，success/warn/error 带强调色 */
export type PluginToastType = 'info' | 'success' | 'warn' | 'error'

/** enter 事件载荷 */
export type PluginEnterEvent = {
  tabId: string
  code?: string
  payload?: unknown
}

/** out 事件载荷；isKill 恒为 false（杀死走 beforeClose/destroy） */
export type PluginOutEvent = { isKill: false }

/** 关闭原因：用户关 Tab / 卸载插件 / 应用退出 */
export type PluginCloseReason = 'tab-close' | 'uninstall' | 'app-quit'

/** beforeClose 事件载荷 */
export type PluginBeforeCloseEvent = { reason: PluginCloseReason }

/** 主题变更事件（enest.ui.onThemeChange） */
export type PluginThemeChangeEvent = {
  mode: 'light' | 'dark'
  tokens: PluginThemeTokens
}

/** 取消订阅 */
export type Unsubscribe = () => void

/** 事件监听器 */
export type Listener = (data: unknown) => void

/** 主题包（enest.theme.register） */
export interface EnestThemePack {
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
}

/** 设置分组（enest.settings.register） */
export interface EnestSettingsSection {
  id: string
  title: string
  items: Array<{
    key: string
    type: string
    label: string
    default?: unknown
  }>
}

export interface EnestPluginApi {
  // —— 顶层扁平别名（与 ui.* 等价）——
  setTitle(title: string): Promise<boolean>
  setIcon(icon: string): Promise<boolean>
  setBadge(badge: string | number): Promise<boolean>
  resize(size: { width?: number; height?: number }): Promise<boolean>

  // —— UI ——
  ui: {
    setTitle(title: string): Promise<boolean>
    setIcon(icon: string): Promise<boolean>
    setBadge(badge: string | number): Promise<boolean>
    resize(size: { width?: number; height?: number }): Promise<boolean>
    /** 由壳子 Toast 统一渲染的轻提示 */
    toast(payload: { message: string; type?: PluginToastType }): Promise<boolean>
    /** 读取当前主题 Token（theme.getTokens 的兼容别名） */
    getThemeTokens(): Promise<{ mode: 'light' | 'dark'; tokens: PluginThemeTokens }>
    /** 订阅主题变更 */
    onThemeChange(cb: (event: PluginThemeChangeEvent) => void): Unsubscribe
  }

  // —— 主题 ——
  theme: {
    getTokens(): Promise<{ mode: 'light' | 'dark'; tokens: PluginThemeTokens }>
    register(pack: EnestThemePack): Promise<unknown>
  }

  // —— 设置 ——
  settings: {
    register(section: EnestSettingsSection): Promise<boolean>
    get(key: string): Promise<unknown>
    set(key: string, value: unknown): Promise<boolean>
  }

  // —— 存储 ——
  storage: {
    /** 持久化 KV：落盘 ~/eNest/data/plugin-storage/{id}.json */
    get(key: string): Promise<unknown>
    set(key: string, value: unknown): Promise<boolean>
    remove(key: string): Promise<boolean>
    clear(): Promise<boolean>
    /** 会话态 KV：主进程内存，关闭/退出即清空 */
    session: {
      get(key: string): Promise<unknown>
      set(key: string, value: unknown): Promise<boolean>
      remove(key: string): Promise<boolean>
      clear(): Promise<boolean>
    }
  }

  // —— 系统 ——
  clipboard: {
    readText(): Promise<string>
    writeText(text: string): Promise<boolean>
  }
  shell: {
    /** 仅允许 http(s) */
    openExternal(url: string): Promise<boolean>
  }
  notify(payload: { title?: string; body?: string }): Promise<boolean>

  // —— 通用事件 ——
  on(event: string, cb: Listener): void
  off(event: string, cb: Listener): void

  // —— 生命周期 ——
  onEnter(cb: (event: PluginEnterEvent) => void): Unsubscribe
  onOut(cb: (event: PluginOutEvent) => void): Unsubscribe
  onBeforeClose(cb: (event: PluginBeforeCloseEvent) => void): Unsubscribe
  onDestroy(cb: () => void): Unsubscribe
  /** 同步：当前插件 id */
  getPluginId(): string
  /** 同步：URL query 中的 code */
  getEnterCode(): string | undefined
}

declare global {
  interface Window {
    enest?: EnestPluginApi
    /** 历史别名，与 enest 为同一对象 */
    zapi?: EnestPluginApi
  }
}

export {}
```

---

## 相关 shared 类型

以下类型定义在 `src/shared/types/plugin.ts`，插件侧如需可复制子集：

```ts
/** 插件权限白名单键 */
export type PluginPermission =
  | 'clipboard.read'
  | 'clipboard.write'
  | 'shell.openExternal'
  | 'storage.local'
  | 'notify'
  | 'ui.setTitle'
  | 'ui.setIcon'
  | 'ui.setBadge'
  | 'ui.resize'
  | 'ui.toast'
  | 'settings.register'

/** 插件宿主 Chrome 模式 */
export type PluginChromeMode = 'default' | 'minimal' | 'none'

/** 插件页面背景 */
export type PluginBackgroundMode = 'transparent' | 'opaque'

/** 插件偏好的配色 */
export type PluginPreferredColorScheme = 'light' | 'dark' | 'auto'

/** plugin.json `ui` 段 */
export interface PluginUiConfig {
  chrome: PluginChromeMode
  themeAware: boolean
  background: PluginBackgroundMode
  preferredColorScheme: PluginPreferredColorScheme
}

/** 关闭原因 */
export type PluginCloseReason = 'tab-close' | 'uninstall' | 'app-quit'
```

---

## 安全包装建议

```ts
import type { EnestPluginApi } from './enest'

function getApi(): EnestPluginApi | null {
  const api = window.enest ?? window.zapi ?? null
  if (!api) {
    console.warn('[plugin] eNest API 不可用（非壳子环境？）')
  }
  return api
}

export const enest = getApi()
```

```ts
// 页面内使用
if (enest) {
  await enest.ui.setTitle('工作台')
} else {
  document.title = '工作台'
}
```

---

## 权限相关的类型收窄

`permissions` 不在类型系统内强制，需要你自己在 manifest 与代码之间保持一致。可用常量集中管理：

```ts
export const REQUIRED_PERMISSIONS = [
  'ui.setTitle',
  'ui.toast',
  'storage.local',
  'clipboard.write'
] as const
```

在 CI 里用脚本把它与 `plugin.json.permissions` 做 diff，避免漏声明导致运行时 `permission denied`。

---

## 相关文档

- [zapi API](api.md) — 方法语义、参数、错误
- [权限说明](permissions.md) — 权限键全表
