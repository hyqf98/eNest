# eNest 两仓库代码评审报告

- **评审日期**: 2026-10-14
- **评审模式**: 全量评审（10 个子代理并行）
- **评审范围**:
  - eNest 壳子 `/Users/haijun/Work/frontend/eNest`：232 个 TS 文件，约 4.8 万行（工作区当前状态，含未提交改动）
  - 插件仓库 `/Users/haijun/Work/frontend/eNest_plugin`：16 个插件约 1.6 万行可评审代码（vendor 压缩库、dist、schema JSON 已排除）+ 工程脚本与文档
- **评审重点**（用户指定）: 事件驱动、代码分层、if-else 使用、模块间冗余、注释与文档充分性（半年后可读性）
- **规则集**: 前端 16 条 + Electron 事件驱动与分层专项（E1 监听器泄漏 / E2 IPC 契约 / E3 异步时序 / E4 错误传播 / L1-L3 分层与约定）
- **执行说明**: 10 个子代理同批并行启动，其中 4 个因账户速率限制分两批补跑，全部完成。

---

## 📊 总览统计

| 模块 | 🔴 严重 | 🟡 重要 | 🟢 轻微 | 合计 |
|------|---------|---------|---------|------|
| 主进程·插件体系 | 1 | 9 | 6 | 16 |
| 主进程·数据与连接层 | 1 | 7 | 6 | 14 |
| 主进程·服务杂项 | 2 | 9 | 8 | 19 |
| 桥接层（preload+shared+IPC） | 2 | 7 | 8 | 17 |
| 渲染层·状态与服务 | 0 | 10 | 7 | 17 |
| 渲染层·页面与组件 | 1 | 9 | 7 | 17 |
| 插件·database | 1 | 9 | 5 | 15 |
| 插件·ssh | 2 | 10 | 5 | 17 |
| 插件仓库·小插件横切 | 1 | 10 | 7 | 18 |
| 跨仓库冗余与文档专项 | 2 | 5 | 5 | 12 |
| **合计** | **13** | **85** | **64** | **162** |

---

## 🔴 13 个严重问题（按修复紧迫度排序）

### 运行时必炸类（3 个，均可实测复现）

1. **`new Electron.ClipboardItem` 主进程运行时抛 `ReferenceError`**
   - 文件: `src/main/ipc/pluginHandlers.ts:685`、`src/main/clipboard/clipboardHistory.ts:39`、`src/main/clipboard/nativeClipboard.ts:128`
   - 问题: `Electron` 仅是类型命名空间（electron.d.ts ambient declaration），主进程运行时无此全局变量（已用项目 Electron 44.4.3 二进制实测 `typeof Electron === 'undefined'`）。插件每次调用 `clipboard.writeImage` 都会进 catch 返回 "Electron is not defined"；剪贴板历史图片回写同样失效。
   - 建议: 改为 `import { ClipboardItem } from 'electron'`（实测 `require('electron').ClipboardItem` 可用），三处统一替换；补一条 Electron 下跑的 smoke 用例。

2. **save-requested 的 ack 在主进程被静默丢弃，一键保存恒走约 4.7s 超时**
   - 文件: `src/main/ipc/pluginHandlers.ts:1469-1478`（断链点）；`src/preload/pluginPreload.ts:1638-1664`（发送端）
   - 问题: preload 对 `save.requested` 的 ack 经 `plugin:lifecycle-ack` 发回，但主进程 handler 只路由 `beforeClose | beforeSuspend`，`save-requested` 落入空 return。`requestSaveAll` 等不到匹配 ack——即使插件已成功持久化，每个运行中插件仍固定等满超时，`PluginSaveSummary.acked` 恒为超时计数。**这是本次未提交 save-all 新功能的自有断链。**
   - 建议: 条件中加入 `payload?.event === 'save-requested'`；handler 注释写明三类 ack 事件枚举（该注释缺失正是断链未被发现的原因）。

3. **PluginEvent 分发器漏 4 类事件，中间件 tail 与插件 WebSocket 回调永不触发**
   - 文件: `src/preload/pluginPreload.ts:1566-1666`（分发器 if-else 链）
   - 问题: 主进程确实发送 `{type:'mw.data'|'mw.error'}`（mwSessionManager.ts:133-135）与 `{type:'net.websocket.message'|'net.websocket.close'}`（websocketService.ts:34,89），类型已定义、preload API 也在订阅——但分发器没有任何分支 emit 这 4 个 type。订阅与发送两端都存在、中间分发缺失。
   - 建议: 补 4 个分支；顺手把分发器改为 `switch (payload.type)` + exhaustive `never` 检查，让 TS 在新增事件类型时强制补分支。

### 设置/升级链路失效类（3 个）

4. **硬件加速开关在 SQLite 模式下必然失效**
   - 文件: `src/main/hardwareAcceleration.ts:20-33`、`src/main/settings/SettingsStore.ts:94-105`
   - 问题: 仍从 `~/.eNest/settings.json` 读 `general.hardwareAcceleration`，但设置已迁移入 `{dataRoot}/data/enest.db`，该文件被降级为只含 dataRoot 的锚点——正常路径下读到的恒为默认值 `true`，用户关闭硬件加速的设置重启即失效。
   - 建议: 先读锚点取 dataRoot，再用 `node:sqlite` `DatabaseSync(path, {readOnly:true})` 同步读 settings 行；或退出时把该标志冗余写回锚点。

5. **DSH runtime 健康检查是空操作，激活失败回退机制不触发**
   - 文件: `src/main/dsh/dshUpgradeService.ts:187-205`
   - 问题: `healthCheck` spawn `process.execPath` 带 `['--version']`，从未传入 dsh 的 bin.js（对比 dshRuntimeService.ts:171-191 的 `runVersion` 是 `[...cmd.args, '--version']`）。任何版本退出码都是 0，损坏 runtime 会被激活，`activateRuntimeVersion` 失败回退与一键升级回滚链形同虚设。
   - 建议: 改为 `spawn(process.execPath, [bin, '--version'], {env: childEnv(dshHome)})`，可直接复用 `dshCommand(resolved)`。

6. **设置页「安装更新」绕过插件脏数据保存流程**
   - 文件: `src/renderer/pages/SettingsPage.tsx:468-471、788-792`
   - 问题: `handleInstallUpdate` 只做 `void shellApi.installUpdate()`，而同批新增的 `UpdateDialog.tsx:124-153` 专门建立了「检测脏数据 → saveAllPlugins → 超时提示 → installUpdate」流程。设置页在 `status === 'downloaded'` 时两条路径并存，点快捷按钮会跳过保存直接退出应用，丢失插件未落盘数据。
   - 建议: 抽 `savePluginsThenInstall()` 共用，或删除直连按钮改为 `openUpdateDialog()` 引导进弹框。

### 插件侧交互/安全类（4 个）

7. **database 插件 XSS：树节点 key 未转义进 HTML 属性**
   - 文件: `plugins/com.enest.database/assets/js/schemaTree.js:568`（key 构造）、`:377-378`（`data-toggle/data-key` 拼接）
   - 问题: key 含宿主返回的表名/列名，未经 `esc()` 插入属性。连到不可信数据库时，名为 `x" onmouseover="alert(1)` 的表可在树上执行脚本；插件页面持有 `window.enest`（可静默 db.execute），XSS 后果是任意 SQL。全文件其余位置均正确转义，唯 key 路径遗漏。
   - 建议: 渲染处 `data-key="${esc(key)}"`，或用 `encodeURIComponent(key)`；index.html 补 CSP meta 作纵深防御。

8. **ssh 插件非 active 会话的终端输出永久丢失**
   - 文件: `plugins/com.enest.ssh/assets/js/app.js:1515-1527、1167-1188`
   - 问题: 后台会话输出只追加进 `s.buffer` 不写 xterm；`mountActiveTerminal` 仅首次创建时回放 buffer，切回 Tab 走 else 分支只重挂 DOM。切走期间的全部输出（编译日志、报错）在可视终端丢失。多会话并行必现。
   - 建议: 每 session 记录 `termWritten` 游标，切回时增量回放 `s.buffer.slice(s.termWritten)`。

9. **ssh 插件无 sid 的 `ssh.error` 广播进所有会话终端**
   - 文件: `plugins/com.enest.ssh/assets/js/app.js:1548-1560`
   - 问题: `if (!sid || s.sessionId === sid)`——宿主推送全局错误时每个会话都被写入同一条错误并设置 `s.error`，用户以为所有主机故障，典型串台。
   - 建议: 无 sid 时不遍历 sessions，仅 toast 全局错误；保留 sid 精确匹配分支。

