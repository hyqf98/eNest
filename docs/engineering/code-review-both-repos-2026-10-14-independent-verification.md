# 两仓库评审报告独立复核

日期：2026-10-14。复核对象：[原评审报告](/Users/haijun/Work/frontend/eNest/docs/engineering/code-review-both-repos-2026-10-14.md)。

依据：eNest 与兄弟仓库 eNest_plugin 的当前工作区，包含未提交变更；两仓 HEAD 分别为 `49e1e10`、`cffe732`，不能把 HEAD 当作本次审查内容的完整快照。没有使用壳仓内的嵌套插件旧副本。

初次复核完整阅读原报告，逐条追踪其 13 项“严重问题”，并复核其余模块中的具体故障、关键修复建议和反例。**没有把全部 162 条建议逐一做运行时验收，也不把静态检查等同于跨平台实测。** 初次复核仅新增这份记录，没有修改业务代码或原报告；下文的代码位置和复现结果对应修复前工作区。用户随后授权实施，已完成的变更和最新验证见 [修复记录](/Users/haijun/Work/frontend/eNest/docs/engineering/code-review-fixes-2026-10-14.md)。

## 判断

报告找到了多项真实缺陷，适合作为问题线索；但不适合直接作为“162 个已确认问题”的修复清单。主要不足是：

- 有些结论只看到局部代码，没有追踪发送端、数据来源、宿主兜底或 CSP。
- 把可触发故障、条件性风险、维护建议和风格偏好放在同一套严重性统计中。
- 有重复计数和相互矛盾的概括。
- 个别建议会破坏已有保护，另一些建议不能解决所述问题。

尤其应撤回“各问题修复建议可直接照做”的结语。下面的成立判断与修复优先级分别考虑，不以原报告的颜色作为依据。

## 13 项严重问题逐项核验

