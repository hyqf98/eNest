# zapi API 参考

壳子通过 preload 向插件页注入 `window.enest`（别名 `window.zapi`）。
所有调用经 IPC `plugin:call`，按 `permissions` 白名单校验。

```js
const api = window.enest || window.zapi
```

## UI

```js
// 权限：ui.setTitle
await enest.ui.setTitle('我的工具')

// 权限：ui.setBadge
await enest.ui.setBadge(3)

// 权限：ui.setIcon / ui.resize（预留）
```

| API | 权限 | 说明 |
|-----|------|------|
| `ui.setTitle(title)` | `ui.setTitle` | 修改 Tab 标题 |
| `ui.setBadge(n)` | `ui.setBadge` | 角标数字 |
| `ui.setIcon(...)` | `ui.setIcon` | Tab 图标 |
| `ui.resize(...)` | `ui.resize` | 建议内容尺寸 |
| `ui.onThemeChange(cb)` | 无 | 订阅主题变更，返回取消订阅函数；详见 [UI 集成标准](ui-standard.md) |

## 主题

### 读取 Token（动态）

插件可随时读取壳子当前解析后的主题 Token，与 `themeAware` 注入内容一致：

```js
const { mode, tokens } = await enest.theme.getTokens()
// mode: 'light' | 'dark'
// tokens: {
//   '--bg', '--surface', '--surface-2', '--surface-3',
//   '--border', '--border-strong',
//   '--text', '--text-2', '--text-3',
//   '--accent', '--ok', '--ok-soft', '--danger', '--danger-soft', '--link'
// }
```

订阅变更（壳子设置切换 / 系统主题 / 应用主题包）：

```js
const off = enest.ui.onThemeChange(({ mode, tokens }) => {
  // 更新 Canvas / WebGL / 自绘 UI
})
// off() 取消订阅
```

### 注册主题包（安装后自动出现在设置）

插件在加载完成后调用 `theme.register`，壳子会：
1. 写入 `~/eNest/themes/registry.json`（`source` 自动记为当前插件 id）
2. 推送 `theme-packs-changed` 事件
3. 设置 → 主题 →「主题包」下拉即时刷新，无需重启

```js
await enest.theme.register({
  id: 'com.example.forest',     // 全局唯一，同 id 覆盖
  name: '森林',                 // 下拉显示名
  mode: 'dark',                 // 'light' | 'dark' | 'system'
  tokens: {
    '--bg': '#0a1f1c',
    '--surface': '#0f2924',
    '--text': '#e8fff8',
    '--text-2': '#9ccfc0',
    '--accent': '#2dd4a8',
    '--border': 'rgba(255,255,255,0.08)',
  },
  // 可选：同时绑定壳子背景（纯色 / CSS 渐变 / 本地路径）
  background: {
    type: 'color',
    value: 'linear-gradient(160deg,#0a1f1c,#134e4a)',
    opacity: 0.9,
  },
})
```

**ThemePack 契约**（`@shared/types/plugin`）：

| 字段 | 必填 | 说明 |
|------|------|------|
| `id` | ✓ | 主题包唯一 id |
| `name` | ✓ | 设置页显示名 |
| `source` | 自动 | 缺省为当前插件 id；内置为 `enest.builtin` |
| `mode` | ✓ | `light` / `dark` / `system` |
| `tokens` | ✓ | 覆盖的 CSS 变量（与壳子 Token 名一致） |
| `background` | | 可选背景，类型见 UI 标准 |

用户在设置中选择该主题包后，壳子会把 `tokens` 写入 `documentElement`，并再次广播 `theme-change` 给所有 `themeAware` 插件。

> TypeScript 项目可自行声明 `interface EnestApi`，或从示例插件拷贝类型定义。

## 本地存储

数据落在插件专属目录，与其它插件隔离。权限：`storage.local`

```js
await enest.storage.set('key', { any: 'json' })
const v = await enest.storage.get('key')
await enest.storage.remove('key')
await enest.storage.clear()
```

## 剪贴板

```js
// clipboard.read / clipboard.write
const text = await enest.clipboard.readText()
await enest.clipboard.writeText('hello')
```

## 系统

```js
// shell.openExternal
await enest.shell.openExternal('https://github.com')

// notify
await enest.notify({ title: '完成', body: '已保存' })
```

## 设置动态注册

注册后，壳子「设置 → 插件」分组会出现该项。权限：`settings.register`

```js
await enest.settings.register({
  id: 'hello.prefs',
  title: 'Hello 工具',
  items: [
    { key: 'name', type: 'text', label: '称呼', default: '朋友' }
  ]
})
```

读写插件设置：

```js
await enest.settings.get('name')
await enest.settings.set('name', '世界')
```

## 下一步

[权限对照表 →](permissions.md)
