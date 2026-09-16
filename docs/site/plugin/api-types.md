# TypeScript 类型定义

在 TypeScript 插件工程中，可直接引用下列类型描述 `window.enest` / `window.zapi`，避免手写 `any`。

## 安装方式

将本页类型保存为项目内 `enest-api.d.ts`，或从示例仓库拷贝。

```ts
/** eNest 插件运行时 API —— 与壳子 preload 注入一致 */
export type EnestToastType = 'info' | 'success' | 'warn' | 'error'

export interface EnestEnterPayload {
  code?: string
  payload?: unknown
  tabId: string
}

export interface EnestThemeTokens {
  mode: 'light' | 'dark' | 'system'
  tokens: Record<string, string>
}

export interface EnestSettingsItem {
  key: string
  type: 'text' | 'switch' | 'select'
  label: string
  default?: unknown
  options?: { label: string; value: string }[]
}

export interface EnestSettingsSection {
  id: string
  title: string
  items: EnestSettingsItem[]
}

export interface EnestPluginApi {
  ui: {
    setTitle(title: string): Promise<boolean>
    setIcon(icon: string): Promise<boolean>
    setBadge(badge: string | number): Promise<boolean>
    resize(size: { width?: number; height?: number }): Promise<boolean>
    toast(payload: { message: string; type?: EnestToastType }): Promise<boolean>
    getThemeTokens(): Promise<EnestThemeTokens>
    onThemeChange(cb: (tokens: EnestThemeTokens) => void): () => void
  }
  theme: {
    getTokens(): Promise<EnestThemeTokens>
    register?(pack: {
      id: string
      name: string
      mode?: 'light' | 'dark'
      tokens: Record<string, string>
    }): Promise<boolean>
  }
  settings: {
    register(section: EnestSettingsSection): Promise<boolean>
    get(key: string): Promise<unknown>
    set(key: string, value: unknown): Promise<boolean>
  }
  storage: {
    get(key: string): Promise<unknown>
    set(key: string, value: unknown): Promise<boolean>
    remove(key: string): Promise<boolean>
    clear(): Promise<boolean>
  }
  clipboard: {
    readText(): Promise<string>
    writeText(text: string): Promise<boolean>
  }
  shell: {
    openExternal(url: string): Promise<boolean>
  }
  notify(payload: { title?: string; body?: string }): Promise<boolean>
  onEnter(cb: (p: EnestEnterPayload) => void): () => void
  onOut(cb: (p: { isKill: boolean }) => void): () => void
  onBeforeClose(cb: (p: { reason: string }) => void): () => void
  onDestroy(cb: () => void): () => void
  getPluginId(): string
  getEnterCode(): string | null
}

declare global {
  interface Window {
    enest: EnestPluginApi
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
| `window.zapi` | 别名，与部分文档/示例兼容 |

两者指向同一对象，类型均为 `EnestPluginApi`。

## 与权限的关系

类型只描述「有哪些方法」；能否调用成功取决于 `plugin.json` 的 `permissions`。未声明权限时，对应 Promise 会 reject，错误文案见 [错误码](errors.md)。
