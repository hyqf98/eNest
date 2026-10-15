# eNest 当前技术架构

更新于 2026-10-15，宿主版本 0.2.0。插件页面运行在 Electron 44 的 WebContentsView 中，可选的插件自有 Node 后端运行在 utilityProcess；壳界面使用 React、TypeScript、zustand 和 GSAP。根目录 ARCHITECTURE.md 保留早期决策，当前插件开发契约以[开发文档](../site/plugin/README.md)和仓库生成的 schema/SDK 为准。

## 进程与视图

```text
Main
├── BaseWindow / Shell WebContentsView（主窗 React 界面）
├── Plugin WebContentsView × N（各插件独立 persist:plugin-{id}）
├── Quick BrowserWindow / Plugin WebContentsView（快捷面板）
├── orb rail WebContentsView（主窗内顶层导航）
├── utilityProcess：插件自己的 backend（通用 RPC 或 DB/MW/SSH 兼容门面）
└── 宿主服务：窗口、文件能力、私有存储/密钥、网络桥、计时、主题与权限
```

所有 renderer 关闭 Node 集成、开启 contextIsolation 和 Chromium sandbox。preload 构建为自包含 `.cjs`，仅暴露 contextBridge API；插件不能自带可执行 preload。可选后端需要 `backend.node` 完整本机信任，具备当前用户可用的 Node 文件、网络和进程能力；utilityProcess 只隔离故障与生命周期，不是操作系统沙箱。DSH 保留专属外部 Node runtime，同样不属于页面沙箱的保证范围。

原生插件视图在 shell DOM 之上，返回首页/设置必须隐藏它；授权使用主进程原生对话框。orb rail 在插件挂载后重新置顶。主窗标题栏固定 36px，插件内容 bounds 由窗口实际尺寸和 chrome 高度计算；Quick 启动模式与主窗通过 API 明确切换，断点只调整空间布局。

## 模块与公共契约

| 区域 | 职责 |
| --- | --- |
| `src/main/plugin` | Registry、安装/卸载、Host、权限、协议、运行代次、活动租约、编译缓存、后端入口解析和通用 RPC |
| `src/main/ipc` | 插件分发与 shell/Quick/orb 的可信窗口门禁 |
| `src/main/dev` | 独立开发注册、源码/服务器/dist 预览与覆盖配置 |
| `src/main/paths`、`db`、`settings` | 数据根、迁移、SQLite、缓冲 KV 与设置 |
| `src/main/database`、`middleware`、`ssh` | 旧 API 的 RPC 门面、文件/密钥桥和实例回收；不持有协议驱动实现 |
| `src/main/window` | 窗口创建、原生层 bounds 与可见性 |
| `src/preload` | 壳、插件和辅助窗口的最小 API 桥 |
| `src/renderer` | React UI、布局、状态、主题、动效 |
| `src/shared` | 跨端类型、IPC 常量、标准路径和生成的 manifest schema |
| 独立插件仓库 | `plugins/<id>` 的前端与 backend、共享业务包（如 ssh-backend）、workspace kit、SDK、构建/验收工具、开发 skill |

壳的跨目录导入使用 `@main`、`@preload`、`@renderer`、`@shared` 别名。公共 API 修改必须同步类型、preload、宿主分发、权限和资源回收；SDK 和文档由插件仓库脚本生成并提供无写入检查模式。

## 加载与安装

插件的源码根为 `plugins/<id>`，包含 plugin.json、package.json、index.html、src 和 public/assets，可选 backend 源码由插件自己的构建配置指定。Vue、React 和原生 JS 共用这一标准。源码/发行格式、必填字段和资源约束见[工程格式](../site/plugin/structure.md)。

