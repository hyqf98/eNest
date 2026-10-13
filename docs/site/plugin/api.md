# enest API 完整参考

eNest 在每个插件页注入 **`window.enest`**，同时暴露别名 **`window.zapi`**（两者是同一个对象）。

> **`zapi` 为 `@deprecated` 历史别名**：保留兼容，计划 v2 移除。新代码统一使用 `enest.*`；本地调试需要双名兜底时写 `window.enest`（壳子环境必有）。

所有能力调用统一进入主进程，完成 **发送者身份校验 → pluginId 匹配 → 权限断言 → 方法分发** 四步。

```js
const api = window.enest
```

?> **命名约定**：文档与示例统一以 `enest.*` 书写。

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

**运行时授权**：manifest 声明权限只是入口，每项权限还对应一份 **按插件持久化的运行时三态授权** `allow / ask / deny`（默认 `ask`）。调用需权限的方法且处于 `ask` 时，壳子弹出授权弹窗「本次允许 / 总是允许 / 拒绝」，60 秒无响应按本次拒绝；选择「拒绝」会被记住为 `deny`（可在 插件设置 → 权限管理 改回）。未声明或已被 `deny` 的调用直接 reject `permission denied: <perm>`。完整模型与 OS 层（如 macOS 屏幕录制 TCC）叠加说明见 [权限说明](permissions.md)。

---

## 方法索引

| 命名空间 | 方法 | 权限 | 说明 |
|---------|------|------|------|
| `ui` | `setTitle(title)` | `ui.setTitle` | 设置 Tab 标题 |
| `ui` | `setIcon(icon)` | `ui.setIcon` | 设置 Tab 图标 |
| `ui` | `setBadge(badge)` | `ui.setBadge` | 设置角标 |
| `ui` | `resize(size)` | `ui.resize` | 声明内容尺寸，Quick 即时适配 |
| `ui` | `setHeight(height)` | `ui.resize` | 期望内容高度（Quick 内嵌消费） |
| `ui` | `toast({ message, type? })` | `ui.toast` | 壳子应用内 Toast |
| `ui` | `getThemeTokens()` | 无 | 读主题变量（别名） |
| `ui` | `onThemeChange(cb)` | 无 | 订阅主题变更 |
| `theme` | `getTokens()` | 无 | 读当前主题变量 |
| `theme` | `register(pack)` | `theme` | 注册主题包（≤8 个/插件） |
| `hotkey` | `register(acc, opts?)` | `hotkey` | 注册全局热键 |
| `hotkey` | `unregister(acc)` | `hotkey` | 注销全局热键 |
| `hotkey` | `onHotkey(cb)` | 无 | 订阅热键触发 |
| `i18n` | `getLocale()` | 无 | 读壳子语言 |
| `i18n` | `onLocaleChange(cb)` | 无 | 订阅语言变更 |
| `contribute` | `registerQuickProvider(meta)` | `contribute` | 注册 Quick 搜索 provider |
| `contribute` | `unregisterQuickProvider(id)` | `contribute` | 注销 provider |
| `contribute` | `onQuickQuery(cb)` | 无 | 订阅 Quick 搜索查询（门禁在 `registerQuickProvider`，纯订阅不校验） |
| `contribute` | `respondQuickQuery(reqId, items)` | `contribute` | 回传查询结果 |
| `settings` | `register(section)` | `settings.register` | 注册设置分组 |
| `settings` | `get(key)` | 无 | 读插件设置 |
| `settings` | `set(key, value)` | 无 | 写插件设置 |
| `storage` | `get/set/remove/clear` | `storage.local` | 持久化 KV |
| `storage.session` | `get/set/remove/clear` | `storage.local` | 会话态 KV |
| `clipboard` | `readText()` | `clipboard.read` | 读纯文本 |
| `clipboard` | `writeText(text)` | `clipboard.write` | 写纯文本 |
| `clipboard` | `readImage()` | `clipboard.readImage` | 读图片 dataURL |
| `clipboard` | `writeImage(dataUrl)` | `clipboard.writeImage` | 写图片 |
| `clipboard.history` | `list/get/remove/clear/togglePin` | `clipboard.history` | 剪贴板历史 |
| `screen` | `capture({ displayId?, bounds? })` | `screen.capture` | 截图 |
| `screen` | `selectRegion()` | `screen.capture` | 全屏区域选择 |
| `screen.record` | `start/stop/cancel` | `screen.record` | 矩形录屏 |
| `pin` | `open/close/list/closeAll` | `pin.create` | 贴图窗口 |
| `net` | `fetch({ url, method?, headers?, body?, timeoutMs? })` | `net.fetch` | 受控 HTTPS |
| `shell` | `openExternal(url)` | `shell.openExternal` | 系统浏览器打开 |
| `shell` | `saveTextFile(payload)` | `shell.openExternal` | 另存文本文件 |
| `vault` | `set(key, secret)` | `vault.write` | 存密钥，返回引用 |
| `vault` | `has(keyOrRef)` | `vault.write` | 判断密钥是否存在 |
| `vault` | `remove(keyOrRef)` | `vault.write` | 删除密钥 |
| `ssh` | `connect(input)` / `disconnect(id)` / `listSessions()` | `ssh.session` | 连接管理 |
| `ssh` | `write(id, data)` / `resize(id, cols, rows)` | `ssh.session` | 交互终端 |
| `ssh` | `exec(input)` | `ssh.exec` | 执行命令取结果 |
| `ssh` | `metrics.start/stop/latest` | `ssh.exec` | 服务器指标采样 |
| `ssh` | `completion.suggest(input)` | `ssh.exec` | 命令补全 |
| `ssh` | `sftp.list/download/upload/mkdir/rename/delete/chmod` | `ssh` | 文件传输与目录 / 权限操作 |
| `ssh` | `onSshTransfer(cb)` | 无 | 订阅 SFTP 传输进度（`ssh.transfer`） |
| `ssh` | `pickLocalFile(opts?)` | `ssh` | 选择本地文件/目录 |
| `db` | `test(config)` / `open(input)` / `close(key)` / `listSessions()` | `db.connect` | 连接管理 |
| `db` | `execute(input)` / `explain(input)` / `cancel(key)` | `db.query` | 查询执行 |
| `db` | `applyChanges(input)` | `db.query` | 表格化编辑回写 |
| `db` | `importPreview(input)` / `importRun(input)` | `db.query` | CSV 导入 |
| `db` | `schema.tree/describe/ddl` | `db.schema` | 库表结构 |
| `db` | `completion(input)` / `dialects.list()` | `db.schema` | SQL 补全 / 方言 |
| `db` | `pickSqliteFile()` / `pickImportFile()` | `db.connect` | 选择数据库文件 |
| — | `notify({ title?, body? })` | `notify` | 系统通知 |
| — | `on(event, cb)` / `off(event, cb)` | 无 | 通用事件 |
| — | `onEnter / onOut / onBeforeClose / onDestroy` | 无 | 生命周期 |
| — | `getLaunchMode()` / `onModeChange(cb)` | 无 | 读 / 订阅启动方式（quick / shell） |
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
| **返回** | `Promise<boolean>` |

