# 主题工作区：目录、已安装与详情

完整首页是独立的 `WebContentsView`，承载插件目录、已安装列表和详情的主题布局，不是普通业务 Tab，也不能迁入 Quick 或独立插件窗口。顶部插件会话 Tab、左下角设置按钮、窗口控制、设置页面与故障恢复始终由宿主拥有；主题不能替换或隐藏这些全局控件。仅内置默认主题与工作区随安装包提供；其它外观通过插件扩展；启动目录读取本地安装与已缓存条目，不等待联网市场请求。贡献名称仍为 `homePages`，不新增一套重复的视图管理器。

## 声明、构建与运行时登记

在普通插件的 `plugin.json` 声明首页，业务 `main` 仍是 `index.html`：

```json
{
  "id": "com.github.eNest.home-demo",
  "contributes": {
    "homePages": [{
      "source": "com.github.eNest.home-demo",
      "id": "dashboard",
      "version": 1,
      "entry": "homes/dashboard.html",
      "variants": ["studio", "library"]
    }]
  }
}
```

这是 manifest 片段，仍需遵守名称、版本、图标、README 与截图等完整包约定。`source` 必须精确等于当前插件 ID，包括 `com.github.eNest` 的大小写。`id` 在插件内唯一，`version` 为正整数；`entry` 是包内 HTML 路径，不能包含 URL、绝对路径、点段、反斜杠或编码遍历。避免使用 `src`、`tests`、`backend`、`runtime`、`node_modules` 作为发布入口目录，推荐 `homes/`。

构建工具把 `index.html` 与全部声明入口加入同一次 Vite 多页面构建；发布校验要求每个首页 HTML 实际存在，且引用的脚本、样式与资源都可在包内解析。不声明的额外首页文件不会因为放进 ZIP 就获得加载权限。

安装、启用后首页声明即可被宿主发现，不要求先运行普通插件。普通插件可在自己的 `enest` 环境调用：

```js
const result = await enest.home.register({
  id: 'dashboard', version: 1,
  entry: 'homes/dashboard.html', variants: ['studio', 'library']
})
if (!result.ok) console.error(result.error)
```

**运行时接口的固定边界**：这是来源绑定、幂等的声明确认，不是绕过 manifest 的任意入口注册。宿主忽略请求中的 `source` 并绑定真实调用者；`id/version/entry/variants` 必须与已安装、已启用插件的当前 manifest 精确相同。调用前后均校验主 frame、精确页面、实例归属与运行代次。登记不能切换主题或首页，也不授予其它权限。

## 首页 API

只有专用工作区页面注入 `window.enestWorkspace`，`window.enestHome` 是同一桥接的兼容别名。SDK 的 `EnestWorkspaceApi`、`EnestHomeApi` 及相关类型由真实 preload/shared 契约生成；类型存在不代表普通插件拥有该桥接。

宿主在开屏动画期间**隐藏预热**当前主题的工作区。首次启动直接使用源码内置主题，不再等待主题选择向导；后续恢复有效的已选插件主题。请先订阅，再并发读取首屏配置/目录并完成渲染，正常发送 `ready` 和路由 ACK；不要等待可见事件才初始化，否则会造成双方等待。首次可见时复用这一实例，无需再请求同一批首屏数据。可见事件用于暂停后台动效、恢复动画及交互，不是提前跳过确认协议的依据。首屏目录已由宿主读取本地及缓存数据，不需要另外持久化完整设置或跨代次快照。

