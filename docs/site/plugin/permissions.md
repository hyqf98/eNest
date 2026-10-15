# 权限、隔离与文件能力

权限管理针对网络、剪贴板、系统控制等敏感能力。插件私有能力直接可用；文件读写由用户在宿主选择器中选定目标时授权，无需再出现通用权限框。插件自行实现界面、算法、业务流程和协议逻辑，不需要为每一种功能申请新的宿主接口或权限名；壳提供统一的数据、界面、网络、文件与系统能力。

**基础能力直接可用**，无需在 `plugin.json.permissions` 声明或经过通用权限框。**敏感能力先声明，再由用户授权**；声明不等于授权。完整能力键由 `PluginPermission` 和 manifest schema 维护，基础/敏感分类由 `docs/plugin-permission-policy.json` 同源生成，API 签名见 [类型定义](api-types.md)。

## 基础能力

| 能力 | 边界 |
| --- | --- |
| `storage.local` | 本插件私有持久化和 session KV；仍受大小预算约束 |
| `ui.setTitle/setIcon/setBadge/resize/toast` | 只作用于自己的 Tab、受限容器尺寸和壳内提示 |
| `settings.register/page`、`settings.get/set` | 本插件设置与入口；不能访问宿主授权表或其它插件设置 |
| `theme` | 注册自己的主题包；有配额，不能覆盖其它来源，注册不等于自动应用 |
| `vault.write` | 保存、判断和移除本插件的密钥引用；无明文读取接口，不能访问系统已有凭据 |
| `fs.read` / `fs.write` | 仅限用户经宿主原生选择器选定的文件、目录或保存位置，以及本插件当前实例持有的文件句柄；保留读写用途与路径边界检查 |
| `timer.background` | 本插件的后台专注计时与记录；每插件一份计时状态，记录最多 2000 条，计时通知仍受 `notify` 声明与拒绝设置控制 |

`agent.apps()` 只返回支持的应用、配置位置及安装、活跃状态，无需声明或授权，不授予配置文件读取能力。从 0.2.0 起，`db.dialects.list()` 与 `db.workbench({ action: 'drivers.list' })` 的资料来自调用方的插件后端，因此需要 `backend.node`；资料查询本身不授予数据库内容的读取能力。

密钥库要求系统加密可用；Linux 的 `basic_text` / 未知后端不作为安全存储。保存失败不会降级为简单混淆。旧 XOR 凭据保留原文件并要求重新输入；新 key 最多 128 个 UTF-8 字节、单个 secret 最多 64 KiB，每插件最多 256 条 / 8 MiB 密文，已有超额数据仍可删除或缩减。

新插件的 `permissions` 只需列出敏感项，纯离线工具可以省略该字段或使用空数组。已有包里声明上述基础能力仍可加载，但这些声明不会产生授权开关；旧版本为基础能力保存的拒绝值不再生效。插件启停仍由用户控制，基础能力不会赋予 Node、任意文件或网络权限。

## 授权与撤权

每项敏感权限有 `ask`（默认）、`allow`、`deny` 三态。插件首次调用尚未授权的敏感能力时，主进程在插件所在主窗或 Quick 窗显示一张原生授权框，列出插件名称及其 manifest 中尚待授权的敏感能力。一次选择覆盖框内列出的能力；已有 `allow` 或 `deny` 不会被这次选择覆盖。并发请求合并处理，避免网络请求等连续调用重复弹窗。基础能力不加入授权列表。

- 本次运行允许：列表内能力在当前插件实例中可用，不写入持久授权表；关闭、重载、崩溃或休眠销毁实例后失效。
- 授权并记住：列表内能力保存为 `allow`；下次打开与重启后沿用。升级后新增的敏感能力仍需授权，不会随旧授权自动放行。
- 暂不允许：当前实例不再请求列表内能力，结束实例后可重新询问；不会把取消操作保存成永久拒绝。需要持续拒绝某项能力时，可在插件权限设置中设为 `deny`。
- 超过 60 秒、关闭插件或实例失效：拒绝未完成的请求，不保存临时或持久授权。
- 撤权会关闭该插件当前实例并回收已有连接、订阅、文件能力和任务；下次打开使用新授权状态。

所有已安装插件都有设置入口，即使没有声明自己的设置项；持久授权结果会同步更新权限页面，可逐项改为允许、询问或拒绝。

