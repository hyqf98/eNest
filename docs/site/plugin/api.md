# zapi API 完整参考

eNest 通过统一 preload（`pluginPreload`）向插件页注入 **`window.enest`**，同时暴露别名 **`window.zapi`**（两者是同一个对象）。

所有能力调用经 IPC 通道 `plugin:call` 进入主进程 `pluginHandlers`，完成 **发送者身份校验 → pluginId 匹配 → 权限断言 → 方法分发**。

```js
const api = window.enest || window.zapi
```

?> **命名约定**：文档以 `enest.*` 书写；你可以在项目里继续使用历史别名 `zapi.*`。

---

## 调用模型

```text
插件页                          主进程
──────                          ──────
await enest.ui.setTitle('x')
        │
        ▼
preload call('ui.setTitle', ['x'])
        │  ipc invoke  plugin:call
        ▼
                              sender ∈ PluginHost? ──否──► unauthorized sender
                              request.pluginId 匹配? ──否──► plugin id mismatch
                              method 已知?          ──否──► unknown method
                              permissions 声明?     ──否──► permission denied
                              dispatch(method, args)
        │
        ▼
resolve({ ok: true, data })
```

失败时 Promise **reject**，`Error.message` 为上图中的错误字符串（见 [错误码](errors.md)）。

---

## 方法索引

| 命名空间 | 方法 | 权限 | 说明 |
|---------|------|------|------|
| `ui` | `setTitle(title)` | `ui.setTitle` | 设置 Tab 标题 |
| `ui` | `setIcon(icon)` | `ui.setIcon` | 设置 Tab 图标 |
| `ui` | `setBadge(badge)` | `ui.setBadge` | 设置角标 |
| `ui` | `resize(size)` | `ui.resize` | 建议内容尺寸（当前预留） |
| `ui` | `toast({ message, type? })` | `ui.toast` | 壳子应用内 Toast |
| `ui` | `getThemeTokens()` | 无 | 读主题 Token（别名） |
| `ui` | `onThemeChange(cb)` | 无 | 订阅主题变更 |
| `theme` | `getTokens()` | 无 | 读当前主题 Token |
| `theme` | `register(pack)` | 无 | 注册主题包 |
| `settings` | `register(section)` | `settings.register` | 注册设置分组 |
| `settings` | `get(key)` | 无 | 读插件设置 |
| `settings` | `set(key, value)` | 无 | 写插件设置 |
| `storage` | `get/set/remove/clear` | `storage.local` | 持久化 KV |
| `storage.session` | `get/set/remove/clear` | `storage.local` | 会话态 KV |
| `clipboard` | `readText()` | `clipboard.read` | 读纯文本 |
| `clipboard` | `writeText(text)` | `clipboard.write` | 写纯文本 |
| `shell` | `openExternal(url)` | `shell.openExternal` | 系统浏览器打开 |
| — | `notify({ title?, body? })` | `notify` | 系统通知 |
| — | `on(event, cb)` / `off(event, cb)` | 无 | 通用事件 |
| — | `onEnter / onOut / onBeforeClose / onDestroy` | 无 | 生命周期 |
| — | `getPluginId()` / `getEnterCode()` | 无 | 插件身份 |

顶层还保留兼容扁平别名：`enest.setTitle` ≡ `enest.ui.setTitle`（icon / badge / resize 同理）。

---

## ui — 界面集成

### `ui.setTitle(title)`

修改当前插件 Tab 的标题（壳子顶栏 / 侧栏轨道同步更新）。

| | |
|--|--|
| **权限** | `ui.setTitle` |
| **参数** | `title: string` — 新标题；空字符串会显示为空 |
| **返回** | `Promise<boolean>` — 恒为 `true` |
| **错误** | `permission denied: ui.setTitle` |

```js
await enest.ui.setTitle('待办 · 3 项')
```

内部发送 `shell:event` → `{ type: 'plugin-title', tabId, title }`，由壳子渲染层更新。

---

### `ui.setIcon(icon)`

