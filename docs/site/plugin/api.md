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

```js
// 读取壳子注入的 CSS Token（按 manifest.ui.preferredColorScheme 解析）
const { mode, tokens } = await enest.theme.getTokens()
// mode: 'light' | 'dark'
// tokens: { '--bg': '#…', '--accent': '#…', … }
```

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

## 主题包注册（扩展）

```js
// 将主题写入壳子下拉列表（ThemePack）
await enest.theme?.register({
  id: 'my-theme',
  name: '森林',
  mode: 'dark',
  tokens: { '--bg': '#0a1f1c', '--accent': '#2dd4a8' }
})
```

> TypeScript 项目可自行声明 `interface EnestApi`，或从示例插件拷贝类型定义。

## 下一步

[权限对照表 →](permissions.md)