主进程仍逐次验证调用窗口、主 frame、插件 ID、精确 origin、manifest、运行代次及文件能力。插件或壳 renderer 发送“已同意”不能授予权限。`agent.write` 与 `agent.writeAssets` 获得 `config.agent.write` 授权后直接执行，继续遵守应用与路径白名单、配额和写前快照约束。恢复配置备份、删除资产、结束进程等破坏性操作仍由宿主展示具体目标并确认；参数 `confirmed: true` 不是用户授权凭据。

## 敏感权限

| 权限 | 用途 |
| --- | --- |
| `clipboard.read` / `clipboard.write` | 系统剪贴板文本读取 / 写入 |
| `clipboard.readImage` / `clipboard.writeImage` | 系统剪贴板图片读取 / 写入 |
| `clipboard.history` / `clipboard.paste` | 剪贴板历史 / 向前台应用粘贴 |
| `screen.capture` / `screen.record` / `pin.create` | 截图、录屏、置顶贴图 |
| `backend.node` | 运行插件自有 Node 后端；完整本机信任，具有当前用户可用的文件、网络和进程能力；不是操作系统沙箱 |
| `net.fetch` | 宿主 HTTP(S) 请求；分片、SSE 仍有字节预算 |
| `net.socket` | TCP、宿主 WebSocket 客户端和限域连接桥 |
| `lan.share` | 用户选择文件的限时局域网分享，需有效只读文件句柄 |
| `fs.rename` | 同目录改名；需要可写句柄，批量操作需宿主确认 |
| `sys.inspect` / `sys.control` | 查看进程、端口 / 结束具体进程 |
| `config.agent.read` / `config.agent.write` | 查看白名单 AI CLI 配置、会话、快照与资产列表 / 修改配置与资产、恢复备份 |
| `shell.openExternal` | 系统浏览器打开 http、https、mailto、tel 链接 |
| `notify` | 操作系统通知 |
| `hotkey` | 注册影响其它应用的全局热键 |
| `contribute` | 注册动态 Quick provider，接收全局搜索文本并提供结果；普通声明式入口无需此权限 |
| `ssh.session` / `ssh.exec` / `ssh.sftp` | SSH 会话 / 命令与指标 / 远程文件操作 |
| `ssh.agent` | 使用宿主系统 SSH agent；不能提供任意 agent socket 路径 |
| `db.connect` / `db.query` / `db.schema` | 数据库连接 / 执行与导入 / 结构与补全 |
| `mw.connect` / `mw.query` / `mw.admin` | 中间件连接 / 查询 / 修改，按 workbench action 校验 |
| `dsh.connect` / `dsh.chat` / `dsh.admin` | DSH 专属运行时连接 / 对话 / 管理（见边界） |

主题读取、语言读取、身份读取和纯事件订阅同样无需额外权限。普通声明式入口直接可用；动态 Quick provider 会读取全局搜索文本，因此保留 `contribute` 授权，两类贡献点都由宿主绑定来源。已有 SSH/数据库/中间件适配 API 保留各自的敏感授权，并额外要求 `backend.node` 才能启动调用方自己的后端；原有连接/查询授权不会隐含完整 Node 信任。两个宿主文件选择器 `ssh.pickLocalFile`、`db.pickSqliteFile` 不启动后端。新业务可组合通用 HTTP、WebSocket、文件句柄或[本机后端](backend.md)，不需要为业务功能新增权限名。

剪贴板历史只有用户实际保存 `clipboard.history=allow` 后才在后台采集；仅在 manifest 声明或选择本次运行允许不会开启持续监控。临时授权只允许当前实例访问已有历史。撤权后立即重检并停止不再被任何授权插件需要的采集。

## 系统文件：句柄，不是路径

```js
// 无需声明 fs.read；用户选择目标即授权，默认只能读。
const [file] = await enest.localFiles.pick({ kind: 'file' })
if (file) {
  console.log(file.name, file.displayPath) // 仅展示
  const contents = await enest.localFiles.read({ handleId: file.id, encoding: 'text' })
  console.log(contents)
}

// 无需声明 fs.write；宿主请用户选择保存位置。
const destination = await enest.localFiles.pickSave({ defaultName: 'export.csv' })
```