设置 Tab 图标。

| | |
|--|--|
| **权限** | `ui.setIcon` |
| **参数** | `icon: string` — 图标标识（emoji / 内置 glyph 名，或后续扩展的资源 URL） |
| **返回** | `Promise<boolean>` |
| **错误** | `permission denied: ui.setIcon` |

```js
await enest.ui.setIcon('✓')
```

---

### `ui.setBadge(badge)`

设置 Tab 角标。

| | |
|--|--|
| **权限** | `ui.setBadge` |
| **参数** | `badge: string \| number` — 数字或短文本；传 `''` 清除 |
| **返回** | `Promise<boolean>` |
| **错误** | `permission denied: ui.setBadge` |

```js
await enest.ui.setBadge(3)
await enest.ui.setBadge('9+')
await enest.ui.setBadge('') // 清除
```

---

### `ui.resize(size)`

向壳子声明建议的内容区尺寸。

| | |
|--|--|
| **权限** | `ui.resize` |
| **参数** | `size: { width?: number; height?: number }` |
| **返回** | `Promise<boolean>` — 当前实现恒为 `true` |

?> **现状**：主进程分发器里此方法为 **预留空实现**（no-op），仅完成权限校验后直接返回 `true`。请勿依赖它改变实际布局；用 `window` 字段声明最小尺寸，或自行响应容器 resize。

```js
await enest.ui.resize({ width: 960, height: 640 })
```

---

### `ui.toast(payload)`

由 **壳子全局 Toast 层** 渲染的轻提示，与 `notify`（系统通知）分工。

| | |
|--|--|
| **权限** | `ui.toast` |
| **参数** | `payload: { message: string; type?: 'info' \| 'success' \| 'warn' \| 'error' }` |
| **返回** | `Promise<boolean>` |
| **错误** | `permission denied: ui.toast`；`toast message required`（`message` 为空） |

- `message` 必填非空。
- `type` 缺省或非法值时按 `'info'` 处理。

```js
await enest.ui.toast({ message: '已保存', type: 'success' })
await enest.ui.toast({ message: '网络异常', type: 'error' })
```

| | `ui.toast` | `notify` |
|--|-----------|----------|
| 渲染方 | 壳子应用内 Toast | 操作系统通知 |
| 场景 | 当前窗口内轻反馈 | 可后台触发、系统级 |
| 权限 | `ui.toast` | `notify` |

---

### `ui.getThemeTokens()`

读取壳子解析后的主题 Token。**规范入口是 `enest.theme.getTokens()`**，此方法为兼容别名，行为完全一致。

| | |
|--|--|
| **权限** | 无（所有插件可用） |
| **返回** | `Promise<{ mode: 'light' \| 'dark'; tokens: Record<string, string> }>` |

```js
const { mode, tokens } = await enest.ui.getThemeTokens()
console.log(mode, tokens['--accent'])
```

---

### `ui.onThemeChange(cb)`

订阅主题变更。壳子 `setTheme`、系统主题切换、主题包切换时推送。

| | |
|--|--|
| **权限** | 无 |
| **参数** | `cb: (event: { mode: 'light' \| 'dark'; tokens: Record<string, string> }) => void` |
| **返回** | `() => void` — 取消订阅函数 |

```js
const off = enest.ui.onThemeChange(({ mode, tokens }) => {
  console.log('主题切换为', mode)
  // 重绘 Canvas / 更新 WebGL uniform
})
// 不再需要时
off()
```

等价通用写法：

```js
enest.on('theme-change', handler)
enest.off('theme-change', handler)
```

---

## theme — 主题

### `theme.getTokens()`

按插件 `manifest.ui.preferredColorScheme` 解析 **最终生效** 的 Token。

| | |
|--|--|
| **权限** | 无 |
| **返回** | `Promise<{ mode: 'light' \| 'dark'; tokens: Record<string, string> }>` |

叠加顺序：**内置预设 → 活动主题包 → 用户 overrides**。`preferredColorScheme` 为 `light` / `dark` 时强制该配色；`auto` 跟随壳子（含系统主题）。

