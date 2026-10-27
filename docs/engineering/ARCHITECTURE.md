# eNest 当前技术架构

更新于 2026-10-24，宿主版本 0.2.3。插件页面运行在 Electron 44 的 WebContentsView 中，可选的插件自有 Node 后端运行在 utilityProcess；壳界面使用 React、TypeScript、zustand 和 GSAP。根目录 ARCHITECTURE.md 保留早期决策，当前插件开发契约以[开发文档](../site/plugin/README.md)和仓库生成的 schema/SDK 为准。

2026-10-24 外观扩展更新：安装包只保留源码内置 eNest 默认主题（`enest.builtin / default`）；目录与详情统一为隔离主题 Workspace（`catalog/detail` 路由 ACK），已安装属于主题本地筛选。默认设置和 Quick 策略归入默认主题代码，第三方主题可用隔离 `settingsPage` / `enestSettings`、chrome 和 Quick 目录/结果协议替换安全呈现。设置控制器仍由宿主管理表面选择、原生入口和故障回退。主进程 appearanceService 是唯一外观权威；账号、权限、媒体选择与敏感系统设置不暴露原始值给主题。详见[主题与工作区标准](THEME_STANDARD.md)。

## 进程与视图

```text
Main
├── BaseWindow / Shell WebContentsView（主窗 React 界面）
├── Theme Workspace WebContentsView（目录、已安装、详情）
├── Plugin WebContentsView × N（各插件独立 persist:plugin-{id}）
├── Quick BrowserWindow / Plugin WebContentsView（快捷面板）
├── Free Panel BaseWindow × N（自由面板：chrome 底板 View + 组件 Plugin WebContentsView，置顶透明）
├── orb rail WebContentsView（主窗内顶层导航）
├── utilityProcess：插件自己的 backend（统一通用 RPC）
└── 宿主服务：窗口、文件能力、私有存储/密钥、网络桥、计时、主题与权限
```

所有 renderer 关闭 Node 集成、开启 contextIsolation 和 Chromium sandbox。preload 构建为自包含 `.cjs`，仅暴露 contextBridge API；插件不能自带可执行 preload。可选后端需要 `backend.node` 完整本机信任，具备当前用户可用的 Node 文件、网络和进程能力；utilityProcess 只隔离故障与生命周期，不是操作系统沙箱。DSH 的运行时业务与其启动的外部进程由 DSH 插件后端管理，经通用控制协议登记归属，不再由壳内 DSH 专属服务实现。

原生插件视图在 shell DOM 之上。返回目录走 `navigateWorkspace`，隐藏业务视图并等待路由 ACK；进入设置则隐藏 Workspace 表面并切到原生设置视图（`set-view: settings`），不存在受保护设置恢复通道。授权使用主进程原生对话框。orb rail 在插件挂载后重新置顶。主窗标题栏固定 36px，插件内容 bounds 由窗口实际尺寸和 chrome 高度计算；Quick 启动模式与主窗通过 API 明确切换，断点只调整空间布局。

自由面板（默认关闭，设置 → 通用开启）提供第四种插件 placement `{ kind: 'panel'; panelId }`：用户框选区域生成置顶透明窗口，把插件作为组件在其内自由拼接（移动语义，同一 webContents 换父级，沿用 `?mode=shell`）。面板组件常驻可见（`isPresented` 对 panel 恒真，免疫空闲休眠与 LRU），拖动与缩放全程主进程驱动（读光标 + setBounds + 边/中心吸附线），组件条与底板由面板 chrome 绘制。布局持久化在独立 `panels` 设置段（仅主进程写），重启后先建窗口再按 2 并发上限冷启动组件。详见 [panel-windows.md](panel-windows.md)。

启动在 Home IPC 就绪后直接隐藏预热工作区，与源码内置主题的开屏和轻量会话恢复并行；首次启动不再显示主题选择或写入完成标记，后续保留有效插件主题选择；`ready`、路由 ACK 和事务提交完成后，直接显示同一个实例，不插入正常加载/准备页。原生 orb 投影等壳完成启动再开启。设置/注册表和解析外观使用主进程内存状态，不把完整设置或资源授权复制到工作区持久缓存；具体门禁和缓存边界见 `THEME_STANDARD.md`。

## 模块与公共契约