10. **password-kit 复制的密码明文流入宿主持久化剪贴板历史**
    - 文件: `plugins/com.enest.password-kit/assets/js/main.js:9-16、127-173`；机制根源 `plugins/com.enest.clipboard/assets/js/main.js:29-49`
    - 问题: 宿主剪贴板历史自动捕获系统剪贴板变化并持久化。密码工具箱复制的每个密码在「粘贴板」插件中明文可见、跨会话留存，插件自身「历史仅会话内存」的设计被下游抵消。
    - 建议: ① 复制后 15-30s 延迟自动覆盖剪贴板（可开关）；② 与壳子约定 `clipboard.writeText(text, {excludeFromHistory: true})` 豁免通道；③ 至少 UI 明示风险。

### 跨仓库契约漂移类（2 个）

11. **权限枚举三处定义漂移：代码 47 项 / schema 28 项 / 文档写 21 项**
    - 文件: 壳子 `src/shared/types/plugin.ts:56`（47）vs 插件仓 `docs/plugin-manifest.schema.json`（28）vs `docs/manifest.md:35`、`README.md:76`（21）
    - 问题: 代码独有的 19 项含 `mw.*`/`dsh.*`/`fs.*`/`sys.*` 核心权限——依赖离线 schema 校验的构建/CI 链会拒绝 ssh/database/mw 等合法插件。schema 本应由插件仓脚本生成，生成链路没跑或没提交。
    - 建议: 立即重跑生成脚本并提交；CI 加一致性断言（代码 vs schema vs 文档计数）。另注意 `eNest/eNest_plugin/` 磁盘上存在嵌套旧副本（已 gitignore），易改错仓库。

12. **tips 组件双份维护且已行为分叉**
    - 文件: `plugins/com.enest.ssh/assets/js/tips-global.js`（161 行）vs `plugins/com.enest.database/assets/js/tips.js`（175 行），同构约 90%
    - 问题: database 版 143-148 行有「modal-mask 弹出时隐藏残留 tip」修复，ssh 版没有——ssh 插件保留该 bug。
    - 建议: 先把该修复同步回 ssh 止血（10 分钟）；正式方案是插件仓 `packages/plugin-kit` 共享（选择器差异需参数化）。

### 数据链路类（1 个）

13. **socketSend 启发式猜测编码，普通文本被静默 base64 解码成乱码**
    - 文件: `src/main/net/socketBridge.ts:539-545`
    - 问题: `data.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/` 命中即按 base64 解码。`PING`/`USER`/`HELO` 这类 4 字节文本协议命令会被解码为不可逆二进制垃圾发给服务器且无报错。同模块 `websocketSend` 已用显式 `binary` 参数，两套 API 不一致。
    - 建议: `socketSend` 增加显式 `encoding` 参数对齐 websocketSend 契约，猜测逻辑仅作兼容回退并记 warn。

---

## 🎯 六大关注点 · 结论

### ① 事件驱动：骨架好，断链集中在「新增功能没接全」

两处 🔴（save-ack 断链、事件分发器漏分支）都是近期新功能的集成缺口。存量问题是清理纪律不均：

- 壳子渲染层 35 个组件监听器卫生「极佳」（window/document 事件、Observer、GSAP context、定时器均成对释放，子代理逐个抽查确认）；
- 但主进程侧：kafka 查询定时器 `.finally(() => clearTimeout(undefined))` 是无效调用（kafka.ts:139-162）；PluginHost `teardownView` 失败路径不清 `retiringViews`，webContents 挂死时插件永久无法重开（PluginHost.ts:1594-1612）；
- 插件侧：ssh `initTheme` 每次主题切换累积订阅（api.js:473-501）；14 个小插件仅 translate 有 beforeunload 清理，timestamp/sticky-notes 的 interval 隐藏后空转；
- 异步时序：zustand「await 后重读 state」版本守卫在 theme/font 做得一致，但 `removeCustomFont`（useFont.ts:595-636）用旧快照落盘、`refreshPacks`（useTheme.ts:245-256）无版本守卫两处漏防；database 并发查询无 token 防护（store.js:42 预留 `lastExecuteToken` 从未接线）；ssh `connecting` 态可重复连接泄漏宿主会话（app.js:1345）。

### ② 代码分层：整体优秀，违例集中在三个点

AGENTS.md 约定抽查 5/6 与代码一致（`@` 别名全仓零 `../../../`、IPC 通道 100% 集中在 `@shared/types/ipc` 且无硬编码字符串、TITLEBAR_HEIGHT=36 与 CSS 一致）。多个「疑似冗余」核实后是有文件头注释自证的合理架构同构。真正违例：

- `pluginPreload.ts`（1603 行）60% 篇幅是应下沉 `@shared/types/plugin-api.ts` 的 SDK 类型，违反「preload 只做 contextBridge 暴露」；
- `pluginHandlers.ts` 的约 900 行 `dispatch` 巨型 switch 混入应下沉服务层的完整业务实现（如 `net.fetch` 单 case 125 行）；
- 主进程硬编码 `com.enest.dsh` 插件专属特例（marketClient.ts:117 的 256MB 上限、PluginInstaller.ts:419/422 的 `runtime/` 白名单），违背「不按插件业务改壳子」约定，应移入声明式元数据。

### ③ if-else 使用：策略表覆盖率高，残留几条「三元链重灾区」

权限三档、四中间件 driver 能力矩阵、workbench 判别联合分发都已用查表/策略模式，避免了深嵌套——这是亮点。残留问题：

- `pluginHandlers.ts:1389-1401` 权限解析 5 层嵌套三元、`PluginHost.ts:472` 的 tab status 是 120+ 字符三元链；
- `completion.ts` 的 `buildCompletion`（约 380 行）8 个 else-if 上下文分支 + 闭包；
- `SettingsPage.tsx` `renderValue` 六种控件分支内联在 JSX IIFE（811-937 约 120 行、条件嵌套 5 层）；
- database 插件 `collectCatalogItems` 约 155 行 5 分支。
- 建议：策略表 `PERMISSION_RESOLVERS`、`resolveTabStatus()` 卫语句、按上下文拆建议函数、SettingsPage 拆卡片组件。

### ④ 模块间冗余：整体可控，需要治理的是三处

核实结论（详见第十节专项报告 A 表）：

- **合理、不需要合并**：middleware 四 driver（<10% 重复，协议适配主体不同）、两个 preload（不同 trust domain 的安全模型差异）、五个 workbench 类型（刻意同构的契约层，文件头自证）、sshFiles vs localFiles（层次清晰）。
- **要治理 (a) SQL 补全双份维护**：壳子 `completion.ts` 与插件 `completion.js/tokenizer.js` 约 55-60% 逻辑重复且方言词表已分叉（TDengine 词表两边不一致），是最大单点（~900 行重叠域）。方案：插件回退词表改读宿主 `db.dialects.list()` 缓存；`fuzzyMatch` 等纯函数两仓镜像处加同步标记。
- **要治理 (b) 权限枚举三处定义**（见 🔴11）。
- **要治理 (c) 散件**：tips 90% 同构已漂移；`escape/escapeHtml` 在插件仓 6 份相同实现（正是 XSS 遗漏的温床）；小插件初始化样板约 15%（api 引导 15 份、toast 13 份、isPerm 12 份）。结论：**不抽运行时公共 JS**——`.enestplugin` 独立打包自包含是硬约束，改为三步：壳子统一 `__enest_theme.css` 注入删 10 份内联兜底、新增 `scripts/new-plugin.mjs` 脚手架、文档把约定写成规范。

### ⑤ 注释与文档：壳子显著好于插件仓库，一个文件「半年后看不懂」级

- 壳子：PluginHost（注释覆盖 16.1%）、pluginPreload（15.2%）文件头有完整架构注释；docs/site/plugin 三个 API 文档抽查**全部与代码同步**（含刚改的 lifecycle ack 常量逐字对上）；engineering/ 有 20+ 份验证评审留痕——同类项目罕见。
- 插件仓：`database/main.js` 1775 行、注释率 1.7%、**零分节标记**，全部大文件中唯一「差」评级；ssh `app.js` 靠 25 处分节横幅「一般」；新人按 README 第一步跑 `node scripts/validate-manifests.mjs` 直接 `ERR_MODULE_NOT_FOUND`（ajv 依赖只存在于 CI YAML，仓库无 package.json）。
- 文档缺口 Top5：① 权限枚举对齐（P0）；② completion 双份镜像同步声明；③ database 插件模块结构文档；④ 插件仓 docs/README 索引与宿主 API 参考（目前唯一线索是「去读另一个仓库的 plugin.ts」）；⑤ 新插件 checklist/CONTRIBUTING。

### ⑥ 全面性/半年后可读性