```js
const { mode, tokens } = await enest.theme.getTokens()
```

内置预设 Token 名（完整语义见 [UI 集成标准](ui-standard.md)）：

`--bg` · `--surface` · `--surface-2` · `--surface-3` · `--border` · `--border-strong` · `--text` · `--text-2` · `--text-3` · `--accent` · `--ok` · `--ok-soft` · `--danger`

---

### `theme.register(pack)`

把主题包注册进壳子「设置 → 主题」下拉列表。主题插件的主入口能力。

| | |
|--|--|
| **权限** | 无（当前不设权限；`source` 自动记为插件 id） |
| **参数** | `pack: ThemePack` |
| **返回** | `Promise<unknown>` — 注册后的主题包对象 |

```js
await enest.theme.register({
  id: 'com.example.forest',
  name: '森林',
  mode: 'dark',
  tokens: {
    '--bg': '#0a1f1c',
    '--surface': '#0f2924',
    '--surface-2': '#14352f',
    '--text': '#e8fff8',
    '--text-2': '#9ccfc0',
    '--text-3': '#6a9a8c',
    '--accent': '#2dd4a8',
    '--border': 'rgba(255,255,255,0.08)',
    '--border-strong': 'rgba(255,255,255,0.14)',
    '--ok': '#3dd68c',
    '--danger': '#ff7a8e'
  },
  background: {
    type: 'color',
    value: 'linear-gradient(160deg,#0a1f1c,#134e4a)',
    opacity: 0.9
  }
})
```

**ThemePack 契约**（`@shared/types/plugin`）：

| 字段 | 必填 | 类型 | 说明 |
|------|------|------|------|
| `id` | ✓ | `string` | 全局唯一；同 id 覆盖注册 |
| `name` | ✓ | `string` | 设置页下拉显示名 |
| `mode` | ✓ | `'light' \| 'dark' \| 'system'` | 主题模式 |
| `tokens` | ✓ | `Record<string, string>` | CSS 变量覆盖，键名与壳子一致 |
| `source` | 自动 | `string` | 缺省为当前插件 id；内置为 `enest.builtin` |
| `background` | | `{ type, value, opacity?, fit? }` | 可选壳子背景 |

注册成功后主进程推送 `theme-packs-changed`，设置页 **即时刷新**，无需重启。

---

## settings — 插件设置

### `settings.register(section)`

向壳子「设置 → 插件」分组动态注册一块设置面板。

| | |
|--|--|
| **权限** | `settings.register` |
| **参数** | `section: { id: string; title: string; items: Array<{ key, type, label, default? }> }` |
| **返回** | `Promise<boolean>` |
| **错误** | `permission denied: settings.register`；`invalid settings section`（缺 `id` 或 `title`） |

```js
await enest.settings.register({
  id: 'hello.prefs',
  title: 'Hello 工具',
  items: [
    { key: 'name', type: 'text', label: '称呼', default: '朋友' },
    { key: 'volume', type: 'number', label: '音量', default: 80 }
  ]
})
```

| 字段 | 说明 |
|------|------|
| `section.id` | 分组唯一 id |
| `section.title` | 设置页分组标题 |
| `items[].key` | 设置键，后续 `settings.get/set` 使用 |
| `items[].type` | 控件类型（如 `text` / `number` / `switch`，以壳子实现为准） |
| `items[].label` | 控件标签 |
| `items[].default` | 默认值（可选） |

---

### `settings.get(key)`

读取插件设置值。优先从设置桥读取，否则回落到壳子已持久化的插件设置。

| | |
|--|--|
| **权限** | 无（由 Bridge / SettingsStore 管控） |
| **参数** | `key: string` |
| **返回** | `Promise<unknown>` — 未设置时为 `undefined` |

```js
const name = await enest.settings.get('name')
```

---

### `settings.set(key, value)`

写入插件设置，同时更新内存桥与持久化存储。