| 原编号 | 复核结论 | 证据与修正 |
|---|---|---|
| 1 ClipboardItem | **核心成立，已在 Electron 主进程复现** | Electron 44.4.3 中 `typeof Electron === 'undefined'`，原构造式抛 ReferenceError；导入 `ClipboardItem` 后构造成功。[pluginHandlers.ts:687](/Users/haijun/Work/frontend/eNest/src/main/ipc/pluginHandlers.ts:687)、[clipboardHistory.ts:39](/Users/haijun/Work/frontend/eNest/src/main/clipboard/clipboardHistory.ts:39)。第三处 [nativeClipboard.ts:126](/Users/haijun/Work/frontend/eNest/src/main/clipboard/nativeClipboard.ts:126) 只在 Linux 尝试此路径，catch 后还有 native helper 回退，不能把三处都说成最终功能必然失败。 |
| 2 保存 ACK 被丢弃 | **成立，真实源码隔离复现** | preload 发出 `save-requested` ACK，main [pluginHandlers.ts:1463](/Users/haijun/Work/frontend/eNest/src/main/ipc/pluginHandlers.ts:1463) 仅接受另外两类。需纠正文案：通常是 `acked=0`、`timedOut=total`，不是“acked 为超时计数”；[PluginHost.ts:1268](/Users/haijun/Work/frontend/eNest/src/main/plugin/PluginHost.ts:1268) 使用 Promise.all 并行等候，总延迟约 4.7 秒，不是插件数量乘以 4.7 秒。没有运行中插件时不会等待。 |
| 3 四类事件漏转发 | **成立，真实 preload 打包隔离复现** | 向真实分发器注入 `mw.data`、`mw.error`、`net.websocket.message`、`net.websocket.close` 均不触发已注册回调；对照事件 `net.close` 正常触发。发送端、订阅端存在，缺口在 [pluginPreload.ts:1566](/Users/haijun/Work/frontend/eNest/src/preload/pluginPreload.ts:1566)。用穷尽检查防再次遗漏合理。 |
| 4 硬件加速开关 | **在设置已迁移 SQLite 的正常路径成立** | [hardwareAcceleration.ts:22](/Users/haijun/Work/frontend/eNest/src/main/hardwareAcceleration.ts:22) 仍只读取锚点中的 hardwareAcceleration，而 [SettingsStore.ts:98](/Users/haijun/Work/frontend/eNest/src/main/settings/SettingsStore.ts:98) 锚点仅保留 dataRoot。应保证 before-ready 的读取路径与持久化真值一致，同时保留旧格式和库不可用时的兼容；单纯在退出时冗余写入并非完整方案。 |
| 5 DSH 健康检查 | **核心成立** | [dshUpgradeService.ts:187](/Users/haijun/Work/frontend/eNest/src/main/dsh/dshUpgradeService.ts:187) 检查入口是否存在，却只执行当前可执行程序的 `--version`，未执行入口文件。隔离函数探针也证明结果不取决于 DSH 程序是否能运行。精确表述为“不能验证已找到的 runtime 入口是否健康”；入口完全找不到、spawn 失败或超时仍会返回 false。 |
| 6 设置页安装更新 | **入口绕过显式保存成立；必然丢数据的结论过强** | [SettingsPage.tsx:469](/Users/haijun/Work/frontend/eNest/src/renderer/pages/SettingsPage.tsx:469) 不走 UpdateDialog 的 saveAll。主进程仍有 [update.installing 通知](/Users/haijun/Work/frontend/eNest/src/main/update/updateService.ts:198) 和 [常规退出 beforeClose 流程](/Users/haijun/Work/frontend/eNest/src/main/index.ts:349)，但它们不能当作跨平台可靠替代，尤其 macOS 原生 updater 的 before-quit 时机晚于窗口关闭。保留统一保存协调入口的建议，风险需按平台、插件保存钩子和耗时描述。未执行真实安装更新。 |
| 7 database XSS | **未转义属性注入成立；正式态的示例脚本执行结论不成立** | [schemaTree.js:377](/Users/haijun/Work/frontend/eNest_plugin/plugins/com.enest.database/assets/js/schemaTree.js:377) 直接拼入 key，应该修。报告漏查 [pluginSessionPolicy.ts:71](/Users/haijun/Work/frontend/eNest/src/main/plugin/pluginSessionPolicy.ts:71) 的 CSP。用当前 CSP 和合成 HTML 在隐藏 Electron 页面实测：普通 enest 策略阻止 onmouseover 执行，配置远程 devUrl 后允许执行。不能凭该示例宣称正式插件可直接执行任意 SQL；也不能因此保留属性注入。 |
| 8 SSH 后台输出丢失 | **成立** | [app.js:1515](/Users/haijun/Work/frontend/eNest_plugin/plugins/com.enest.ssh/assets/js/app.js:1515) 后台只追加 buffer；[app.js:1099](/Users/haijun/Work/frontend/eNest_plugin/plugins/com.enest.ssh/assets/js/app.js:1099) 仅首次创建终端时回放，已有终端重新挂载时缺补写。增量游标方案必须处理 buffer 截断，不能直接用永久累计游标切一个有长度上限的字符串。也可评估持续写入每个存活 session 的终端实例。 |
| 9 SSH 无 sid 错误串台 | **分支存在，当前宿主触发链未成立；撤出严重缺陷** | [app.js:1553](/Users/haijun/Work/frontend/eNest_plugin/plugins/com.enest.ssh/assets/js/app.js:1553) 确有无 sid 时遍历所有会话的分支。但当前唯一宿主 `ssh.error` 发送点 [sshSessionManager.ts:304](/Users/haijun/Work/frontend/eNest/src/main/ssh/sshSessionManager.ts:304) 始终携带 sessionId。可改成更稳妥的全局提示，属于防御改进，不能声称当前多会话必然串台。 |
| 10 密码进入剪贴板历史 | **条件性隐私风险成立，实施时进一步收窄** | 历史采集需要已启用的消费插件和持久 allow 授权，还受暂停/排除配置影响。实施时确认既有 `noteExternalText()` 已将宿主普通写入记入去重哈希，不能说每次复制密码都会入库；实际缺口是写入与正在 await 的采集交错。已补行为测试并修复该竞态，同时让密码工具显式声明敏感写入豁免。延迟清空系统剪贴板不能删除已经持久化的历史，也可能覆盖用户后来复制的新内容。 |
| 11 权限 47/28/21 漂移 | **数字漂移成立；当前 CI 会拒绝 SSH/database 的推断错误** | 当前 16 份 manifest 全部通过真实 schema，执行仓库实际 validateAllManifests（含市场资产校验）也为 0 errors；当前插件没有使用 schema 外的权限。仓内也没有 mw 插件。真实后果是未来声明新增敏感权限时可能被拒绝，以及文档误导。未找到权限 schema 生成器，不能直接“重跑生成脚本”。本地缺 ajv 的上手问题另行成立，CI 已安装 ajv，二者应分开。 |
| 12 tips 双份漂移 | **维护漂移属实；严重程度和修复建议不当** | database 监听新增 `.modal-mask`，SSH 用已有 `.modal-root` 切换 `.show`；直接复制 database 的补丁不能覆盖 SSH 实际操作方式。应以真实 hover/弹窗复现决定具体改法，视觉残留按普通体验问题处理，不应与数据损坏并列严重。 |
| 13 socketSend 编码猜测 | **成立，提取实际函数的隔离探针复现** | [socketBridge.ts:539](/Users/haijun/Work/frontend/eNest/src/main/net/socketBridge.ts:539) 会把 `PING` 变成 3 字节 `3c8346`，不再是原始 4 字节文本。现有文档也描述了启发式规则，所以应按有歧义的 API 契约缺陷修复：明确编码、迁移调用方；把猜测保留为默认回退会留下同一问题。 |