`localFiles.pick/pickSave/read/list/reveal/prepareDrag`、`shell.saveFile/saveTextFile`、`ssh.pickLocalFile` 和数据库文件选择器可直接调用，无需声明 `fs.read` / `fs.write` 或先经过通用授权框。文件选择器仍需用户选定目标；关闭或取消选择不会授予文件能力。

句柄绑定插件、真实路径、用途和当前运行代次。另一个插件、重载后的旧页面、撤权或关闭后的句柄均无效。不要持久化 `id`，恢复时让用户重新选择。`displayPath`、字符串绝对路径或 DOM 文件输入的 `path` 不能替代能力。浏览器下载和静默直接文件系统访问不获放行；`fromDrop` 最多接收 20 个路径，宿主展示全部候选并由用户确认后才签发句柄，插件自报路径本身不授予权限。

- SSH 私钥：选择只读文件，将 `id` 作为 `privateKeyHandleId`。
- SFTP 上传：`localHandleId`；下载：选择 `{ kind:'directory', access:'write' }`，传 `localDirectoryHandleId`。
- SQLite / DuckDB：`fileHandleId`；内存数据库用 `database: ':memory:'`。打开读写库需可写句柄，不能用只读句柄升级。
- CSV：`fileHandleId` 或显式 `csvText`，不接受任意 `filePath`。
- `shell.saveFile/saveTextFile` 由用户在原生保存对话框中选定位置，每次只写所选目标。

官方数据库后端的 SQL 通道保留文件访问约束：SQLite 使用引擎 authorizer 拦截 ATTACH、文件相关 PRAGMA、扩展等；DuckDB 关闭外部访问并锁定配置，防止 SQL 借 `read_csv`、COPY 或扩展访问其它文件。这些是官方驱动的接口约束，不能据此声称已获 `backend.node` 的任意 Node 代码没有直接文件访问能力。

`localFiles.read` 直接读取用户已选定并授予句柄的普通文件，`encoding: 'text'` 默认上限为 2 MiB，`'dataUrl'` 默认 16 MiB；`maxBytes` 可调整但最多 32 MiB，同一插件最多两次并发读取。文本导入和图片预览都应使用此接口并显示超限/取消/失效句柄错误。官方插件的文件按钮通过宿主选择器与读取接口执行；Chromium 的普通文件输入是另一种由用户交互选择文件的机制，Electron 的权限回调不覆盖所有此类输入，不能把回调或页面补丁说成全面拦截。

## 页面隔离与网络

通用插件在开启 Chromium sandbox、`contextIsolation` 且禁用 Node 集成的 `WebContentsView` 中运行。preload 为自包含 CJS；每插件独立 session。生产代码使用外部 JS 文件，不执行内联脚本。资源协议仅服务入口和 `assets/`，静态源码调试额外服务 `src/` 和 `public/assets` 的固定映射。

浏览器原生敏感权限、设备权限、下载、任意导航及直接外联默认拒绝。远程 HTTP 请求用 `enest.net.fetch`，WebSocket 用 `enest.net.websocket`。只有本插件明确配置的开发 origin（含同源 HMR）和宿主签发的实际连接桥可以直连。其它 localhost 端口和其它插件资源不获放行。

**后端边界**：从 0.2.0 起，普通插件可以声明 `backend.entry` 并在获得 `backend.node` 授权后运行独立 Node utility process。页面仍保持上述隔离，但 Node 后端具有完整本机执行能力，细分的前端文件/网络权限不会构成它的操作系统沙箱。宿主验证包内入口、授权和实例归属，并在撤权时终止后端。DSH 的专属 `runtime/` 仍单独集成，同样不属于 Chromium 页面沙箱的保证范围。

## 数据与系统权限

插件业务数据通过 `storage` API 保存到宿主管理的 `~/.eNest`（用户显式设置数据根时遵从该设置）。不要自行拼接用户目录。关 Tab 保留持久数据；卸载清理对应 partition、KV、设置与贡献。生命周期和预算见 [生命周期](lifecycle.md)。

macOS 截屏/录屏还需要系统 TCC，通知、全局热键在不同系统也有自身限制。宿主 `allow` 不会绕过操作系统权限。错误 `permission denied: <key>` 表示宿主门禁；`os permission denied: screen` 表示系统门禁。未实测平台不能仅由 macOS 测试推导通过。