| | |
|--|--|
| **权限** | 无 |
| **参数** | `key: string`，`value: unknown` |
| **返回** | `Promise<boolean>` |

```js
await enest.settings.set('name', '世界')
```

---

## storage — 数据持久化

两套存储语义对比：

| | `storage.*`（local） | `storage.session.*` |
|--|----------------------|---------------------|
| 介质 | 磁盘 JSON | 主进程内存 Map |
| 路径 | `~/eNest/data/plugin-storage/{id}.json` | 不落盘 |
| 生命周期 | 关 Tab **保留**；卸载清理 | 插件关闭 / 应用退出即清空 |
| 权限 | `storage.local` | `storage.local`（复用，无需单独声明） |

### `storage.get(key)` / `storage.set(key, value)` / `storage.remove(key)` / `storage.clear()`

| | |
|--|--|
| **权限** | `storage.local` |
| **参数** | `key: string`；`set` 另需 `value: unknown`（任意 JSON 可序列化值） |
| **返回** | `get → Promise<unknown>`；其余 `Promise<boolean>` |
| **错误** | `permission denied: storage.local` |

```js
await enest.storage.set('prefs', { theme: 'dark', compact: true })
const prefs = await enest.storage.get('prefs')
await enest.storage.remove('prefs')
await enest.storage.clear()
```

值经 `JSON` 序列化写入，**不要**存函数、循环引用或超大二进制。

### `storage.session.get / set / remove / clear`

会话态 KV：适合草稿、临时缓存、轮询状态。

| | |
|--|--|
| **权限** | `storage.local` |
| **参数 / 返回** | 与 local 相同 |

```js
await enest.storage.session.set('draft', { text: '未完成…' })
const draft = await enest.storage.session.get('draft')
await enest.storage.session.clear()
```

?> 关闭 Tab 时主进程会调用 `clearPluginSession(pluginId)`，会话 bag 整体丢弃。**重要状态必须写 `storage.*`，不要只写 session。**

---

## clipboard — 剪贴板

### `clipboard.readText()`

| | |
|--|--|
| **权限** | `clipboard.read` |
| **返回** | `Promise<string>` |

```js
const text = await enest.clipboard.readText()
```

### `clipboard.writeText(text)`

| | |
|--|--|
| **权限** | `clipboard.write` |
| **参数** | `text: string`（缺省按 `''` 处理） |
| **返回** | `Promise<boolean>` |

```js
await enest.clipboard.writeText('已复制的内容')
```

---

## shell — 系统能力

### `shell.openExternal(url)`

用系统默认浏览器打开外部链接。

| | |
|--|--|
| **权限** | `shell.openExternal` |
| **参数** | `url: string` |
| **返回** | `Promise<boolean>` |
| **错误** | `permission denied: shell.openExternal`；`only http(s) urls allowed` |

仅允许 `http://` / `https://` 协议（大小写不敏感）。`file://`、`javascript:`、自定义协议一律拒绝。

```js
await enest.shell.openExternal('https://github.com')
```

---

## notify — 系统通知

### `notify(payload)`

| | |
|--|--|
| **权限** | `notify` |
| **参数** | `payload: { title?: string; body?: string }` |
| **返回** | `Promise<boolean>` |

- `title` 缺省为 `'eNest'`
- `body` 缺省为 `''`

```js
await enest.notify({ title: '备份完成', body: '已写入 128 个文件' })
```

---

## 事件总线

### `on(event, cb)` / `off(event, cb)`

底层事件订阅。生命周期与主题 API 均封装自它。

| | |
|--|--|
| **权限** | 无 |
| **参数** | `event: string`，`cb: (data: unknown) => void` |
| **返回** | `void` |

```js
function onEnter(data) { console.log('enter', data) }
enest.on('enter', onEnter)
enest.off('enter', onEnter)
```

内置事件名：

