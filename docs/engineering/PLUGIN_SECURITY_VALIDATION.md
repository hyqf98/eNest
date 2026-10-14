# 插件安全能力验证（2026-10-13）

本报告记录通用前端插件的权限、文件、网络及运行代次隔离修复与实际检查。默认持久目录为 `~/.eNest`；工程与包格式见 [插件工程结构](../site/plugin/structure.md)，权限 API 见 [权限说明](../site/plugin/permissions.md)。原生窗口与生命周期实测另见 [沙箱与生命周期验证](PLUGIN_SANDBOX_LIFECYCLE_VALIDATION.md)。

后续已按“壳提供统一能力、插件自行实现业务”收口为 10 个免声明/免授权的基础能力与 37 个敏感能力，并修复设置项自行授权、密钥库弱加密降级和主题背景外联边界。最新实现与追加验证见 [能力与权限收口](PLUGIN_PERMISSION_CLOSEOUT.md)；下文批量测试数字保留其实际执行时点。

## 已实施的边界

| 入口 | 宿主执行约束 |
| --- | --- |
| 插件 IPC | 绑定 Host 持有的 WebContents、主 frame、当前插件入口与运行代次；壳 IPC 不能由插件 renderer 调用；贴图/区域选择/录屏辅助窗口也匹配当前 WebContents 对象与主 frame |
| 授权 | 基础能力直接可用；敏感能力使用宿主原生对话框，默认/取消均拒绝；仅本次/长期允许分开；renderer 不能伪造批准；有队列上限与截止时间；关闭后取消挂起申请 |
| 撤销 | 撤销权限同时关闭该插件代次，释放已保留的连接、文件句柄与任务；晚到的异步结果不能交给重开的实例 |
| 本地文件 | 官方插件通过 `localFiles.pick/pickSave/fromDrop/read`；API 不接受自由绝对路径；句柄限定插件、代次、读写范围和选中文件/目录 |
| 文件内容 | 读取普通文件并使用 `O_NOFOLLOW`、字节上限、并发限制与最终关闭描述符；写入拒绝符号链接与目录越界；`displayPath` 仅用于展示 |
| SSH / SFTP | 私钥、上传源、下载目标使用句柄；SSH agent 是独立权限，只使用宿主已配置的 agent；旧路径提示不恢复访问能力 |
| 本地数据库 | SQLite / DuckDB 文件通过句柄；SQLite 原生 authorizer 拒绝附加数据库、扩展和危险 PRAGMA，DuckDB 锁定外部文件/网络/扩展能力 |
| 网络 | `net.fetch`/受控 WebSocket/受控 socket 有许可、连接数、消息/响应大小、时间与缓冲限制；关闭代次取消连接；支持配置的 HTTP CONNECT 与 SOCKS5 代理 |
| 高风险操作 | 终止进程、修改外部 AI 配置等使用独立权限及宿主确认，不信任页面的 confirmed 布尔值；结束进程前后校验目标身份 |
| 主题 | 仅允许合法 CSS 自定义属性名及安全值，加载旧 registry 也清理；声明主题的更新/禁用串行处理，删除已撤掉的声明 pack；不同来源的持久化串行且原子替换 |
| 发布包 | 根入口、manifest 和 assets 固定布局，拒绝路径穿越/符号链接/源码杂项；暂存副本重新完整校验且 manifest 必须与安装快照一致；市场包 id/version 必须与索引一致 |

后台剪贴板轮询要求长期 `clipboard.history` 允许；“仅本次”不启动持续采集。文件导入的批量确认限制数量，保证展示给用户的选择与实际发放句柄一致。

## HTML 文件选择的真实边界

Electron 的 `setPermissionRequestHandler` **不能统一拦截所有** HTML `input[type=file]` 选择器。用户在 Chromium 原生选择器中明确选择文件，或把文件拖到页面，是浏览器自身授予该页面所选 `File` 内容的能力。页面不能据此自由读取未选择的任意系统路径。