| API | 内容 |
| --- | --- |
| `ready({ revision, workspaceVersion: 1, routes })` | 声明已实现路由；换提供者要等 ready 与当前路由 ACK 再提交 |
| `ackNavigation({ requestId, generation, ok })` | 收到 navigate 后完成 DOM 与数据渲染，再确认路由已就绪 |
| `getAppearance()` / `onAppearance(cb)` | 读取或订阅脱敏渲染快照，包含 `generation` 与外观 `revision` |
| `getConfig()` | 语言、目录排序及缓存状态；不包含完整设置 |
| `getCatalog()` | 立即读取本地与缓存市场目录，不发起网络请求 |
| `getDetail(pluginId)` | 公开详情、权限名称、包大小及受限 README/截图引用 |
| `search({ query, scope, limit })` | 返回名称、公开图标及短期受控句柄，不返回应用路径或命令 payload |
| `refresh({ reason })` | `boot` 仅缓存读取；显式 `manual` 才等待宿主市场刷新 |
| `action(request)` | 请求受控启动、安装、更新、启停、卸载、设置及刷新 |
| `onCommand(cb)` | 订阅 navigate、settingsChanged、可见性、刷新及安装命令 |

`action` 支持 `navigate`、`activateSearchResult`、`openPlugin`、`openMarket`、`openSettings`、`refreshApps`、`installPlugin`、`updatePlugin`、`setPluginEnabled`、`uninstallPlugin`、`refreshCatalog`、`setHomeVisible`。启动搜索结果只提交 `handle`；句柄一次性使用、两分钟到期，绑定当前首页所有者与代次，销毁后全部撤销。`openPlugin` 仅打开当前已安装且启用的插件，不能通过启动接口绕过安装确认。

## 路由与确认协议

```ts
type WorkspaceRoute =
  | { page: 'catalog' | 'installed' }
  | { page: 'detail'; pluginId: string }

await workspace.action({ type: 'navigate', route: { page: 'installed' } })
```

页面内的目录和详情导航也必须调用该动作，不能只改本地 DOM，否则宿主无法在切换主题时恢复正确路由。`openMarket` 是目录路由的兼容入口；`openSettings` 请求宿主切到原生设置视图，不是 Workspace 路由。

先注册 `onCommand`，再调用 `ready({ workspaceVersion: 1, routes: ['catalog', 'installed', 'detail'] })`。收到 `{ type: 'navigate', route, requestId, generation, revision }` 后：

1. 按路由读取安全数据，并完成页面渲染。
2. 仅确认本次命令的原始 `requestId/generation`，调用 `ackNavigation({ requestId, generation, ok: true })`。失败发送 `ok: false`；不能在加载前提前 ACK。
3. 页面不支持该路由时不得虚假声明能力。旧 Home 没有完整 workspace 握手时不能冒充完整工作区。
4. 超时、拒绝或崩溃时宿主隐藏原生层，显示可信恢复入口；过期 ACK 不会复活旧页面。

切换提供者时，候选页必须准备好当前路由才提交。主题参数和深浅模式变化不重建同一页面。主题工作区只控制内容区域，没有设置页；设置入口统一走 `openSettings` 动作由宿主切换原生设置视图。

## 设置归属

设置只有一个原生壳视图：通用、账号、外观（主题 Tab 按主题 pack schema 动态渲染全部外观字段）、快捷键、开发者与各插件设置都在其中。Workspace 桥没有 `getSettings` / `updateSetting` / `runSettingsAction`；主题字段提交走外观通道（`updateThemeProfile` / `appearance-changed`）。进入设置用 `action({ type: 'openSettings' })` 请求宿主切换视图。

管理动作由宿主原生弹层确认并调用已有安装、卸载与启停服务，页面传入 `confirmed` 等额外字段不能替代确认。确认等待期间首页隐藏、被替换或销毁时，旧请求不能再开始新的宿主操作。

未知宿主异常只返回固定的公开失败消息，不透传文件路径、远程凭据或底层错误原文；详细诊断留在宿主日志。安装订阅保留任务、状态和数值进度，但步骤与失败文本由宿主改写为公开消息。来源标识保持 manifest 的原始大小写，例如 `com.github.eNest.theme`，不会小写归一化或与另一个来源合并。

## 初始化、更新与清理

首页 HTML 使用包内外部脚本，例如 `<script type="module" src="../src/home.js"></script>`，由 Vite 产出可发布引用；生产 CSP 不允许内联脚本或动态代码执行。脚本中先订阅再读初始快照：