| 事件 | 触发 | 数据 |
|------|------|------|
| `enter` | 首次加载完成 / Tab 激活 | `{ tabId, code?, payload? }` |
| `out` | 切到其它 Tab | `{ isKill: false }` |
| `beforeClose` | 即将销毁 | `{ reason }` |
| `destroy` | 关闭已开始 | `undefined` |
| `theme-change` | 主题变更 | `{ mode, tokens }` |

回调抛错会被捕获，**不会**影响其它监听器。

---

## 生命周期

完整状态机见 [生命周期](lifecycle.md)。

### `onEnter(cb)`

进入插件：**首次加载完成后** + **每次 Tab 激活**。与 `onOut` 成对，可用来 pause / resume。

| | |
|--|--|
| **参数** | `cb: (event: { tabId: string; code?: string; payload?: unknown }) => void` |
| **返回** | `() => void` — 取消订阅 |

```js
enest.onEnter(({ tabId, code, payload }) => {
  console.log('进入', tabId, code, payload)
})
```

`code` / `payload` 来自 `openPlugin` 的进入载荷，对应 `features[].code` 与透传数据。

### `onOut(cb)`

退到后台（其它 Tab 成为 active）。**不销毁** View，状态保留。

| | |
|--|--|
| **参数** | `cb: (event: { isKill: false }) => void` |
| **返回** | `() => void` |

```js
enest.onOut(() => {
  pauseHeavyWork()
})
```

### `onBeforeClose(cb)`

即将销毁：Tab 关闭 / 卸载插件 / 应用退出。可在此 **同步** flush 草稿。

| | |
|--|--|
| **参数** | `cb: (event: { reason: 'tab-close' \| 'uninstall' \| 'app-quit' }) => void` |
| **返回** | `() => void` |

- preload 在派发完监听器后 **自动** 回 ack。
- 主进程最多等待 **300ms**；异步 flush 请自行在这段时间内完成，或优先写 `storage.session` / 同步路径。

```js
enest.onBeforeClose(({ reason }) => {
  // 同步写本地（fire-and-forget 亦可）
  enest.storage.session.set('last-close', reason)
})
```

### `onDestroy(cb)`

关闭已开始（best-effort）。清理逻辑请放在 `onBeforeClose`。

| | |
|--|--|
| **参数** | `cb: () => void` |
| **返回** | `() => void` |

---

## 身份工具

### `getPluginId()`

| | |
|--|--|
| **返回** | `string` — 当前插件 id（与 URL query `pid` 一致） |
| **同步** | 是，不走 IPC |

```js
const id = enest.getPluginId()
```

### `getEnterCode()`

| | |
|--|--|
| **返回** | `string \| undefined` — URL query 中的 `code` |
| **同步** | 是 |

```js
const code = enest.getEnterCode()
```

?> 完整进入载荷（含 `payload`）请以 `onEnter` 回调为准；`getEnterCode` 适合在首屏脚本 **同步** 分支时使用。

---

## TypeScript

完整 `window.enest` 接口声明见 [TypeScript 类型](api-types.md)。也可以直接从源码拷贝：

```text
src/preload/pluginPreload.ts  →  export interface EnestPluginApi
```

推荐插件内的安全用法：

```ts
const api = (window as any).enest as EnestPluginApi | undefined
if (!api) {
  // 本地浏览器直开 / 未挂载壳子
  console.warn('eNest API 不可用')
}
```

---

## 安全模型要点

1. **无 Node**：插件页不能 `require('electron')`，不能访问任意文件系统。
2. **权限门禁**：未在 `plugin.json` 的 `permissions` 声明的调用被拒绝。
3. **身份绑定**：IPC 仅接受 PluginHost 管理的 WebContents；伪造 `pluginId` 返回 `plugin id mismatch`。
4. **协议隔离**：`enest://plugin/{id}/...` 只映射该插件根目录，路径穿越会被拒。
5. **partition 隔离**：每个插件独立 `persist:plugin-{id}`，cookie / localStorage 互不可见。

→ 权限完整表见 [权限说明](permissions.md)  
→ 错误字符串见 [错误码](errors.md)
