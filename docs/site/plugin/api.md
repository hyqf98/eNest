# enest API 完整参考

eNest 在普通插件主页面注入 **`window.enest`**，同时暴露别名 **`window.zapi`**（两者是同一个对象）。沙箱后台、辅助页和隔离主题页只获得各自的专用桥，不获得此完整 API。

> **`zapi` 为 deprecated 历史别名**：当前保留兼容，新代码统一使用 `enest.*`。普通插件页面使用 `window.enest`；不要将别名当作旧宿主缺失新能力的兜底，也不承诺尚未发布的移除版本。

跨进程能力调用进入主进程，完成 **窗口 / 主 frame / 精确 origin / 运行代次校验 → pluginId 匹配 → 基础能力放行 / 敏感能力授权 → 方法分发**。同步读取当前模式、注册本地事件监听等 preload 操作不因此获得新的原生权限。

```js
const api = window.enest
```

?> **命名约定**：文档与示例统一以 `enest.*` 书写。

---

## 隔离主题页面 API

普通插件页面使用 `window.enest`；Workspace 使用专用 `window.enestWorkspace`；V2 主题包声明 `quick: { version: 1, entry }` 的 Quick 页面只获得 **`window.enestQuick`**，不可复用普通插件或壳子 API。

`enestQuick.ready()` 通知首帧就绪；`getState()` 与 `onState(listener)` 获取当次展示快照；`onFocus(listener)` 处理宿主焦点请求；`action(request)` 提交受限查询、过滤、选中、打开、展开、市场入口、隐藏、业务插件返回／固定／聚焦及有界布局请求。`state.read()/state.write(value, expectedRevision)` 提供当前提供者有界 JSON/CAS 私有存储；目录 `stateKey` 与成功启动 `opened` 回执供其实现自己的近期/偏好模型，不接受 stable key 作为启动授权。结果 ID 是短期不透明句柄；真实启动请求、文件路径、全量设置与其它提供者历史不出桥。主题页不能凭自己发送的按键消息伪造用户授权。详细声明、可运行示例、原生几何限制及失败回退见[主题包标准](themes.md#quick-自绘页面-v1)，参数以自动生成的 `EnestQuickApi` 为准。

主题自绘设置页使用 `window.enestSettings` 的 `ready/getState/onState/action`，只获得安全字段描述符与可进入的原生分组；Workspace 没有完整设置读取权。主题导航使用 `window.enestChrome`，不能通过该桥获得普通插件的业务能力。各桥的入口、手势、归属与清理规则见[设置页面](settings-and-windows.md)、[Workspace](home.md)与[Chrome](chrome.md)。

## MCP 工具处理器

普通插件通过 `contributes.mcpTools` 声明工具，在业务初始化后调用一次 `enest.mcp.registerHandlers(handlers)`；处理器键集合须与 manifest 完全一致，不得依赖前台 `onEnter` 才注册。MCP 不授予额外权限，也不替用户触发原生交互。服务默认关闭，当前尚无原生管理区；完整声明、结果、取消、限额与交付边界见 [MCP 工具贡献](mcp.md)。

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

?> **开发态差异**：开发者控制台只有开发模式，壳按 `package.json` 自动识别源码形态（框架 HMR / 静态源码 / 离线产物预览），没有 dev/prod 切换。连接开发服务时放宽 script CSP 并放行该 origin 的 HMR WebSocket；静态源码或按产物目录预览时使用与正式安装一致的生产 CSP 与标准产物路径。开发服务下可用的内联脚本等宽松行为，只有在按产物目录预览（或解包 `.enestplugin`）时才会被生产 CSP 拒绝，从而暴露问题。启动命令解析与自动识别见[开发加载](debug.md)。

---

## 方法索引

插件自绘设置、`page` 入口与 Quick / 桌面原生容器的职责划分见[自绘设置与窗口边界](settings-and-windows.md)。普通插件不获得全量壳设置或原生窗口管理 API。

从 0.2.2 起，AI 配置、局域网分享、数据库、中间件和 SSH 使用插件自己的适配器及 `enest.backend.call`；壳不再暴露 `agent`、`net.share`、`db`、`mw`、`ssh` 专用 API。番茄钟周期/统计位于插件，通用后台计划用 `deadlineTasks`。升级旧插件包后再使用新壳，见[本机后端与迁移](backend.md)。

从 0.2.3 起，剪贴板历史属于 clipboard 插件的沙箱后台；选区、录制和贴图属于插件仓的 `@enest/native-surfaces`。原生 `window.enest` 不再提供 `clipboard.history.*`、`screen.selectRegion`、`screen.record.*` 或 `pin.*`。宿主保留剪贴板原生读写/观察、`screen.capture/displays`、通用 `background`、`auxiliary` 与私有 `files.stream`；兼容权限名仍然有效，但不是同名业务 API。

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
| `theme` | `getAppearance()` / `onAppearanceChange(cb)` | 基础能力 | 读取、订阅带 revision 的统一外观；订阅先于初始读取 |
| `home` | `register(contribution)` | 基础能力 | 确认本插件当前 manifest 的精确首页声明；来源由宿主绑定，不激活主题或首页，见[完整首页](home.md) |
| `hotkey` | `register(acc, opts?)` | `hotkey` | 注册全局热键 |
| `hotkey` | `unregister(acc)` | `hotkey` | 注销全局热键 |
| `hotkey` | `onHotkey(cb)` | 无 | 订阅热键触发 |
| `i18n` | `getLocale()` | 无 | 读壳子语言 |
| `i18n` | `onLocaleChange(cb)` | 无 | 订阅语言变更 |
| `contribute` | `registerQuickProvider(meta)` | `contribute` | 注册会接收全局搜索文本的动态 Quick provider |
| `contribute` | `unregisterQuickProvider(id)` | `contribute` | 注销 provider |
| `contribute` | `onQuickQuery(cb)` | 无 | 订阅 Quick 搜索查询（门禁在 `registerQuickProvider`，纯订阅不校验） |
| `contribute` | `respondQuickQuery(reqId, items)` | `contribute` | 回传当前 provider 的查询结果 |
| `settings` | `register(section)` | 基础能力 | 注册设置分组 |
| `settings` | `get(key)` | 无 | 读插件设置 |
| `settings` | `set(key, value)` | 无 | 写插件设置 |
| `storage` | `get/set/remove/clear/flush/commit` | 基础能力 | 持久化 KV；set/remove 入队，flush/commit 返回显式提交回执 |
| `storage.session` | `get/set/remove/clear` | 基础能力 | 会话态 KV |
| `storage.blobs` | `put/get/remove` | 基础能力 | deprecated 兼容适配，与 assets 使用同一图片服务与配额，旧 ID 继续可用 |
| `storage.assets` | `put/list/get/remove` | 基础能力 | 推荐图片入口；互斥接收 `{bytes,mime}` 或 `{dataUrl}`，可选 `name/assetId`；单文件32MiB、每插件合计1GiB/10,000项，含旧附件；稳定ID可原样覆盖，`delete`为remove兼容别名，见[存储标准](storage.md) |
| `storage.files` | `list/get/remove/export` | 基础能力 | 完成私有输出的分页、分块读取、删除和原生确认导出；只接收 ID，不接收路径 |
| `background` | `call(method, args?, { timeoutMs? }?)` | 按声明事件校验 | 调用本插件沙箱后台的私有方法，不是 Node 后端 |
| `auxiliary` | `open/send/close/list` | 普通窗口为基础能力；捕获/置顶另验权限 | 包内辅助页；辅助页只有 `enestAux` |
| `files.stream` | `open/write/finish/abort` | 基础能力 | 当前实例的有界私有输出流，不接受目标路径 |
| `runtime` | `acquireActivity(reason?)` / `releaseActivity(token)` | 基础能力 | 当前运行代次的显式活动租约；每实例128份、全局4096份，不阻止显式关闭 |
| `clipboard` | `capabilities()` / `requestPermission()` | 无 / `clipboard.paste` | 查询平台能力 / 请求平台支持的回贴授权 |
| `clipboard` | `readText()` | `clipboard.read` | 读纯文本 |
| `clipboard` | `writeText(text, options?)` / `writeFiles(paths)` | `clipboard.write` | 写纯文本 / 文件引用 |
| `clipboard` | `readImage()` | `clipboard.readImage` | 读图片 dataURL |
| `clipboard` | `writeImage(dataUrl)` | `clipboard.writeImage` | 写图片 |
| `clipboard` | `paste()` | `clipboard.paste` | 将已复制内容回贴到宿主捕获的原应用 |
| `clipboard` | `inspectFiles(paths)` / `revealFile(path)` | 基础能力，仍校验目标 | 只检查已授权文件；定位前由原生选择确认签发能力 |
| `screen` | `capture({ displayId?, bounds? })` | `screen.capture` | 截图 |
| `screen` | `displays()` | 基础能力 | 显示器几何、缩放与主屏标记，不读取屏幕内容 |
| `net` | `fetch({ url, method?, headers?, body?, bodyBase64?, auth?, timeoutMs?, stream? })` | `net.fetch` | 受控 HTTP(S) / 流式 / SSE；`bodyBase64` 为二进制请求体（≤8MB，multipart 上传等）；`auth.secretRef` 由主进程从本插件 vault 解引用注入鉴权头（默认 `Authorization: Bearer`，可改 header/scheme），密钥不回到页面 |
| `net.socket` | `connect/send/close/list` / `serveWs(socketId)` | `net.socket` | 出站 TCP + 本地 ws 桥 |
| `net` | `onNetData(cb)` / `onNetClose(cb)` / `onChunk(cb)` | 无（纯订阅） | `net.data` / `net.close` / `net.chunk` 事件 |
| `sys` | `processes()` / `ports()` / `kill(pid, opts)` | `sys.inspect` / `sys.control` | 本机进程 / 端口 / 结束确认 |
| `shell` | `openExternal(url)` | `shell.openExternal` | 系统浏览器打开 |
| `shell` | `saveFile(payload)` / `saveTextFile(payload)` | 基础能力 | 用户经原生对话框选定保存位置后写入 |
| `deadlineTasks` | `start/get/pause/resume/skip/cancel/onChange` | 基础能力 | 插件自定义持久化步骤计划；不含业务周期/统计；通知单独校验 `notify` |
| `quickInput` | `configure({placeholder?,value?})` / `release()` / `escape()` / `readContext()` / `onChange(cb)` / `onAction(cb)` | 基础能力 | 当前 Quick 插件接管小窗顶部输入；readContext 读取本次进入携带的文本/图片/文件上下文 |
| `vault` | `set(key, secret)` | 基础能力 | 存密钥，返回引用 |
| `vault` | `has(keyOrRef)` | 基础能力 | 判断密钥是否存在 |
| `vault` | `remove(keyOrRef)` | 基础能力 | 删除密钥 |
| — | `notify({ title?, body? })` | `notify` | 系统通知 |
| — | `on(event, cb)` / `off(event, cb)` | 无 | 通用事件 |
| — | `onEnter / onOut / onBeforeClose / onDestroy` | 无 | 生命周期 |
| — | `setDirty(dirty)` | 基础能力 | 上报未保存数据标记（更新重启前脏检测与一键保存） |
| — | `onNotice(topic?, cb)` | 无 | 订阅壳统一通知（ShellNotice 标准信封） |
| — | `onSaveRequested(cb)` | 无 | 壳请求立即保存数据（回调可返回 Promise） |
| — | `getLaunchMode()` / `onModeChange(cb)` | 无 | 读 / 订阅布局模式（quick / shell / panel），不是原生挂载位置 |
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

进入插件后，Quick 外框统一展开为 720 × 545px，顶部输入区 64px，插件内容区为 718 × 480px，仅在显示器工作区不足时缩小。此接口保留参数校验和成功返回，不改变 Quick、主窗或自由面板组件尺寸；manifest 的 `window` 尺寸建议也不会改变 Quick。面板组件的 `views.panel.size` 只影响首次添加，后续由用户拉伸与保存布局决定。插件应按实际 viewport 响应式布局，超出部分内部滚动；width / height 必须是正有限数。

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

?> 调用成功表示参数已接受，不表示窗口高度改变。Quick 插件态保持固定内容区，主窗和面板组件尺寸由用户控制。

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
// 纯复制完成后收起；复制仍需 clipboard.write 授权。
await enest.clipboard.writeText(resultText)
await enest.ui.dismissQuick()
```

没有 `enest.quick.hide()`。回贴使用 `enest.clipboard.paste()`：先由插件复制内容，宿主再验证原应用并按回贴流程隐藏 Quick；失败时可能恢复 Quick，插件应展示返回的 `reason`，不要无条件再次隐藏。

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
| **参数** | `section: SettingsSectionContribution`，与 `contributes.settings` 复用同一契约；包含 `schemaVersion?`、`items[].shareWithThemes?` |
| **返回** | `Promise<boolean>` |
| **错误** | `invalid settings section`（缺 `id` 或 `title`）；`unsupported settings schema version`（版本既非省略也非字符串 `'1'`） |

```js
await enest.settings.register({
  id: 'hello.prefs',
  title: 'Hello 工具',
  schemaVersion: '1',
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
| `section.schemaVersion` | 可选；当前只接受省略或字符串 `'1'`。宿主会透传并校验此字段，数字 `1`、空字符串及其它版本均拒绝 |
| `items[].key` | 设置键，后续 `settings.get/set` 使用 |
| `items[].type` | 控件类型：`text` / `string` / `switch` / `boolean` / `bool` / `select`（含 `options`）/ `number` / `slider`（含 `min` / `max` / `step`）/ `color`；`page` 为打开本插件设置功能的入口（基础能力）。非法类型渲染层回退 `text` |
| `items[].label` | 控件标签 |
| `items[].default` | 默认值（可选） |
| `items[].options` | `select` 的选项列表 `Array<{ label, value }>` |
| `items[].min` / `max` / `step` | `slider` 的范围与步长 |
| `items[].shareWithThemes` | 可选布尔值，只有显式 `true` 的安全简单字段可进入第三方设置描述符；不是共享整个插件设置，跨插件写入仍逐次原生确认 |

---

### `settings.get(key)`

读取调用插件自己的设置值。已持久化值优先，无保存值时读取设置桥或声明的默认值。为兼容旧配置，合法的旧私有持久化键仍可读；未保存、未声明的键返回 `undefined`。宿主保留键（如 `permissionGrants`）不能注册、读取或写入；本接口不接受其它插件 ID。

| | |
|--|--|
| **权限** | 无（由 Bridge / SettingsStore 管控） |
| **参数** | `key: string` |
| **返回** | `Promise<unknown>` — 未设置时为 `undefined` |
| **错误** | `reserved plugin settings key`（试图读取宿主保留键） |

```js
const name = await enest.settings.get('name')
```

---

### `settings.set(key, value)`

写入插件设置。**只能写本插件注册过的非 page 设置项**；宿主等待真实持久化成功后才更新内存桥、刷新相关后台并广播 `settings.onChange` 与壳设置变更。写入失败时 Promise reject，不发布成功态，也不覆盖最后一次确认值。调用方应等待成功后确认界面值，或在失败时回滚本地预览；`page` 仅是打开本插件页面的动作入口。

| | |
|--|--|
| **权限** | 无 |
| **参数** | `key: string`，`value: unknown` |
| **返回** | `Promise<boolean>` |
| **错误** | `unknown settings key: <key>`（写入未注册的 key）；宿主保留键或持久化失败同样 reject |

```js
await enest.settings.set('name', '世界')
```

---

## storage — 数据持久化

两套存储语义对比：

图片、后台文档、输出流、用户文件和密钥的选择、完成语义及兼容规则见[数据存储与私有资源](storage.md)。`storage.clear()` 仅清本插件持久化 KV，不清图片或其它存储域；`storage.set/remove` 的成功是进入有界写队列，需要提交确认时另用 `flush/commit`。

| | `storage.*`（local） | `storage.session.*` |
|--|----------------------|---------------------|
| 介质 | SQLite（`~/.eNest` 数据根下 `data/enest.db` 的 `plugin_storage` 表，按 `plugin_id + key` 隔离） | 主进程内存 Map |
| 写入策略 | set/remove 50ms 合并写；flush/commit 显式 FULL 提交；配额：每插件 1000 键、单值 512 KiB | 即时内存 |
| 生命周期 | 关 Tab **保留**；卸载清理 | 插件关闭 / 应用退出即清空（休眠有快照恢复） |
| 权限 | 基础能力 | 基础能力 |

### `storage.get(key)` / `storage.set(key, value)` / `storage.remove(key)` / `storage.clear()`

| | |
|--|--|
| **权限** | 基础能力，无需声明或授权 |
| **参数** | `key: string`；`set` 另需 `value: unknown`（有限、纯 JSON 值，不接受自定义实例、循环或 `undefined`） |
| **返回** | `get → Promise<unknown>`；其余 `Promise<boolean>` |
| **错误** | `storage quota exceeded`（每插件 >1000 键或单值 >512KB） |

```js
await enest.storage.set('prefs', { theme: 'dark', compact: true })
const prefs = await enest.storage.get('prefs')
await enest.storage.remove('prefs')
await enest.storage.clear()
```

值经 `JSON` 序列化写入，**不要**存函数、循环引用或超大二进制（单值 >512KB 会触发 `storage quota exceeded`）。

### `storage.flush()` / `storage.commit(operations)`

两者都返回 `Promise<{commitId,committedAt,committedKeys}>`。`flush()` 提交本插件此前已入队的 KV；`commit()` 将本批次与本插件已有待写 KV 放进同一事务，提交成功后才发布本批新值。回执不是 CAS 版本，也不包含图片、完成文件、设置或其它插件的数据。

```ts
await enest.storage.set('draft', draft)
const receipt = await enest.storage.flush()
await enest.storage.commit([
  { op: 'set', key: 'document', value: document },
  { op: 'remove', key: 'legacyDocument' }
])
```

`commit` 接受 1–100 个唯一键操作，重复键整批拒绝；键最长 1024 UTF-8 字节、单值 512 KiB，本批加已有待写数据合计不超过 8 MiB（含记账开销）。普通写采用 WAL/NORMAL，显式提交采用 SQLite FULL，macOS 加 fullfsync；空 flush 也写提交标记同步此前普通事务。数据库失败保留已接收的待写数据，不自动接收本批失败的新值；回执通信中断不能推断磁盘未变，应读取业务状态后幂等重试。限制及硬件持久性边界见[存储标准](storage.md)。

### `storage.assets` / `storage.files`

图片使用 `assets.put/list/get/remove`；`blobs` 和 `assets.delete` 为兼容入口。`files.stream.finish()` 返回的完成文件 ID 使用 `storage.files.list/get/remove/export` 管理：列表默认 100 条、最多 200 条，读取单块最多 512 KiB，删除释放私有输出配额，导出必须由用户在原生保存框选择目标。详细参数、旧数据兼容和提交不确定性见[存储标准](storage.md)，完整类型见 [API 类型](api-types.md)。

### `storage.session.get / set / remove / clear`

会话态 KV：适合草稿、临时缓存、轮询状态。

| | |
|--|--|
| **权限** | 基础能力，无需声明或授权 |
| **参数 / 返回** | 与 local 相同；载荷配额为每插件8MiB、全局64MiB，不使用local的512KiB单值限制 |

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
// 保留兼容参数；宿主自己的文本、图片和文件写入都不会回送原生变化观察器。
await enest.clipboard.writeText(secret, { excludeFromHistory: true })
```

`excludeFromHistory` 仍接受布尔值，但当前宿主已统一排除自己的写入，不因省略或传 `false` 而将内容送入后台。此机制不删除插件已有历史，也不能控制其它应用记录或插件自行持久化收到的数据。宿主不延迟清空系统剪贴板，避免覆盖用户随后复制的新内容。

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

### 文件、回贴与平台能力

| 方法 | 返回 / 边界 |
|---|---|
| `clipboard.capabilities()` | `Promise<{ files, sourceApp, paste, permissionRequired, reason? }>`；布尔字段反映当前平台能力，不授予权限 |
| `clipboard.requestPermission()` | 同上；需 `clipboard.paste`，只请求平台明确支持的系统授权，不授予持续观察权限 |
| `clipboard.writeFiles(paths)` | `Promise<boolean>`；需 `clipboard.write`，只写文件引用，不复制原件或授予文件内容读取能力 |
| `clipboard.paste()` | `Promise<{ pasted: boolean; reason?: string }>`；需 `clipboard.paste`，回贴当前已复制内容，不接收历史 ID、目标进程或键盘脚本 |
| `clipboard.inspectFiles(paths)` | `Promise<Array<{path,exists:boolean\|null,directory?}>>`；未获当前实例文件能力的路径不探测，`exists` 为 `null` |
| `clipboard.revealFile(path)` | `Promise<boolean>`；宿主先展示原生目标确认，确认并获得文件能力后才定位；取消不授予能力 |

回贴目标由宿主在 Quick 呼出前捕获，失效、系统拒绝或平台不能恢复原窗口时返回 `pasted:false`。复制成功不等于回贴成功；失败时保留已复制内容并提示手动粘贴。来源不能可靠确认时不提供 `sourceApp`；Wayland 不承诺原窗口恢复。

### 剪贴板历史属于插件，不是宿主命名空间

clipboard 的历史模型、去重、置顶、保留、迁移解释与搜索位于插件自己的沙箱后台。它的前台通过 `enest.background.call('history.query', [options])` 等私有 RPC 访问；`history.*` 是该插件自行注册的方法，不是所有插件共有的宿主接口，也不允许跨插件调用。插件的 `createClipboardApi(host)` 只创建本地 facade，不修改或扩充冻结的 `window.enest`。

```js
// 仅 clipboard 插件自己的前台：方法名由其 background/history.mjs 实现。
const page = await enest.background.call('history.query', [{ query: '草稿', limit: 20 }])
```

`clipboard.history` 保留为敏感权限名，约束原生 `clipboard.changed` 观察及相关后台访问，不重新提供历史 CRUD。持续观察和 Quick 后台搜索要求持久 `allow`；本次运行授权只能支持当前前台实例调用其后台，不能开启持续采集。声明、设置绑定、停用与撤权见下节及[权限说明](permissions.md)。

---

## background — 插件私有沙箱后台

manifest 的 `background` 声明包内生产 HTML、原生事件、可选的布尔设置绑定和 Quick 搜索能力。例如剪贴板插件使用以下声明，同时在 `contributes.settings` 注册 `monitoring` 开关，并声明 `clipboard.history` 权限：

```json
{
  "background": {
    "entry": "assets/background.html",
    "events": ["clipboard.changed"],
    "eventSettings": { "clipboard.changed": "monitoring" },
    "quickSearch": true
  }
}
```

后台只有 `window.enestBackground`，没有普通插件 `enest`、Node、任意网络或路径访问。外部脚本调用 `register({onEvent?,call,search?})` 注册一次；`onEvent(event,data)` 接收已授权的原生快照，`call(method,args)` 执行本插件方法，`search(query,limit)` 返回本插件搜索结果。`clipboard.changed` 的数据是带 `revision/capturedAt/type` 的文本、图片或文件引用快照，不是历史记录；宿主只有一个共享的有界原生观察器，不执行历史策略。

`enestBackground.host.private` 提供 `readDocument/writeDocument/getBlob/putBlob/removeBlob`，文档原子替换且数据只属于当前插件。`host.settings.get()` 只读本插件设置；`host.emit(event,data)` 只发到本插件存活前台的 `background.event`。`host.legacy` 仅提供宿主预定的一次性旧数据迁移源，不接受任意文件路径。业务必须等持久化完成再返回，串行化并发修改由插件实现。

前台 `background.call(method,args?,{timeoutMs?}?)` 返回后台结果；默认超时30秒，可设250毫秒至24小时，仍受消息、并发与队列限制，不是无限期保活授权。后台可空闲回收并从私有文档重建。无授权、禁用、撤权或手动停止后不由设置刷新/Quick 查询偷偷唤醒；性能面板停止后，显式前台调用、禁用再启用或构建更新可以重新启用。关闭前台不等于关闭已获持久观察授权的事件订阅。

源码预览的后台也必须有匹配 manifest 的 `dist/assets/background.html` 及构建后的脚本；缺失时明确失败，不以 Node、宽松网络或直接执行源码兜底。它与需完整本机信任的 `backend.node` 是不同机制。

---

## screen — 原生截图与显示器

宿主 `screen` 只有 `capture` 与 `displays`。截图及辅助页显示捕获在 macOS 受系统「屏幕录制」TCC 控制；被拒后需到系统隐私设置开启并按系统要求重启 eNest。宿主 `allow` 不绕过系统门禁，拒绝报 `os permission denied: screen`。Linux Wayland 依赖系统 portal，实际平台行为需分别验证。

### `screen.capture(opts?)`

截取指定显示器的全部或局部区域。

| | |
|--|--|
| **权限** | `screen.capture` |
| **参数** | `opts?: { displayId?: number; bounds?: ScreenBounds }` — 缺省主屏全屏；`bounds` 为设备像素（相对该 display），越界部分自动裁交 |
| **返回** | `Promise<{ dataUrl: string; width: number; height: number; displayId?: number }>` — PNG dataURL、裁剪后尺寸与当前显示器 ID |
| **错误** | `permission denied: screen.capture`、`os permission denied: screen`、`Requested display capture unavailable` 等 |

```js
const shot = await enest.screen.capture({ displayId, bounds: { x, y, width, height } })
```

### `screen.displays()`

基础能力，无需敏感权限；返回 `Promise<Array<{id,bounds,workArea,scaleFactor,primary}>>`。显示器几何是 Electron 的桌面逻辑坐标（DIP），截图 `bounds` 是相对目标截图的设备像素，不要直接混用。显示器移除后旧 ID 可能失效，应重新读取。

---

## auxiliary / files.stream — 通用原生容器与私有输出

普通插件用 `auxiliary.open({entry,data?,...})` 打开本插件 `assets/` 内的 HTML，返回 `{windowId}`；`send(windowId,data,{visible?}?)` 传消息或请求显示/隐藏，`close(windowId)` 关闭，`list()` 返回当前实例的 `{windowId,entry}[]`。几何、显示器和样式选项见自动生成的 `AuxiliaryOpen`。辅助页只有 `enestAux.getContext/onMessage/post/close`，`getContext()` 仅可消费一次；它不能调用主页面的剪贴板、设置、文件或完整 `enest`。前台通过 `auxiliary.message` / `auxiliary.closed` 接收带 `windowId` 的事件。

普通辅助窗口是基础 UI 能力；非捕获窗口的 `alwaysOnTop:true` 仍需兼容权限 `pin.create`，不是宿主贴图 API。`capture:{displayId?,withAudio?}` 需 `screen.record` 与系统许可，且主插件可见；只允许当前辅助页主 frame 在真实原生点击后请求一次指定显示器的 `getDisplayMedia`。不允许页面自报捕获 ID、合成激活、摄像头或麦克风权限；音频选项是平台支持时的系统 loopback，不保证每个平台可用。每插件最多8个辅助窗口、全局24个；窗口、代次、消息、Session 与活动租约由宿主有界管理。

`files.stream` 是基础私有输出能力，不是任意文件系统接口：

| 方法 | 返回 / 边界 |
|---|---|
| `open({extension})` | `Promise<{streamId}>`；扩展名为1–12位小写字母/数字，`part` 为保留值，不接受路径 |
| `write(streamId,sequence,bytes)` | `Promise<void>`；`bytes` 为非空 `ArrayBuffer`，序号从0递增，等待 ACK 后继续写 |
| `finish(streamId)` | `Promise<{id,path,size}>`；同步、关闭并提交私有文件后才成功；path 为 deprecated 兼容字段 |
| `abort(streamId)` | `Promise<boolean>`；丢弃未完成输出 |

每插件最多2流、全局16流；每块512KiB、每流最多16个待写/8MiB排队、单文件1GiB、每插件私有输出4GiB/4096项。`id` 原样交给 `storage.files` 进行列表、分块读取、删除或导出；`path` 不是下一次任意路径读写授权。撤权/强制销毁会回收窗口、捕获轨和未完成输出；正常关闭只在有界收尾期内尝试保存，超时/磁盘失败不能显示保存成功。rename 提交后发生目录同步失败或代次失效时，已发布文件保留并明确报告已提交但完成状态未确认；应先刷新文件列表，不能把 reject 当作文件必定不存在。卸载清理该插件私有输出，不改写已保存的业务历史。详见[私有输出生命周期](storage.md)。

---

## 插件侧选区、录制与贴图

官方插件共享包 `@enest/native-surfaces` 实现选区、图像缩放、贴图交互、MediaRecorder 与录制状态。它组合上述原生能力，创建独立 facade；不是 SDK 新命名空间，不改写 `window.enest`。插件需将此包及页面资产随自身构建，Vite 配置加入 `nativeSurfacesAssets()`（导入自 `@enest/native-surfaces/vite`），生成分发路径 `assets/vendor/native-surfaces/`。

```js
import { createNativeSurfaces } from '@enest/native-surfaces'

const surfaces = createNativeSurfaces(window.enest)
const bounds = await surfaces.screen.selectRegion()
if (bounds) {
  const { dataUrl } = await surfaces.screen.capture({ bounds })
  await surfaces.pin.open({ dataUrl, width: 420, title: '参考图' })
}
```

此包的 `surfaces.screen.selectRegion()` 返回带 `displayId` 的设备像素矩形或 `null`；选区截图需 `screen.capture`，当前置顶选区页还需 `pin.create`。`surfaces.pin.open/close/list/closeAll` 管理本插件贴图，仅接收图片 dataURL，不提供任意路径读取。

`surfaces.screen.record.start({bounds?,displayId?,withAudio?})` 等待用户在辅助页真实点击开始后返回 `{sessionId}`；`stop(sessionId)` 返回 `{id,path,size,durationMs}`，其中 `id` 用于 `storage.files`，`path` 仅兼容；`cancel(sessionId)` 丢弃未完成录制。每个 facade 同时只保留一个录制会话，状态与裁剪/编码策略属于插件；输出通过有序 `files.stream` 提交，不再写宿主的业务专用 `recordings/` 服务。

第三方也可用 `auxiliary` 实现自己的交互，不必复制官方业务包。辅助页/后台、主页面和 Node 后端的能力不同，不能交换桥对象来绕过授权，见[窗口边界](settings-and-windows.md)。

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

- **协议限制**：缺省 URL 与每次重定向都必须是 `https://`；manifest 声明 `"net": { "allowInsecure": true }` 时才放行明文 `http://`。宿主有界手动跟随，逐次校验协议；这不是目标 IP/内网隔离策略，不承诺阻断所有内网请求或 SSRF。
- **GET / POST / PUT / PATCH / DELETE / HEAD**
- **响应体上限**：非流式 2 MiB；`stream: true` 流式 32 MiB，完整响应体经 `net.chunk` 事件分片推送，不是先返回 2 MiB 再推送余量；普通 chunk 为 base64。
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

供 noVNC、TCP 调试类插件使用。仅 outgoing 连接（不提供任意监听）；与
插件自己的 SSH 后端打开的本地隧道口衔接：先建隧道，再
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
后续连接即使 token 对也被拒绝；忽略客户端扩展 offer，不协商压缩并拒绝带 RSV 的帧）。桥建立后该 socket 的双向流直通 ws 二进制
帧（不再经 IPC 分片），不识别 RDCleanPath、X.224 或其他应用协议。RDP 协商由远程桌面插件私有后端提供；这里以插件页内 noVNC 等字节流客户端为例：

```js
const { socketId } = await enest.net.socket.connect({ host: '127.0.0.1', port: 5901 })
const { url } = await enest.net.socket.serveWs(socketId)
const ws = new WebSocket(url)  // ws.binaryType = 'arraybuffer'，双向二进制流
ws.binaryType = 'arraybuffer'
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

### 打开方式（宿主统一能力，非插件 API）

「设为默认打开软件」不暴露给插件：系统关联的写入目标只能是 eNest 本体（插件是壳内视图），注册、状态检测与「类型→插件」路由统一由壳主进程负责。插件只经 [manifest `contributes.openWith`](manifest.md#打开方式contributesopenwith) 声明能处理的类型/scheme；命中后以 `onEnter`（`code: 'open-file' | 'open-url'`）收到 `{ paths?, handles?, url? }`，文件读取走 `localFiles.read` 只读句柄。管理界面在壳设置 → 通用 → 打开方式。

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
| **权限** | 基础文件能力，无需声明 `fs.write` 或 `shell.openExternal`；仍需用户经原生保存框选定目标 |
| **参数** | `payload: { defaultName?: string; filename?: string; content: string }` |
| **返回** | `Promise<{ ok: boolean; path: string } \| null>` — 用户取消时返回 `null` |

```js
const saved = await enest.shell.saveTextFile({
  defaultName: 'report.md',
  content: markdownText
})
if (saved?.ok) enest.ui.toast({ message: `已保存到 ${saved.path}` })
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
// secretRef can be passed to the plugin's own backend; never return plaintext to the page.
await enest.backend.call('connect', [{ host, username, secretRef }])
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

## quickInput — Quick 顶部输入接管

### `quickInput.configure(config)` / `release()` / `escape()`

仅当前挂载于 Quick 小窗的插件可接管顶部输入框。

| | |
|--|--|
| **权限** | 基础能力，无需声明或授权 |
| **参数** | `config: { placeholder: string; value: string }` — placeholder ≤160 字符，value ≤100000 字符 |
| **返回** | `Promise<boolean>` — 接管/释放/退出是否生效 |

```js
await enest.quickInput.configure({ placeholder: '输入待办内容…', value: draft })
const offChange = enest.quickInput.onChange(value => setValue(value))
const offAction = enest.quickInput.onAction(action => {
  if (action === 'submit') save()
})
```

迁移、隐藏、返回全局搜索或实例销毁立即解除接管，旧 generation 的消息无效；重新进入 Quick 需重新 `configure`。`onChange` 收到宿主输入框的实时文本，`onAction` 收到 `next / previous / submit / clear`（方向键、Enter、清空）。完整键盘语义见[多布局工具接口 — 接管顶部输入](dual-mode-tools.md#接管顶部输入)。

### `quickInput.readContext()`

读取本次 Quick 启动注入给当前插件实例的输入上下文（文本 / 粘贴图片 / 粘贴文件）。

| | |
|--|--|
| **权限** | 基础能力，无需声明或授权 |
| **参数** | 无 |
| **返回** | `Promise<QuickEnterInput \| null>` — `{ text?, images?: Array<{ dataUrl, width, height }>, files?: Array<{ handleId, path, name, size, kind }> }`；无上下文或实例已换代返回 null |

```js
// onEnter 已交付同一对象；输入框清空后重开插件、或需要按当前上下文继续处理时再读取。
const ctx = await enest.quickInput.readContext()
if (ctx?.images?.length) importImages(ctx.images.map(image => image.dataUrl))
```

文件条目经 `localFiles.read/list({ handleId })` 读取（宿主签发的只读句柄），`path` 仅用于展示。上下文只在 Quick 启动注入的成功实例与当前 runtime 代次内可读；离开 Quick、换代或销毁后返回 null，重复激活不重放旧上下文。字段边界与启动语义见[多布局工具接口 — 输入上下文](dual-mode-tools.md#输入上下文)。

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
| `enter` | 首次加载完成 / Tab 激活 / 唤醒重建 | `{ tabId, code?, type?, payload?, input?, mode? }` |
| `out` | 切到其它 Tab / Quick 退场 | `{ isKill: false }` |
| `beforeClose` | 即将销毁 | `{ reason }` |
| `destroy` | 关闭已开始 | `undefined` |
| `mode-change` | 布局值变化（quick / shell / panel；不重载页面，同布局的容器迁移不发送） | `{ mode }` |
| `theme-change` | 主题变更 | `{ mode, tokens }` |
| `hotkey` | 插件注册的全局热键被按下 | `{ accelerator }` |
| `locale-change` | 壳子界面语言变更 | `{ locale }` |
| `quick-query` | Quick 搜索查询（已注册 provider 的插件） | `{ reqId, query }` |
| `backend.event` | 本插件后端命名事件 | `{ event, data }` |
| `deadline-task-change` | 本插件计划状态提交 | `{ taskId }` |
| `background.event` | 本插件沙箱后台主动发布；具体事件名由插件定义 | `{ event, data }` |
| `auxiliary.message` | 本插件当前辅助页发送消息 | `{ windowId, data }` |
| `auxiliary.closed` | 本插件辅助页关闭 | `{ windowId }` |
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
  await enest.storage.commit([{ op: 'set', key: 'draft', value: editor.value }])
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
- 休眠中的插件无活动渲染进程，不参与脏检测与保存广播；插件须在 `beforeSuspend` 中确认自己的持久检查点，不能把宿主内存 session 快照当作磁盘提交。

### 扩展约定

- topic 命名 `<域>.<节点>`（如 `update.downloaded`）；新 topic 只会追加，不会改语义。
- 新增关键节点 = 在 `@shared/types/notice` 的 `ShellNoticeDataMap` 加条目 + 本表加行；插件侧遇到未知 topic 忽略即可，无需适配。

---

## runtime — 活动租约

用于确有在途工作的短期活动保护，避免该实例被闲时休眠或 LRU 回收；不是常驻权限，也不是数据持久化回执。

| 方法 | 参数与返回 |
|---|---|
| `runtime.acquireActivity(reason?)` | 可省略 `reason`；提供时必须为字符串且 `length <= 160`。返回 `Promise<string>`，值为当前运行代次的不透明 token |
| `runtime.releaseActivity(token)` | 释放当前代次自己的 token，返回 `Promise<void>`；不存在、重复或其它代次的 token 不产生作用 |

每个运行实例最多128份、全局最多4096份**通过本 API 申请的显式租约**。超额、实例关闭或代次过期时申请 reject；这些限额不表示其它原生资源可以无限创建，它们仍各有预算。应在 `finally` 释放，而不是用永久租约替代真正的后台能力。

```ts
const token = await enest.runtime.acquireActivity('生成预览')
try {
  await generatePreview()
} finally {
  await enest.runtime.releaseActivity(token)
}
```

租约不阻止用户关闭、撤权、停用、卸载、崩溃回收或应用退出。宿主销毁原代次时自动回收租约；重建实例不能释放旧代次或其它插件的租约。关闭后的旧页面仍受 IPC 生命周期门禁约束，不能凭 token 恢复实例。详细生命周期见[生命周期与资源责任](lifecycle.md)。

---

## 生命周期

完整状态机见 [生命周期](lifecycle.md)。

### `onEnter(cb)`

进入插件：**首次交互打开完成后** + **再次激活** + **休眠唤醒或用户显式重试崩溃页面的重建完成后**。与 `onOut` 配合 pause / resume；插件可能被销毁重建，初始化逻辑要可重入。MCP 隐藏冷启动不发送前台进入事件，因此通用处理器注册不能依赖本回调。

| | |
|--|--|
| **参数** | `cb: (event: { tabId: string; code?: string; type?: 'text' \| 'regex' \| 'over' \| 'img' \| 'files'; payload?: unknown; input?: QuickEnterInput; mode: 'quick' \| 'shell' \| 'panel' }) => void` |
| **返回** | `() => void` — 取消订阅 |

```js
enest.onEnter(({ tabId, code, type, payload, input, mode }) => {
  console.log('进入', tabId, code, payload, mode)
  // Quick 粘贴上下文：文本 / 图片 dataUrl / 宿主签发的只读文件句柄
  const text = input?.text ?? (typeof payload === 'string' ? payload : '')
  for (const image of input?.images ?? []) loadFromDataUrl(image.dataUrl)
  for (const file of input?.files ?? []) readViaHandle(file.handleId)
})
```

`code` / `payload` 来自 `openPlugin` 的进入载荷，对应 `features[].code` 与透传数据；Quick 打开插件时 `payload` 恒为当前输入文本（regex/over 命中为原始文本，provider 结果为 provider 载荷）；`input` 为本次启动携带的粘贴上下文（文本/图片/文件，有界），仅 Quick 启动携带上下文时存在。`mode` 为本次进入的布局（quick / shell / panel），与 `getLaunchMode()` 一致，但不代表当前原生容器。完整交互见[多布局工具接口 — 输入上下文](dual-mode-tools.md#输入上下文)；重复激活不重放旧 `payload`/`input`。实际挂载于 Quick 期间可用 `enest.quickInput.readContext()` 重取本次上下文。

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

- 回调返回 **Promise** 时，preload 会等它 settle 后再回 ack（关闭流程随之等待）；reject 回报保存未确认，不伪造成功。
- 纯同步回调 / 无监听器时，preload 通过 microtask 确认，不使用固定 50ms 延迟；必要写入必须返回并等待 Promise。
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

## 布局模式（launch mode）

`PluginLaunchMode` 表示插件的三种呈现布局：quick 紧凑工具、shell 完整工作台、panel 组件摘要。它由打开入口、用户启动偏好与 manifest `views` 共同选择。普通启动请求布局未声明时用 `views.default`，不会把不支持的布局传给插件；加入自由面板则必须显式声明 panel，不走兼容回退。

启动请求目标 `PluginLaunchTarget` 只有 quick/shell。Quick、快捷键与 Workspace 打开经统一启动器解析：最终 quick 布局进入 Quick，其余布局在主窗显示；Workspace 目录、详情和首页搜索显式请求 shell。`views.default` 仅在请求布局未适配时使用，因此默认 panel 不覆盖已适配的 quick/shell 请求；只有请求未适配且最终回退 panel 时，启动器才在主窗呈现组件布局，不自动创建自由面板。宿主普通打开（`ShellOpenPlugin`）不走这套目标重选：请求 shell 并保留主窗位置，即使回退 quick 布局。

用户明确固定到主窗或拖入 Quick 时保留指定位置，再选择 shell/quick 或默认布局。加入自由面板先检查 `views.layouts` 包含 panel，否则不显示候选并拒绝挂载；通过后始终选择 panel。独立窗口保留原布局，因此 mode 不能作为原生位置探测 API。

已有面板组件或独立窗口从普通 Quick 搜索（未指定显式目标）或 `ShellOpenPlugin` 打开时原地聚焦，新载荷正常交付；Workspace 打开、显式设置入口、快捷键目标或原生迁移动作仍可移动实例。不能把所有主窗按钮都视为原地聚焦入口。面板、主窗、独立窗共用业务状态，普通插件不读取宿主完整设置，也不操纵父窗口。入口决策与实际内容区的适配见 [UI 集成标准](ui-standard.md#三种布局与挂载位置) 和 [自由面板](panels.md)。

### `getLaunchMode()`

| | |
|--|--|
| **返回** | `'quick' \| 'shell' \| 'panel'` — 当前布局模式 |
| **同步** | 是，不走 IPC（URL 初始值 + 事件实时更新） |

```js
const mode = enest.getLaunchMode()
if (mode === 'quick') renderCompact()
else if (mode === 'panel') renderWidget()
else renderFull()
```

URL query 中的 `?mode=quick|shell|panel`（与 `?pid` / `?code` 并列）只是**初始值**，首个脚本可同步读取；容器迁移后 URL 不再代表当前值，运行时一律以 `getLaunchMode()` / `onModeChange` 为准。

### `onModeChange(cb)`

订阅布局模式变更。容器迁移（⌘Enter 固定到主窗、移入/移出自由面板等）**不重载页面**，仅当最终布局值变化时推送本事件。独立窗口沿用原布局，或主窗承载的 panel 布局移入面板时，迁移可能没有模式事件；尺寸变化另用 `ResizeObserver`，不要靠 onEnter 重建业务。

| | |
|--|--|
| **权限** | 无 |
| **参数** | `cb: (mode: 'quick' \| 'shell' \| 'panel') => void` |
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
| `mode-change` | `{ mode: 'quick' \| 'shell' \| 'panel' }` |

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

`pickSave` 的文件名和扩展名由调用插件决定；省略或传入空 `defaultName` 时使用原生对话框默认行为，宿主不预设数据库等业务文件类型。非空建议名最多 255 字符、不含 NUL，宿主只取 basename，不允许借建议名指定初始目录。

`localFiles.read({ handleId, encoding: 'text' | 'dataUrl', maxBytes? })` 直接读取用户已选定并授予句柄的文件，返回 UTF-8 文本字符串或带 MIME 的 data URL 字符串。文本默认 2 MiB、data URL 默认 16 MiB，调用方可设置 `maxBytes`，最大 32 MiB；每插件最多两次并发读取。只接受普通文件，不跟随符号链接；关闭、重载或撤权后原句柄失效。官方插件的文本导入、图片预览通过此接口读取，不持久化系统路径或句柄。

数据库插件自己的文件选择适配器组合通用 `files.pick/save`（后端控制）或 `localFiles.pick/pickSave`（页面），不再存在宿主 `db.pickSqliteFile` / `db.pickImportFile`。句柄用途与代次规则不变，不要保存句柄跨重启复用。

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