```js
const home = window.enestWorkspace
if (!home) throw new Error('Dedicated Home bridge is unavailable')
let revision = -1
const accept = snapshot => {
  if (snapshot.appearance.revision < revision) return
  revision = snapshot.appearance.revision
  // Apply semantic tokens/material/layout without replacing business state.
}
const offAppearance = home.onAppearance(accept)
const offCommand = home.onCommand(async command => {
  if (command.type === 'navigate') {
    try {
      await renderRoute(command.route) // 实现目录、已安装或详情，等待真实渲染完成。
      await home.ackNavigation({ requestId: command.requestId, generation: command.generation, ok: true })
    } catch {
      await home.ackNavigation({ requestId: command.requestId, generation: command.generation, ok: false })
    }
    return
  }
  if (command.type !== 'visibility') return
  for (const media of document.querySelectorAll('video, audio')) {
    if (!command.visible || document.hidden) media.pause()
  }
  document.documentElement.dataset.homeVisible = String(command.visible)
})
const initial = await home.getAppearance()
accept(initial)
await home.getCatalog()
await home.ready({ revision, workspaceVersion: 1, routes: ['catalog', 'installed', 'detail'] })
addEventListener('pagehide', () => { offAppearance(); offCommand() }, { once: true })
```

示例在隐藏时暂停媒体；页面自己的连续动画还应接入相同可见性信号。实际应用应同时按 `generation/revision` 丢弃过期消息，不能让晚到的初始读取覆盖更新的推送。`HomeEvent` 的宿主信封是 `{ appearance?: HomeAppearanceSnapshot, command?: HomeCommand }`，preload 已拆分为两个订阅；不要再手工订阅完整 IPC。

同一提供者切换已声明布局、模式或参数时复用页面，不刷新连接、不清空搜索或草稿。不同提供者使用独立、非持久化会话；稳态只有当前首页，替换后销毁旧 frame，撤销协议处理器并清空会话数据。监听、媒体、字体与动画资源均需有取消/释放路径。

安装命令中的 `pluginId` 可能缺省，`jobId/name` 仅供任务状态展示；`name` 不是插件 ID。不要据此覆盖另一插件的状态，安装完成后读取缓存目录核实结果。

## 资源和权限隔离

生产首页使用 `enest-home://surface/<entry>`。会话仅提供自身入口、脚本、样式与静态资源；拒绝其它 HTML 导航、iframe、后端源码、任意 `file:`、完整 `enest:` 协议与外网连接。入口与资产在读取时重新做 canonical 路径校验，不能用符号链接逃逸资源根。内置首页开发模式仅额外允许宿主指定的精确 loopback 开发 origin 与同源 HMR WebSocket，插件首页不继承这项开发例外。

跨插件公开资源使用宿主给出的 `enest-home://catalog/<pluginId>/icon`、`readme`、`screenshot/<index>`，只能命中当前目录条目对应槽位，不能拼接任意路径读取该插件目录。资源来源按开发实例、已安装包、本地预览、远程市场选择，同一条目的缺失槽位不借用另一版本素材。源码预览将 `assets/` 映射到 `public/assets/`；远程官方市场素材由宿主限时限量读取、校验类型并缓存后供应，不把外部 URL 交给页面，也不放宽页面 CSP。README 相对图片仅可映射到同插件已声明的截图槽位。市场卡片的 `packageSize` 是最终插件包的字节数，缺失不伪造。

用户明确导入的背景与当前使用字体通过 `enest-home://appearance/media/<opaque-id>`、`font/<opaque-id>` 提供。`snapshot.resources.fonts` 只包含 family 与受控 URL，不返回文件名、本地路径或整个自定义字体列表。主题/profile 全量数据、诊断、凭据和任意宿主设置都不跨首页桥接。

资源白名单及 IPC fixture 测试不是原生验收替代品。发布前仍须在真实 Electron 中验证首页隔离、弹层遮挡/焦点恢复、离线首启、崩溃/超时成对回退，以及隐藏停帧和资源释放。