因此不能宣称“所有浏览器文件读取都经过宿主 `fs.read` 弹窗”。官方插件已迁移至宿主选择器和文件句柄 API，以获得一致的 eNest 授权、代次和大小限制；这属于官方实现约定，不是靠 DOM 替换建立的安全边界。`file-system-access-restricted` 的拒绝策略覆盖 Chromium 的受限目录 gate，也不等于拦截全部文件选择。

若产品将来要求连浏览器用户明确选择的文件都必须经过统一宿主批准，需要单独评估 Chromium/Electron 可执行的产品边界；不能用页面脚本拦截输入框来声称实现了该保证。

## DSH 与其他例外

DSH 是专属外部 Node 子进程运行时，独立于通用前端页面沙箱。本轮仅维持其明确路径与生命周期整合：源码预览读取 `dist/runtime`，发布根读取 `runtime`，`DSH_HOME` 分开存储，内嵌端点限定宿主登记的 loopback URL 并在退出时撤销。**这些约束不构成 DSH 的操作系统级沙箱，也不保证其内部工具逐项经过通用插件权限。** 不能把 DSH 的执行能力复制给普通插件，或把本报告当作 DSH 外部工具的权限认证。

开发服务器是用户明确配置的可信 origin；浏览器允许该 origin 的静态资源和 HMR，宿主不启动 npm、不复制源码、不监听源码来强制刷新。该 origin 本身提供的网络服务和第三方远端 SSH/数据库服务器不属于本地页面沙箱。远端数据库账户权限仍由服务端管理。

不支持的自定义代理协议（例如当前 socket 转发未实现的 HTTPS 代理）报错关闭连接，不静默直连。TLS 默认校验证书；RDP 自签名例外需要先展示证书 SHA256 并由宿主确认，再交换后续协议数据。

## 实际验证

环境：macOS，本地 Node 22.22.1，Electron 44.4.3 内嵌 Node 24.21.0。SQLite authorizer 与 DuckDB 的安全检查使用实际 Electron Node 和实际驱动；权限窗口的队列/取消检查使用原生 dialog 接口的可控 stub，不能把该单元测试称为人工点击系统授权窗口。

2026-10-13 重新执行安全回归，102 项中 **101 通过、0 失败、1 跳过**。跳过项是原有、依赖专门 Linux OpenSSH 环境的集成套件；其余 SSH 认证、代理与资源归属检查有可控测试服务/fixture。此后另行完成下述临时本地 OpenSSH 实测，不将旧套件的跳过改记为通过。批量回归执行范围：

```sh
node --test \
  src/main/plugin/PermissionService.test.mjs \
  src/main/plugin/localFiles.rename.test.mjs \
  src/main/plugin/pluginFiles.test.mjs \
  src/main/plugin/pluginSessionPolicy.test.mjs \
  src/main/net/websocketService.test.mjs \
  src/main/net/socketBridge.test.mjs \
  src/main/net/wsFrames.test.mjs \
  src/main/net/fetchStream.test.mjs \
  src/main/net/lanShareService.test.mjs \
  src/main/database/localDatabaseSecurity.test.mjs \
  src/main/database/dbLifecycle.test.mjs \
  src/main/ssh/sshAuth.test.mjs \
  src/main/ssh/sshLifecycle.test.mjs \
  src/main/ssh/sshProxy.test.mjs \
  src/main/ssh/sshIntegration.test.mjs \
  src/main/sys/sysInspectService.test.mjs \
  src/main/ipc/pluginToolsOwnership.test.mjs \
  src/main/ipc/ipcSecurity.test.mjs \
  src/main/dsh/dshRuntimeStore.test.mjs
node --test \
  src/main/plugin/pluginStandard.test.mjs \
  src/main/theme/themePacks.test.mjs \
  src/main/plugin/PluginRegistry.theme.test.mjs \
  src/main/pin/pinService.test.mjs \
  src/main/screen/screenService.test.mjs
npx tsc --noEmit -p tsconfig.node.json
```

随后独立差异审阅的组合回归 **24/24 通过**：安装标准 5 项、主题键/并发落盘 2 项、主题贡献竞态 3 项、贴图/录屏/区域选择 14 项。覆盖源码公开目录、非法资源路径、发布格式、复制期间 manifest/布局变化、市场身份不匹配、恶意主题键、旧主题清理与辅助 IPC 伪造发送方。最新主进程类型检查通过；完整宿主 typecheck/build 与应用冒烟以主集成结果为准。