| 层 | 评级 | 说明 |
|----|------|------|
| 主进程·插件体系 | 好 | 文件头职责/被谁调用注释体系是全仓亮点 |
| 主进程·数据与连接层 | 好 | socketBridge 安全清单、dbSessionManager facade 说明尤佳；三个千行文件扣分 |
| 主进程·服务杂项 | 好 | 关键取舍就地说明（seek 时序、BaseWindow 职责） |
| 桥接层 | 好 | 设计意图注释（uTools 对标、SSRF 理由）属上乘；体量扣分 |
| 渲染层·状态与服务 | 好 | 竞态决策都写了「为什么」 |
| 渲染层·页面与组件 | 好偏上 | 债务不在注释在体量（SettingsPage/PluginDetailModal） |
| 插件·database | 一般偏好 | 注释密度上乘但 main.js 体量 + 无类型系统 |
| 插件·ssh | 一般 | app.js 单文件 4095 行 |
| 小插件横切 | 好（个别文件一般） | clipboard/screen-assistant 低注释拉低下限 |

主要债务不在注释而在**体量**：`app.js` 4095、`PluginHost.ts` 1687、`pluginPreload.ts` 1603、`pluginHandlers.ts` 1503、`main.js`(db) 1775、`completion.ts` 1009、`SettingsPage.tsx` 941——每个模块的子代理报告都给出了具体拆分方案（按职责切块、每块管什么），可直接照做。

---

## 🛠 修复优先级建议

- **P0（本周）**: 🔴1-3 三个新功能断链（改动小、收益直接）+ 🔴11 权限枚举重跑生成 + 🔴7 XSS + 🔴8/9 ssh 会话问题。
- **P1（本月）**: 🔴 剩余 4 项；五大巨型文件拆分（先 pluginHandlers 与 pluginPreload）；SQL 补全收敛到宿主 `dialects.list()` 单源；i18n 壳子级收口（23 个死 key + 硬编码中文 toast）；toastStore 20 处迁移到 notify.*。
- **P2（顺手做）**: 中间件 `driverCommon.ts`；插件仓补 `package.json` + `new-plugin.mjs` 脚手架；`database/main.js` 补分节注释与模块文档；文档缺口清单逐项补齐。

---

## ✅ 跨模块共识的优点

1. **生命周期与并发治理是全仓最强项**：PluginHost 多锁（opening/closing/reloading/retiring/suspending）封死竞态窗口、mw 会话 SIGTERM→250ms SIGKILL 阶梯 + generation 防晚到释放、dbOpen epoch 防旧连接复活、await 后统一 re-check cancelled/barriers 是正确范式。
2. **安全纵深扎实**：SQL 全量参数绑定 + SQLite worker setAuthorizer 白名单；凭据只走 vault secretRef、全链路（内存/日志/导出）无明文；plugin:call 六层校验链（sender 身份→URL 匹配→pluginId 防伪→scope→manifest+三态 grant+OS 权限）；SSRF 逐跳重定向校验、zip-slip/symlink 防护、WS 桥一次性 token + timingSafeEqual。
3. **约定执行力**：`@` 别名零违规、IPC 通道零硬编码、GSAP 全走 `d()/dy()/ease()` 且 low 档/ReducedMotion 双降级、资源配额常量全面导出（8 socket/插件、1MB/s 令牌桶、8MiB ResultBudget 等）。
4. **插件仓亮点**：小插件 XSS 主体防护扎实（textContent/createElement，无一处用户数据直拼 innerHTML）；password-kit 随机性工程规范（rejection sampling 消模偏差）；calculator 手写 tokenizer+递归下降且禁 eval；market-assets 安全校验链有 8 个高质量测试。

---

# 分模块详细报告

以下为 10 个子代理的完整评审输出。

---

## 模块 1: 主进程·插件体系（前端 TypeScript / Electron main）

评审范围：src/main/plugin（30 文件）+ ipc/pluginHandlers.ts + pluginToolsHandlers.ts + hotkey（3）+ contrib + db + settings/PluginSettingsBridge + dev。

### 🔴 严重问题

1. [规则13/运行时必现故障] `new Electron.ClipboardItem(...)` 在主进程运行时抛 `ReferenceError: Electron is not defined`，`clipboard.writeImage` API 必然失效
   - 文件: src/main/ipc/pluginHandlers.ts:685（同根因：src/main/clipboard/clipboardHistory.ts:39、src/main/clipboard/nativeClipboard.ts:128）
   - 问题: `Electron` 作为类型命名空间在 electron.d.ts 中是 ambient declaration，tsc 通过；但主进程运行时没有全局 `Electron` 变量（已用本项目 Electron 44.4.3 二进制实测：`typeof Electron === 'undefined'`，产物 `out/main/index.js` 中原样保留、electron.vite.config.ts 无 define 注入）。插件每次调用 `clipboard.writeImage` 都会进 dispatch 的 catch。
   - 建议: 改为从 import 绑定取构造器：`import { clipboard, ClipboardItem } from 'electron'`，三处统一替换；补 Electron 下 smoke 用例防止回归。

### 🟡 重要建议

1. [规则7/4 巨型文件与方法] pluginHandlers.ts 1538 行、`dispatch()` 约 900 行；PluginHost.ts 1687 行
   - 文件: src/main/ipc/pluginHandlers.ts:452-1354、src/main/plugin/PluginHost.ts
   - 建议: pluginHandlers 按域拆为 pluginIpc/storage.ts、clipboard.ts、net.ts、screen.ts、ssh.ts、db.ts、agentSys.ts，各导出 `Record<method, handler>` 表，dispatch 只做查表+统一权限/跟踪；PluginHost 抽出 PluginQuickContainer（约 300 行）与 PluginResourcePolicy（约 150 行）。
2. [规则2 嵌套过深] 权限解析与 Tab 状态用 5 层三元链
   - 文件: pluginHandlers.ts:1389-1401、PluginHost.ts:472
   - 建议: 改策略表 `PERMISSION_RESOLVERS` 按序首个命中；status 抽 `resolveTabStatus(id)` 卫语句。
3. [L3 约定落实] 主进程硬编码 `com.enest.dsh` 插件专属特例
   - 文件: marketClient.ts:117、PluginInstaller.ts:419、:422
   - 问题: 下载体积上限（256MB）与发布包目录白名单（runtime/）按插件 id 写死在宿主。
   - 建议: 移入声明式元数据（registry.json 的 asset.sizeClass / manifest 的 packageExtras）。
4. [规则9 重复代码] 「对象形参/位置形参双兼容」归一样板重复 15+ 次；picker 注册/释放样板整段复制
   - 文件: pluginHandlers.ts:1181-1280（ssh.* 族）、822-889（agent 族）；localFiles.ts:112-140 与 143-172
   - 建议: 扩展 argStr/argNum 为 `pick(args, {key, pos})` 助手；localFiles 抽 `withPicker(pluginId, fn)` 高阶函数。
5. [规则11 输入验证] `settings.set` 对 value 无大小限制
   - 文件: pluginHandlers.ts:604-617、SettingsStore.ts:341-348
   - 问题: key 有白名单但 value 原样落盘；storage.local 有 512KiB/键上限，settings 通道没有，行为不对称。
   - 建议: 复用 serializeJson + MAX_VALUE_BYTES（如 64KiB）校验，超限抛 quota 错误。
6. [规则14 性能] `setPluginStorageValue` 每次写都全量 `SELECT key` 计数
   - 文件: db/pluginStorage.ts:251
   - 建议: 改 `SELECT COUNT(*)` 或维护计数缓存。
7. [规则14 性能] settings.get/set 热路径反复全表扫描 + JSON.parse
   - 文件: pluginHandlers.ts:441-450、PluginSettingsBridge.ts:93-103
   - 建议: ContributionRegistry 增加 listKeysBySource 轻量查询或缓存。
8. [E1 状态残留] `teardownView` 失败路径不清理 `retiringViews`，插件可能永久无法重开
   - 文件: PluginHost.ts:1594-1612
   - 问题: `retiringViews.delete` 只在 done 里执行；300ms 超时 reject 与 catch 分支都不删除。
   - 建议: 超时与 catch 分支同样 delete（保留 once('destroyed') 兜底幂等）。
9. [规则13 持久化健壮性] `disabled.json` 非原子写，损坏即禁用状态全部静默丢失
   - 文件: pluginEnabledStore.ts:47-51
   - 建议: 复用 devPluginsStore 的 tmp+rename 模式（抽公共 writeJsonAtomic）。

### 🟢 轻微建议

1. [规则8] 无引用导出：pluginProtocol.ts:281 `fileUrlFor`、mockMarket.ts:277 `shortNameOf`；PluginHost.ts:231-238 `enforceAliveLimit()` 重复调用。
2. [规则15] 基础层绕过 logService 直写 console：PluginSessionStore.ts:88/107/115、pluginStorage.ts、sqliteService.ts:52、OsPermissionChecks.ts:55。
3. [规则15] 校验阈值与文案不一致：pluginFiles.ts:85（96MB 判定、文案写 64MB）。
4. [规则14] 每次快照保存都 `CREATE TABLE IF NOT EXISTS`：PluginSessionStore.ts:84/113，改 ensureInit 一次性建表。
5. [规则6] 输入上下文白名单字面量与共享类型双维护：PluginHost.ts:246，改用 shared 导出的 PLUGIN_INPUT_CONTEXTS。
6. [规则11] `contribute.registerQuickProvider` 的 id 无长度/数量上限：pluginHandlers.ts:1105-1116。

