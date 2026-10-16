# enest API 完整参考

eNest 在每个插件页注入 **`window.enest`**，同时暴露别名 **`window.zapi`**（两者是同一个对象）。

> **`zapi` 为 `@deprecated` 历史别名**：保留兼容，计划 v2 移除。新代码统一使用 `enest.*`；本地调试需要双名兜底时写 `window.enest`（壳子环境必有）。

所有能力调用统一进入主进程，完成 **窗口 / 主 frame / 精确 origin / 运行代次校验 → pluginId 匹配 → 基础能力放行 / 敏感能力授权 → 方法分发** 四步。

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
                              敏感能力声明并授权?   ──否──► permission denied
                              （基础能力跳过此步）
                              dispatch(method, args)
        │
        ▼
resolve({ ok: true, data })
```

失败时 Promise **reject**，`Error.message` 为上图中的错误字符串（见 [错误码](errors.md)）。

**能力与授权分开**：私有存储、插件 UI、设置、声明式入口、主题和私有密钥保存是基础能力，无需声明或单项授权。其它敏感能力需要在 manifest 声明，并使用按插件保存的 `allow / ask / deny`（默认 `ask`）；`ask` 时由主进程原生对话框询问，超时拒绝。设置页可随时调整敏感授权，撤权会关闭当前实例并回收资源。插件可以自行实现任意前端业务，权限清单只约束敏感资源访问，见 [权限说明](permissions.md)。

?> **开发模式差异**：API 行为在两种开发模式下一致，但运行约束不同——**dev（开发）模式**连接开发服务时放宽 script CSP 并放行该 origin 的 HMR WebSocket；**prod（正式包）模式**与正式安装完全一致，使用生产 CSP 与标准产物路径。内联脚本、开发态网络假设等宽松行为只有在 prod 模式（或解包 `.enestplugin`）下才能暴露。模式切换与启动命令解析见[开发加载](debug.md)。

---

## 方法索引

从 0.2.0 起，`db.*`、`mw.*`、`ssh.*` 的协议业务由调用方自己的插件后端实现；除 `db.pickSqliteFile`、`ssh.pickLocalFile` 两个宿主文件选择器外，这些 API 在表中所列权限之外还要求 `backend.node`。旧授权不包含完整 Node 信任；缺少后端的旧包需要更新。它们保留专用门面的会话/取消语义，不与 `backend.call` 的通用进程混用，见[迁移与兼容边界](backend.md)。

| 命名空间 | 方法 | 权限 | 说明 |
|---------|------|------|------|
| `backend` | `call(method, args?)` | `backend.node` | 调用本插件的 Node 后端；事件经 backend.event 接收，见[后端协议与预算](backend.md) |
| `ui` | `setTitle(title)` | 基础能力 | 设置 Tab 标题 |
| `ui` | `setIcon(icon)` | 基础能力 | 设置 Tab 图标 |
| `ui` | `setBadge(badge)` | 基础能力 | 设置角标 |
| `ui` | `resize(size)` | 基础能力 | 兼容尺寸建议，保持容器尺寸 |
| `ui` | `setHeight(height)` | 基础能力 | 兼容高度建议，保持容器尺寸 |
| `ui` | `dismissQuick()` | 基础能力 | 提交即收起 Quick 小窗（仅 quick 挂载者生效） |
| `ui` | `toast({ title?, body?, format?, position?, level?, duration? })` | 基础能力 | 当前原生容器内的安全富文本通知 |
| `ui` | `getThemeTokens()` | 无 | 读主题变量（别名） |
| `ui` | `onThemeChange(cb)` | 无 | 订阅主题变更 |
| 基础能力 | `getTokens()` | 无 | 读当前主题变量 |
| 基础能力 | `register(pack)` | 基础能力 | 注册主题包（≤8 个/插件） |
| `hotkey` | `register(acc, opts?)` | `hotkey` | 注册全局热键 |
| `hotkey` | `unregister(acc)` | `hotkey` | 注销全局热键 |
| `hotkey` | `onHotkey(cb)` | 无 | 订阅热键触发 |
| `i18n` | `getLocale()` | 无 | 读壳子语言 |
| `i18n` | `onLocaleChange(cb)` | 无 | 订阅语言变更 |
| 基础能力 | `registerQuickProvider(meta)` | 基础能力 | 注册 Quick 搜索 provider |
| 基础能力 | `unregisterQuickProvider(id)` | 基础能力 | 注销 provider |
| 基础能力 | `onQuickQuery(cb)` | 无 | 订阅 Quick 搜索查询（门禁在 `registerQuickProvider`，纯订阅不校验） |
| 基础能力 | `respondQuickQuery(reqId, items)` | 基础能力 | 回传查询结果 |
| `settings` | `register(section)` | 基础能力 | 注册设置分组 |
| `settings` | `get(key)` | 无 | 读插件设置 |
| `settings` | `set(key, value)` | 无 | 写插件设置 |
| `storage` | `get/set/remove/clear` | 基础能力 | 持久化 KV |
| `storage.session` | `get/set/remove/clear` | 基础能力 | 会话态 KV |
| `clipboard` | `readText()` | `clipboard.read` | 读纯文本 |
| `clipboard` | `writeText(text)` | `clipboard.write` | 写纯文本 |
| `clipboard` | `readImage()` | `clipboard.readImage` | 读图片 dataURL |
| `clipboard` | `writeImage(dataUrl)` | `clipboard.writeImage` | 写图片 |
| `clipboard.history` | `list/get/remove/clear/togglePin` | `clipboard.history` | 剪贴板历史 |
| `screen` | `capture({ displayId?, bounds? })` | `screen.capture` | 截图 |
| `screen` | `selectRegion()` | `screen.capture` | 全屏区域选择 |
| `screen.record` | `start/stop/cancel` | `screen.record` | 矩形录屏 |
| `pin` | `open/close/list/closeAll` | `pin.create` | 贴图窗口 |
| `net` | `fetch({ url, method?, headers?, body?, timeoutMs?, stream? })` | `net.fetch` | 受控 HTTP(S) / 流式 / SSE |
| `net.socket` | `connect/send/close/list` / `serveWs(socketId)` | `net.socket` | 出站 TCP + 本地 ws 桥 |
| `net` | `onNetData(cb)` / `onNetClose(cb)` / `onChunk(cb)` | 无（纯订阅） | `net.data` / `net.close` / `net.chunk` 事件 |
| `agent` | `apps()` | 无 | 支持的应用及安装、活跃状态，不返回配置内容 |
| `agent` | `read(app)` / `write({ app, changes, confirmed })` / `backups(app)` / `restore({ app, id })` / `listAssets` / `writeAssets` / `deleteAssets` | `config.agent.read` / `config.agent.write` | AI CLI 配置白名单读写（自动快照）+ 资产文件通道（如 codex pets/） |
| `sys` | `processes()` / `ports()` / `kill(pid, opts)` | `sys.inspect` / `sys.control` | 本机进程 / 端口 / 结束确认 |
| `shell` | `openExternal(url)` | `shell.openExternal` | 系统浏览器打开 |
| `shell` | `saveFile(payload)` / `saveTextFile(payload)` | 基础能力 | 用户经原生对话框选定保存位置后写入 |
| `focusTimer` | `start/get/pause/resume/skip/stop/updateRecord` | 基础能力 | 本插件后台计时与记录；计时通知仍受 `notify` 声明与拒绝设置控制 |
| `vault` | `set(key, secret)` | 基础能力 | 存密钥，返回引用 |
| `vault` | `has(keyOrRef)` | 基础能力 | 判断密钥是否存在 |
| `vault` | `remove(keyOrRef)` | 基础能力 | 删除密钥 |
| `ssh` | `connect(input)` / `disconnect(id)` / `listSessions()` | `ssh.session` | 连接管理 |
| `ssh` | `write(id, data)` / `resize(id, cols, rows)` | `ssh.session` | 交互终端 |
| `ssh` | `exec(input)` | `ssh.exec` | 执行命令取结果 |
| `ssh` | `metrics.start/stop/latest` | `ssh.exec` | 服务器指标采样 |
| `ssh` | `completion.suggest(input)` | `ssh.exec` | 命令补全 |
| `ssh` | `sftp.list/download/upload/mkdir/rename/delete/chmod` | `ssh.sftp` | 文件传输与目录 / 权限操作；本地目标限用户选定的文件句柄 |
| `ssh` | `onSshTransfer(cb)` | 无 | 订阅 SFTP 传输进度（`ssh.transfer`） |
| `ssh` | `pickLocalFile(opts?)` | 基础能力 | 用户经原生选择器选择本地文件/目录 |
| `db` | `test(config)` / `open(input)` / `close(key)` / `listSessions()` | `db.connect` | 连接管理 |
| `db` | `execute(input)` / `explain(input)` / `cancel(key)` | `db.query` | 查询执行 |
| `db` | `applyChanges(input)` | `db.query` | 表格化编辑回写 |
| `db` | `importPreview(input)` / `importRun(input)` | `db.query` | CSV 导入 |
| `db` | `schema.tree/describe/ddl` | `db.schema` | 库表结构 |
| `db` | `completion(input)` | `db.schema` | SQL 补全 |
| `db` | `dialects.list()` | `backend.node` | 本插件后端提供的方言资料 |
| `db` | `workbench({ action: 'drivers.list' })` | `backend.node` | 本插件后端提供的驱动描述；其它 action 另按对应数据库权限校验 |
| `db` | `pickSqliteFile()` / `pickImportFile()` | 基础能力 | 用户经原生选择器选择数据库文件 |
| `mw` | `workbench(request)` | 按 action：`mw.connect` / `mw.query` / `mw.admin` | 中间件控制台统一入口（kafka / rabbitmq / mqtt / rocketmq）：连接、浏览、变更与实时监听；tail 消息经 `enest.on('mw.data')` 推送，错误经 `enest.on('mw.error')` |
| — | `notify({ title?, body? })` | `notify` | 系统通知 |
| — | `on(event, cb)` / `off(event, cb)` | 无 | 通用事件 |
| — | `onEnter / onOut / onBeforeClose / onDestroy` | 无 | 生命周期 |
| — | `setDirty(dirty)` | 基础能力 | 上报未保存数据标记（更新重启前脏检测与一键保存） |
| — | `onNotice(topic?, cb)` | 无 | 订阅壳统一通知（ShellNotice 标准信封） |
| — | `onSaveRequested(cb)` | 无 | 壳请求立即保存数据（回调可返回 Promise） |
| — | `getLaunchMode()` / `onModeChange(cb)` | 无 | 读 / 订阅启动方式（quick / shell） |
| — | `getPluginId()` / `getEnterCode()` | 无 | 插件身份 |

顶层还保留兼容扁平别名：`enest.setTitle` ≡ `enest.ui.setTitle`（icon / badge / resize 同理）。

---

## ui — 界面集成

### `ui.setTitle(title)`

修改当前插件 Tab 的标题（壳子顶栏 / 侧栏轨道同步更新）。

| | |
|--|--|
| **权限** | 基础能力，无需声明或授权 |
| **参数** | `title: string` — 最多 120 个 Unicode 码点，不含控制字符；空白字符串恢复 manifest 名称 |
| **返回** | `Promise<boolean>` — 当前实例的展示状态是否更新 |
| **错误** | 标题过长或包含控制字符 |

```js
await enest.ui.setTitle('待办 · 3 项')
```



---

### `ui.setIcon(icon)`

临时以文字图形覆盖 classic / orb Tab 的包内图标。默认图标始终来自当前插件安装包。

| | |
|--|--|
| **权限** | 基础能力，无需声明或授权 |
| **参数** | `icon: string` — 1–2 个可见 Unicode 码点，例如 `✓` 或 `★`；不接受 URL、路径、空白或控制字符。空字符串恢复包内图标 |
| **返回** | `Promise<boolean>` |
| **错误** | 文本过长或非法图标值 |

```js
await enest.ui.setIcon('✓')
await enest.ui.setIcon('') // 恢复本插件 assets/market/icon.svg
```

---

### `ui.setBadge(badge)`

设置 classic / orb Tab 角标。标题、图标覆盖与角标经宿主统一快照同步，切换和休眠时保留，最终关闭后清除。

| | |
|--|--|
| **权限** | 基础能力，无需声明或授权 |
| **参数** | `badge: string \| number` — 0–999999 的整数或最多 8 个 Unicode 码点的文本，不含控制字符；传 `''` 清除 |
| **返回** | `Promise<boolean>` |
| **错误** | 数字越界、文本过长或包含控制字符 |

```js
await enest.ui.setBadge(3)
await enest.ui.setBadge('9+')
await enest.ui.setBadge('') // 清除
```

---

### `ui.resize(size)`

兼容旧插件的内容区尺寸建议接口。

| | |
|--|--|
| **权限** | 基础能力，无需声明或授权 |
| **参数** | `size: { width?: number; height?: number }` |
| **返回** | `Promise<boolean>` |

进入插件后，Quick 外框统一展开为 720 × 545px，顶部输入区 64px，插件内容区为 718 × 480px，仅在显示器工作区不足时缩小。此接口保留参数校验和成功返回，不改变 Quick 或主窗尺寸；manifest 的 `window` 尺寸建议也不会改变 Quick。插件应按实际 viewport 响应式布局，超出部分内部滚动；width / height 必须是正有限数。

```js
await enest.ui.resize({ width: 960, height: 640 })
```

---

### `ui.setHeight(height)`

兼容旧插件的内容高度建议接口，与 `resize({ height })` 等价。

| | |
|--|--|
| **权限** | 基础能力，无需声明或授权 |
| **参数** | `height: number` — 期望高度 px（正数） |
| **返回** | `Promise<boolean>` |
| **错误** | `invalid height`（非正数） |

?> 调用成功表示参数已接受，不表示窗口高度改变。Quick 插件态保持固定内容区，主窗尺寸由用户控制。

```js
await enest.ui.setHeight(420)
```

---

### `ui.dismissQuick()`

提交即收起 Quick 小窗，适合「选中即走」类交互（如回车回贴/复制完成后）。

| | |
|--|--|
| **权限** | 基础能力，无需声明或授权 |
| **参数** | 无 |
| **返回** | `Promise<boolean>` — 是否因本次调用收起了小窗 |

- 仅当本插件**当前挂载于 Quick 容器**时生效；主窗 / 独立窗口 / 后台实例调用返回 `false`，不做任何事。
- 收起走壳子统一隐藏语义：插件进程保留，用户再次呼出 Quick 时**直接恢复本插件**（与失焦隐藏一致）。
- 与 `quickInput.escape()` 分工：escape 是退出插件回全局搜索列表；dismissQuick 是收起整个小窗。

```js
// 回车选中历史记录后自动收起（回贴由 clipboard.history.paste 内部完成收起）
const result = await enest.clipboard.history.paste(id)
if (!result.pasted && copiedAnyway) await enest.ui.dismissQuick()
```

---

### `ui.toast(payload)`

由宿主管理的原生通知层渲染，显示在当前插件所属的主窗口、Quick 或独立窗口中，位于插件内容之上。默认右下角；居中通知没有遮罩，不冻结插件，均有关闭按钮。

| 参数 | 说明 |
|--|--|
| `title` | 可选纯文本标题，最多 120 个字符；无标题时使用级别名称 |
| `body` | 正文，最多 16000 个字符；标题与正文至少一个非空 |
| `format` | `text`（默认）、`html` 或 `markdown` |
| `position` | `bottom-right`（默认）或 `center`；保留旧宿主 `top` 兼容 |
| `level` | `info`、`success`、`warn`、`error`，默认 `info` |
| `duration` | 自动关闭毫秒，范围 1500–60000；`0` 手动关闭。默认纯文本 4200、富文本 6500；超过 500 字符默认手动关闭 |
| `message` / `type` | 兼容旧 API，分别等价于 `body` / `level`；新字段优先 |

返回 `Promise<boolean>`。基础能力，无需声明或额外授权。参数非法、内容超限、容器不可用或超过频率/队列上限时拒绝 Promise。每个运行实例最多每 10 秒 10 次，每个容器最多排队 8 条；右下最多同时显示 3 条，居中/顶部各 1 条。新通知不抢焦点；悬停、键盘聚焦、窗口隐藏时暂停计时，长内容可滚动。聚焦通知后 Esc 可关闭；也可点击关闭按钮。

HTML 采用白名单重建，仅保留段落、强调、标题、列表、引用、代码、表格、分隔线和安全链接。`script`、`iframe`、SVG、样式、事件处理器、表单、媒体与图片均不加载；任意 class/id/style/data 属性被丢弃。Markdown 复用宿主的安全渲染器，不执行原始 HTML、不加载图片。链接仅允许无凭据的 HTTP(S)/mailto，经宿主打开系统浏览器，不导航插件或通知页面。插件来源名称由宿主填写，插件不能指定其它来源。

```js
// 旧调用继续可用
await enest.ui.toast({ message: '已保存', type: 'success' })