发布根固定为 dist，其直接内容打成 `{id}@{version}.enestplugin`。安装过程在后台准备与解包，校验路径、schema、真实文件、包身份和市场摘要，重新校验暂存副本，再原子替换并发布 Registry。失败时回滚，更新使旧内容版本缓存失效。无后端的普通包拒绝源码、环境配置、依赖目录、符号链接和额外目录层。声明 `backend.entry` 后允许包内 `backend/**` 及其中锁定的运行依赖，仍拒绝源码映射、开发源码和符号链接；后端依赖需要的运行时源码与许可证保留。市场下载统一限 256 MiB，解压总量限 2 GiB。

开发注册不复制、不安装、不运行 npm。框架自行运行开发服务器；宿主只连接明确配置的 origin 与同源 HMR。静态源码只映射 index.html、src 和 public/assets；修改后手动重载。生产预览明确选 dist，不因服务器失败静默切换路径。连接开发服务器的后端插件仍从源码根的 `dist/backend` 加载，必须预先构建；后端修改后重建并重载实例。

已安装版本的 icon、README 和截图走该版本的 `enest://plugin/{id}/assets/...`；未安装市场的媒体从最终 ZIP 提取。Markdown 不执行 HTML，资源路径和链接协议受限。后端目录不向页面资源协议开放。

## 插件后端与驱动归属

`plugin.json.backend.entry` 指向包内后端文件；`pluginBackend` 校验当前实例、manifest、`backend.node` 授权与实际路径，拒绝符号链接和越界入口。加载器不搜索宿主依赖，也不从缺失的新插件入口回退到旧驱动。

通用入口由 `pluginBackendRpc` 按插件运行代次复用 utility process。前端使用 `enest.backend.call(method, args)`，宿主发送 init 与请求消息；响应按 id 关联，主动事件包装为 `backend.event` 并绑定真实插件来源。每进程最多 32 个在途请求，参数最多 4 MiB，回复/事件最多 8 MiB，30 秒超时会终止该进程及其它在途请求。活动租约、退出确认、撤权和代次检查由宿主管理，完整契约见[本机后端协议](../site/plugin/backend.md)。

`enest.db.*`、`enest.mw.*`、`enest.ssh.*` 保留前端 API 兼容门面，另用各自的会话、取消和事件通道；不能与通用 RPC 的进程混用。SQL/数据库适配器迁到数据库插件，Kafka/MQTT/RabbitMQ 等协议迁到中间件插件，SSH/SFTP/隧道迁到共享 `@enest/ssh-backend`，由 SSH 和远程桌面插件分别打入自己的后端。壳保留可复用的文件选择与句柄、私有存储/密钥和原生桥，不依赖这些插件的 npm 驱动。宿主 `src/main/db` 的内置 `node:sqlite` 设置/KV 存储与用户数据库插件是不同职责。

插件在 `package.json.enestBackend` 声明源码入口与生产依赖；构建按插件仓库锁文件复制精确依赖闭包，生成 `dist/backend/index.cjs`、后端 node_modules 和清单。原生包由 `platformPackages` 显式选择并校验摘要；当前 DuckDB 携带 darwin-arm64、darwin-x64、win32-x64、linux-x64 四变体。SSH 使用不含可选本地加速模块的纯 JavaScript ssh2。后端构建禁止导入 Electron 和 `@main/@preload/@renderer/@shared` 宿主运行时。

迁移后的数据库 1.2.0、中间件 0.2.0、SSH 1.2.0、远程桌面 1.1.0 均要求宿主 `>=0.2.0`；新增 `backend.node` 必须单独取得授权，旧连接/查询权限不会隐含完整 Node 信任。纯前端插件仍可按原有格式运行。

## 能力边界

插件 IPC 校验 WebContents 身份、主 frame、origin、插件 ID、当前运行代次。壳提供统一能力，插件自行实现业务。基础存储/UI/设置/主题/声明式入口/私有密钥保存直接可用；只有敏感能力先声明，再经 ask/allow/deny 决策；原生对话框串行执行，撤权关闭当前代次。浏览器敏感权限、下载、任意导航与直接外联默认拒绝，开发 origin 与宿主签发的连接桥按精确范围放行。

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
