# 两仓评审修复记录

日期：2026-10-14。依据：[独立复核](/Users/haijun/Work/frontend/eNest/docs/engineering/code-review-both-repos-2026-10-14-independent-verification.md)。

用户授权后，按复核后的优先级修复已确认的功能断链、数据竞态和安全边界，并对齐两仓权限契约。变更保存在 eNest 与兄弟仓库 eNest_plugin 的当前工作区，保留两仓原有未提交内容；未提交、推送或发布。原 AI 报告保持原样。

## 已完成

| 范围 | 修复行为 |
|---|---|
| 图片剪贴板 | 三处使用 Electron 导出的运行时 `ClipboardItem`，消除 `Electron` 类型命名空间被当作运行时对象的问题。 |
| 保存与事件链路 | 主进程接受 `save-requested` ACK，保留发送者、实例和 operationId 校验。preload 补全 `mw.data`、`mw.error`、`net.websocket.message`、`net.websocket.close`；穷尽检查还发现并补上原报告遗漏的 `ssh.auth`。 |
| 硬件加速 | ready 前通过引导锚点定位 SQLite 设置，以只读连接读取实际持久化值；保留旧格式和不可用库的兼容，不创建或迁移数据库。 |
| DSH | 健康检查执行找到的 runtime 入口及 `--version`；失败后回滚激活标记。远端元数据及下载使用 Electron `net.fetch`，遵循默认 session 的代理配置。 |
| Socket | 发送编码显式区分 UTF-8/base64；本地 WebSocket 桥监听失败后清理状态，重试不会复用端口 0。 |
| 中间件 HTTP/TLS | 拒绝跨 origin 重定向和 HTTPS 降级，避免认证头、Cookie、请求体被转发到其他目标。三个 HTTP 驱动默认校验证书，仅显式配置 `tlsRejectUnauthorized: false` 时跳过。 |
| Kafka / 代理 | 后续消息到达时替换 idle timer，结束时清理 deadline/idle/seek timer。代理环境变量改为有效单一 URL，处理 IPv6 地址格式。 |
| 更新入口 | 设置页与更新弹框共用保存后安装动作；同步锁防重复提交，保存期间不能关闭弹框，安装失败可重试。 |
| 字体删除 | 文件删除 await 后重读选择与列表；并发删除不复活字体，期间选择其他字体不会被旧快照覆盖。晚到的加载/刷新也不能重选已删除字体。 |
| 敏感剪贴板 | 宿主文本写入串行化并使旧采集失效；支持 `excludeFromHistory`，密码工具显式传入。排队任务取消和写入失败有对应恢复逻辑。 |
| 数据库插件 | 转义树节点属性；执行锁覆盖自动连接、菜单和快捷键，结果绑定发起时的编辑器，取消使用原请求连接，丢弃失效响应。连接尝试去重并使用独立 sessionKey，旧清理不误关新连接。 |
| 数据库密码与复制 | 测试连接使用临时密码，不写 vault；清除密码暂存到保存时执行，取消不修改已存密码。结果网格等待宿主复制成功后才显示成功提示。 |
| SSH 插件 | 后台输出持续写入存活终端，终端输入/resize 绑定原会话；密码弹窗前即锁定连接尝试，关闭/断开后晚到的连接会释放。主题重订阅取消旧监听，并阻止旧响应覆盖新设置。 |
| 权限与工程校验 | 插件仓新增 package/lockfile 和可跨平台运行的测试入口。从显式指定的宿主源码用 TypeScript AST 同步 47 项权限到 schema，再生成文档表格。CI 使用 `npm ci`、校验和回归测试，保留草稿发布方式。 |

## 契约变化与保留策略

- `enest.net.socket.send(socketId, data)` 现在始终按 UTF-8 发送。旧二进制调用必须补第三参数 `'base64'`；这两仓未发现需要迁移的业务调用，第三方插件仍需检查。接收事件的 base64 格式保持不变。[API 说明](/Users/haijun/Work/frontend/eNest/docs/site/plugin/api.md:806)。
- 中间件自签证书连接不再默认跳过验证；需要使用有效证书，或在已有配置中明确设置 `tlsRejectUnauthorized: false`。管理端点跨源重定向会报错，应将连接地址设为实际目标。
- 两个更新入口均先等待保存。**保留原有策略：保存失败或超时会提示并继续安装**，因此不能将本次修复表述为保证更新零数据损失。未执行真实更新安装。
- `excludeFromHistory` 仅作用于 eNest 自身的采集，不删除已存历史，不控制其他应用的剪贴板记录，不定时清空系统剪贴板。[API 说明](/Users/haijun/Work/frontend/eNest/docs/site/plugin/api.md:611)。
- 剪贴板复核更正：既有 `noteExternalText()` 已抑制普通宿主写入被重复采集；本次修复的是在途异步采集与写入交错的缺口，并增加敏感写入的明确契约。
- 默认权限校验只检查插件仓 schema 与文档快照。只有显式传 `--host-root` 才核对宿主源码；离线 CI 不宣称已验证最新宿主。