await enest.ui.toast({
  title: '导入完成', body: '**成功 24 项**\n\n- 数据已写入本地\n- 可继续编辑',
  format: 'markdown', position: 'bottom-right', level: 'success'
})

await enest.ui.toast({
  title: '操作说明', body: '<p>请先选择文件，再点击 <strong>开始转换</strong>。</p>',
  format: 'html', position: 'center', duration: 0
})
```

| | 基础能力 | `notify` |
|--|-----------|----------|
| 渲染方 | 壳子应用内 Toast | 操作系统通知 |
| 场景 | 当前窗口内轻反馈 | 可后台触发、系统级 |
| 权限 | 基础能力 | `notify` |

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
| **权限** | 基础能力，无需声明或授权；两种注册路径共用本插件配额 |
| **参数** | `pack: ThemePack` |
| **返回** | `Promise<unknown>` — 注册后的主题包对象 |
| **错误** | `invalid theme pack: require id and name`；`theme pack id already registered by <src>`；`theme pack limit reached` 等（见 [错误码](errors.md)） |

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
| **权限** | `contribute`（接收 Quick 全局搜索文本） |
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
| **权限** | `contribute`（接收 Quick 全局搜索文本） |
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
| **权限** | 基础能力，无需声明或授权 |
| **参数** | `section: { id: string; title: string; items: Array<{ key, type, label, default? }> }` |
| **返回** | `Promise<boolean>` |
| **错误** | `invalid settings section`（缺 `id` 或 `title`） |

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
| `items[].type` | 控件类型：`text` / `string` / `switch` / `boolean` / `bool` / `select`（含 `options`）/ `number` / `slider`（含 `min` / `max` / `step`）/ `color`；`page` 为打开本插件设置功能的入口（基础能力）。非法类型渲染层回退 `text` |
| `items[].label` | 控件标签 |
| `items[].default` | 默认值（可选） |
| `items[].options` | `select` 的选项列表 `Array<{ label, value }>` |
| `items[].min` / `max` / `step` | `slider` 的范围与步长 |

---

### `settings.get(key)`

读取插件设置值。优先从设置桥读取，否则回落到壳子已持久化的插件设置。**只能读取注册过的设置项**（`settings.register` 或 `contributes.settings` 声明的 key）；宿主保留键（如 `permissionGrants`）不能注册、读取或写入。

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
| 介质 | SQLite（`~/.eNest` 数据根下 `data/enest.db` 的 `plugin_storage` 表，按 `plugin_id + key` 隔离） | 主进程内存 Map |
| 写入策略 | 50ms 合并写（脏键批量事务落库）；配额：每插件 1000 键、单值 512KB | 即时内存 |
| 生命周期 | 关 Tab **保留**；卸载清理 | 插件关闭 / 应用退出即清空（休眠有快照恢复） |
| 权限 | 基础能力 | 基础能力 |

### `storage.get(key)` / `storage.set(key, value)` / `storage.remove(key)` / `storage.clear()`

| | |
|--|--|
| **权限** | 基础能力，无需声明或授权 |
| **参数** | `key: string`；`set` 另需 `value: unknown`（任意 JSON 可序列化值） |
| **返回** | `get → Promise<unknown>`；其余 `Promise<boolean>` |
| **错误** | `storage quota exceeded`（每插件 >1000 键或单值 >512KB） |

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
| **权限** | 基础能力，无需声明或授权 |
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

### `clipboard.writeText(text, options?)`

| | |
|--|--|
| **权限** | `clipboard.write` |
| **参数** | `text: string`（缺省按 `''` 处理）；`options?: { excludeFromHistory?: boolean }` |
| **返回** | `Promise<boolean>` |

```js
await enest.clipboard.writeText('已复制的内容')
// 密码等敏感内容：宿主在写入前阻止并作废交错的历史采集，不把此次内容加入 eNest 历史。
await enest.clipboard.writeText(secret, { excludeFromHistory: true })
```

`excludeFromHistory` 仅控制 eNest 的历史采集，不删除已有历史，也不能控制其他应用的剪贴板记录。宿主不延迟清空系统剪贴板，避免覆盖用户随后复制的新内容。

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

受控 HTTP(S) 请求，用于调用开放 API / 拉取文本资源 / 流式订阅。

| | |
|--|--|
| **权限** | `net.fetch` |
| **参数** | `req: { url: string; method?: 'GET' \| 'POST' \| 'PUT' \| 'PATCH' \| 'DELETE' \| 'HEAD'; headers?: Record<string, string>; body?: string; timeoutMs?: number; stream?: boolean }` |
| **返回** | `Promise<{ status: number; headers: Record<string, string>; body: string; streamed?: boolean; reqId?: string }>`（`stream:true` 时 `body` 为空，分片走 `net.chunk` 事件） |

硬约束（超限直接 reject，见 [错误码](errors.md)）：

- **仅 https**：URL 与每一跳重定向都必须是 `https://`（手动逐跳跟随，最多 5 跳，阻断 http / 内网跳转 SSRF）；manifest 声明 `"net": { "allowInsecure": true }` 时放行明文 `http://`（重定向逐跳仍按此规则校验）
- **GET / POST / PUT / PATCH / DELETE / HEAD**
- **响应体上限**：非流式 2MB；`stream: true` 流式 32MB（超过 2MB 的部分经 `net.chunk` 事件分片推送，chunk 为 base64）
- **SSE**：`stream: true` 且响应 `content-type: text/event-stream` 时按行转发 `data:` 事件（chunk 为 utf8 文本，`done: true` 终态）
- **超时**：默认 15s，可传 `timeoutMs` 调整（下限 1s、上限 120s）；超时报 `net.fetch timeout`