| 区域 | 职责 |
| --- | --- |
| `src/main/plugin` | Registry、平台分发校验、安装/卸载、Host、权限、协议、运行代次、活动租约、编译缓存、后端入口解析、通用 RPC 与有界后端控制 |
| `src/main/ipc` | 插件分发与 shell/Quick/orb 的可信窗口门禁 |
| `src/main/dev` | 独立开发注册、源码/服务器/dist 预览与覆盖配置 |
| `src/main/paths`、`db`、`settings` | 数据根、迁移、SQLite、缓冲 KV 与设置 |
| `src/main/plugin/pluginBackend*` | 通用后端 RPC、文件/密钥能力与实例回收；数据库、中间件、SSH 门面及业务 DTO 均在插件仓 |
| `src/main/window` | 窗口创建、原生层 bounds 与可见性 |
| `src/main/panel` | 自由面板：几何纯函数、布局持久化、区域框选、编排（经窄接口调用插件运行时，不反向依赖 PluginHost） |
| `src/main/home`、`src/main/theme` | 隔离 Workspace 生命周期与安全数据、统一外观解析/事务/资源 |
| `src/preload` | 壳、插件和辅助窗口的最小 API 桥 |
| `src/renderer` | React UI、布局、状态、主题、动效 |
| `src/shared` | 跨端类型、IPC 常量、无平台依赖的纯模型和 canonical manifest schema |
| 独立插件仓库 | `plugins/<id>` 的前端与 backend、共享业务包（如 ssh-backend）、workspace kit、SDK、构建/验收工具、开发 skill |

壳的跨目录导入使用 `@main`、`@preload`、`@renderer`、`@shared` 别名。公共 API 修改必须同步类型、preload、宿主分发、权限和资源回收；SDK 和文档由插件仓库脚本生成并提供无写入检查模式。

## 加载与安装

插件的源码根为 `plugins/<id>`，包含 plugin.json、package.json、index.html、src 和 public/assets，可选 backend 源码由插件自己的构建配置指定。Vue、React 和原生 JS 共用这一标准。源码/发行格式、必填字段和资源约束见[工程格式](../site/plugin/structure.md)。

发布根固定为 dist，其直接内容打成 `<短名>@<version>.enestplugin`。安装过程在后台准备与解包，校验路径、schema、真实文件、包身份和市场摘要，重新校验暂存副本，再原子替换并发布 Registry。失败时回滚，更新使旧内容版本缓存失效。无后端的普通包拒绝源码、环境配置、依赖目录、符号链接和额外目录层。声明 `backend.entry` 后允许包内 `backend/**` 及其中锁定的运行依赖，仍拒绝源码映射、开发源码和符号链接；后端依赖需要的运行时源码与许可证保留。声明后端的插件还可带私有 `runtime/` 附件，其中运行资源不按浏览器源码规则裁剪，但递归拒绝符号链接及非普通文件。此规则不按插件 ID 特判。市场下载统一限 256 MiB，解压总量限 2 GiB。

通用包与 `registry.json` 保留旧命名、`schemaVersion: 1`；平台包为 `<短名>@<version>-<os>-<arch>.enestplugin`，索引为 `registry-<os>-<arch>.json`。市场优先选择本机索引，缺失时回退通用索引；可移植插件无需重复产物。`assets/enest-distribution.json` 的 `{ schemaVersion: 1, target }` 与后端依赖清单的 `target` 必须一致，安装拒绝不匹配的显式 OS/架构。旧包缺少标记时按 universal 兼容，不代表其中原生实现自动支持任意平台。当前显式目标为 darwin-arm64、darwin-x64、linux-x64（仅 glibc）、win32-x64；未支持目标不得伪装成可用通用回退。

开发注册不复制、不安装、不运行 npm。框架自行运行开发服务器；宿主只连接明确配置的 origin 与同源 HMR。静态源码只映射 index.html、src 和 public/assets；修改后手动重载。生产预览明确选 dist，不因服务器失败静默切换路径。连接开发服务器的后端插件仍从源码根的 `dist/backend` 加载，必须预先构建；后端修改后重建并重载实例。

已安装版本的 icon、README 和截图走该版本的 `enest://plugin/{id}/assets/...`；未安装市场的媒体从最终 ZIP 提取。Markdown 不执行 HTML，资源路径和链接协议受限。`backend/` 与 `runtime/` 均不向页面资源协议开放。

## 插件后端与驱动归属

`plugin.json.backend.entry` 指向包内后端文件；`pluginBackend` 校验当前实例、manifest、`backend.node` 授权与实际路径，拒绝符号链接和越界入口。加载器不搜索宿主依赖，也不从缺失的新插件入口回退到旧驱动。

通用入口由 `pluginBackendRpc` 按插件运行代次复用 utility process。前端使用 `enest.backend.call(method, args)`，宿主发送 init 与请求消息；响应按 id 关联，主动事件包装为 `backend.event` 并绑定真实插件来源。每进程最多 32 个在途请求，参数最多 4 MiB，后端消息最多 8 MiB，默认 30 秒超时会终止该进程及其它在途请求，插件可按操作设置 250ms–24h 的有界超时。进程 V8 old-space 为 256 MiB，不是总 RSS 或原生内存硬上限。