## 验证结果

| 验证 | 结果与边界 |
|---|---|
| 宿主 `npm run typecheck` | node + web 全部通过。历史记录中的类型检查阻塞不适用于当前工作区。 |
| 宿主 `npm run build` | 通过，包含原生 helper、main、preload、renderer；仍有现有静态/动态 import 混用警告。 |
| Socket / preload / PluginHost | 37/37 通过。包含本机真实 TCP 文本/二进制收发、监听失败重试、ACK 安全边界、Promise 保存语义和事件转发。 |
| 主进程服务 / renderer / 剪贴板 / 权限边界 | 52/52 通过，使用实际模块及受控异步/故障注入验证。与上一组不重叠，共 89 项。 |
| 插件性能既有回归 | 12/12 通过。 |
| macOS Electron 隔离 smoke | 1/1 通过。真实 sandboxed 插件返回保存 ACK，成功摘要为 total=1、acked=1、timedOut=0、dirtyBefore=1；该次合成样例约 27ms，不是产品性能基准。抛错回调不确认保存，脏状态保留；五类补齐事件经过真实 WebContents IPC。 |
| 原生 smoke 清理 | 结束时插件实例、资源计数和 sessionBytes 均为 0；隔离 profile/data 清理完成。验证了运行时 ClipboardItem 构造，未写入用户系统剪贴板，未重启原有应用。 |
| 插件仓 `npm ci` / `npm run validate` | 锁定依赖安装成功，全部 16 份 manifest 通过。 |
| 插件仓 `npm test` | 41/41 通过，包含数据库 9 项、SSH 9 项，以及权限契约和既有市场资产测试。 |
| 显式跨仓权限检查 | 47 项一致；缺宿主路径或发生漂移会失败，不静默退回离线检查。 |
| 两仓 `git diff --check` | 通过。 |

关键复跑命令：

```bash
# eNest 工作目录
npm run typecheck
npm run build
node --test src/main/net/socketBridge.test.mjs src/preload/pluginEvents.test.mjs src/main/plugin/PluginHost.test.mjs
node --test src/main/hardwareAcceleration.test.mjs src/main/dsh/dshUpgradeService.test.mjs src/main/dsh/dshRuntimeStore.test.mjs src/main/middleware/httpRequest.test.mjs src/main/middleware/kafkaQuery.test.mjs src/main/middleware/driverContracts.test.mjs src/main/proxy/proxyService.test.mjs src/renderer/hooks/useFont.test.mjs src/renderer/stores/updateDialogStore.test.mjs src/main/clipboard/clipboardHistory.races.test.mjs src/main/clipboard/nativeClipboard.races.test.mjs src/main/ipc/pluginPermissionPolicy.test.mjs src/main/settings/pluginSettingsBoundary.test.mjs
node --test src/main/plugin/pluginPerformance.test.mjs
ENEST_APP_SMOKE=1 node --test src/main/plugin/pluginBuiltinCapabilities.smoke.test.mjs

# eNest_plugin 工作目录
npm ci
npm run validate
npm test
npm run permissions:check -- --host-root ../eNest
```

未连接真实 SSH、数据库或 Kafka 服务，未执行真实 runtime 升级或应用更新安装，也未完成 Linux/Windows 原生 UI 验收。插件回归使用 Node VM 执行生产函数并模拟宿主/DOM 边界，不能当作真实 xterm 多 Tab 或远端协议端到端测试。主进程/preload 变更须重启开发进程后才能在原应用中生效；插件文件变更也须重新加载相应插件。

## 未纳入本轮

未批量实施原报告全部 162 条建议。大文件拆分、SQL 补全来源收敛、提示组件、国际化和样式整理仍是后续维护事项；不能以本记录推断这些工作已完成。复核确认的误报不实施，`retiringViews` 的原生销毁确认屏障继续保留，避免旧实例未销毁时重开同插件。