Quick 内嵌时按内容尺寸调整小窗，并受 `window.minWidth` / `minHeight` 与显示器工作区限制。主窗 Tab 中仅记录建议，不改变用户窗口大小。插件始终应按实际 viewport 响应式布局，超出部分内部滚动；width / height 必须是正有限数。

```js
await enest.ui.resize({ width: 960, height: 640 })
```

---

### `ui.setHeight(height)`

上报插件期望的内容高度（Quick 命令面板内嵌场景使用）。

| | |
|--|--|
| **权限** | `ui.resize`（复用） |
| **参数** | `height: number` — 期望高度 px（正数） |
| **返回** | `Promise<boolean>` |
| **错误** | `invalid height`（非正数） |

?> Quick 内嵌场景下，壳子据此自动调整小窗高度；主窗 Tab 场景仅记录不动作。

```js
await enest.ui.setHeight(420)
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

读取壳子当前生效的主题变量。**规范入口是 `enest.theme.getTokens()`**，此方法为兼容别名，行为完全一致。

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

按插件 `manifest.ui.preferredColorScheme` 解析 **最终生效** 的主题变量。

| | |
|--|--|
| **权限** | 无 |
| **返回** | `Promise<{ mode: 'light' \| 'dark'; tokens: Record<string, string> }>` |

叠加顺序：**内置预设 → 活动主题包 → 用户 overrides**。`preferredColorScheme` 为 `light` / `dark` 时强制该配色；`auto` 跟随壳子（含系统主题）。

```js
const { mode, tokens } = await enest.theme.getTokens()
```

内置主题变量名（完整语义与默认色板见 [UI 集成标准](ui-standard.md)）：

`--bg` · `--surface` · `--surface-2` · `--surface-3` · `--border` · `--border-strong` · `--text` · `--text-2` · `--text-3` · `--accent` · `--accent-soft` · `--ok` · `--ok-soft` · `--danger` · `--danger-soft` · `--radius-xl/lg/md/sm/pill` · `--shadow-soft` · `--shadow-float` · `--font` · `--mono` · `--font-size-base`

**主题跟随**：`ui.themeAware` 缺省 `true`，插件应通过 `enest.theme.getTokens()`（首屏/Canvas）与 `enest.ui.onThemeChange`（运行时）读取主题变量。插件还 **建议** 在设置中注册布尔项 `followShellTheme`（缺省 `true`，经 `enest.settings.register` 或 `contributes.settings`）：为 `true` 时跟随壳子主题；为 `false` 时由插件钉住自有 `preferredColorScheme` 并自行绘制。设计规范与检查清单见 [UI 集成标准](ui-standard.md)。

---

### `theme.register(pack)`

把主题包注册进壳子「设置 → 主题」下拉列表。主题插件的主入口能力。

| | |
|--|--|
| **权限** | `theme`（运行时注册路径需声明；manifest `contributes.themePacks` 声明式路径同样计入本插件配额） |
| **参数** | `pack: ThemePack` |
| **返回** | `Promise<unknown>` — 注册后的主题包对象 |
| **错误** | `permission denied: theme`；`invalid theme pack: require id and name`；`theme pack id already registered by <src>`；`theme pack limit reached` 等（见 [错误码](errors.md)） |

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
    value: '#0a1f1c',
    opacity: 0.9
  }
})
```

**ThemePack 契约**（`@shared/types/plugin`）：

| 字段 | 必填 | 类型 | 说明 |
|------|------|------|------|
| `id` | ✓ | `string` | 全局唯一；同 id 覆盖注册（仅限自己的来源） |
| `name` | ✓ | `string` | 设置页下拉显示名 |
| `mode` | | `'light' \| 'dark' \| 'system'` | 主题模式（可选） |
| `tokens` | ✓ | `Record<string, string>` | CSS 变量覆盖，键名与壳子一致 |
| `source` | 自动 | `string` | 缺省为当前插件 id；内置为 `enest.builtin` |
| `background` | | `{ type, value, opacity?, fit? }` | 可选壳子背景 |

