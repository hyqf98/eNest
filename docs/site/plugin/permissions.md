# 权限、隔离与文件能力

权限管理针对网络、剪贴板、系统控制等敏感能力。插件私有能力直接可用；文件读写由用户在宿主选择器中选定目标时授权，无需再出现通用权限框。插件自行实现界面、算法、业务流程和协议逻辑，不需要为每一种功能申请新的宿主接口或权限名；壳提供统一的数据、界面、网络、文件与系统能力。

**基础能力直接可用**，无需在 `plugin.json.permissions` 声明或经过通用权限框。**敏感能力先声明，再由用户授权**；声明不等于授权。完整能力键由 `PluginPermission` 和 manifest schema 维护，[权限分类快照](https://github.com/hyqf98/eNest_plugin/blob/main/docs/plugin-permission-policy.json)从同一分类源生成，API 签名见 [类型定义](api-types.md)。

## 基础能力

| 能力 | 边界 |
| --- | --- |
| `storage.local` | 本插件私有持久化和 session KV；仍受大小预算约束 |
| `ui.setTitle/setIcon/setBadge/resize/toast` | 只作用于自己的 Tab、受限容器尺寸和壳内提示 |
| `settings.register/page`、`settings.get/set` | 本插件设置与入口；不能访问宿主授权表或其它插件设置 |
| `theme` | 注册自己的主题包；有配额，不能覆盖其它来源，注册不等于自动应用 |
| `vault.write` | 保存、判断和移除本插件的密钥引用；无明文读取接口，不能访问系统已有凭据 |
| `fs.read` / `fs.write` | 仅限用户经宿主原生选择器选定的文件、目录或保存位置，以及本插件当前实例持有的文件句柄；保留读写用途与路径边界检查 |
| `timer.background` | 本插件通用 `deadlineTasks`；每插件最多 4 个计划，每计划最多 2000 条不可变回执；基础能力免额外授权，通知单独校验 `notify` |

`storage.assets/files/flush/commit`、`background.call`、后台的私有文档/blob、普通 `auxiliary` 窗口和 `files.stream` 私有输出不新增权限枚举。它们仍绑定本插件、当前运行代次、入口及配额；后台声明的原生事件、捕获或置顶行为另受对应敏感权限控制，不能用基础容器绕过授权。私有输出导出仍须原生保存确认，资源 ID 和兼容 `path` 字段都不授予裸路径访问。

0.2.2 不再提供 AI 配置、LAN、数据库、中间件和 SSH 专用宿主 API。它们由明确声明并获得 `backend.node` 授权的插件后端实现；旧的受限业务授权不能升级为完整 Node 信任。

0.2.3 进一步把剪贴板历史迁至 clipboard 插件沙箱后台，选区、录制与贴图迁至插件仓 `@enest/native-surfaces`。`clipboard.history`、`screen.record`、`pin.create` 是保留的敏感权限名，不表示宿主仍提供同名历史 CRUD、录制会话或贴图业务 API。

新插件的 `permissions` 只需列出敏感项，纯离线工具可以省略该字段或使用空数组。已有包里声明上述基础能力仍可加载，但这些声明不会产生授权开关；旧版本为基础能力保存的拒绝值不再生效。插件启停仍由用户控制，基础能力不会赋予 Node、任意文件或网络权限。

## 密钥保险库

插件通过 `await enest.vault.set(key, secret)` 保存本插件的密钥，取得不透明 `secretRef`；用 `vault.has` 判断记录是否存在，用 `vault.remove` 删除。页面没有明文 `get`。引用可以交给 `enest.net.fetch` 的鉴权注入，或由已获 `backend.node` 授权的本插件后端通过 `secret.resolve` 使用；后端不得把明文转发给页面。`has` 为真只表示存在记录，不保证系统密钥库已解锁或该记录当前可以解密。

公开行为与预算如下：

| 项目 | 契约 |
| --- | --- |
| 单条数据 | 新 key 最多 128 个 UTF-8 字节，单个 secret 最多 64 KiB |
| 持久化容量 | 每插件最多 256 条、8 MiB 密文；旧超额记录仍可删除或在不增加超额占用的前提下缩减 |
| 待完成加解密 | 每插件最多 16 个，宿主全部插件合计最多 64 个，包含正在执行和排队的保存、鉴权解密及后端 `secret.resolve`；切换数据根不会增加同一插件的额度 |
| 限额与失败 | 超限、实例失效、系统密钥库不可用或加解密失败时拒绝 Promise；`has` / `remove` 不占用上述加解密队列名额 |
| 保存成功 | Promise 成功解析后才可确认本次密文写入完成；这不是跨 KV、设置、附件的事务，也不承诺硬断电后的持久性 |

不要在等待系统密钥库时持续提交保存请求。界面应合并尚未提交的输入，等待当前保存完成；失败时提示用户解锁或配置系统密钥库，再由用户重试。不得为了绕过拒绝而把 secret 转存普通 `storage`、设置或日志。宿主不会降级为明文、固定密钥混淆或插件自行提供的弱加密。

### 旧数据与系统密钥库

早期 eNest 使用同步 `safeStorage` API 生成的安全密文可由当前异步实现直接读取，正常升级无需重新输入密钥。系统要求密钥轮换时，宿主重新加密同一密钥内容并原子替换密文，不改变 `secretRef`。解密或重新加密失败会保留原文件并拒绝本次操作；旧 XOR 数据及不满足当前安全策略的弱密文不会被当作正常安全凭据使用，须由用户重新输入。兼容旧格式不等于支持将密文迁移到另一台机器、另一系统账号或已丢失密钥的系统密钥库。

Linux 当前仅接受已识别的 `gnome_libsecret`、`kwallet`、`kwallet5`、`kwallet6` 后端；`basic_text` / 未知后端拒绝读写。即使异步加密初始化成功，若实际返回 Linux 固定密钥 fallback 的 `v10` 密文，也会拒绝使用而不是降级。这个 `v10` 限制仅针对 Linux，不表示 macOS 同名前缀的正常旧密文无效。仅提供 Secret Portal、但传统后端未被识别的 Linux 环境目前也会保守拒绝；不能据此承诺所有 Flatpak / Portal 环境均可用。

**宿主实现说明，不是插件 API**：主进程使用 Electron 的 `isAsyncEncryptionAvailable()`、`encryptStringAsync()`、`decryptStringAsync()`，并处理返回的 `shouldReEncrypt`。插件只依赖自己的 Promise API 和不透明引用，不应导入 Electron、解析密文头、拼接保险库路径或自行处理密钥轮换标记。

### 失效与删除

待完成操作绑定发起它的插件实例及当时的数据根。关闭、重载、撤权或实例退役后，旧操作不能提交密文或继续使用解密结果；数据根切换会使旧操作失效，即使随后切回原路径也不会恢复。操作不会静默改写到新根目录，应由仍有效的实例重新发起。

删除一个 key 会同时使该 key 先前在途的保存或重新加密失效；卸载清理密钥命名空间后，先前操作不能重新创建它。此规则不撤销失效前已经完成的保存，也不妨碍用户随后在有效实例中明确保存新密钥。运行代次、数据根代次和密文替换检查由宿主维护，插件不持有或修改这些内部计数。

## 授权与撤权

每项敏感权限有 `ask`（默认）、`allow`、`deny` 三态。插件首次调用尚未授权的敏感能力时，主进程在插件所在主窗或 Quick 窗显示一张原生授权框，列出插件名称及其 manifest 中尚待授权的敏感能力。一次选择覆盖框内列出的能力；已有 `allow` 或 `deny` 不会被这次选择覆盖。并发请求合并处理，避免网络请求等连续调用重复弹窗。基础能力不加入授权列表。

- 本次运行允许：列表内能力在当前插件实例中可用，不写入持久授权表；关闭、重载、崩溃或休眠销毁实例后失效。
- 授权并记住：列表内能力保存为 `allow`；下次打开与重启后沿用。升级后新增的敏感能力仍需授权，不会随旧授权自动放行。
- 暂不允许：当前实例不再请求列表内能力，结束实例后可重新询问；不会把取消操作保存成永久拒绝。需要持续拒绝某项能力时，可在插件权限设置中设为 `deny`。
- 超过 60 秒、关闭插件或实例失效：拒绝未完成的请求，不保存临时或持久授权。
- 将敏感权限改为询问或拒绝，会停止该插件沙箱后台与原生订阅，关闭当前实例并回收已有连接、辅助窗口、捕获、文件能力和未完成输出；下次打开使用新授权状态。撤权不是删除已持久化私有数据，也不能收回插件此前已读取的内容。

所有已安装插件都有设置入口，即使没有声明自己的设置项；持久授权结果会同步更新权限页面，可逐项改为允许、询问或拒绝。

主进程仍逐次验证调用窗口、主 frame、插件 ID、精确 origin、manifest、运行代次及文件能力。插件或壳 renderer 发送“已同意”不能授予权限。官方 AI 配置插件在自身白名单/快照约束下执行，并使用通用 `dialog.confirm` 获得新鲜原生确认。恢复配置备份、删除资产、结束进程等破坏性操作仍由宿主展示具体目标并确认；参数 `confirmed: true` 不是用户授权凭据。

## 敏感权限

| 权限 | 用途 |
| --- | --- |
| `clipboard.read` / `clipboard.write` | 系统剪贴板文本读取 / 写入 |
| `clipboard.readImage` / `clipboard.writeImage` | 系统剪贴板图片读取 / 写入 |
| `clipboard.history` | 兼容权限名：授权后台接收原生 `clipboard.changed` 快照及相关前台后台调用；不是宿主历史 CRUD |
| `clipboard.paste` | 向宿主捕获的原应用回贴已复制内容；系统授权请求单独受此权限控制 |
| `screen.capture` | 原生 `screen.capture` 截图；`screen.displays` 只读几何，无需此权限 |
| `screen.record` | 通用辅助页一次指定显示器的捕获，还需系统许可、当前可见实例和真实原生用户手势；不是宿主录制业务 API |
| `pin.create` | 兼容权限名：非捕获辅助窗口的原生 `alwaysOnTop` 位置能力；贴图内容与交互由插件实现 |
| `backend.node` | 运行插件自有 Node 后端；完整本机信任，具有当前用户可用的文件、网络和进程能力；不是操作系统沙箱 |
| `net.fetch` | 宿主 HTTP(S) 请求；分片、SSE 仍有字节预算 |
| `net.socket` | TCP、宿主 WebSocket 客户端和限域连接桥 |
| `fs.rename` | 同目录改名；需要可写句柄，批量操作需宿主确认 |
| `sys.inspect` / `sys.control` | 查看进程、端口 / 结束具体进程 |
| `shell.openExternal` | 系统浏览器打开 http、https、mailto、tel 链接 |
| `notify` | 操作系统通知 |
| `hotkey` | 注册影响其它应用的全局热键 |
| `contribute` | 注册动态 Quick provider，接收全局搜索文本并提供结果；普通声明式入口无需此权限 |
| `ssh.agent` | 官方 SSH 后端请求的细分授权；其解释与 socket 约束位于插件，不在壳的协议处理器 |
| `db.connect` / `db.query` / `db.schema` | 数据库插件通过通用 `permission.authorize` 请求的细分授权 |
| `mw.connect` / `mw.query` / `mw.admin` | 中间件插件通过通用 `permission.authorize` 请求的细分授权；action 解释位于插件 |

主题读取、语言读取、身份读取和纯事件订阅同样无需额外权限。普通声明式入口直接可用；动态 Quick provider 会读取全局搜索文本，因此保留 `contribute` 授权，两类贡献点都由宿主绑定来源。官方插件可通过通用后端控制请求已声明的细分授权。壳不解释 SQL、SSH 或中间件 action；对本机后端的完整 Node 信任仍必须单独明确声明。

DSH 从 0.0.1 起要求 eNest `>=0.2.1`，业务实现迁入插件自己的后端，通过通用后端协议运行；旧 `dsh.connect`、`dsh.chat`、`dsh.admin` 专属权限与调用通道已移除。旧包须升级配套版本，旧授权不能转换成或隐含 `backend.node`。升级后新增的完整 Node 信任仍须用户明确授权，不可静默兼容放行。

### 剪贴板观察与沙箱后台

持续观察要求插件在 manifest 声明 `background.events: ["clipboard.changed"]` 及 `clipboard.history`，并实际保存 `clipboard.history=allow`。若 `eventSettings` 将事件绑定到插件声明的布尔设置，该值还必须为真。宿主维护一个共享原生观察器，向合格后台发送有界快照；历史模型、去重、置顶、保留与搜索由插件实现，普通前台不能订阅原生变化来绕过门禁。

本次运行允许可以供当前前台调用本插件 `background.call`，但不启用持续观察或基于该敏感事件的 Quick 后台搜索；manifest 声明本身也不授权。系统 `requestPermission()` 不会写入 `clipboard.history=allow`。后台方法不接受其它插件 ID，私有文档/blob也不能跨插件读取。

撤权、禁用或性能面板的停止操作会回收后台及其原生订阅；没有剩余授权订阅者时共享观察器停止。观察器重新开始时只对齐当前剪贴板，不导入停用期间内容。手动停止后，普通设置刷新和 Quick 搜索不会自动重启；显式前台后台调用、禁用再启用或构建更新可以解除停止，仍须重新满足授权。前台关闭不会取消已经持久授权且仍启用的事件订阅，后台运行实例则可空闲回收并从持久私有文档重建。

### 屏幕辅助页

普通辅助页只有 `enestAux` 的上下文/消息/关闭接口，没有完整 `enest` 或 Node。`screen.record` 不能变成任意 `getDisplayMedia`、摄像头或麦克风访问：宿主绑定当前主 frame、插件代次、指定显示器、可见且聚焦的辅助窗口与真实用户手势；每窗口只允许一次捕获。系统 loopback 音频是否可用取决于平台，不应宣传为通用麦克风权限。

撤销 `screen.record` 关闭捕获辅助页，撤销 `pin.create` 关闭非捕获置顶辅助页；随后当前插件实例关闭，私有输出流也随运行域清理。录制与贴图状态由插件包管理，不能靠保留旧的 `enest.screen.record` / `enest.pin` 调用绕过上述流程。

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

`localFiles.pick/pickSave/read/list/reveal/prepareDrag`、`shell.saveFile/saveTextFile`可直接调用，无需声明 `fs.read` / `fs.write` 或先经过通用授权框。文件选择器仍需用户选定目标；关闭或取消选择不会授予文件能力。

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

**后端边界**：从 0.2.0 起，普通插件可以声明 `backend.entry` 并在获得 `backend.node` 授权后运行独立 Node utility process。页面仍保持上述隔离，但 Node 后端具有完整本机执行能力，细分的前端文件/网络权限不会构成它的操作系统沙箱。宿主验证包内入口、授权和实例归属，并在撤权时终止后端。

0.2.1 的 `protocolVersion: 1` 控制协议只提供当前实例的活动租约、已验证后代进程登记、回环子页面端点、代理解析和有界关闭，不提供任意宿主 IPC。资源绑定 `pluginId + generation + wcId`；子进程核验真实父子链与启动时间，端点限定显式 HTTP 回环端口，控制请求及活动/进程/端点数量均有预算。它们用于占用统计、正常空闲休眠协调和回收，不减少 `backend.node` 的完整本机信任。具体消息、参数和预算见[本机后端](backend.md)。

任何声明后端的插件都可携带私有 `runtime/` 附件；不再为 DSH ID 单独豁免。附件与 `backend/` 一样不由页面资源协议提供，且禁止符号链接及非普通文件。宿主不会因为附件存在而自动执行它；插件后端负责自己的运行时业务，仍受当前实例关闭/撤权回收流程管理。

## 数据与系统权限

插件业务数据通过 `storage` API 保存到宿主管理的 `~/.eNest`（用户显式设置数据根时遵从该设置）。不要自行拼接用户目录。关 Tab 保留持久数据；卸载清理对应 partition、KV、设置与贡献。生命周期和预算见 [生命周期](lifecycle.md)。

macOS 截屏/录屏还需要系统 TCC，通知、全局热键在不同系统也有自身限制。宿主 `allow` 不会绕过操作系统权限。错误 `permission denied: <key>` 表示宿主门禁；`os permission denied: screen` 表示系统门禁。未实测平台不能仅由 macOS 测试推导通过。
