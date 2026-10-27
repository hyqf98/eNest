# Quick 与桌面工具接口

同一个插件使用 `enest.getLaunchMode()` 判断 `quick` 或 `shell`，通过 `onModeChange(mode)` 订阅真实容器变化。迁移沿用同一个 WebContents、文档和业务状态。宽度断点只调整空间，不能代替模式判断。声明式设置与插件自己的管理页面可同时存在。

## 接管顶部输入

```js
const offChange = enest.quickInput.onChange(value => updateQuery(value))
const offAction = enest.quickInput.onAction(action => {
  if (action === 'next') selectNext()
  if (action === 'previous') selectPrevious()
  if (action === 'submit') performSelected()
})
await enest.quickInput.configure({ placeholder: '搜索内容…', value: draft })
```

仅当前 Quick 插件能够配置输入；主进程绑定插件 ID 与 runtime generation。迁移、隐藏、返回全局搜索或销毁立即解除接管，旧实例的消息无效。重新进入 Quick 时重新 configure。未接入的插件保留全局搜索。中文输入法组合期间，导航与提交不执行。

`Mod+K` 聚焦顶部输入，`Mod+Enter` 固定到桌面，多行执行使用 `Mod+Shift+Enter`。顶部输入栏和普通工作台中的裸 Esc、返回按钮均直接回到空白全局搜索。终端、编辑器和弹层声明相应 inputContext 后继续自行处理 Esc；输入法组合期间宿主不拦截。长按 Esc 不会在返回后继续隐藏 Quick。插件主动调用 `quickInput.escape()` 仍先清空非空查询，再返回搜索；清空按钮只清空查询。

## 输入上下文

Quick 小窗的输入框支持粘贴图片与文件（uTools/zTools 的内容上下文模型）。粘贴后输入框左侧出现有界缩略图，悬停显示删除按钮，空输入框 Backspace 移除最后一项，Esc 先清上下文再退出。图片与文件字节由宿主按会话保管（最多 8 张图 / 单张 12 MB / 合计 32 MB，最多 20 个文件），Quick 隐藏、退场或成功启动即清空，不跨呼出保留，主题表面只见缩略图。

搜索时携带图片/文件上下文会命中插件 `features[].cmds` 中声明的 `img`/`files` 指令（详见 [plugin.json](manifest.md)）；纯名称或别名打开插件时，当前输入文本同样随启动交付，等价 uTools「选择处理器后带入内容」。插件在 `onEnter` 中接收：

```js
enest.onEnter(async ({ code, type, payload, input }) => {
  // 1) 文本：payload 始终是当前原始输入字符串（含 regex/over 命中），保持旧插件兼容。
  const text = input?.text ?? (typeof payload === 'string' ? payload : '')
  // 2) 图片：宿主校验过的 data URL，可直接作为 <img src>。
  for (const image of input?.images ?? []) loadCanvas(image.dataUrl)
  // 3) 文件：宿主签发的只读句柄；读取走 localFiles.read({handleId})，不承诺裸路径可访问。
  for (const file of input?.files ?? []) {
    const handle = { id: file.handleId, name: file.name, kind: file.kind, size: file.size }
    if (handle.kind === 'file') { const dataUrl = await enest.localFiles.read({ handleId: handle.id, encoding: 'dataUrl' }); importImage(dataUrl) }
  }
})
```

| 字段 | 约定 |
|---|---|
| `input.text` | 启动时的输入文本（≤4096 字符），与 `payload` 同源 |
| `input.images[]` | `{ dataUrl, width, height }`；PNG/JPEG/WebP/GIF，数量与体积受宿主预算约束 |
| `input.files[]` | `{ handleId, path, name, size, kind: 'file'\|'directory' }`；`handleId` 是本实例的只读 `localFiles` 句柄，`path` 仅用于展示，插件读取一律经 `localFiles.read/list({handleId})` |
| `type` | 命中的内容指令类型：`text`/`regex`/`over`/`img`/`files` |

已被注入的上下文可在插件仍挂载于 Quick 期间通过 `enest.quickInput.readContext()` 重新读取（返回同形状 `QuickEnterInput`，无则为 null）；离开 Quick、换代或实例销毁后失效。重复激活（无新载荷的 enter）不会重放旧 input。