注册成功后主进程推送 `theme-packs-changed`，设置页 **即时刷新**，无需重启。

?> 每个插件最多注册 **8** 个主题包；只能修改自己注册的包；主题包取值会做安全校验，非法值会被忽略。

---

## hotkey — 全局热键

### `hotkey.register(accelerator, opts?)`

注册全局快捷键（Electron accelerator，如 `Control+Alt+P`）。

| | |
|--|--|
| **权限** | `hotkey` |
| **参数** | `accelerator: string`；`opts?: { label?: string }`（保留） |
| **返回** | `Promise<{ ok: boolean; error?: string }>` — 冲突/失败 **不 reject**，用 `ok: false` 携带原因 |
| **限制** | 每插件最多 4 个；与 Quick 当前生效热键、其它插件启动热键、其它插件运行时热键及系统/其它应用占用互斥 |

```js
const res = await enest.hotkey.register('Control+Alt+P')
if (!res.ok) console.warn('注册失败', res.error)

enest.hotkey.onHotkey(({ accelerator }) => {
  if (accelerator === 'Control+Alt+P') togglePanel()
})
```

插件运行时热键与「每插件启动热键」（`settings.pluginLaunch[id].hotkey`，设置 UI 在插件详情「快捷启动」区）共用全局热键空间：启动键保存前经 `shell:probe-launch-hotkey` 归属探测，插件启动键 / 运行时键冲突可经用户确认「接管」，Quick 当前生效键不可接管。

### `hotkey.unregister(accelerator)` / `hotkey.onHotkey(cb)`

注销热键（幂等，未注册也返回 `true`）；`onHotkey` 返回取消订阅函数。插件关闭时壳子自动批量注销其全部热键。

---

## i18n — 多语言

### `i18n.getLocale()`

| | |
|--|--|
| **权限** | 无 |
| **返回** | `Promise<'zh-CN' \| 'en-US'>` — 当前壳子界面语言 |

### `i18n.onLocaleChange(cb)`

订阅语言变更（壳子设置页切换语言时推送）。

| | |
|--|--|
| **权限** | 无 |
| **参数** | `cb: (event: { locale: 'zh-CN' \| 'en-US' }) => void` |
| **返回** | `() => void` |

```js
const locale = await enest.i18n.getLocale()
const off = enest.i18n.onLocaleChange(({ locale }) => switchDict(locale))
```

---

## contribute — 贡献点（Quick 搜索 provider）

贡献点机制的运行时入口：插件注册 Quick 搜索 provider 后，壳子搜索时把查询推给插件，插件回传结果项。**需在 `permissions` 声明 `contribute`。**

声明式贡献（`plugin.json` 的 `contributes` 段：settings / homeCards / railEntries / themePacks）不走本命名空间，由壳子扫描 manifest 时入库——见 [plugin.json](manifest.md)。

### `contribute.registerQuickProvider(meta)`

| | |
|--|--|
| **权限** | `contribute` |
| **参数** | `meta: { id: string; explain?: string; schemaVersion?: string }` |
| **返回** | `Promise<{ ok: true } \| { ok: false; error?: string }>` — 失败不 reject |

### `contribute.unregisterQuickProvider(providerId)`

注销本插件的某个 provider（幂等）。插件关闭时壳子自动批量释放其全部 provider。

### `contribute.onQuickQuery(cb)`

订阅 Quick 搜索查询；等价 `enest.on('quick-query', cb)`。

| | |
|--|--|
| **参数** | `cb: (event: { reqId: string; query: string }) => void` |
| **返回** | `() => void` — 取消订阅 |

### `contribute.respondQuickQuery(reqId, items)`

回传查询结果。**`reqId` 来自 `onQuickQuery` 回调；超时（500ms）后回传被静默丢弃**，请在回调内尽快响应。

| | |
|--|--|
| **权限** | `contribute` |
| **参数** | `reqId: string`；`items: Array<{ id?; title?; subtitle?; explain?; code? }>` |
| **返回** | `Promise<boolean>` |

```js
await enest.contribute.registerQuickProvider({ id: 'search', explain: '搜索我的笔记' })

enest.contribute.onQuickQuery(async ({ reqId, query }) => {
  const items = (await searchNotes(query)).map((n) => ({
    id: n.id,
    title: n.title,
    subtitle: '笔记',
    code: 'open-note' // 选中回车后 openPlugin 以该 code 进入插件
  }))
  await enest.contribute.respondQuickQuery(reqId, items)
})
```

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
| `items[].type` | 控件类型：`text` / `string` / `switch` / `boolean` / `bool` / `select`（含 `options`）/ `number` / `slider`（含 `min` / `max` / `step`）/ `color`；`page` 为预留（需 `settings.page` 权限，本期仅声明）。非法类型渲染层回退 `text` |
| `items[].label` | 控件标签 |
| `items[].default` | 默认值（可选） |
| `items[].options` | `select` 的选项列表 `Array<{ label, value }>` |
| `items[].min` / `max` / `step` | `slider` 的范围与步长 |

---

### `settings.get(key)`

读取插件设置值。优先从设置桥读取，否则回落到壳子已持久化的插件设置。**只能读取注册过的设置项**（`settings.register` 或 `contributes.settings` 声明的 key）。

| | |
|--|--|
| **权限** | 无（由 Bridge / SettingsStore 管控） |
| **参数** | `key: string` |
| **返回** | `Promise<unknown>` — 未设置时为 `undefined` |
| **错误** | `unknown settings key: <key>`（读取未注册的 key） |

```js
const name = await enest.settings.get('name')
```

---

### `settings.set(key, value)`

写入插件设置，同时更新内存桥与持久化存储。**只能写注册过的设置项**。