### 📝 可读性与文档评估

- 半年后可读性: 好——PluginHost/Registry/Installer 文件头「职责/被谁调用/关键依赖」注释体系是全仓亮点，生命周期有独立状态机模块；扣分项是 900 行 switch 和 PluginRegistry.get() 五源合并。
- 注释缺口 Top3: ① PluginRegistry.get()/list() 五源合并优先级无决策注释；② closePlugin 的时序语义散在行间；③ dispatch 各 case 的双兼容契约无注释。
- 文档建议: 容器迁移与 save.requested ack 流程补进 lifecycle.md。

### ✅ 优点

1. 生命周期工程质量高：状态机独立纯函数模块可单测，多把并发锁系统性封死竞态。
2. 权限模型统一且纵深：METHOD_PERMISSION 单表 + pluginPermissionPolicy 二分 + PermissionService 原生弹窗仲裁，无散落 if(permission) 旁路。
3. 资源防御体系完整：RuntimeScope disposer 链 + 休眠快照 + LRU + 各处配额 + zip-slip/symlink/SSRF 校验。

### 统计: 🔴 1 🟡 9 🟢 6

---

## 模块 2: 主进程·数据与连接层（前端 TypeScript / Electron main）

评审范围：src/main/database（25 文件）、ssh（8）、net（6），共 7703 行逐文件完整读取。

### 🔴 严重问题

1. [规则11/E4] `socketSend` 用启发式猜测编码，普通文本被静默 base64 解码（详见总报告 🔴13）
   - 文件: src/main/net/socketBridge.ts:539-545
   - 建议: 增加显式 encoding 参数对齐 websocketSend 契约，猜测逻辑仅作兼容回退并记 warn。

### 🟡 重要建议

1. [E3/E4] `socketServeWs` 监听失败不清理 wsBridge，后续复用死桥返回无效 URL
   - 文件: socketBridge.ts:860-869、766-775
   - 建议: listen Promise 加 catch，失败时 closeWsBridge 并置 undefined 后 rethrow。
2. [规则7] sshSessionManager.ts 1142 行、5 类职责、sshConnect 约 150 行
   - 建议: 拆 sshConnection.ts / sshExecMetrics.ts / sshSftp.ts / sshCompletion.ts。
3. [规则7/4] completion.ts 1009 行、buildCompletion 约 380 行
   - 建议: 拆 sqlLexer.ts / virtualTables.ts / completionContext.ts / completionBuild.ts；按上下文拆建议函数策略表。
4. [规则7] socketBridge.ts 886 行，RDCleanPath/DER 协议应独立
   - 建议: 抽 rdpCleanPath.ts，文件头标注 vendored 代码范围。
5. [规则14] SQLite completionCatalog 每表 4 次串行 PRAGMA，300 表 ≈ 1200 次 worker IPC 往返
   - 文件: sqliteRuntime.ts:107-111
   - 建议: 改 table-valued pragma 批量查询或 Promise.all 分批并发。
6. [规则8/9] `adapterBase.test` 被 drivers.ts 注册表初始化整体覆盖，死代码且双份实现
   - 文件: adapterUtils.ts:25-30、drivers.ts:115-124
   - 建议: 只留一份。
7. [规则13/E4] dbService 顶层把 logInfo/logWarn 定义成空函数，工具进程内日志静默
   - 文件: dbService.ts:47-48、135、391
   - 建议: 接 console 转发或 postMessage 透传诊断事件。

### 🟢 轻微建议

1. [规则8] 未使用导入：dbService.ts:33/38-39、sshSessionManager.ts:14/17。
2. [规则8] lanShareService.ts:70 `detached` 声明后从未赋值。
3. [规则15] dbService.ts:1-2 Host 前缀别名导入造成双名。
4. [规则15] sshTrust.ts:20-21 `host` 实参是 host:port 组合串，应更名 hostPort。
5. [规则6] dbService.ts:264 dbCancel 硬编码驱动名单，与声明式目录并行，应加 cancelByClose 标志。
6. [规则5] dbService.ts:93-104 dbOpen 双形态参数运行时探测，应在边界归一化。

### 📝 可读性与文档评估

- 半年后可读性: 好。文件头职责/安全设计注释尤佳，命名约定统一（requireOwnedXxx），测试覆盖策略层+真实驱动集成层；三个千行文件扣分。
- 注释缺口 Top3: ① ownedStep/epoch/snapshot 对账等并发防御逻辑缺「为什么」与时序图；② completion.ts:207 原文二次执行的偏移等价性假设无注释（全文件最脆弱点）；③ socketBridge RDP 模式状态机缺状态流转说明。
- 文档建议: 增补「数据与连接层架构」一页（utility 进程生命周期、会话所有权模型、插件事件清单）。

### ✅ 优点

- 并发与会话治理扎实：会话 Map 增删配对、epoch 防旧连接复活、retiringReleases 保证引用时序。
- SQL 注入防护系统化：quoteIdentifier + 参数绑定 + sqlTokens 中和 + setAuthorizer 白名单 + 阻断可执行注释，且有针对性测试。
- 凭据处理干净：密码仅内存与 MessagePort 传递，日志零泄露。
- 资源配额全面有界；网络统一走 hostProxy 兼容 proxyService；WS 桥 token+origin 双校验；TOFU 指纹校验。
- 分层零违规：无 React 引用、全别名导入（grep 验证）。

### 统计: 🔴 1 🟡 7 🟢 6

---

## 模块 3: 主进程·服务杂项（前端 TypeScript / Electron main）

评审范围：middleware（11）、dsh（5）、clipboard、launcher（10）、window、theme、settings、config、paths、sys、pin、logs、vault、timer、screen、proxy、update 等约 40+ 文件。

### 🔴 严重问题

1. [规则11/配置失效] 硬件加速开关 SQLite 模式下必然失效（详见总报告 🔴4）
   - 文件: src/main/hardwareAcceleration.ts:20-33、SettingsStore.ts:94-105
2. [规则13/安全兜底失效] DSH runtime 健康检查是空操作（详见总报告 🔴5）
   - 文件: src/main/dsh/dshUpgradeService.ts:187-205

### 🟡 重要建议

1. [规则13/E1] kafka 查询消费者定时器清理失效：`.finally(() => clearTimeout(undefined))` 无效调用，每次查询留下最长 20s 空转定时器
   - 文件: kafka.ts:139-162
2. [规则12] 三个 HTTP 驱动硬编码 `insecureTls: true`，Basic 凭据经未校验 TLS 传输（rabbitmq.ts:56-58、rocketmq.ts:65-73、mqtt.ts:103/130-132）。与 kafka 的 tlsRejectUnauthorized 配置对齐。
3. [规则9/3] 四中间件驱动结构性重复：payloadType 判定三处逐字重复、max 钳制三处重复、每驱动约 10 个 unsupported 桩（合计 ~120 行）。新建 drivers/driverCommon.ts：detectPayloadType()/clampMax()/baseDriver(kind)，预计每驱动减 60-100 行。
4. [规则12] 剪贴板历史明文持久化所有复制内容（clipboardHistory.ts:107/125-141/191-207）。至少设置页明示，可选 safeStorage 加密。
5. [规则12] agentRead 将 codex auth.json（tokens/OPENAI_API_KEY）全文回传插件（agentConfigService.ts:96-97/477-492）。默认脱敏，需原文时单独确认。
6. [规则14] dsh 备份/恢复全同步 IO 跑主进程，数百 MB cpSync/rmSync/readFileSync 阻塞事件循环（dshProfileService.ts:102-141/216-275、dshUpgradeService.ts:133）。改 fs.promises 或移入 utility process。
7. [网络约定] 代理 env 兼容缺口：applyEnv 把 Chromium 规则串写入 HTTP_PROXY（undici 解析失败）；dshUpgradeService 全局 fetch 不读 env 可能绕过代理（proxyService.ts:93-111、dshUpgradeService.ts:58-141）。env 单独序列化单一 URL；GitHub 请求改 net.fetch 或 ProxyAgent。
8. [规则4] 超长方法：commandIndex.ts:320-411（6 参数 ~90 行）、agentConfigService.ts:220-351（~130 行）、dshRuntimeService.ts:260-348（~88 行）。
9. [规则7] 大文件拆分：agentConfigService(1013)/screenService(665)/clipboardHistory(540)/dshRuntimeService(559)，按正交职责拆。

### 🟢 轻微建议