该链路由当前宿主源码引入。更早打包的旧宿主按旧 `plugin-manifest.schema.json` 校验，`features.items.additionalProperties:false` 会直接拒绝包含 `img`/`files` 指令的包（fail-fast），属预期；新宿主接受并执行完整链路。官方参考实现见插件仓 `plugins/image-tools`（粘贴图片 → 压缩）。

## 设置、主题和反馈

`contributes.settings` 提供静态声明与默认值；`settings.get(key)` 优先读已保存值，无值才返回声明默认值（false 和 0 不会被误判为空）。`settings.set(key,value)` 只能写声明过的键；`settings.onChange(({key,value})=>{})` 同步壳设置变更。`ui.openSettings()` 隐藏原生插件层并定位当前插件设置。复杂管理入口使用 `type: 'page'` 和 `entry: {code,payload?}`。

持久偏好放设置，业务数据和必要草稿放 `storage.get/set`，当前操作参数可以只在页面中维护。`storage.local` 是兼容能力名，不是 API 命名空间。JSON 正文与生成的密码默认不落盘。插件内反馈应显示在自己的文档中，因为原生 WebContentsView 会盖住壳 renderer 的浮层。

主题同步包括 CSS token、`data-theme`、`data-anim`、字体栈和字号比例。用户自定义字体经当前插件同源的 `__enest_fonts/<filename>` 白名单地址流式加载。插件遵守 `prefers-reduced-motion`；低动画档不要播放大幅位移动画。

插件仓库 `packages/plugin-kit` 以版本化 workspace 依赖 `@enest/plugin-kit` 提供适配器，由 Vite 打入 dist；样式导入 `@enest/plugin-kit/style.css`，不要逐插件复制共享源码。

## 剪贴板

eNest 0.2.3 的原生 `window.enest` **没有 `clipboard.history.*`**。clipboard 1.4.0 的历史、去重、置顶、保留策略、迁移解释和搜索属于插件的 `background/history.mjs`；前台通过通用 `background.call` 访问自己的后台。其 `createClipboardApi(host)` 创建本地 facade，保留该插件 UI 的 `query/list/get/copy/paste/reveal/onChange` 调用形式，但不修改宿主 API，也不把历史服务开放给其它插件。

- 该插件的私有 `history.query` 返回 `{items,total,nextCursor}`；`history.get` 按需读取图片，变更通过 `background.event` 中的 `history.changed` 通知。宿主不再发送 `clipboard-history-changed`。
- 后台用 `enestBackground.host.private` 的文档/blob 保存数据，接收 `clipboard.changed` 原生快照；文件记录保存引用，不复制原件。历史查询、排序和修剪不是宿主工作。
- 原生 `clipboard.readText/readImage/writeText/writeImage/writeFiles` 保留；写入各自校验剪贴板权限，宿主自己的写入不回送原生观察器。`clipboard.capabilities()` 返回平台能力；`requestPermission()` 另需 `clipboard.paste`，只请求平台支持的系统授权，不开启持续观察。
- `clipboard.history` 仍是敏感权限名，但不是 CRUD。只有持久 `allow`、插件启用且声明的事件开关为真时才订阅原生变化；临时授权只供当前前台调用后台，不能开启持续采集或 Quick 后台搜索。撤权、禁用或手动停止后台会释放订阅；停用期间的内容不会补采。

回贴分为插件复制与原生 `enest.clipboard.paste()` 两步；后者无需参数，不接收历史 ID、窗口 ID、进程 ID 或键盘脚本。目标只由宿主在 Quick 呼出前捕获。复制失败不要继续回贴；复制成功后，目标失效或平台不能恢复原窗口时返回 `{pasted:false,reason}`，提示手动粘贴。Wayland 不承诺原窗口恢复。

纯复制完成后收起使用 `ui.dismissQuick()`，没有 `quick.hide()`。回贴流程由宿主验证目标并隐藏 Quick，失败时可恢复；不要收到失败结果后无条件隐藏错误提示。

## 截图、录制与贴图

宿主只提供 `screen.capture/displays`。选区几何、贴图缩放/交互、MediaRecorder 和录制会话由插件仓 `@enest/native-surfaces` 实现。插件调用 `createNativeSurfaces(window.enest)` 得到本地 facade，才有 `surfaces.screen.selectRegion/record` 与 `surfaces.pin`；这些不是原生 `enest.screen` / `enest.pin` 方法。