| | |
|--|--|
| **权限** | 无 |
| **参数** | `key: string`，`value: unknown` |
| **返回** | `Promise<boolean>` |
| **错误** | `unknown settings key: <key>`（写入未注册的 key） |

```js
await enest.settings.set('name', '世界')
```

---

## storage — 数据持久化

两套存储语义对比：

| | `storage.*`（local） | `storage.session.*` |
|--|----------------------|---------------------|
| 介质 | SQLite（`~/.eNest` 数据根下 `enest.db` 的 `plugin_storage` 表，按 `plugin_id + key` 隔离） | 主进程内存 Map |
| 写入策略 | 50ms 合并写（脏键批量事务落库）；配额：每插件 1000 键、单值 512KB | 即时内存 |
| 生命周期 | 关 Tab **保留**；卸载清理 | 插件关闭 / 应用退出即清空（休眠有快照恢复） |
| 权限 | `storage.local` | `storage.local`（复用，无需单独声明） |

### `storage.get(key)` / `storage.set(key, value)` / `storage.remove(key)` / `storage.clear()`

| | |
|--|--|
| **权限** | `storage.local` |
| **参数** | `key: string`；`set` 另需 `value: unknown`（任意 JSON 可序列化值） |
| **返回** | `get → Promise<unknown>`；其余 `Promise<boolean>` |
| **错误** | `permission denied: storage.local`；`storage quota exceeded`（每插件 >1000 键或单值 >512KB） |

```js
await enest.storage.set('prefs', { theme: 'dark', compact: true })
const prefs = await enest.storage.get('prefs')
await enest.storage.remove('prefs')
await enest.storage.clear()
```

值经 `JSON` 序列化写入，**不要**存函数、循环引用或超大二进制（单值 >512KB 会触发 `storage quota exceeded`）。

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

### `clipboard.readImage()`

读取系统剪贴板中的图片（PNG dataURL 形式返回）。

| | |
|--|--|
| **权限** | `clipboard.readImage` |
| **返回** | `Promise<{ dataUrl: string; width: number; height: number } \| null>` — 无图片时 `null` |

```js
const img = await enest.clipboard.readImage()
if (img) console.log(img.width, img.height, img.dataUrl.slice(0, 30))
```

### `clipboard.writeImage(dataUrl)`

把图片写入系统剪贴板。

| | |
|--|--|
| **权限** | `clipboard.writeImage` |
| **参数** | `dataUrl: string` — `data:image/...` 格式 |
| **返回** | `Promise<boolean>` |
| **错误** | `invalid image dataUrl`（非 data:image 前缀）；`invalid image data`（解码为空图） |

```js
const { dataUrl } = await enest.screen.capture()
await enest.clipboard.writeImage(dataUrl)
```

### `clipboard.history.*` — 剪贴板历史

主机侧剪贴板历史（list 不含完整二进制；`get` 返回完整字段）。

| 方法 | 参数 | 返回 | 说明 |
|------|------|------|------|
| `list(opts?)` | `{ limit?: number }`（缺省 100） | `Promise<ClipboardHistoryEntry[]>` | 历史列表（轻量字段） |
| `get(id)` | `id: string` | `Promise<(ClipboardHistoryEntry & { dataUrl? }) \| null>` | 单条详情，图片含 dataUrl |
| `remove(id)` | `id: string` | `Promise<boolean>` | 删除一条 |
| `clear()` | — | `Promise<boolean>` | 清空历史 |
| `togglePin(id)` | `id: string` | `Promise<ClipboardHistoryEntry>` | 置顶/取消置顶 |

统一需 `clipboard.history` 权限。`ClipboardHistoryEntry` 字段：`id / type: 'text' | 'image' / preview / text? / hasImage? / width? / height? / ts / pinned / bytes?`。历史变化经 `clipboard-history-changed` 事件推送 `{ entryId, entryType }`。

```js
const list = await enest.clipboard.history.list({ limit: 20 })
const entry = await enest.clipboard.history.get(list[0].id)
if (entry?.hasImage) showImage(entry.dataUrl)
```

---

## screen — 屏幕截图与录屏

?> **macOS 屏幕录制权限（TCC）**：`screen.*` 在 macOS 受系统「屏幕录制」门禁（`getMediaAccessStatus('screen')`）。首次调用会弹系统授权框；被拒后需到 系统设置 → 隐私与安全性 → 屏幕录制 中开启并 **重启 eNest**。系统层面已拒绝时调用直接报 `os permission denied: screen`（见 [错误码](errors.md)）。Linux Wayland 下截屏经系统 portal（壳子已启用 WebRTCPipeWireCapturer）；Windows 无额外系统门。

### `screen.capture(opts?)`

截取指定显示器的全部或局部区域。

| | |
|--|--|
| **权限** | `screen.capture` |
| **参数** | `opts?: { displayId?: number; bounds?: ScreenBounds }` — 缺省主屏全屏；`bounds` 为设备像素（相对该 display），越界部分自动裁交 |
| **返回** | `Promise<{ dataUrl: string; width: number; height: number }>` — PNG dataURL 与裁剪后尺寸 |
| **错误** | `permission denied: screen.capture`；`screen capture failed: no display source` |

```js
const shot = await enest.screen.capture({ displayId, bounds: { x, y, width, height } })
```

### `screen.selectRegion()`

拉起全屏区域选择遮罩，用户框选一个矩形（设备像素，相对 capture 的 display）。

| | |
|--|--|
| **权限** | `screen.capture`（与截图共用） |
| **返回** | `Promise<ScreenBounds \| null>` — 用户取消时 `null` |