## 必须纠正的其他判断和修复建议

### 1. 不应在销毁超时后直接删除 retiringViews

原报告模块 1 建议在超时和 catch 路径直接删除该记录。这会在旧 WebContents 尚存活时允许创建同插件的新实例，削弱资源归属和孤儿进程防护。

[PluginHost.ts:509](/Users/haijun/Work/frontend/eNest/src/main/plugin/PluginHost.ts:509) 明确阻止这种重开；[PluginHost.ts:1594](/Users/haijun/Work/frontend/eNest/src/main/plugin/PluginHost.ts:1594) 在收到 destroyed 后才清除记录，超时后监听器仍保留，并非必然永久锁死。仓库已有专门的 [回归测试](/Users/haijun/Work/frontend/eNest/src/main/plugin/PluginHost.test.mjs:214)，本次执行通过。

若需要改善“销毁始终未确认”的恢复体验，应增加受控重试、诊断或可验证的终止流程，确认旧实例终止后再释放屏障。不能靠删除记账掩盖未知的原生生命周期状态。

### 2. mock 的 onEvent 已实现

[shellApi.ts:783](/Users/haijun/Work/frontend/eNest/src/renderer/services/shellApi.ts:783) 已实现订阅和退订，接口也将它定义为必选，无 preload 时使用 mock。模块 6 的“预览一挂载就 TypeError”不成立，无需为此补判空。

### 3. 插件 manifest color 注入缺少真实输入来源

[PluginDetailModal](/Users/haijun/Work/frontend/eNest/src/renderer/components/PluginDetailModal.tsx:127) 确实使用 p.color，但远程颜色由 [colorFromId](/Users/haijun/Work/frontend/eNest/src/main/plugin/marketMetadata.ts:190) 生成，本地使用 [内置固定色或默认色](/Users/haijun/Work/frontend/eNest/src/main/plugin/PluginRegistry.ts:120)。当前并未从 manifest 接受任意 color，不能把这个 CSS sink 直接定性为恶意 manifest 漏洞。

### 4. 96 MiB 与 64 MiB 是两层校验，不能只看前一层