1. [规则8] rocketmq.ts:124 tsToMs 两分支相同的恒等表达式；agentConfigService.ts:426 恒为死条件的正则过滤。
2. [规则15] mqtt.ts:116 错误文案「v5/v5」应为「v5/v4」。
3. [规则8] mqtt.ts:353 no-op 替换，异常时间串会得 Invalid Date。
4. [规则15] clipboardHistory.ts:41-49 import 位置应在文件顶部。
5. [规则10/12] httpRequest.ts:53-58 重定向时 basicAuth 转发到跨主机 Location，应剥离 Authorization。
6. [规则14] logService.ts:120-125 logsDir 惰性缓存不随 dataRoot 变更刷新。
7. [规则6] dsh/workbench.ts 大量 `as { input: … }` 断言绕过判别联合，应用 Extract 收窄。
8. [规则14] windowsScanner.ts:21-26 Start Menu Programs 根重复扫描两遍。

### 📝 可读性与文档评估

- 半年后可读性: 好——几乎每文件有职责/设计决策/被谁调用的头注释，关键取舍就地说明。
- 注释缺口 Top3: ① MwCapability 三态语义未在契约层定义；② dshWorkbench 三档权限缺 action→权限汇总表；③ focusTimer「先转移状态再持久化」时序约束应固化到模块头。
- 文档建议: 补「中间件驱动开发指南」一页。

### ✅ 优点

- 进程生命周期管理极严谨：kill 阶梯、generation 防晚到释放、端口冲突换口重启、Worker 预算。
- 声明式能力矩阵 + 策略表，避免了深嵌套。
- 安全边界意识强：token 白名单、safeStorage 校验、路径白名单、senderFrame 校验。
- 约定遵守度高：src/main 零 React、@别名 100%、通道全取自 shared、TITLEBAR 一致。

### 统计: 🔴 2 🟡 9 🟢 8

---

## 模块 4: 桥接层（preload + shared + IPC 入口）（前端 TypeScript）

评审范围：src/preload（5）、src/shared（25）、main/index.ts、ipc/{channels,ipcSecurity,quickHandlers,shellHandlers}。

### 🔴 严重问题

1. [E2/E4] save-requested 的 ack 在主进程被静默丢弃（详见总报告 🔴2）
   - 文件: pluginHandlers.ts:1469-1478；pluginPreload.ts:1638-1664
2. [E2 孤儿事件] PluginEvent 分发器漏 mw.data/mw.error/net.websocket.message/net.websocket.close 四类事件（详见总报告 🔴3）
   - 文件: pluginPreload.ts:1566-1666

### 🟡 重要建议

1. [规则8/11] PermissionResponse 废弃通道四件套全链路保留且注释与实现矛盾（ipc.ts:163-164/244-251/471-475、shellPreload.ts:477-484、pluginHandlers.ts:1483-1499）。删干净或恢复语义。
2. [规则7/L1] pluginPreload.ts 1672 行违反「preload 只做暴露」，60% 是应下沉 shared 的 SDK 类型。三步拆分：类型下沉 @shared/types/plugin-api.ts → 分发器抽 pluginEventDispatch.ts → api 按域拆 src/preload/api/{net,ssh,db,...}.ts，主文件目标 <150 行。
3. [规则9] shellPreload 与 renderer shellApi/mockData 三方手抄同一批接口（ShellThemeResult/PickFileOptions 等），mock 契约靠人工对齐。提升到 @shared/types/shell-api.ts。
4. [规则4] 三个超长函数：dispatch 约 900 行、registerShellHandlers 537 行、分发器 100 行 20+ 分支。按域拆文件、handler 独立导出。
5. [规则9] plugin:call 请求形状校验连续执行两遍（pluginHandlers.ts:1387 与 1396，第二处永不触发的复制粘贴遗留）；两个 preload 各自维护 ok 解包。删重复；抽 src/preload/lib/unwrap.ts。
6. [规则6] Orb 状态 tabs: unknown[] 弱化（shellPreload.ts:136-153）；quickInput 三态返回无注释（:279）。
7. [E3] ensureAppDirs 在 ready 流程内重复调用（main/index.ts:188 与 199）。删除或注释理由（装配顺序本身验证无竞态）。

### 🟢 轻微建议

1. [规则8] channels.ts 全文件无引用（grep 验证），删除或强制唯一引用点。
2. [规则8] MwPluginEvent/DshPluginEvent 导出未用，mw 事件形状定义两遍（ipc.ts:397-398 与 429-434）。
3. [规则16] ipcMain 导入未使用 ×2（quickHandlers.ts:9、shellHandlers.ts:14）；孤儿注释（pluginPreload.ts:76-77）。
4. [规则15] 事件 type 点分 vs 连字符双风格并存，约定写入 ipc.ts 头注释。
5. [规则3] dsh.onDshEvent 绕过统一订阅模式直接操作 listeners Map（pluginPreload.ts:1467-1474）。
6. [规则6] saveAllPlugins 的 reason 硬编码 'update'（shellHandlers.ts:642）。
7. [规则14] settings.set 每次全表扫描注册键（pluginHandlers.ts:451-460）。
8. [规则1] PluginLifecycleAck handler 未说明 event 枚举（正是 🔴 断链点）。

### 📝 可读性与文档评估

- 半年后可读性: 好。注释密度与设计意图说明在同类代码库属上乘。
- 注释缺口 Top3: ① lifecycle-ack 的 event 枚举契约；② EnestPluginApi 缺命名空间地图总览；③ 约 1/3 通道无语义注释。
- 文档建议: docs/site/plugin 增加 plugin-api-events.md（type → 消费 API → 发送方三列表，可 CI 生成），孤儿事件即无所遁形。

### ✅ 优点

1. 通道集中性满分：IpcChannels 100% 定义于 shared，无硬编码字符串。
2. 别名纪律满分：无跨目录相对导入，shared 零运行时依赖。
3. plugin:call 六层校验链完整，最小权限面落地扎实。
4. ipcSecurity 的 surface 机制 fail-closed。
5. ack 配对常量两端同步约定清晰；emitAndCollectPromises + allSettled + ackOnce 幂等。
6. contextBridge 暴露面收敛：错误信封、SSRF 逐跳校验、vault 无明文 get、调用跟踪不记 args。

### 统计: 🔴 2 🟡 7 🟢 8

---

## 模块 5: 渲染层·状态与服务（前端 TypeScript / React）

评审范围：stores（2）、services（3）、hooks（10）、gsap（4）、i18n（3）、layout（4）、orb-overlay、main/App，约 5900 行。

### 🔴 严重问题

无。（E1 监听器泄漏与 GSAP 清理经逐文件核查基本干净。）

### 🟡 重要建议

1. [规则13/E4] useTheme 持久化失败策略不一致：四种策略并存（await 无 catch / void 未捕获 / 完全静默），设置「看似生效重启即丢」无感知。统一 persistThemeSafe() helper。
2. [E3] removeCustomFont 先快照 state 再 await，落盘用旧快照（useFont.ts:595-636）。await 后重取 get()。
3. [规则8/9+L3] i18n 双轨割裂：23 个 key 零引用，而 shellStore/useShellEvents/useTheme 硬编码语义相同的中文 toast——en-US 用户仍看到中文。把壳子级 toast 接入 t() 或删死键。
4. [规则7/9] shellApi.ts 897 行：createMockApi 单函数约 540 行、合并段 15+ 处重复样板。按域拆 mock + 泛型 prefer helper。
5. [规则7] useFont.ts 679 行拆 presets.ts / fontFaceFs.ts / store.ts / index.ts，导入路径不变。
6. [规则9] marketMotion 弹框动画两套近重复（playModalIn/Out vs playUpdateDialogIn/Out）。参数化为 playDialogMotion(root, {prefix, parts})。
7. [规则9/8] icons.paths 声称共享但 icons.tsx 仍手写同批路径，6/9 条目零引用。改单一来源或删。
8. [规则10] notify.custom 的 html 通道是无消毒 dangerouslySetInnerHTML（notifyService.ts:27-31/133-137）。加 sanitize 或降级为 ReactNode。
9. [规则14] refreshPacks 缺少版本守卫（useTheme.ts:245-256），与 refresh 的防护不一致。
10. [规则4] createMockApi 返回对象字面量约 540 行，按域拆工厂函数。

### 🟢 轻微建议

1. [规则3/15] 8 个 zustand store 分居两处（stores/ 与 hook 文件内），统一迁 stores/。
2. [规则16] shellApi.ts:478 两条实现挤一行的格式粘连（未提交改动引入）。
3. [规则1] useFont.ts:166-173 JSDoc 重复两遍。
4. [规则6] mockData.ts:185-189 本地重复定义 TabStyle/AnimationLevel，应 re-export shared。
5. [规则5] `t-${pluginId}` 约定散落硬编码 4 处，抽 tabIdOf()。
6. [规则1] shellStore.ts:311 依赖旧 activeTabId 的微妙时序，补注释。
7. [规则8] respondPermissionRequest 自注 Legacy 且无调用方，确认后删除。