```js
const bounds = await enest.screen.selectRegion()
if (bounds) await enest.screen.capture({ bounds })
```

### `screen.record.start(opts?)` / `stop(sessionId)` / `cancel(sessionId)`

矩形录屏（webm，写入壳子数据根 `recordings/` 目录）。

| 方法 | 参数 | 返回 |
|------|------|------|
| `start` | `opts?: { bounds?: ScreenBounds; withAudio?: boolean; displayId?: number }` | `Promise<{ sessionId: string }>` |
| `stop` | `sessionId: string` | `Promise<{ path: string; size: number; durationMs: number }>` — 产物绝对路径 / 字节 / 时长 |
| `cancel` | `sessionId: string` | `Promise<boolean>` — 丢弃录制 |

统一需 `screen.record` 权限。同一时刻只允许一个录制会话（`recording already in progress`）；`stop` 返回未知的 sessionId 报 `recording session not found: <id>`。

```js
const { sessionId } = await enest.screen.record.start({ withAudio: true })
// …
const done = await enest.screen.record.stop(sessionId)
console.log(done.path, done.size, done.durationMs)
```

---

## pin — 屏幕贴图

置顶展示截图 / 图片的无边框小窗（可拖动、滚轮缩放、Esc 关闭）。

### `pin.open(payload)`

| | |
|--|--|
| **权限** | `pin.create` |
| **参数** | `payload: { dataUrl?: string; path?: string; x?: number; y?: number; width?: number; title?: string }` — **当前仅接受 `dataUrl`**（`data:image/(png|jpeg|jpg|gif|webp);base64,` 格式；`path` 通道关闭，防任意本地文件读取）；`x/y/width` 为初始位置与宽度（缺省居中、360px，受工作区限制） |
| **返回** | `Promise<{ pinId: string }>` |
| **错误** | `pin.open requires image dataUrl` |

```js
const { dataUrl } = await enest.screen.capture()
const { pinId } = await enest.pin.open({ dataUrl, width: 420, title: '参考图' })
```

### `pin.close(pinId)` / `pin.closeAll()` / `pin.list()`

| 方法 | 返回 | 说明 |
|------|------|------|
| `close(pinId)` | `Promise<boolean>` | 关闭单张（只能关自己创建的贴图；不存在或非本插件贴图返回 `false`） |
| `closeAll()` | `Promise<number>` | 关闭本插件全部贴图，返回数量 |
| `list()` | `Promise<Array<{ pinId: string }>>` | 列出本插件存活的贴图 |

统一需 `pin.create` 权限。

---

## net — 受控网络请求

### `net.fetch(req)`

受控 HTTPS 请求，用于调用开放 API / 拉取文本资源。

| | |
|--|--|
| **权限** | `net.fetch` |
| **参数** | `req: { url: string; method?: 'GET' \| 'POST'; headers?: Record<string, string>; body?: string; timeoutMs?: number }` |
| **返回** | `Promise<{ status: number; headers: Record<string, string>; body: string }>` |

硬约束（超限直接 reject，见 [错误码](errors.md)）：

- **仅 https**：URL 与每一跳重定向都必须是 `https://`（手动逐跳跟随，最多 5 跳，阻断 http / 内网跳转 SSRF）
- **仅 GET / POST**
- **响应体上限 2MB**（先看 `content-length`，再按实际字节复核）
- **超时**：默认 15s，可传 `timeoutMs` 调整（下限 1s、上限 60s）；超时报 `net.fetch timeout`

```js
const res = await enest.net.fetch({
  url: 'https://api.example.com/v1/quote',
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ lang: 'zh' }),
  timeoutMs: 10_000
})
if (res.status === 200) console.log(res.body)
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
| **错误** | `permission denied: shell.openExternal`；`only http(s)/mailto/tel urls allowed` |

允许的 scheme：`http` / `https` / `mailto` / `tel`。`file://`、`javascript:`、自定义协议一律拒绝。插件页面里的 `window.open` / `<a target="_blank">` 外链同样统一经该权限门禁后交系统打开。

```js
await enest.shell.openExternal('https://github.com')
```

### `shell.saveTextFile(payload)`

弹出系统保存对话框，把文本内容写入用户选择的路径。

| | |
|--|--|
| **权限** | `shell.openExternal`（与打开链接共用同一权限） |
| **参数** | `payload: { defaultName?: string; filename?: string; content: string }` |
| **返回** | `Promise<{ ok: boolean; path: string } \| null>` — 用户取消时返回 `null` |

```js
const saved = await enest.shell.saveTextFile({
  defaultName: 'report.md',
  content: markdownText
})
if (saved) enest.ui.toast({ message: `已保存到 ${saved.path}` })
```

---

## vault — 密钥保险库

保存连接口令、API token 等敏感信息。**只写不读**：存入后返回一个 `secretRef` 引用，之后把引用传给 SSH / 数据库连接参数，明文不会回到插件页。

### `vault.set(key, secret)`

| | |
|--|--|
| **权限** | `vault.write` |
| **参数** | `key: string`（插件内唯一的标识，如 `prod-db`）；`secret: string` |
| **返回** | `Promise<{ secretRef: string }>` |

### `vault.has(keyOrRef)` / `vault.remove(keyOrRef)`

| | |
|--|--|
| **权限** | `vault.write` |
| **参数** | `keyOrRef: string` — 存入时的 key 或返回的 secretRef 均可 |
| **返回** | `Promise<boolean>` |

```js
const { secretRef } = await enest.vault.set('prod-db', password)
// 之后连接时只传引用，不再持有明文
await enest.db.open({ config: { driver: 'mysql', host, username, secretRef } })
```