[pluginFiles.ts:85](/Users/haijun/Work/frontend/eNest/src/main/plugin/pluginFiles.ts:85) 是输入字符串的早期长度上限，后面会在 [解码及 Buffer 字节长度](/Users/haijun/Work/frontend/eNest/src/main/plugin/pluginFiles.ts:101) 再执行 64 MiB 上限。data URL/base64 长度不等于文件字节数。提示时机可以改善，不能据此认定最终文件配额与文案不一致，更不应简单把早期 96 改成 64。

### 5. 空 sha256 的结果被写反了

[marketClient.ts:201](/Users/haijun/Work/frontend/eNest/src/main/plugin/marketClient.ts:201) 在摘要为空时跳过校验并记 warn，不会按原报告所说直接失败。因此 registry 回退快照的问题是缺乏完整性校验，不能写成已确认安装失败。

### 6. database/main.js 并非零分节

文件中现有 boot、sidebar collapse、render、actions、connection form、chrome 等分节。文件大、职责多，可以改善结构和模块说明；但“零分节”“唯一半年后看不懂”没有充分依据。注释比例不是可维护性的直接度量，原报告在此还出现“一般偏好”和“差”的评级矛盾。

### 7. PermissionResponse 是明确的拒绝式兼容入口

[PermissionService.ts:152](/Users/haijun/Work/frontend/eNest/src/main/plugin/PermissionService.ts:152) 明确说明旧 renderer 授权回应故意拒绝，只有原生弹窗可授权；[pluginHandlers.ts:1471](/Users/haijun/Work/frontend/eNest/src/main/ipc/pluginHandlers.ts:1471) 也写明兼容意图。可以确认旧 API 的支持期后删除，但不能建议“恢复语义”而绕过原生授权边界。

### 8. ensureAppDirs 两次调用之间有 dataRoot 变化

[index.ts:189](/Users/haijun/Work/frontend/eNest/src/main/index.ts:189) 和 200 行之间执行了 settingsStore.load；后者会在 [SettingsStore.ts:179](/Users/haijun/Work/frontend/eNest/src/main/settings/SettingsStore.ts:179) 和 196 行设置/校正有效根目录。二次调用不保证针对同一个目录，不应机械删除；补充这一顺序的说明是合理建议。

### 9. 不能仅凭危险 sink 或缺少序号就报告已触发故障

- notify HTML 通道确实没有消毒，但当前找到的 notify.custom 调用只传纯文本 body，未建立外部输入到 HTML 的路径。可做防御性收口；报告在模块 5/6 还重复计算了同一个问题。
- refreshPacks 没有版本号，但 await 后重读当前 store，main getTheme 是同步获取；没有实证当前路径可发生报告所暗示的乱序覆盖。
- DevConsole 日志行仅为文本和 className，没有子组件内部状态。index key 不理想，但不能据此断言截断会显示错位。
- 页面销毁时，浏览器会释放该页面的定时器、DOM 监听器和 Observer；缺 beforeunload 手动清理不能直接等同于跨实例泄漏。隐藏但仍驻留时是否暂停，应结合业务活动和宿主休眠策略逐项判断。

### 10. 部分建议漏掉既有语义

- storage 写入时的 SELECT keys 不只是计数，还与 dirty 队列合并，并区分覆盖、新增和未落盘删除。[pluginStorage.ts:251](/Users/haijun/Work/frontend/eNest/src/main/db/pluginStorage.ts:251)。换 COUNT(*) 必须同时保留这些语义。
- 大型 preload 中定义 API 类型是组织和复用问题，不自动构成“混入业务逻辑”。移到 shared 可以提高可发现性，但不能用类型占比证明分层违规。
- switch 分发、判别联合和少量 if 分支本身没有问题。此次事件断链需要完整枚举和链路测试，不能靠一律改策略表解决。
- DSH 专属 ID 特例确实与约定不一致，但把 packageExtras/sizeClass 开放为插件自报字段时，仍须保留宿主认可的边界和上限，不能直接放宽任意插件的安装内容限制。

## 原报告低估或没有讲完整的问题

### 跨 origin 重定向转发凭据应提高优先级