### 📝 可读性与文档评估

- 半年后可读性: 好。关键竞态决策都写了「为什么」。
- 注释缺口 Top3: ① shellStore 会话持久化的模块级可变状态组缺状态机说明；② useProductCarousel 镜像滚动物理/逻辑索引模型；③ shellApi 合并段缺策略注释。
- 文档建议: 补「渲染层三 store 水合顺序图」。

### ✅ 优点

- E1 清理纪律出色：ambientFlow 9 监听+2 Observer 对称移除、splashMotion gsap.context+revert、import.meta.hot.dispose 等。
- E3 版本守卫模式统一（font/theme/animation 三处写法一致）。
- i18n 结构防漂移（DeepStringify 缺键即编译错误）。
- L3 约定贯彻好：GSAP 全走 d()/dy()/ease()、新代码已用 notify.*、设置先 set 再异步持久化。
- zustand 细粒度 selector、devLogs 截断、pagehide 落盘兜底。

### 统计: 🔴 0 🟡 10 🟢 7

---

## 模块 6: 渲染层·页面与组件（前端 TypeScript / React）

评审范围：pages（4，SettingsPage 941 行）、components（35），逐文件完整读取并对照 marketMotion/notifyService/shellStore 验证。

### 🔴 严重问题

1. [E4/数据一致性] 设置页「安装更新」绕过插件脏数据保存流程（详见总报告 🔴6）
   - 文件: SettingsPage.tsx:468-471、788-792

### 🟡 重要建议

1. [E1] shellApi.onEvent 未判空直接调用，mock/浏览器预览挂载即 TypeError（SettingsPage.tsx:358、InstallProgressPanel.tsx:28）。补守卫。
2. [E4] 多个 async 事件处理器无 catch 且乐观状态不回滚（DevConsoleSection.tsx:76/83-88/108-116、QuickSettingsSection.tsx:44-71）。统一 try/catch + notify + 回滚（SettingsPage.tsx:227-255 已是正确范式）。
3. [L3] 通知新旧 API 大面积混用：23 处 toastStore.getState().push vs notify.*，同一文件内混用。机械替换 + ESLint no-restricted-syntax 阻新增。
4. [规则15/i18n] 快捷启动相关 UI 大面积硬编码中文（SettingsPage:610、PluginDetailModal:100-114/521-635、HotkeyPresetCards:133-163/259-277、QuickSettingsSection:56-96、BackgroundPicker:267-337），英文用户中英混排。
5. [规则9] 热键录制/accelerator 转换两处独立实现且行为已分叉（PluginDetailModal.tsx:40-97 vs HotkeyPresetCards.tsx:8-80）。抽 @renderer/lib/accelerator.ts + useHotkeyRecorder。
6. [规则9] 模态退场/Escape 编排与 update-status 订阅在两个弹窗逐行重复。抽 useModalDismiss / useUpdateState。
7. [规则7/4] SettingsPage 941 行（renderValue 120 行 JSX IIFE 5 层嵌套）、PluginDetailModal 675 行（六类职责）。给出完整拆分方案：settings/ 目录 7 文件 + hooks/useUpdateState + components/ui/{Card,Field,Switch}。
8. [规则8] DevConsolePage.tsx 13 行死页面（全仓无引用），删除或接入路由。
9. [规则11] 插件 manifest 的 color 未过白名单直接拼 CSS linear-gradient（PluginDetailModal.tsx:124-129），绕过了已有的 backgroundColorStyle 沙箱。复用白名单或正则校验。

### 🟢 轻微建议

1. [规则8] BackgroundPicker.tsx:120 colorInputRef 从未读取。
2. [规则16] SettingsPage.tsx:25-26 连续两条同源 import；QuickLauncherApp.tsx:61 行内 import 提升顶部。
3. [规则6/a11y] Switch 无可访问名称。
4. [规则14] DevConsoleSection 以 index 为 key，若截断会错位。
5. [规则10] NotificationHost 的 dangerouslySetInnerHTML 建议加 Brand 类型约束或 DOMPurify 兜底。
6. [规则14] QuickLauncherApp ResizeObserver 回调直接发 IPC，可 rAF 合帧。
7. [规则1] PluginDetailModal 内联 style 散落；ProductVisual 手写英文变量可改 t()。

### 📝 可读性与文档评估

- 半年后可读性: 好偏上。债务不在注释而在体量。
- 注释缺口 Top3: ① renderValue 六种 item.type 分支无总述；② probe/takeover 四态状态机缺说明；③ UpdateDialog handleRestart 关键决策只有一行注释。
- 文档建议: 补「弹窗动效编排约定」与「update-status 事件消费方清单」。

### ✅ 优点

- 监听器卫生极佳：35 个组件抽查全部成对释放。
- 异步竞态防护到位：searchVersion/inputRevision/escapingRef 三套版本号去重。
- GSAP 约定落实：全走 marketMotion，未发现裸写大位移。
- 安全意识：MarkdownView 自研渲染器 + 协议白名单；backgroundColorStyle 函数白名单。
- 状态分层清晰：selector 粒度细腻，UpdateDialog 独立 store 多入口共享。

### 统计: 🔴 1 🟡 9 🟢 7

---

## 模块 7: 插件·com.enest.database（前端 JavaScript / eNest 插件）

评审范围：13 个文件约 6.6k 行逐文件完整读取。

### 🔴 严重问题

1. [规则10 XSS] 树节点 key 未转义进 HTML 属性（详见总报告 🔴7）
   - 文件: schemaTree.js:568、377-378
   - 其余 innerHTML 使用点已逐一核对均正确转义，未发现第二条可利用链。

### 🟡 重要建议

1. [E3] execute() 无请求序号/取消防护，并发查询先完成者覆盖后发起者（main.js:1027-1141）；store.js:42 预留的 lastExecuteToken/activeQuery 从未使用；execute/open 无超时。token 防护 + 超时 + cancelQuery。
2. [规则13/E4] 网格复制单元格的 Promise rejection 捕获不到，失败仍报成功（resultGrid.js:393-398、416-421）。改 await .then/.catch。
3. [规则12] 「测试连接」即写 vault：编辑态点取消仍换掉已保存密码；新建取消留孤儿密钥（main.js:1624-1637、1659-1688、849-861）。测试成功后仅保存时才 Vault.set。
4. [规则4] 超长函数：openConnectionForm 约 300 行、execute 约 115 行、collectCatalogItems 约 155 行。按阶段拆函数。
5. [规则8] renderStatus 指向不存在的 #statusbar，6 处调用空转；一批死导出/死字段（store.js:42-43/47、editor.js:516-524/283-292/455、api.js:9/335、completion.js:523）。
6. [规则9] escape/escapeHtml 同一实现 6 份；方言兜底列表 2 份。收敛单一 html.js + DEFAULT_DIALECTS 常量。
7. [规则3/边界] 运行时 monkeypatch SqlEditor.prototype._renderCompletion 实现补全同步（main.js:255-269）。改 onCompletionSelect 回调。
8. [E1] 组件无 destroy 生命周期；tips 的 cleanup 遗漏 focusin/focusout/scroll/resize 四监听（resultGrid.js:113-117、tips.js:123-165、editor.js）。为三大组件提供 destroy()。
9. [规则7] main.js 1775 行、resultGrid.js 1066 行按职责拆分（给出了保持纯 ES Module 的完整拆分方案：main→boot/chrome/connectionForm/queryService/renderers/tableActions；resultGrid→grid/{render,viewModel,changes,menus}）。

### 🟢 轻微建议

1. [规则15] api.js:7 的 window.zapi 兼容来源未注释；editor.js 空 if 块应删。
2. [规则11] 表单 port 未校验 0-65535；CSV 粘贴无大小上限。
3. [规则10] 补全文档面板 kindMeta 未知 kind 回填原文进 innerHTML（editor.js:420），建议一并 escape。
4. [规则14] warmCatalogFromHost 一次并发 40 个 describe 打满 IPC，建议分批 8；localItems 每击键全量重建可缓存。
5. [规则5/UX] SQL 预览用 window.prompt 不可读；会话满 50 静默淘汰建议 toast 告知。

### 📝 可读性与文档评估

- 半年后可读性: 一般偏好。注释密度上乘，但 main.js 体量 + 无类型系统，回读 boot()/execute() 需上下文重建。
- 注释缺口 Top3: ① 六类核心数据模型无 @typedef（无 TS 补偿下最大缺口）；② 宿主 db.* 契约全靠防御式代码反推；③ 组件构造 opts 回调表（12 个回调）无签名说明。
- 文档建议: 加 model.md 或 JSDoc @typedef 块定义核心对象；main.js 顶部补模块地图。

### ✅ 优点