---

## ssh — 远程服务器

交互式终端、命令执行、指标采集与文件传输。密钥认证支持 `secretRef`（来自 vault）或一次性明文。

### `ssh.connect(input)`

| | |
|--|--|
| **权限** | `ssh` |
| **参数** | `input: SshConnectInput`（见下） |
| **返回** | `Promise<SshSessionInfo>`（含 `sessionId`） |

`SshConnectInput` 主要字段：

| 字段 | 类型 | 说明 |
|------|------|------|
| `host` | `string` | 必填 |
| `username` | `string` | 必填 |
| `port` | `number?` | 缺省 22 |
| `authType` | `'password' \| 'key' \| 'agent'?` | 认证方式 |
| `secretRef` | `string?` | vault 引用（推荐） |
| `password` | `string?` | 一次性口令（不落盘） |
| `privateKeyPath` | `string?` | 本地私钥路径 |
| `jump` | `SshJumpConfig?` | 跳板机（字段同上，`host`/`username` 必填） |
| `cols` / `rows` / `term` | | 终端初始尺寸与类型 |
| `timeoutMs` / `keepAliveSec` | | 连接超时与保活 |

### `ssh.write(sessionId, data)` / `ssh.resize(sessionId, cols, rows)`

向交互终端写入输入（含 `\r` 回车）或同步终端尺寸。返回 `Promise<boolean>`。终端输出经 `ssh.data` 事件推送（见事件总线）。

### `ssh.exec(input)`

一次性执行命令并等待结果，适合脚本化操作（不需要交互终端）。

| | |
|--|--|
| **参数** | `input: { sessionId?, command? \| cmd?, timeoutMs?, host?, username?, ... }` — 已有会话传 `sessionId`，否则可用连接字段直接执行（自动建连） |
| **返回** | `Promise<{ stdout: string; stderr: string; exitCode: number \| null; durationMs: number }>` |

```js
const r = await enest.ssh.exec({ sessionId, command: 'df -h' })
console.log(r.exitCode, r.stdout)
```

### `ssh.metrics.start(sessionId, intervalMs?)` / `stop` / `latest`

采样 CPU / 内存 / 磁盘 / 网卡 / 进程 Top。`start` 返回 `{ ok, intervalMs }`；采样数据经 `ssh.metrics` 事件推送，`latest()` 随时取最近一份。

### `ssh.completion.suggest(input)`

给自建终端 UI 做命令补全。入参 `{ sessionId, line, cursor?, history?, snippets? }`，返回 `{ items: Array<{ label, kind, insertText, dangerous? }>, danger? }`（`dangerous` 非空时建议在 UI 上标红确认）。

### `ssh.sftp.list / download / upload / mkdir / rename / delete / chmod`

统一需 `ssh.sftp` 权限；参数均支持对象形 `{ sessionId, ... }` 或位置参数（已连接时也可直接传连接字段自动建连）。

| 方法 | 参数 | 返回 |
|------|------|------|
| `list` | `{ sessionId?, path? }` | `Promise<SftpEntry[]>` — `name/type/size/mtime` |
| `download` | `{ sessionId?, remotePath?, localPath? }` | `Promise<SftpTransferResult>` |
| `upload` | `{ sessionId?, localPath?, remotePath? }` | `Promise<SftpTransferResult>` |
| `mkdir` | `(sessionId, path)` | `Promise<boolean>` — 新建远程目录 |
| `rename` | `(sessionId, path, newPath)` | `Promise<boolean>` — 重命名 / 移动 |
| `delete` | `(sessionId, path, recursive?)` | `Promise<boolean>` — 删除文件 / 目录（目录递归需 `recursive: true`） |
| `chmod` | `(sessionId, path, mode)` | `Promise<boolean>` — `mode` 为八进制数字或字符串（如 `0o755` / `'755'`） |

```js
await enest.ssh.sftp.mkdir(sessionId, '/srv/app/logs')
await enest.ssh.sftp.chmod(sessionId, '/srv/app/logs', '755')
await enest.ssh.sftp.rename(sessionId, '/srv/app/old.conf', '/srv/app/new.conf')
await enest.ssh.sftp.delete(sessionId, '/srv/app/tmp', true)
```

### `ssh.onSshTransfer(cb)`

订阅 SFTP 传输进度（`download` / `upload` 过程推送）；等价 `enest.on('ssh.transfer', cb)`。

| | |
|--|--|
| **参数** | `cb: (event: SshTransferEvent) => void` |
| **返回** | `() => void` — 取消订阅 |

`SshTransferEvent`：`{ sessionId, direction: 'upload' \| 'download', path, transferred, total, done?, error? }`。`total` 为 0 表示未知（预取大小失败）；进度按时间 / 字节双阈值节流推送，终态（成功 `done: true` / 失败 `done: true, error`）不受节流约束。

```js
const off = enest.ssh.onSshTransfer(({ direction, path, transferred, total, done, error }) => {
  const pct = total ? Math.round((transferred / total) * 100) : '?'
  console.log(`${direction} ${path}: ${pct}%${done ? (error ? ` 失败: ${error}` : ' 完成') : ''}`)
})
```

### `ssh.disconnect(sessionId)` / `ssh.listSessions()`

断开会话 / 列出当前会话。插件关闭或休眠时壳子会自动回收它的全部 SSH 会话，无需手动处理。

### `ssh.pickLocalFile(opts?)`

弹出系统文件选择框。

| | |
|--|--|
| **参数** | `opts?: { properties?: Array<'openFile' \| 'openDirectory'>; mode?: 'file' \| 'dir' }` |
| **返回** | `Promise<string \| null>` — 用户取消时 `null` |