```js
const res = await enest.net.fetch({
  url: 'https://api.example.com/v1/quote',
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ lang: 'zh' }),
  timeoutMs: 10_000
})
if (res.status === 200) console.log(res.body)

// 流式（>2MB 响应 / SSE）：
const off = enest.net.onChunk(({ reqId, chunk, done, error }) => {
  if (done) { off(); return }
  const text = atob(chunk) // base64 → 文本（SSE 模式 chunk 已是 utf8 文本）
  console.log(text)
})
await enest.net.fetch({ url: 'https://api.example.com/stream', stream: true })
```

---

## net.socket — 出站 TCP 连接与本地 WebSocket 桥

供远程桌面（noVNC / RDP）、TCP 调试类插件使用。仅 outgoing 连接（不提供监听）；与
`enest.ssh.workbench({ action: 'tunnel.open' })` 打开的本地隧道口衔接：先建隧道，再
`socket.connect({ host: '127.0.0.1', port: <隧道本地口> })`。

| 方法 | 说明 |
|------|------|
| `net.socket.connect({ sessionId?, host, port, tls?, timeoutMs? })` | 建立 TCP / TLS 连接 → `{ socketId }`；连接超时缺省 10s；**每插件并发上限 8** |
| `net.socket.send(socketId, data, encoding?)` | 默认按 UTF-8 原样发送，包括 `PING` 等恰好符合 base64 字符集的文本；发送二进制须传第三参数 `'base64'`。每 socket 1MB/s 令牌桶限速（突发 2MB） |
| `net.socket.close(socketId)` | 关闭连接（插件关闭时宿主自动释放全部 socket） |
| `net.socket.list()` | 本插件 socket 概览（含 ws 桥端口、收发字节统计） |
| `net.socket.serveWs(socketId)` | 为已连接 socket 起本地 WebSocket 桥 → `{ url, token, port }` |