0.2.1 的 init 带 `context: { protocolVersion: 1, appDataPath, packagePath, appExecPath }`，0.2.2 增加来自真实 WebContents 的 `pageOrigin`。后端通过 `host.request/host.response` 访问 `pluginBackendControl` 的 `activity.acquire/release`、`process.track/untrack`、`endpoint.allow/revoke`、`network.resolveProxy`；没有任意宿主 IPC 或业务服务透传。控制请求最多 64 个在途，每代次最多 128 份显式活动租约、128 个显式登记后代进程、32 个回环端点。资源归属绑定 `pluginId + generation + wcId`，后代身份校验 PID、启动时间与父子链，端点可属于当前后端自身或其真实后代；子页面限显式端口 HTTP 回环源，WebSocket 限显式端口 WS 回环 origin/path。代理解析返回宿主 session 的结果，不代替插件为网络客户端配置代理。上下文和控制接口不构成 Node 沙箱。RDP 的 RDCleanPath/X.224/TLS 业务仅在远程桌面插件后端，壳通用 socket 桥不再识别它们。

关闭时撤销端点、拒绝新工作并发送 `shutdown(reason, deadlineAt)`，给予约 900 ms 协作关闭时间，再有界 TERM/KILL 清理后端及已确认归属的后代。`shutdown.complete` 只作确认消息，必须观察实际退出才能释放所有权；未确认退出会记录清理失败并阻止静默叠加替代进程。活动租约、撤权和代次检查由宿主管理，完整消息及预算契约见[本机后端协议](../site/plugin/backend.md)。

0.2.2 删除壳内 AI 配置、LAN、数据库、中间件、SSH 专用服务和 preload 门面；全部使用通用后端 RPC。协议、会话、取消、业务 DTO、前端适配器随各插件发布，SSH/远程桌面共享插件仓包。番茄钟的周期、统计、旧数据解释留在插件，宿主仅保留不理解业务的 deadlineTasks 持久化调度。宿主 `src/main/db` 的内置 `node:sqlite` 设置/KV 存储与用户数据库插件是不同职责。

0.2.3 继续删除壳内剪贴板历史服务、选区/录屏/贴图 UI 和 Quick 匹配策略。剪贴板使用插件自有沙箱后台与私有文档/blob；屏幕相关界面由插件仓 `packages/native-surfaces` 提供，宿主只暴露原生捕获、受限辅助窗口及有界私有文件流。后台 Session 按插件复用，辅助 Session 使用有限槽位与一次性 nonce；关闭、撤权和卸载校验真实归属并回收。默认设置整体迁到 `src/renderer/themes/default/settings/`；浏览器 mock 独立惰性加载，不再在真实 Electron 启动时创建 mock 目录/图标。两个固定旧数据适配器及宿主账号协议明确保留，不声称整个主进程只有 OS 原语。

同日收尾进一步移除通用保存接口的数据库默认名和贴图/选区/录音的 8 个死 IPC。默认 Workspace 展示、样式、轮播、图库与 DEV 预览集中在 `themes/default/workspace/`，专属动画集中在 `themes/default/motion/`；公共目录只保留可复用设施，不把主题实现伪装成共享控件。失效旧宿主业务测试已退役，不能拿其历史通过记录代替当前验收。兼容导入的来源、所有者与退场条件见[旧数据导入边界](LEGACY_PLUGIN_DATA_IMPORTS.md)，实物与验证见[迁移收尾记录](PLUGIN_MIGRATION_CLEANUP_2026-10-24.md)。

DSH 0.3.1 将 profile/设置、工作台、运行时下载与升级、进程管理迁入插件仓 `plugins/dsh/backend/`，由通用后端调用与控制协议承载；`runtime/` 路径保留为私有附件。壳不再有 `src/main/dsh` 业务服务、`dsh.*` 专用 IPC 或权限，也不按 DSH ID 特判运行时目录。0.2.2 已继续移除 SSH、数据库、中间件专用门面。

插件在 `package.json.enestBackend` 声明源码入口与生产依赖；构建按插件仓库锁文件复制精确依赖闭包，生成 `dist/backend/index.cjs`、后端 node_modules 和清单。原生包由 `platformPackages` 显式选择并校验摘要；当前 DuckDB universal 包携带 darwin-arm64、darwin-x64、win32-x64、linux-x64 四变体，平台包仅携带匹配变体。目标构建输出隔离在插件仓 `dist/platform-builds/<target>/<短名>`，不覆盖 universal dist；CI 用 `--platform-variants` 从已校验产物裁剪并发布各平台索引，不重复编译全部前端。默认 `--all` 仍只打通用包，未支持的原生目标直接失败。SSH 使用不含可选本地加速模块的纯 JavaScript ssh2。后端构建禁止导入 Electron 和 `@main/@preload/@renderer/@shared` 宿主运行时。