---

## db — 数据库

支持 MySQL / SQLite / InfluxDB / Timescale / TDengine。凭据与 vault 集成，插件关闭时自动回收连接。

### `db.test(config)` / `db.open(input)` / `db.close(sessionKey)`

| | |
|--|--|
| `test` | 参数 `DbConnectionConfig`，返回 `{ ok, message, version?, latencyMs? }`，只验连不建会话 |
| `open` | 参数 `{ config, sessionKey? }` 或直接 `config`，返回 `DbSessionInfo`（后续调用都用 `sessionKey`） |
| `close` | 参数 `sessionKey`，返回 `Promise<boolean>` |

`DbConnectionConfig` 常用字段：

| 字段 | 说明 |
|------|------|
| `driver` | 必填：`mysql` / `sqlite` / `influxdb` / `timescale` / `tdengine` |
| `host` / `port` / `database` / `username` | 连接信息 |
| `secretRef` / `ephemeralSecret` | vault 引用（推荐）或一次性口令 |
| `filePath` / `createIfMissing` | SQLite 本地库文件 |
| `org` / `bucket` | InfluxDB v2 |
| `readOnly` | 只读连接（推荐查询类插件开启） |

### `db.execute(input)`

| | |
|--|--|
| **参数** | `input: { sessionKey, sql, params?, maxRows?, timeoutMs?, confirmed? }` |
| **返回** | `Promise<QueryResult>` — `{ columns, rows, rowCount, durationMs, truncated? ... }` |

- `params` 支持 `?` 位置占位与 `:name` 命名占位，请始终用参数化查询拼接用户输入。
- 生产 / 受保护连接执行写操作时需 `confirmed: true`（对应错误见 [错误码](errors.md)）。
- `truncated: true` 表示命中 `maxRows` 上限被截断。

```js
const info = await enest.db.open({
  config: { driver: 'mysql', host, username, secretRef, database: 'app' }
})
const { rows, columns } = await enest.db.execute({
  sessionKey: info.sessionKey,
  sql: 'SELECT id, name FROM users WHERE status = ? LIMIT 50',
  params: ['active']
})
```

### `db.explain(input)` / `db.cancel(sessionKey)`

`explain` 取执行计划（`{ sessionKey, sql }` → `QueryResult`）；`cancel` 中断该会话上正在执行的查询。

### `db.applyChanges(input)`

把表格化编辑（用户在结果网格里改的值）合成为 SQL 批量回写。

| | |
|--|--|
| **参数** | `input: { sessionKey, changes: RowChange[], mode?: 'stop-on-error' \| 'continue', confirmed? }` |
| **返回** | `Promise<BatchResult>` — 每条变更一个 `{ index, ok, affected?, error? }` |

`RowChange` 三种形态：`update`（`table + key + set`）、`insert`（`table + values`）、`delete`（`table + key`）。

### `db.importPreview(input)` / `db.importRun(input)`

CSV 导入两步流：先 `importPreview` 看列映射与 SQL 预览（`{ columns, sampleRows, mappedColumns, sqlPreview }`），确认后 `importRun` 执行（`{ ok, inserted, failed, errors? }`）。数据源传 `csvText`，或先 `pickImportFile()` 选文件后传 `filePath`。`conflict` 策略支持 `insert / upsert / skip`。

### `db.schema.tree / describe / ddl`

| 方法 | 参数 | 返回 |
|------|------|------|
| `tree` | `{ sessionKey, database?, schema?, table?, filter? }` | `SchemaObject[]` — 库/表/列树 |
| `describe` | `{ sessionKey, table, database?, schema? }` | `TableDetail` — 列、主键、索引 |
| `ddl` | 同上 | `Promise<string>` — 建表语句 |

### `db.completion(input)` / `db.dialects.list()`

`completion` 给 SQL 编辑器做补全：入参 `{ sessionKey, sql, cursor? }`，返回 `{ replace: { from, to }, items }`，直接对接编辑器替换区间。**`db.completion.suggest(input)` 为规范全名**，`db.completion(input)` 是可直接调用的兼容别名（同一方法，二选一即可）。`dialects.list()` 返回各驱动方言信息（关键字、函数、代码片段）。

### `db.pickSqliteFile()` / `db.pickImportFile()`

系统文件选择框：前者限定 SQLite 库文件，后者限定 CSV 等导入文件。只允许使用选择器返回的路径。

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
| `enter` | 首次加载完成 / Tab 激活 / 唤醒重建 | `{ tabId, code?, payload?, mode? }` |
| `out` | 切到其它 Tab / Quick 退场 | `{ isKill: false }` |
| `beforeClose` | 即将销毁 | `{ reason }` |
| `destroy` | 关闭已开始 | `undefined` |
| `mode-change` | 启动方式变化（quick ↔ shell 容器迁移，如 ⌘Enter 固定到主窗；不重载页面） | `{ mode }` |
| `theme-change` | 主题变更 | `{ mode, tokens }` |
| `hotkey` | 插件注册的全局热键被按下 | `{ accelerator }` |
| `locale-change` | 壳子界面语言变更 | `{ locale }` |
| `quick-query` | Quick 搜索查询（已注册 provider 的插件） | `{ reqId, query }` |
| `ssh.data` | SSH 终端有新输出 | `{ sessionId, data }` |
| `ssh.exit` | SSH 交互终端退出 | `{ sessionId, code?, signal? }` |
| `ssh.error` | SSH 会话错误 / 断开 | `{ sessionId?, message }` |
| `ssh.metrics` | 指标采样推送（`metrics.start` 后） | `{ sessionId?, profileId?, sample }` |
| `ssh.transfer` | SFTP 传输进度（`sftp.download/upload` 过程） | `{ sessionId, direction, path, transferred, total, done?, error? }` |
| `clipboard-history-changed` | 剪贴板历史新增 / 变更 | `{ entryId, entryType }` |