迁移旧调用：此前 `send(socketId, data)` 会猜测 base64；现在省略编码始终发送 UTF-8 文本。发送二进制的插件须改为 `send(socketId, base64Data, 'base64')`，接收事件的 `chunk` 仍为 base64。显式 base64 输入必须符合标准字母表及填充格式，格式错误会拒绝发送。

**权限**：`net.socket`。

**事件**（`enest.on(...)` / 命名空间订阅）：

| 事件 | 载荷 | 说明 |
|------|------|------|
| `net.data` | `{ socketId, chunk }`（base64） | 对端数据（64KB / 20ms 双阈值节流合并） |
| `net.close` | `{ socketId, reason }` | 连接关闭（对端关闭 / 本端关闭 / 错误） |

**serveWs 模式**：桥服务只绑 `127.0.0.1` 随机端口，`token` 一次性（首个命中连接消费，
后续连接即使 token 对也被拒绝；扩展协商拒绝）。桥建立后该 socket 的双向流直通 ws 二进制
帧（不再经 IPC 分片），插件页内 vendored 的 noVNC / ironrdp-wasm 直接：

```js
const { socketId } = await enest.net.socket.connect({ host: '127.0.0.1', port: 5901 })
const { url } = await enest.net.socket.serveWs(socketId)
const ws = new WebSocket(url)  // ws.binaryType = 'arraybuffer'，双向二进制流
ws.binaryType = 'arraybuffer'
```