插件 Vite 配置用 `nativeSurfacesAssets()`（`@enest/native-surfaces/vite`）将辅助页随自身分发到 `assets/vendor/native-surfaces/`。宿主的 `auxiliary` 管理有界原生容器，辅助页只持有 `enestAux`；主页面通过 `files.stream` 顺序写入自己的私有输出，不接受任意保存路径。非捕获置顶页使用兼容权限名 `pin.create`；捕获页使用 `screen.record`、系统许可和真实原生点击启动一次指定显示器的捕获。选区截图本身仍需 `screen.capture`，当前置顶选区页也需 `pin.create`。

录制必须等待文件流 ACK，停止后提交成功才展示保存完成；取消、撤权或强制销毁会终止捕获并丢弃未完成输出。正常关闭只在有界收尾期内尝试排空，不能把超时或磁盘失败报告为成功。具体签名、配额与能力边界见 [API 参考](api.md) 和[设置与窗口边界](settings-and-windows.md)。

## 后台番茄钟

`timer.background` 是基础能力，提供 `deadlineTasks.start/get/pause/resume/skip/cancel/onChange`。宿主只保存有界步骤计划和不可变执行回执，不理解专注/休息，不接受任意脚本。关闭标签不取消、退出暂停、禁用取消、卸载清理；周期/统计/历史编辑属于插件。通知另需 `notify`，见[后台步骤计划](deadline-tasks.md)。

自然到期只结算一次，跳过不计完成；系统睡眠跨过截止时间只结算当前阶段，下一阶段暂停。退出应用保存剩余进度，重启恢复暂停；退出期间不承诺通知。

## 附件与导出

图片统一使用 `storage.assets.put/list/get/remove`；`put` 支持互斥的 `{bytes,mime}` 或 `{dataUrl}`，支持 PNG/JPEG/WebP/GIF，单文件32MiB、每插件合计1GiB/10,000项。旧 `storage.blobs.put/get/remove` 是同服务兼容适配，旧附件UUID仍可读删并出现在assets列表，不在启动时全量搬迁。稳定ID必须原样保存，不手拼扩展名；ID不能跨插件读取，关闭实例取消在途操作，卸载清理资源。完整选择与提交语义见[存储标准](storage.md)。

`shell.saveTextFile({defaultName,content})` 和 `shell.saveFile({defaultName,dataUrl})` 使用系统保存对话框，是无需额外声明 `fs.write` 的基础能力，仍需用户选定目标；取消返回 null，成功返回 `{ok:true,path}`。关闭插件后对话框即使晚返回，也不会继续写文件。界面仅在 `result?.ok` 时显示保存成功。

## 出站 TCP 与本地桥（net.socket）

远程桌面（noVNC / RDP）与 TCP 调试类插件的底层通道，需声明 `net.socket` 权限。典型路径是先经本插件私有 SSH adapter 的 `workbench({action:'tunnel.open'})` 把远端端口转发到本地，再 `net.socket.connect({host:'127.0.0.1', port})` 衔接隧道口。

- 每插件并发 socket 上限 8；连接超时缺省 10s；发送方向 1MB/s 令牌桶限速（突发 2MB）。
- 数据经 `net.data`（base64，64KB/20ms 节流合并）与 `net.close` 事件推送；`enest.net.onNetData / onNetClose` 订阅。
- 高吞吐场景（VNC / RDP 逐帧流）用 `net.socket.serveWs(socketId)` 换取直连：桥只绑 `127.0.0.1` 随机端口，token 一次性，页面内 `new WebSocket(url)` 后双向二进制直通，绕开逐帧 IPC。
- 插件关闭、休眠或崩溃时宿主经 runtime scope 统一释放全部 socket 与 ws 桥，不泄漏端口。

## 插件业务与系统巡检

AI CLI 十个应用的适配、白名单、最小侵入合并、快照、资产 staging 和会话读取位于插件仓 `@enest/agent-config-backend`，由 CCSwitch 和 Codex Pets 自己打包。0.2.2 已移除宿主 `agent.*`，插件通过通用 `backend.call` 与 `dialog.confirm` 执行；首次使用需要明确的完整 Node 信任，不继承旧 config.agent 权限。

`sys.processes()` / `sys.ports()` 提供 1s 采样缓存的进程与监听端口视图；`sys.kill` 使用 sys.control 并由宿主确认 PID，插件的 confirmed 参数不构成授权，宿主拒绝结束自身与 PID 1。详见 [enest API](api.md)。