回调抛错会被捕获，**不会**影响其它监听器。

---

## 生命周期

完整状态机见 [生命周期](lifecycle.md)。

### `onEnter(cb)`

进入插件：**首次加载完成后** + **每次 Tab 激活** + **休眠唤醒 / crash 重启的重建完成后**。与 `onOut` 成对，可用来 pause / resume；插件可能被销毁重建，初始化逻辑要可重入。

| | |
|--|--|
| **参数** | `cb: (event: { tabId: string; code?: string; payload?: unknown; mode?: 'quick' \| 'shell' }) => void` |
| **返回** | `() => void` — 取消订阅 |

```js
enest.onEnter(({ tabId, code, payload, mode }) => {
  console.log('进入', tabId, code, payload, mode)
})
```

`code` / `payload` 来自 `openPlugin` 的进入载荷，对应 `features[].code` 与透传数据；`mode` 为本次进入的启动方式（quick / shell），与 `getLaunchMode()` 一致。

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

即将销毁：Tab 关闭 / 卸载插件 / 应用退出。可在此 flush 草稿。

| | |
|--|--|
| **参数** | `cb: (event: { reason: 'tab-close' \| 'uninstall' \| 'app-quit' }) => void \| Promise<unknown>` |
| **返回** | `() => void` |

- 回调返回 **Promise** 时，preload 会等它 settle 后再回 ack（关闭流程随之等待）。
- 纯同步回调 / 无监听器时，preload 延迟一小窗口（约 50ms，给同步 flush 留余量）再 ack。
- 主进程最多等待约 1500ms 超时兜底；超长异步操作请自行拆分。

```js
enest.onBeforeClose(async ({ reason }) => {
  // 返回 Promise：壳子会等这里完成后再销毁
  await flushDraftToStorage()
})
```

### `onDestroy(cb)`

关闭已开始（best-effort）。清理逻辑请放在 `onBeforeClose`。

| | |
|--|--|
| **参数** | `cb: () => void` |
| **返回** | `() => void` |

---

## 启动方式（launch mode）

插件的渲染容器由打开入口决定：Quick 快捷启动 → `quick`（小窗内嵌），主窗（市场 / 圆轨 / Tab）→ `shell`（主窗 Tab）。用户可为每插件覆盖（`settings.pluginLaunch[id]`）。插件据此在「小窗样式」与「桌面样式」两套入口样式间切换，详见 [UI 集成标准 → 双入口样式](ui-standard.md)。

### `getLaunchMode()`

| | |
|--|--|
| **返回** | `'quick' \| 'shell'` — 当前启动方式 |
| **同步** | 是，不走 IPC（URL 初始值 + 事件实时更新） |

```js
const mode = enest.getLaunchMode()
if (mode === 'quick') renderCompact()
else renderFull()
```

URL query 中的 `?mode=quick|shell`（与 `?pid` / `?code` 并列）只是**初始值**，首个脚本可同步读取；容器迁移后 URL 不再代表当前值，运行时一律以 `getLaunchMode()` / `onModeChange` 为准。

### `onModeChange(cb)`

订阅启动方式变更。quick ↔ shell 容器迁移（⌘Enter 固定到主窗等）**不重载页面**，只推送本事件。

| | |
|--|--|
| **权限** | 无 |
| **参数** | `cb: (event: { mode: 'quick' \| 'shell' }) => void` |
| **返回** | `() => void` — 取消订阅 |

```js
const off = enest.onModeChange(({ mode }) => {
  document.documentElement.dataset.mode = mode
})
```

等价通用写法（`plugin:event` 通道推送）：

```js
enest.on('mode-change', ({ mode }) => applyMode(mode))
```

| 事件 | 数据 |
|------|------|
| `mode-change` | `{ mode: 'quick' \| 'shell' }` |

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

完整 `window.enest` 接口声明见 [TypeScript 类型](api-types.md)（由 `scripts/generate-api-types.mjs` 自动生成，勿手改）。推荐安装 **`@enest/plugin-sdk`** 包（位于壳子仓库 `packages/plugin-sdk`，含 d.ts 与 manifest 校验 CLI），或将生成的 d.ts 拷入插件工程：

```text
packages/plugin-sdk/src/enest-api.d.ts   ← 自动生成，与 preload 严格一致
```

推荐插件内的安全用法：

```ts
const api = (window as { enest?: EnestPluginApi }).enest
if (!api) {
  // 本地浏览器直开 / 未挂载壳子
  console.warn('eNest API 不可用')
}
```

---

## 安全模型要点

1. **无 Node**：插件页不能 `require('electron')`，不能访问任意文件系统。
2. **权限门禁**：未在 `plugin.json` 的 `permissions` 声明的调用被拒绝；已声明的能力还受运行时三态授权（allow / ask / deny）约束（见 [权限说明](permissions.md)）。
3. **身份绑定**：调用仅接受壳子管理的插件页面；伪造 `pluginId` 返回 `plugin id mismatch`。
4. **协议隔离**：`enest://plugin/{id}/...` 只映射该插件根目录，路径穿越会被拒。
5. **partition 隔离**：每个插件独立 `persist:plugin-{id}`，cookie / localStorage 互不可见。

→ 权限完整表见 [权限说明](permissions.md)  
→ 错误字符串见 [错误码](errors.md)