- 宿主滞后降级体系完整一致（HOST_LAG/NO_API/PERM + 300ms 超时回退 + 四路方法名尝试）。
- 密钥纪律：密码只经 secretRef，导出主动剔除。
- 性能意识：虚拟滚动 + 分页 + maxRows 截断 + 200KB perfMode 降级。
- 持久化健壮：防抖 + 三路幂等 flush + 损坏自愈。
- tokenizer 手写分词器零依赖完整覆盖；危险 SQL 二次确认。

### 统计: 🔴 1 🟡 9 🟢 5

---

## 模块 8: 插件·com.enest.ssh（前端 JavaScript / eNest 插件）

评审范围：全部文件（app.js 4095 行分段读完，vendor/xterm 跳过）。

### 🔴 严重问题

1. [E3 会话串台] 非 active 会话的终端输出永久丢失（详见总报告 🔴8）
   - 文件: app.js:1515-1527、1167-1188
2. [E4 串台] ssh.error 无 sessionId 时广播进所有会话终端（详见总报告 🔴9）
   - 文件: app.js:1548-1560

### 🟡 重要建议

1. [规则7] app.js 4095 行至少 9 类职责混杂，靠注释横幅分节。给出完整拆分方案：events/sessions/termView/completion/sftp/metrics/leftTree/profileForm/rightDrawer+dialogs/io/boot 共 11 模块，app.js 保留约 50 行装配入口。
2. [E3] connecting 态可重复连接泄漏宿主 SSH 会话（app.js:1345-1348）；promptDialog/confirmDialog 单例并发重入丢失（938-965）。幂等保护 + 重入队列。
3. [E1] initTheme 每次调用新增订阅且不退订（api.js:473-501、app.js:1016-1027）。保存取消函数先退订再注册。
4. [规则14] tips-global 全文档 MutationObserver 叠加在 xterm 高频渲染路径（tips-global.js:131-147）。排除终端容器或收窄观察范围。
5. [规则14/内存] ssh.data 无写入合批，buffer 截断逐 chunk O(n) 拷贝；pathCache 无淘汰（app.js:1522-1525、17、2555-2577）。
6. [规则5] 粘贴输入绕过 lastCommand 跟踪，历史与危险命令检测失真（app.js:1278-1283）。
7. [规则11] 端口与监控间隔未做范围钳制（app.js:3431、3972-3976、api.js:131-140）。
8. [规则12] 导出资产时静默覆盖系统剪贴板，完整主机清单进剪贴板无提示（app.js:3670-3674、3742-3746）。
9. [规则16] plugin.json 声明未使用的 notify 与 shell.openExternal 权限，违反最小权限。
10. [规则9] 三处复制粘贴：closeTab 重复断开、传输成功兜底两份 16 行、groupMenuItems 内联重写 store 循环。

### 🟢 轻微建议

1. [规则8] dict.js:177-181 空 if 块死代码。
2. [规则8] api.js 对象形态兼容分支与 term.js searchNext 无调用方。
3. [规则15] hint* 系列命名是已删除输入条的遗留语义，应改名 command* 系列。
4. [规则8] injectDynamicStyles 空壳函数。
5. [规则9] cssVar/cssGet 同实现；transfers 清理定时器未存句柄可能误删。

### 📝 可读性与文档评估

- 半年后可读性: 一般——模块级文件边界清晰，但 app.js 无类型无 JSDoc，改连接逻辑需通读 4000 行。
- 注释缺口 Top3: ① Profile/Jump 数据模型无集中定义（三处对照才能拼出 schema）；② 宿主事件 payload 契约散见各 handler；③ sendInput 补全按键协议与 lastCommand 规则无说明。
- 文档建议: store.js 顶部补 JSDoc typedef；集中列出宿主事件契约与降级策略；拆分后每模块头 3-5 行职责声明。

### ✅ 优点

- XSS 防护到位：所有 innerHTML 拼接点一致 escapeHtml，颜色注入有白名单。
- 凭据规范：只走 secretRef/ephemeral，导出剥离，历史脱敏。
- 事件绑定用赋值覆盖天然无累积；closeTab 完整 dispose。
- api.js 防御层质量高：has() 探测 + 统一降级文案 + 错误翻译。
- 降级链路完备：xterm→textarea、search addon→计数降级、按宿主能力置灰。
- 危险命令体系与 SFTP 递归删除二次确认。

### 统计: 🔴 2 🟡 10 🟢 5

---

## 模块 9: 插件仓库·小插件横切与工程（前端 JavaScript / Node 脚本）

评审范围：14 个小插件 + scripts/（6 脚本）+ docs/ + README + CI workflow，并实测复现了本地校验失败。

### 一致性矩阵（14 插件对照）

| 插件 | 入口模式 | 状态存储 | 宿主 API 错误处理 | 清理逻辑 | 注释密度 |
|---|---|---|---|---|---|
| calculator | 顶层直跑 | 会话内存 history≤12 | toast，无 isPerm ❌ | 无 | 中 |
| clipboard | 顶层直跑 | 宿主 clipboard.history | isPerm + 区分提示 ✅ | 无 | 低 |
| codec | 顶层直跑 | 无持久化 | isPerm + toast | keydown 不清理 | 中 |
| color-picker | 顶层直跑 | storage colors_v1 | isPerm + failToast ✅ | 无 | 中 |
| json-tools | 顶层直跑 | 无持久化 | isPerm + toast | keydown 不清理 | 高 |
| password-kit | 顶层直跑 | 会话内存 history≤8 | isPerm | 无 | 中 |
| pomodoro | 顶层直跑 | settings + storage | isPerm + toast | timer 有注释豁免 | 中 |
| qrcode | 顶层直跑 | 会话内存 history≤6 | isPerm + failToast | resize×2+RO 不清理；有文件头注释 ✅ | 高 |
| screen-assistant | 顶层直跑 | storage sa_history_v1 | isPerm + failToast | recTimer 不清理 | 低-中 |
| sticky-notes | 顶层直跑 | storage notes_v1（带 shape 校验 ✅） | toast 原文，无 isPerm ❌ | timeTimer 不清理 | 中 |
| timestamp | 顶层直跑 | 无持久化 | isPerm + toast | setInterval 不清理 | 中 |
| todos | 顶层直跑 | storage todos_v1（shape 校验 ✅） | isPerm + toast | confirmTimer 不清理 | 中 |
| translate | 顶层直跑 | settings | isPerm + 分层提示 ✅ | 唯一有 beforeunload 清理 ✅ | 高 |
| hello | async boot() ❌ 与其余不同 | settings | try/catch 原文，无 isPerm ❌ | 无 | 低 |

偏离模式：hello（身兼新人模板却模式全不同）、calculator/sticky-notes（缺 isPerm）、pomodoro/password-kit（manifest 缺 ui 段）、8 个缺 window 段。**主题接入两套方式并存是最大一致性裂口**。

### 🔴 严重问题

1. [敏感数据] password-kit 密码明文流入宿主持久化剪贴板历史（详见总报告 🔴10）
   - 文件: password-kit/main.js:9-16、127-173；机制根源 clipboard/main.js:29-49

### 🟡 重要建议

1. [一致性/规则9] 主题接入两套方式并存：4 插件用 `__enest_theme.css` 注入、10 个手写内联兜底（各 30-40 行相同 token 块，最大重复源）；12/14 把全部 CSS 内联 index.html（414-790 行），违背 PLUGIN_STRUCTURE.md 的 assets/css/main.css 标准。定 canonical 方式写进文档。
2. [规则16/工程] 本地无法运行 manifest 校验：validate-manifests.mjs:8 依赖 ajv 但仓库无 package.json（ajv 仅 CI YAML 提供），README 开发流程第一步即 `ERR_MODULE_NOT_FOUND`。补最小 package.json。
3. [E1/规则14] 隐藏不销毁的定时器持续运行，无插件实现 onOut 暂停（timestamp 500ms interval、sticky-notes 60s、qrcode 双重监听）。
4. [规则11] onEnter payload 解析 8 处手写且行为分叉（calculator 收任意对象 text、translate 收不到 {type:'text'} 格式）。契约写进文档并统一。
5. [规则6/工程] manifest 权限声明与实际使用不匹配（clipboard/translate 声明未用的 storage.local）；validator 不校验 main 入口存在、不做权限/使用比对。
6. [规则4/14] screen-assistant 会话画廊驻留 20 张全分辨率截图 dataUrl；25 行截图流程重复两份。
7. [规则13] 权限错误依赖魔术字符串 'permission denied'，12 插件重复且 3 个缺失；约定未文档化。宿主应给 error.code。
8. [规则13] translate 依赖非官方 Google client=gtx 端点硬编码，虽有 MyMemory 降级但 Google 侧失效体验降级明显。
9. [规则11/14] qrcode 解码无输入大小守卫（对照 json-tools 已有 2MB/8MB 成熟模式）。
10. [工程] 仓库内 registry.json 快照 size=0/sha256=''，恰是壳子声明的回退数据源——回退机制按约定校验 sha256 将直接失败。