原报告把该项放在“轻微”。[httpRequest.ts:37](/Users/haijun/Work/frontend/eNest/src/main/middleware/httpRequest.ts:37) 设置 Authorization/cookie，而 [重定向分支](/Users/haijun/Work/frontend/eNest/src/main/middleware/httpRequest.ts:53) 复用完整 opts，还允许 HTTPS 转 HTTP。

本次用两个本机临时 HTTP 服务和合成凭据，直接转译执行当前实现：302 跳转到不同端口后，目标收到 Basic 认证、cookie 和 POST body。没有读取或发送真实凭据。它应作为条件性凭据泄露风险优先处理。修复不能只删 headers.authorization，因为 basicAuth/bearerToken 会重新生成该头；还必须处理 cookie、敏感 body 和协议降级。

三个中间件 HTTP 驱动硬编码 insecureTls=true 也确实存在，应放在结构拆分之前。原报告“全链路凭据零泄漏”“网络统一走代理”等全称赞语与这些代码事实不兼容，应改为有边界的评价。

### 字体删除竞态已复现

[useFont.ts:595](/Users/haijun/Work/frontend/eNest/src/renderer/hooks/useFont.ts:595) 先取快照、等待删除文件、再使用旧快照更新和持久化。本次用真实模块转译及受控 Promise 复现：删除激活字体 A 期间选择 B，删除完成后字体被重置为空并落盘。原报告这项正确，优先级高于把 useFont 拆成几个文件。修复需在 await 后同时重读当前选择和字体列表。

### Kafka 不只是留下一个空转计时器

[kafka.ts](/Users/haijun/Work/frontend/eNest/src/main/middleware/drivers/kafka.ts:139) 的 finally 确实没有清理真实句柄。对实际函数使用模拟时钟和消息流还发现：旧 idle timer 未清除，后续消息已到达时旧 timer 仍可能提前结束读取；原报告只描述“最长 20 秒空转”不完整。此处为隔离时钟探针，没有连接真实 Kafka 集群。

### socketServeWs 失败后复用残留状态成立

原报告模块 2 的该项成立。对实际函数注入 listen 失败后再调用，得到 `ws://127.0.0.1:0`，说明失败的 bridge 仍被复用。此处为故障注入探针，没有把它算成真实外部服务或系统端口故障的实测。

### 数据库与 SSH 的并发问题应保留，但要写清触发条件

- database [execute](/Users/haijun/Work/frontend/eNest_plugin/plugins/com.enest.database/assets/js/main.js:1027) 缺少执行版本保护。虽然执行按钮会 disabled，菜单和快捷键仍可重入，旧请求晚返回时可能覆盖新结果。这条成立。但宿主 [dbSessionManager.ts:204](/Users/haijun/Work/frontend/eNest/src/main/database/dbSessionManager.ts:204) 有 RPC 超时，execute 也有执行超时，原报告同时声称“execute/open 无超时”不成立。
- SSH [连接入口](/Users/haijun/Work/frontend/eNest_plugin/plugins/com.enest.ssh/assets/js/app.js:1345) 只挡 connected，未挡 connecting，可能重复连接后覆盖 sessionId；插件最终销毁还有宿主资源清理，应描述为当前插件实例生命周期内遗留连接。
- SSH [initTheme](/Users/haijun/Work/frontend/eNest_plugin/plugins/com.enest.ssh/assets/js/api.js:462) 重复订阅确实存在，但触发重复初始化的是 followShellTheme 设置变化后的进入流程，普通宿主主题变化只调用既有监听器，不是“每次切主题都新增订阅”。

### 部分统计和契约描述也需收紧

- SQLite catalog 的查询数是每表 3 次加每个索引 1 次，不是固定每表 4 次。并发发送到单个 worker 不自动等于并行执行，应测量后选择批处理方案。
- MwCapability 实际为 available、unsupported、not-configured、error 四态；原报告的“三态”描述不准确。
- agentRead 返回 auth.json 原文属实，但受敏感 config.agent.read 授权控制，API 也承诺原文返回。加强凭据范围告知、拆分授权或脱敏需要结合现有契约，不能把已授权读取直接认定为越权。
- 小插件 ui/window 段是合法可选字段且宿主有默认值。缺省并非自动构成规范或运行时缺陷。