数据库 1.4.0、中间件 0.4.0、SSH 1.4.0、远程桌面 1.3.1、AI 配置 1.3.0、桌面宠物 1.2.0、LAN 1.2.0、番茄钟 1.4.0 要求宿主 >=0.2.2；DSH 0.3.1 保持 >=0.2.1。移出的旧专用 API 不再提供宿主回退，必须同步更新插件。backend.node 不会由任何旧细分授权静默推导；纯前端插件不需要此权限。

## 能力边界

插件 IPC 校验 WebContents 身份、主 frame、origin、插件 ID、当前运行代次。壳提供统一能力，插件自行实现业务。基础存储/UI/设置/主题/声明式入口/私有密钥保存直接可用；只有敏感能力先声明，再经 ask/allow/deny 决策；原生对话框串行执行，撤权关闭当前代次。浏览器敏感权限、下载、任意导航与直接外联默认拒绝，开发 origin 与宿主签发的连接桥按精确范围放行。

「设为默认打开软件」（文件类型 / URL scheme 关联）是壳统一能力：插件不是独立 OS 应用，系统关联写入目标只能是 eNest 本体，插件仅经 `contributes.openWith` 声明（open-with 插槽）。`src/main/openWith/` 聚合声明、维护设置段 `openWith` 的「类型→插件」路由表（仅主进程写，renderer 写入在 set-settings 剥离），并按平台注册：Linux xdg-mime/xdg-settings 可程序化设默认；Windows HKCU 候选 + 引导系统设置；macOS 候选来自打包期 Info.plist，默认切换由用户在系统层完成——设置页对每行如实显示三态。外部打开入口（open-file/open-url/second-instance argv）由 `openWithRouter` 解析：路由命中或单候选自动路由后经 `launchPlugin(source: 'open-with')` 唤起插件并附带只读文件句柄（OS 双击 = 用户选定，与拖入同语义）；多候选弹原生选择框（modalSurface open-with-choice），无人接手发 `open-with-unhandled` toast。macOS 候选类型随壳发版维护在 `build/open-with.json`，`scripts/generate-builder-associations.mjs check` 防止与 electron-builder.yml 漂移；Windows/Linux 运行时动态注册不受此限制。卸载插件时 `PluginUninstaller` 摘除指向它的路由。

系统文件通过原生选择器签发的能力句柄访问，绑定插件、用途、真实路径和运行代次。在宿主文件 API 中，裸路径仅展示。官方数据库后端通过 SQLite authorizer、DuckDB 外部访问锁定防止 SQL 通道绕过文件授权；这不限制已获完整 Node 信任的后端自行执行其它 Node 代码。文件读取、网络流、SSE、连接队列和待写存储都有预算。

Chromium 用户通过 HTML 文件选择器或拖放授予的 File 能力不等同于宿主 API 权限；Electron 的权限回调并不能统一拦截全部此类输入。官方插件已改用宿主 pick/read 接口。完整边界见[权限说明](../site/plugin/permissions.md)与[安全验证](PLUGIN_SECURITY_VALIDATION.md)。

## 生命周期与数据

默认保持六个实例的软上限，后台三分钟休眠，按 LRU 回收；开发模式和活跃宿主任务有明确例外。切换、主窗隐藏/最小化、Quick 隐藏采用一致的可见性语义。休眠前发送检查点事件，销毁原生 renderer；再次进入重新加载并恢复业务状态。

关闭先摘除原生视图，再在有截止时间的保存流程后销毁。重载、崩溃、停用、卸载和替换撤销代次，释放监听、连接、文件句柄、活动租约和在途操作，并终止该代次的后端进程；迟到结果不能进入替代实例。存储写入失败保留已接收数据并报告错误。编译使用 Chromium/V8 缓存，不维护第二套编译器。

默认数据根 `~/.eNest`，显式配置优先。引导设置位于默认根 settings.json，设置与 KV 主体在 `{dataRoot}/data/enest.db`。安装包在 plugins，主题在 themes，session 使用各插件 partition。旧数据只在复制、哈希与数据库完整性检查成功后删除来源。

## 开发与验证

```sh
npm run typecheck
npm run build
ENEST_APP_SMOKE=1 node --test src/main/plugin/pluginApp.smoke.test.mjs
```

主进程或 preload 修改后重启 dev；renderer 可用 HMR。原生验收使用临时数据根和独立 profile。跨平台构建配置或包内存在原生变体不等于跨平台已实测；历史验证数字和范围见[标准化交付报告](PLUGIN_STANDARDIZATION_REPORT.md)、[生命周期与性能](PLUGIN_SANDBOX_LIFECYCLE_VALIDATION.md)，后端迁移的当前验证应另以对应测试结果为准。