### 🟢 轻微建议

1. [规则15] 小工具命名漂移：storage key 常量名 5 种、fmtBytes 两种语义、flashCopied 两种实现。
2. [规则16] vendor 目录位置与 script 路径前缀两种风格。
3. [规则8] codec 输出信息双写两处。
4. [规则7] todos 全量 render 重建列表，>100 条时改增量。
5. [规则1] clipboard/screen-assistant 几乎无分区注释。
6. [隐私] clipboard 历史对密码/token 明文展示，可加敏感掩码开关。
7. [一致性] hello 应升级为标准样板完整版。

### 📝 可读性与文档评估

- 半年后可读性: 好（个别文件一般）。
- 样板冗余结论: 14 个 main.js 共 3910 行，跨插件重复样板约 380-450 行（JS 重复比例约 10-12%）；加 index.html 内联主题兜底约 400 行，全仓约 15%。**不建议抽运行时公共 JS**（独立打包自包含是硬约束），三步替代：壳子统一 theme.css 注入删内联兜底、新增 new-plugin.mjs 脚手架、docs 把 permission denied 约定/onEnter 契约/storage key 命名写成规范。
- 文档缺口: ① 宿主 API 参考（最大缺口，目前只能去读壳子仓库源码）；② 插件生命周期与重载语义；③ 主题接入 canonical 方式；④ 新插件 checklist/CONTRIBUTING；⑤ registry 回退索引行为契约。

### ✅ 优点

- XSS 主体防护扎实：全部走 textContent/createElement，无一处用户数据直拼 innerHTML。
- password-kit 随机性工程规范：rejection sampling 消模偏差、Fisher-Yates、UUID v4 正确置位。
- calculator 手写 tokenizer + 递归下降且禁 eval。
- json-tools 2MB/8MB 守卫 + 自研 JSON 扫描器兜底定位行列。
- market-assets 安全校验链完整且有 8 个高质量测试。
- storage 读取普遍带 shape 校验；权限声明总体最小化。

### 统计: 🔴 1 🟡 10 🟢 7

---

## 模块 10: 跨仓库冗余与文档专项

### A. 跨模块冗余清单

| # | 冗余对 | 结论 | 证据 | 建议 |
|---|--------|------|------|------|
| 1 | 壳子 completion.ts(1009) vs 插件 completion.js(609)+tokenizer.js(450) | **冗余（版本漂移已发生）** | 方言词表双份已分叉（TDengine 词表不一致）；fuzzyMatch 逐行同构（注释自认「与宿主对齐」）；INSERT/UPDATE/JOIN 逻辑双份；snippets 双份。估算 55-60% 重复 | 插件回退词表改读宿主 db.dialects.list() 缓存；fuzzyMatch 等纯函数两仓加「镜像文件：改动必须同步」标记。成本半天 |
| 2 | 通知体系 shellNotices + notice.ts + notifyService + useToast | **合理（职责不同，非双轨）** | 四者链条清晰：进程间事件信封 / UI Toast / 显式声明的兼容层 | 不合并。但 shellStore 20 处仍走旧 API 与约定不符，一次性替换后删兼容层（1-2 小时） |
| 3 | middleware 四 driver | **合理复制（<10%）** | 共享契约已抽好（MwDriver 接口 + unsupported()）；真重复仅 payloadType 三处、unwrap 两份 | 可选：抽 messageUtils.ts 约 40 行。不建议过度抽象 |
| 4 | ssh/tips-global.js vs database/tips.js | **冗余（~90% 同构 + 已漂移）** | database 版有 modal-mask 修复 ssh 版没有 | 先同步修复止血；正式方案 plugin-kit 共享（选择器差异参数化） |
| 5 | sshFiles.ts vs database 文件处理 | **合理（层次清晰）** | database 侧不碰文件系统，统一收口 localFiles | 唯一真重复：safeFileName vs validateNewName 规则强度不一致，并档说明两档适用场景 |
| 6 | pluginPreload vs shellPreload | **合理（不同 trust domain）** | 唯一重复是 10 行 ok 解包；主体是安全模型差异（具名通道 vs 单通道方法分发） | 不合并 |
| 7 | 各小插件 main.js 初始化样板 | **冗余（浅层，量大）** | api 引导 15 份、toast 13 份、isPerm 12 份，每插件 5-8 行 | plugin-kit 暴露 createPluginApi()；低优先级 |
| 8 | shared/types 五个 workbench 类型 | **合理（刻意同构契约层）** | 文件头自述设计意图；判别联合是统一 dispatch 模式 | 不合并。SshWorkbenchRequest 是弱类型大口袋（16 可选字段 + action:string），应判别联合化 |
| 9 | **权限枚举三处定义漂移** | **冗余（已产生真漂移，🔴）** | 代码 47 / schema 28 / 文档 21；差的 19 项含 mw.*/dsh.*/fs.*/sys.* | 立即重跑生成脚本；CI 加一致性断言；清理 eNest/eNest_plugin 嵌套旧副本 |
| 10 | escapeHtml 三份 + 错误包装散布 | **冗余（轻微）** | 插件仓三份相同 escapeHtml；壳子 (e as Error).message 约 8 处 | 并入 plugin-kit；壳子加 @shared/errFormat.ts errMsg() |

### B. 文档与注释充分性

**1. 约定一致性（抽 5 条验证）**：`@`别名（一致，grep 零命中）、IPC 通道集中（一致，零硬编码）、TITLEBAR=36（一致）、notifyService 优先（**部分不一致**：shellStore 20 处走兼容层）、设置持久化（一致）、权限走 pluginPermissionPolicy（一致）。**5/6 全过，质量罕见地好。**

**2. API 文档同步度**：lifecycle.md（同步，ack 常量逐字对上）、api.md mw/db/ssh 段（同步，权限映射与入参逐字段一致）、api-types.md（同步，含新加 usageBoost）、壳通知 topic 清单（同步）；对照：manifest.md 权限计数（**严重漂移**）。

**3. 新人上手评估**：壳子仓库好（README → engineering/ARCHITECTURE → AGENTS.md 链条完整，20+ 份验证留痕）；插件仓库中下（能写 hello 级但写不好真插件：权限数字错误会让新人无从排查、API 细节全在另一仓库、大插件结构无文档）。

**4. 大文件可读性**：

| 文件 | 行数 | 注释覆盖 | 半年后可读性 |
|------|------|---------|-------------|
| PluginHost.ts | 1687 | 16.1% + 40 行头注释 + 16 处分节 | 好 |
| pluginPreload.ts | 1672 | 15.2% + uTools 对标头注释 | 好 |
| ssh/app.js | 4095 | 2.5% + 25 处分节横幅 | 一般 |
| database/main.js | 1775 | 1.7%、零分节 | **差** |
| SettingsPage.tsx | 943 | 4.7% | 一般偏好 |

**5. 文档缺口清单（按优先级）**：P0 权限枚举对齐；P1 completion 镜像声明；P1 database 插件结构文档；P2 插件仓 docs 索引；P2 shellStore 迁移；P3 SshWorkbenchRequest 判别联合化。

### 🔴 严重问题

1. 权限枚举三处漂移（置信度 95%）——见总报告 🔴11。
2. tips 组件漂移已造成行为不一致（置信度 90%）——见总报告 🔴12。

### 🟡 重要建议

1. SQL 补全方言词表收敛到宿主单一来源（两仓最大双维护块，约 900 行重叠域）。
2. shellStore 20 处 toastStore.push 迁移。
3. SshWorkbenchRequest 判别联合化。
4. safeFileName 与 validateNewName 规则统一。
5. database/main.js 补分节注释。

### 🟢 轻微建议

1. middleware payloadType/unwrap 抽 messageUtils.ts。
2. 插件仓样板并入 plugin-kit。
3. 壳子 errMsg() 收敛。
4. 两个 preload 的 ok 解包共享（收益极小）。
5. 清理 eNest/eNest_plugin 嵌套旧副本磁盘目录。

### 总结论

- **冗余总体评价**：整体可控——四组「疑似冗余」核实后均为合理架构性同构；真正需要治理集中在三处（SQL 补全双份、权限枚举三处、tips/小工具散件），建议一次小专项（约 2-3 人日）而非全面重构。
- **文档总体评价**：壳子文档质量显著高于插件仓库；最该补的三件事：① 对齐并 CI 锁定权限枚举；② completion 双份镜像加同步声明；③ 为 database 插件 main.js 补模块结构文档（唯一「半年后看不懂」级文件）。

---

*报告由 10 个并行评审子代理产出，主代理汇总校对。各问题均带文件:行号取证，修复建议可直接照做。*