## 结构与可读性的总体评价

“先梳理巨型模块职责、减少真正双维护、对事件与权限契约增加自动检查”的方向合理。跨仓权限与 SQL 补全确有维护成本，SSH/database 大文件也有拆分价值。

但文件行数、注释率、if-else 数量不能直接决定严重性或证明设计不良。应优先提取可独立验证的职责，在行为保持后逐步拆分。宿主/插件的信任边界、协议适配器差异、生命周期所有权，不应为减少重复而被抹平。独立插件包也可以在构建期复用模块并把产物打进各包，“自包含”不等于无法做任何共享。

162 是报告条目总数，不能作为独立缺陷数：例如 createMockApi 过大在同模块重复列出，HTML 通道跨模块重复，通知迁移和权限漂移也多处出现。应先按根因去重，再分别标记故障、条件风险、性能机会和维护建议。

## 建议的执行次序

1. 先修已确认功能断链：ClipboardItem、保存 ACK、四类事件转发、DSH 检查、SSH 后台输出、socket 编码、硬件加速配置读取。为关键链路补有行为断言的针对性验证。
2. 并行处理数据与安全边界：跨 origin 认证转发、TLS 校验策略、数据库属性转义、统一升级保存入口、剪贴板敏感数据策略、字体删除竞态，以及已确认的查询/连接并发问题。
3. 再对齐权限 schema、文档和构建校验，修复本地校验依赖，并逐步收敛 SQL 补全等重复来源。
4. 最后按实际维护压力安排大文件拆分、提示组件、国际化和样式一致性。不要先批量应用原报告全部结构改造建议。

## 本次验证记录与边界

| 验证 | 结果 | 范围 |
|---|---|---|
| `npm run typecheck` | 通过 | 当前工作区 node + web；不是从旧审计记录沿用的结果。 |
| Electron 44.4.3 ClipboardItem 探针 | 原式 ReferenceError；导入后的构造成功 | 独立临时 profile，未读写用户剪贴板，未做所有 OS 的图片回写验收。 |
| 当前 preload 分发器及主进程 ACK handler | 复现 4 类漏转发、save ACK 被丢弃 | preload 经 esbuild 打包，Electron IPC 替身；主进程 handler 由 TS AST 提取，不是完整应用 E2E。 |
| `node --test --test-name-pattern='unconfirmed native destruction' src/main/plugin/PluginHost.test.mjs` | 1/1 通过 | 证明保留 retiring 记录是已有且受测试保护的约束。 |
| 16 份 manifest / 实际 validateAllManifests | 16/16，0 errors | 使用插件仓实际 schema 与校验函数，依赖解析指向壳仓已安装 AJV；未安装依赖或修改插件仓。没有执行远程 CI。 |
| 本地直接启动插件校验脚本 | 缺 ajv，ERR_MODULE_NOT_FOUND | 本地上手依赖问题，与现有 schema 是否拒绝当前插件分开。 |
| database 同型属性注入 + 当前 CSP | 普通策略阻止 inline handler，devUrl 策略允许 | Electron 隐藏窗口、合成 HTML，不连接真实数据库，不构成对所有可能注入形式的安全证明。 |
| middleware 跨 origin 重定向 | 合成认证、cookie、body 被转发 | 两个本机临时服务器；无真实凭据、无外部目标。 |
| 字体删除 | 删除 A 期间选择 B 后被旧状态覆盖 | 实际模块 + 受控异步依赖。 |
| DSH / socketSend / socketServeWs / Kafka | 对应问题在隔离函数或故障注入中复现 | 没有执行真实 runtime 升级、远端协议通信或 Kafka 集群测试。 |

未执行完整 build、真实应用升级或 Linux/Windows/macOS 三端全流程验收；没有据此宣称 162 项均完成验证。