---

## agent — AI CLI 配置白名单读写

白名单覆盖 10 个应用（路径硬编码在宿主内，禁止任意路径）：
`claude-code`（~/.claude/settings.json）、`claude-desktop`、`codex`（~/.codex/config.toml +
auth.json）、`gemini-cli`（~/.gemini/settings.json）、`grok-build`（~/.grok/config.toml）、
`opencode`、`openclaw`、`hermes`（config.yaml）、`pi`、`minimax-code`。

| 方法 | 说明 |
|------|------|
| `agent.apps()` | 无需权限声明或授权；可用应用、配置位置及探测到的安装状态（`installed` 主配置存在）与活跃状态（如 codex auth 有登录材料），不返回配置内容 |
| `agent.read(app)` | 配置原文 + 解析结果（JSON 解析为对象；TOML/YAML 回传原文） |
| `agent.write({ app, changes, confirmed })` | 最小侵入写入：只替换给定**顶层键**（JSON 键序保留、TOML 注释与未触及行保留）；取得 `config.agent.write` 授权后执行；**写前自动快照** |
| `agent.backups(app)` | 快照列表（时间倒序） |
| `agent.restore({ app, id })` | 宿主原生确认应用与备份目标后，从快照恢复（恢复前对当前状态再做一次安全快照） |
| `agent.listAssets({ app, path })` | 资产通道：列白名单应用数据目录（目前 codex 开放 `pets/`）清单 `[{name,isDir,size,modifiedAt}]`；`path` 空串列根，非空首段必须命中白名单子目录 |
| `agent.writeAssets({ app, assets, confirmed })` | 资产通道：写资产文件（`{path, contentText?|contentBase64?}`，单文件 ≤8MiB、单次 ≤20 个 / ≤32MiB）；取得 `config.agent.write` 授权后执行；**覆盖已存在文件前自动快照** |
| `agent.deleteAssets({ app, paths, confirmed })` | 资产通道：删除资产文件 / 目录（递归）；宿主原生确认展示完整目标后执行，不可恢复 |