测试覆盖真实 HTTP CONNECT / WebSocket 流量、丢弃的跨代次回调、SSE 分段 UTF-8 与上限、句柄跨插件/跨代次拒绝、私钥和数据库路径拒绝、原生 SQLite/DuckDB 文件逃逸策略。原生 WebContents、浏览器无 require/process、直接未授权网络阻止和长期资源采样见关联生命周期报告；这里不据单元测试推断全部平台、长期无泄漏或所有外部服务已通过。

### 临时本地 OpenSSH 实测

新增独立 opt-in 用例 **1/1 通过**，使用本机 OpenSSH 10.3p1，仅绑定 `127.0.0.1` 的临时高端口，生成临时 Ed25519 主机/客户端密钥、授权文件与配置。测试未修改用户 SSH 配置或系统服务，结束后已确认服务停止、临时文件删除。原始证据见 [本地 OpenSSH 结果](plugin-local-openssh-2026-10-13.json)。

```sh
ENEST_LOCAL_SSH_SMOKE=1 \
ENEST_LOCAL_SSH_OUTPUT=docs/engineering/plugin-local-openssh-2026-10-13.json \
node --test src/main/ssh/sshLocalOpenSsh.test.mjs
```

该用例加载实际 `localFiles`、SSH 会话管理、信任/代理和 SFTP 主进程模块，以真实 SSH/SFTP 传输验证：

- 通过生产文件句柄读取私钥，用预先固定的主机指纹认证，并执行无副作用命令。
- 读写含中文名称的 SFTP 文件，拒绝旧内容哈希覆盖。
- 通过文件/目录句柄上传、下载 256 KiB 数据，校验两端 SHA256 一致；拒绝裸本地路径和跨插件句柄。
- 断开、重连后释放会话与 activity lease；撤销本地句柄后不能再次解析。

原生权限窗口、密钥保管库与事件投递使用隔离 fixture；本用例不覆盖首次信任对话框、Linux 资源采集、多跳或 SSH agent。旧集成套件仍跳过，用户真实远端服务也未连接。

## 独立差异审阅

复查安装、Registry、schema、市场资源、开发加载和路径迁移时，确认并修复以下问题：

- **P2 安装快照不一致**：原先只校验复制前的源目录。现在发布前重读完整暂存布局并比较 manifest，变化即拒绝，旧版本未开始替换；市场身份不匹配也有独立回归。
- **P2 主题键注入**：原先只检查 token 值，非法键可进入 CSS 文本或成为普通根样式属性。注册和加载现存 registry 都限制合法 `--` 变量名，不能注入选择器、规则或 `display` 等普通属性。
- **P2 主题生命周期竞态**：异步注册与禁用/更新可能交错，旧声明 pack 也未按差集删除。现在按来源串行协调，过期操作停止继续注册但仍完成旧声明清理，最终禁用撤销全部来源 pack；更新保留运行时独立注册的 pack。
- **P2 主题文件并发写**：不同来源可能同时写同一个 registry 文件。现在全局串行落盘，以同目录临时文件原子替换，避免截断或混写。
- **防御补强：辅助 IPC 身份**：原先贴图关闭、录屏和区域选择只比较数字 WebContents id。现在同时匹配实际对象与主 frame，测试验证子 frame 和同 id 伪造对象均不能驱动操作。这些窗口仍使用宿主固定 HTML。

市场元数据的非字符串分类与非法 id/version 已由主集成修正并添加回归；本报告不将单元测试之外的推断列为原生实测。此次差异审阅未确认常规前端插件可以直接绕过宿主系统权限的 P0/P1 缺陷，但这不是对所有 Electron/Chromium、原生依赖或未来插件实现的证明。

本报告不声称完成形式化安全证明或全面渗透测试。残余产品边界是上述 Chromium 用户选择、显式开发 origin 和 DSH 外部运行时；不能将它们合并成“所有系统能力均被一个弹窗完全控制”的承诺。
