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

## 设置、主题和反馈

`contributes.settings` 提供静态声明与默认值；`settings.get(key)` 优先读已保存值，无值才返回声明默认值（false 和 0 不会被误判为空）。`settings.set(key,value)` 只能写声明过的键；`settings.onChange(({key,value})=>{})` 同步壳设置变更。`ui.openSettings()` 隐藏原生插件层并定位当前插件设置。复杂管理入口使用 `type: 'page'` 和 `entry: {code,payload?}`。

持久偏好放设置，业务数据和必要草稿放 storage.local，当前操作参数可以只在页面中维护。JSON 正文与生成的密码默认不落盘。插件内反馈应显示在自己的文档中，因为原生 WebContentsView 会盖住壳 renderer 的浮层。

主题同步包括 CSS token、`data-theme`、`data-anim`、字体栈和字号比例。用户自定义字体经当前插件同源的 `__enest_fonts/<filename>` 白名单地址流式加载。插件遵守 `prefers-reduced-motion`；低动画档不要播放大幅位移动画。

插件仓库 `packages/plugin-kit` 以版本化 workspace 依赖 `@enest/plugin-kit` 提供适配器，由 Vite 打入 dist；样式导入 `@enest/plugin-kit/style.css`，不要逐插件复制共享源码。

## 剪贴板

- `clipboard.history.list` 保持旧的文本/图片返回行为；`query({query,type,pinned,cursor,limit})` 支持文件记录和分页，返回 `{items,total,nextCursor}`。
- `clipboard.history.onChange(cb)` 在历史保存成功后通知刷新。`get(id)` 按需读取原图。
- `copy(id,{paths?:true})` 复制记录或文件路径；`paste(id)` 先复制，再尝试回贴；`reveal(id,index)` 定位文件原件。失效文件会返回明确错误。
- `clipboard.capabilities()` 分别说明文件、来源、回贴与授权能力；`requestPermission()` 只请求平台明确支持的授权。来源不能可靠确认时省略 `sourceApp`，界面应显示未知来源。
- `clipboard.paste` 为独立权限；复制同时需要历史权限及相应的 `clipboard.write` / `clipboard.writeImage`。文件只保存引用，不复制到插件数据目录。

回贴的目标仅由主进程在 Quick 呼出前捕获。插件只提交历史 ID，不能提交窗口 ID、进程 ID 或键盘脚本。目标失效、权限拒绝或平台不能恢复原窗口时返回 `{pasted:false,reason}`；此时内容已复制，提示手动粘贴。Wayland 通用 portal 没有原窗口身份和恢复能力，因此始终采用复制后手动粘贴。

## 后台番茄钟

`timer.background` 权限开放 `focusTimer.start/get/pause/resume/skip/stop/updateRecord/onChange`。它是专注阶段的限定服务，不接受任意定时脚本。状态与完成记录由主进程保存，关闭标签不取消，停用/卸载会取消，卸载清理记录。通知另需 `notify` 权限。

自然到期只结算一次，跳过不计完成；系统睡眠跨过截止时间只结算当前阶段，下一阶段暂停。退出应用保存剩余进度，重启恢复暂停；退出期间不承诺通知。

## 附件与导出

`storage.blobs.put({dataUrl})/get(id)/remove(id)` 使用插件专属附件目录，支持 PNG/JPEG/WebP 原图（单个 32 MB、每插件 200 MB）。ID 不能跨插件读取；卸载清理附件。每个插件最多两个待保存附件，关闭实例取消在途写入并清理残留。

`shell.saveTextFile({defaultName,content})` 和 `shell.saveFile({defaultName,dataUrl})` 使用系统保存对话框，权限为 `fs.write`；取消返回 null，成功返回 `{ok:true,path}`。关闭插件后对话框即使晚返回，也不会继续写文件。界面仅在 `result?.ok` 时显示保存成功。

## 出站 TCP 与本地桥（net.socket）

远程桌面（noVNC / RDP）与 TCP 调试类插件的底层通道，需声明 `net.socket` 权限。典型路径是先经 `ssh.workbench({action:'tunnel.open'})` 把远端端口转发到本地，再 `net.socket.connect({host:'127.0.0.1', port})` 衔接隧道口。

- 每插件并发 socket 上限 8；连接超时缺省 10s；发送方向 1MB/s 令牌桶限速（突发 2MB）。
- 数据经 `net.data`（base64，64KB/20ms 节流合并）与 `net.close` 事件推送；`enest.net.onNetData / onNetClose` 订阅。
- 高吞吐场景（VNC / RDP 逐帧流）用 `net.socket.serveWs(socketId)` 换取直连：桥只绑 `127.0.0.1` 随机端口，token 一次性，页面内 `new WebSocket(url)` 后双向二进制直通，绕开逐帧 IPC。
- 插件关闭、休眠或崩溃时宿主经 runtime scope 统一释放全部 socket 与 ws 桥，不泄漏端口。

## AI CLI 配置与系统巡检（config.agent.read/write / sys.inspect/control）

`agent.*` 是白名单硬编码的 AI CLI 配置读写（10 个应用：claude-code / claude-desktop / codex / gemini-cli / grok-build / opencode / openclaw / hermes / pi / minimax-code）。写采用最小侵入合并——只替换传入的顶层键，注释与其余内容保留；写前自动快照到 `~/.eNest/agent-config-backups/<app>/`（保留 20 份），`agent.restore` 可回滚。读取与写入使用独立权限；修改由宿主原生对话框确认具体目标。

`sys.processes()` / `sys.ports()` 提供 1s 采样缓存的进程与监听端口视图；`sys.kill` 使用 sys.control 并由宿主确认 PID，插件的 confirmed 参数不构成授权，宿主拒绝结束自身与 PID 1。详见 [enest API](api.md)。