**权限**：除 `apps()` 外，读取使用 `config.agent.read`，写入使用 `config.agent.write`。快照位于 `~/.eNest/agent-config-backups/<app>/<timestamp>`，
每应用保留最近 20 份。`changes` 的 `$file` 特殊键指定目标文件（如 codex 的
`{ $file: 'auth.json', OPENAI_API_KEY: 'sk-...' }` 写 auth.json 而非 config.toml）。

敏感能力由宿主按插件集中授权，可选择本次运行允许或授权并记住（见[授权与撤权](permissions.md#授权与撤权)）。`write` / `writeAssets` 获得授权后不再追加操作确认；`restore` / `deleteAssets` 仍需确认具体目标。兼容参数 `confirmed` 不能代替宿主授权。

**资产通道边界**：只进入应用声明的一级子目录（codex 仅 `pets/`）；相对路径拒绝绝对路径、
`..` 逃逸、反斜杠、编码分隔符与隐藏段；命中配置文件（如 `~/.codex/config.toml`）一律拒绝——
配置修改只能走 `agent.write` 的最小侵入合并。典型用法（安装 Codex 桌面宠物包）：

```js
await enest.agent.writeAssets({
  app: 'codex',
  assets: [
    { path: 'pets/bedro/pet.json', contentText: manifestJson },
    { path: 'pets/bedro/spritesheet.webp', contentBase64: base64 }
  ]
})
```

---

## sys — 本机进程与端口

| 方法 | 说明 |
|------|------|
| `sys.processes()` | 进程列表（`ps -axo pid,pcpu,pmem,rss,user,comm`；Linux 探测式回退）；1s 采样缓存 |
| `sys.ports()` | 监听端口（`lsof -nP -iTCP -sTCP:LISTEN`；Linux 回退 `ss -ltnp` / `netstat`）；1s 采样缓存 |
| `sys.kill(pid, { signal?, confirmed })` | 结束进程：宿主原生对话框确认 PID / 进程目标，`confirmed` 不能代替授权；`signal` 支持 TERM（缺省）/ KILL / INT；宿主拒绝 kill 自身进程与 PID ≤ 1 |

**权限**：列表使用 `sys.inspect`，结束进程使用 `sys.control`。

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

保存本插件的连接口令、API token 等敏感信息，不能读取系统已有凭据。系统加密不可用时保存失败，不会静默降级为简单混淆。**只写不读**：存入后返回一个 `secretRef` 引用，之后把引用传给 SSH / 数据库连接参数，明文不会回到插件页。

### `vault.set(key, secret)`

| | |
|--|--|
| **权限** | 基础能力，无需声明或授权 |
| **参数** | `key: string`（插件内唯一的标识，如 `prod-db`）；`secret: string` |
| **返回** | `Promise<{ secretRef: string }>` |

### `vault.has(keyOrRef)` / `vault.remove(keyOrRef)`

| | |
|--|--|
| **权限** | 基础能力，无需声明或授权 |
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
| **权限** | `ssh.session`（agent 另需 `ssh.agent`；私钥文件须由用户选择并提供只读句柄，无额外文件权限框） |
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
| `privateKeyHandleId` | `string?` | 宿主选择器返回的只读私钥句柄；不接受路径 |
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
| `download` | `{ sessionId?, remotePath?, localDirectoryHandleId? }` | `Promise<SftpTransferResult>` |
| `upload` | `{ sessionId?, localHandleId?, remotePath? }` | `Promise<SftpTransferResult>` |
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
| **参数** | `opts?: LocalFilePickOptions` — `kind`、`multiple`、`access`，与 localFiles.pick 相同 |
| **返回** | `Promise<LocalFileHandle \| null>` — 用户取消时 `null` |

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
| `fileHandleId` / `createIfMissing` | SQLite / DuckDB 的用户授权文件；内存库用 `database: ":memory:"` |
| `org` / `bucket` | InfluxDB v2 |
| `readOnly` | 只读连接（推荐查询类插件开启） |

### `db.execute(input)`

| | |
|--|--|
| **参数** | `input: { sessionKey, sql, params?, maxRows?, timeoutMs?, confirmed? }` |
| **返回** | `Promise<QueryResult>` — `{ columns, rows, rowCount, durationMs, truncated? ... }` |

- `params` 支持 `?` 位置占位与 `:name` 命名占位，请始终用参数化查询拼接用户输入。
- 生产 / 受保护连接执行写操作时需用户确认；宿主对危险目标另行原生确认，插件传 `confirmed: true` 不授予权限。
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

CSV 导入两步流：先 `importPreview` 看列映射与 SQL 预览（`{ columns, sampleRows, mappedColumns, sqlPreview }`），确认后 `importRun` 执行（`{ ok, inserted, failed, errors? }`）。数据源传 `csvText`，或先 `pickImportFile()` 选文件后传 `fileHandleId: handle.id`。`conflict` 策略支持 `insert / upsert / skip`。

### `db.schema.tree / describe / ddl`

| 方法 | 参数 | 返回 |
|------|------|------|
| `tree` | `{ sessionKey, database?, schema?, table?, filter? }` | `SchemaObject[]` — 库/表/列树 |
| `describe` | `{ sessionKey, table, database?, schema? }` | `TableDetail` — 列、主键、索引 |
| `ddl` | 同上 | `Promise<string>` — 建表语句 |

### `db.completion(input)` / `db.dialects.list()`

`completion` 给 SQL 编辑器做补全：入参 `{ sessionKey, sql, cursor? }`，返回 `{ replace: { from, to }, items }`，直接对接编辑器替换区间，需 `db.schema` 授权。**`db.completion.suggest(input)` 为规范全名**，`db.completion(input)` 是可直接调用的兼容别名（同一方法，二选一即可）。`dialects.list()` 从本插件后端返回各驱动方言信息（关键字、函数、代码片段），需要 `backend.node`，不读取数据库内容。

### `db.pickSqliteFile()` / `db.pickImportFile()`

系统文件选择框：前者限定 SQLite 库文件，后者限定 CSV 等导入文件。返回文件句柄或 null，只能使用句柄 id，不接受路径。

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
| `shell-notice` | 壳统一通知（任何关键节点；见下方「壳通知」） | `ShellNotice` 信封 |
| `save-requested` | 壳请求立即保存（更新重启 / 退出前；建议用 `onSaveRequested`） | `{ reason, deadlineMs, operationId }` |

回调抛错会被捕获，**不会**影响其它监听器。

---

## 壳通知（ShellNotice）

壳软件的关键节点（更新、保存、退出、外观……）统一按一套标准 JSON 信封广播给所有运行中插件，插件按 `topic` 订阅自己关心的通知。未来新增节点只扩展 topic 清单，**信封字段不变**。

### 信封结构（v1）

```json
{
  "v": 1,                        // 信封结构版本；不认识的版本必须忽略
  "seq": 42,                     // 会话内单调递增序号（主进程重启归零，仅排序/诊断用）
  "ts": "2026-10-14T09:30:00.000Z", // 事件产生时间（ISO 8601）
  "source": "shell",             // 来源恒为 'shell'（预留给未来非壳来源）
  "topic": "update.available",   // 通知主题，点分命名空间 <域>.<节点>
  "data": { "currentVersion": "0.1.0", "latestVersion": "0.2.0" }
}
```

约定：**未知 topic 一律忽略**（向前兼容）；`data` 按 topic 约定，见下表。

### v1 topic 清单

| topic | 触发 | data |
|-------|------|------|
| `update.available` | 检查到新版本（尚未下载） | `{ currentVersion, latestVersion }` |
| `update.downloaded` | 更新包下载完成，可安装 | `{ version }` |
| `update.installing` | 即将退出安装（最后保存机会；随后 `app.before-quit` 与 `beforeClose` 还会各来一次） | `{ version }` |
| `update.error` | 检查 / 下载 / 安装出错 | `{ message }` |
| `save.requested` | 壳请求插件立即保存数据（更新重启 / 退出前） | `{ reason: 'update'\|'app-quit'\|'manual', operationId, deadlineMs }` |
| `app.before-quit` | 应用即将退出（随后收到 `beforeClose(app-quit)`） | `{ reason }` |
| `appearance.changed` | 主题 / 字体 / 动画档变更 | `{ kind: 'theme'\|'font'\|'animation' }` |

### `onNotice(topic?, cb)`

| | |
|--|--|
| **权限** | 无 |
| **参数** | `topic?` 省略收全量；传入时只收该 topic（TypeScript 下 `data` 类型自动收窄） |
| **返回** | 取消订阅函数 |

```js
// 只关心更新
const off = enest.onNotice('update.available', (notice) => {
  console.log(notice.data.latestVersion) // 类型已收窄
})

// 全量（按 topic 自行分发）
enest.onNotice((notice) => {
  if (notice.topic === 'appearance.changed') refreshLook(notice.data.kind)
})
```

等价的底层写法：`enest.on('shell-notice', cb)`（数据即信封对象）。

### `setDirty(dirty)` / `onSaveRequested(cb)` — 数据保存双保险

更新弹框点「立即更新并重启」、以及应用退出前，壳会先**检测未保存数据**再**一键保存**。插件配合方式：

| | |
|--|--|
| `setDirty(dirty)` | **权限：基础能力**。编辑时置 `true`、持久化完成后置 `false`。不上报则视为无未保存数据 |
| `onSaveRequested(cb)` | **权限：无**。收到 `save.requested` 通知时触发；回调里持久化数据并**返回 Promise**，settle 后壳才继续 |

```js
// 1) 脏标记：编辑置位，落盘清除
editor.on('change', () => { dirty = true; enest.setDirty(true) })
async function persist() {
  await enest.storage.set('draft', editor.value)
  dirty = false
  await enest.setDirty(false)
}

// 2) 响应壳的一键保存（返回 Promise → 壳等待完成）
enest.onSaveRequested(async ({ reason, deadlineMs }) => {
  if (!dirty) return            // 幂等：无脏数据直接返回
  await persist()               // 建议在 deadlineMs（默认 5000ms）内完成
})
```

要点：

- **保存必须幂等**：`save.requested`、`beforeClose`、休眠 `beforeSuspend` 都可能触发保存，同一数据可能被写多次。
- 回调返回的 Promise 全部 settle（或超时 `deadlineMs`）后壳继续流程；任一 reject 视为该插件保存未确认，壳仍会继续（有 toast 提示），`beforeClose` 是最后兜底。
- 休眠中的插件无活动渲染进程，不参与脏检测与保存广播（休眠前已 flush）。

### 扩展约定

- topic 命名 `<域>.<节点>`（如 `update.downloaded`）；新 topic 只会追加，不会改语义。
- 新增关键节点 = 在 `@shared/types/notice` 的 `ShellNoticeDataMap` 加条目 + 本表加行；插件侧遇到未知 topic 忽略即可，无需适配。

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
| **参数** | `cb: (mode: 'quick' \| 'shell') => void` |
| **返回** | `() => void` — 取消订阅 |

```js
const off = enest.onModeChange((mode) => {
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

完整 `window.enest` 接口声明见 [TypeScript 类型](api-types.md)（由 `scripts/generate-api-types.mjs` 自动生成，勿手改）。推荐安装 **`@enest/plugin-sdk`** 包（位于插件仓库 `packages/plugin-sdk`，声明与 preload 同源生成），或将生成的 d.ts 拷入插件工程：

```text
eNest_plugin/packages/plugin-sdk/index.d.ts   ← 自动生成，与 preload 严格一致
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
2. **权限门禁**：基础能力无需声明或授权；敏感能力必须在 `plugin.json.permissions` 声明，并取得运行时三态授权（allow / ask / deny）（见 [权限说明](permissions.md)）。
3. **身份绑定**：调用仅接受壳子管理的插件页面；伪造 `pluginId` 返回 `plugin id mismatch`。
4. **协议隔离**：`enest://plugin/{id}/...` 只映射该插件根目录，路径穿越会被拒。
5. **partition 隔离**：每个插件独立 `persist:plugin-{id}`，cookie / localStorage 互不可见。

→ 权限完整表见 [权限说明](permissions.md)
→ 错误字符串见 [错误码](errors.md)


## 文件句柄与 WebSocket 新接口

`localFiles.pick({ kind?, multiple?, access? })` 返回 `LocalFileHandle[]`；`localFiles.pickSave({ defaultName? })` 返回句柄或 `null`。文件选择、读取已选文件和导出均是基础能力，无需声明 `fs.read` / `fs.write` 或追加通用授权框，仍由原生选择器请用户选定目标。句柄包含 `id/name/kind/size/displayPath`，只在签发插件的当前实例中有效。具体能力与持久化策略见 [权限](permissions.md)。

`localFiles.read({ handleId, encoding: 'text' | 'dataUrl', maxBytes? })` 直接读取用户已选定并授予句柄的文件，返回 UTF-8 文本字符串或带 MIME 的 data URL 字符串。文本默认 2 MiB、data URL 默认 16 MiB，调用方可设置 `maxBytes`，最大 32 MiB；每插件最多两次并发读取。只接受普通文件，不跟随符号链接；关闭、重载或撤权后原句柄失效。官方插件的文本导入、图片预览通过此接口读取，不持久化系统路径或句柄。

`db.pickSqliteFile({ createIfMissing?, readOnly? })` 返回 `LocalFileHandle | null`。默认选择可写句柄；显式 `readOnly:true` 且不创建文件时只授予读取用途。`db.pickImportFile()` 返回只读文件句柄或 `null`。两者均无需额外文件权限框，取消选择不会授予句柄。数据库连接与查询继续使用各自权限，不要保存句柄跨重启复用。

`net.websocket` 使用 `net.socket` 权限并走宿主代理：

```js
const { socketId } = await enest.net.websocket.connect({ url: 'wss://example.com/events' })
const offMessage = enest.net.websocket.onMessage(event => {
  if (event.socketId === socketId) console.log(event.data, event.binary)
})
await enest.net.websocket.send(socketId, 'hello')
// 二进制发送时 data 为 base64，第三个参数 binary=true。
await enest.net.websocket.close(socketId)
offMessage()
```

生产页面的原生 fetch / WebSocket 不用于任意外联。`net.socket.serveWs` 是经授权签发、绑定当前运行代次的精确连接桥，仅用于已有二进制协议适配，不能构造 URL 访问其它本机服务。

存储排队写入、HTTP 分片、SSE、socket 帧和发送队列都有字节预算；超限 reject，调用方应显示错误并允许缩小数据或重试，不应无界积累缓冲。完整返回类型以 [生成的 API 类型](api-types.md) 为准。

HTTP 同时最多 8 个在途请求；流式响应（含 SSE）单次最多 32 MiB。SSE 单行最多 2 MiB、最多 65,536 个事件；读取达到预算或运行实例失效时，宿主取消上游请求并返回明确错误。
