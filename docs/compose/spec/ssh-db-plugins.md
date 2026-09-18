---
feature: ssh-db-plugins
status: delivered
updated: 2026-09-18
branch: main
commits: (uncommitted working tree on main)
---

# SSH 管理 + 数据库插件（生产核心路径）

## Report

**What was built** — 在正式主仓（无 worktree）交付宿主运行时与双插件：`vault`/`ssh`/`db` 权限与 API、统一 KV 存储契约（`enest.storage` + `enest.vault`→secretRef）、SSH 会话/补全/监控/SFTP、五数据库驱动 + IDEA 向 SQL 补全 + 结果集变更 + 控制台会话持久化 + 导入导出。插件包：`eNest_plugin/plugins/com.enest.ssh` 与 `com.enest.database`。

**Verification** — `npm run typecheck` PASS；`npm run build` PASS；`validate-manifests` PASS。

**Host integration smoke (2026-09-18)** — Diff 插件调用名 vs preload/handlers：`ssh.*` / `db.*` / `vault.*` / `shell.saveTextFile` 全覆盖，METHOD_PERMISSION 与 PLUGIN_PERMISSIONS / plugin-manifest.schema.json 含 `vault.write`+`ssh.session|exec|sftp`+`db.connect|query|schema`；PluginHost close/hibernate 均调用 `releaseSshSessions`/`releaseDbSessions`。宿主小修：`ssh.pickLocalFile` 兼容插件 `{ mode:'file'|'dir' }`；mockMarket 与 `registry.json` 对齐 plugin.json（v1.0.0 + settings.register）。对象/位置参已在 handlers 侧用 asObj/argStr 兼容。

**Security re-verify (post-review)** — 已修复：applyChanges/import 参数化 SQL + 标识符校验；import `filePath` 仅宿主 picker 白名单；`readOnly` 写 SQL 拦截；prod/`requireConfirm` 宿主强制 `confirmed`；`shell.saveTextFile` 导出落盘；vault.has 跨插件探测；SQLite `createIfMissing`。已知限制：`db.cancel` 对 HTTP/多数驱动无法真正中止在途 SQL（仅标记）。

**Journey log** — 插件无 Node，敏感能力必须走宿主；数据契约只认统一 KV API 不建旁路 JSON；安全边界（参数化/confirmed/路径白名单）必须在宿主而非 UI；ssh2 参数支持对象与位置双形态以兼容插件。

## [S1] Problem

eNest 缺少开发运维两大核心工具。插件运行在无 Node 的 `WebContentsView` 沙箱中，敏感能力必须走宿主 API。

**用户本轮强调的数据库优先级（必须先做深）：**

1. **SQL 代码提示**（对标 IDEA Database Tools）— 最高优先  
2. **查询结果列表**支持新增 / 修改 / 删除 / 批量操作  
3. **控制台会话**（连接上下文、SQL 编辑器 Tab、结果、历史）**保存与持久化**  
4. **导入 / 导出**等数据与配置完整能力  

### 已确认决策

| 决策项 | 选择 |
|--------|------|
| 时序库 | InfluxDB 2.x + TimescaleDB + TDengine |
| SSH 终端 | 宿主 `ssh2` + 插件 xterm.js |
| 数据路径 | `~/.eNest/`（`DATA_DIR_NAME='.eNest'`），宿主统一 KV 落此处 |
| 持久化契约 | **统一 KV API**：业务数据只经 `enest.storage.get/set(key, value)`；密钥只经 `enest.vault.set→secretRef`。**不是 JSON 文件契约**；物理后端由宿主统一 KV 实现（plugin_storage 等） |
| 驱动 | MySQL=`mysql2`；SQLite=独立文件库；Timescale=`pg`；Influx/TDengine=HTTP |
| DB 优先级 | SQL 补全 > 结果集 CRUD/批量 > 会话持久化 > 导入导出 > 其它 |
| 插件 | `com.enest.ssh` / `com.enest.database`，`form: panel` |

## [S2] Design

### 2.0 存储与分层（两插件共用）

**数据契约 = 统一插件 KV API，不是 JSON 文件。**

插件侧只允许：

```ts
// 元数据 / 业务状态 / 会话草稿 —— 一律 KV
await enest.storage.get(key)          // → 结构化值（宿主已反序列化）
await enest.storage.set(key, value)   // value: object | array | string | number | boolean | null
await enest.storage.remove(key)
await enest.storage.clear()

// 密钥 —— 同样是「调 API」，不落插件可见明文
const { secretRef } = await enest.vault.set(key, secretString)
await enest.vault.has(secretRef)
await enest.vault.remove(secretRef)
```

| 项 | 约定 |
|----|------|
| 契约 | **仅** `enest.storage` / `enest.vault`（+ `enest.ssh.*` / `enest.db.*` 运行时 API） |
| 键空间 | 按插件隔离（宿主用 pluginId 命名空间）；SSH/DB 自用逻辑键，见下表 |
| 值 | 逻辑对象/数组；插件不关心宿主如何序列化 |
| 物理落盘 | **宿主内部实现**，插件与 Spec 均不绑定文件格式。目标底座：壳子统一 KV（`~/.eNest/data/` 下共享库，如 `enest.db` 的 `plugin_storage`）；旧 `plugin-storage/{id}.json` 仅作迁移源，**不是**对外契约 |
| 禁止 | 插件自写文件、宿主为 SSH/DB 另开 `ssh-profiles.json` 等旁路契约 |
| 密钥 | `vault.set → secretRef`；连接/查询 API 只传 ref，宿主内部解密 |

**逻辑键（契约的一部分，不是文件名）：**

| 键 | 值类型 | 用途 |
|----|--------|------|
| `ssh.profiles` | `SshProfile[]` | 连接资产（仅 secretRef） |
| `ssh.groups` | `SshGroup[]` | 分组树 |
| `ssh.history` | `SshHistoryEntry[]` | 命令历史 |
| `ssh.snippets` | `SshSnippet[]` | 片段 |
| `ssh.ui` | object | 折叠/字号/筛选等 |
| `db.connections` | `DbConnection[]` | 数据库连接（仅 secretRef） |
| `db.sessions` | `DbConsoleSession[]` | 控制台会话 |
| `db.activeSessionId` | string | 当前会话 |
| `db.queryHistory` | `DbQueryHistoryEntry[]` | SQL 历史 |
| `db.completionUsage` | `Record<string, number>` | 补全使用频次 |
| `db.ui` | object | 分栏等 UI 态 |

```
插件 UI
  enest.storage.*  → 统一 KV（宿主 pluginId 隔离，值为逻辑对象）
  enest.vault.*    → 密钥 API → secretRef
  enest.ssh.* / enest.db.* → 会话/查询（入参带 secretRef）
宿主
  统一 KV 底座 · secretVault · sshSessionManager · dbDrivers/* · dbSessionManager
```

---

# 插件一：SSH 管理（`com.enest.ssh`）

生产级远程运维客户端：连接资产库 + 交互终端 + 命令智能提示 + 性能监控 + 最小 SFTP。

## SSH-A 连接资产管理

### A1 连接配置（Profile）

| 字段 | 说明 |
|------|------|
| id / name | 稳定 ID、显示名 |
| host / port | 默认 22 |
| username | 登录用户 |
| authType | `password` \| `key` \| `agent` |
| privateKeyPath | 密钥登录时的本地私钥路径（路径入库，**内容不入库**） |
| secretRef | vault 引用：密码 **或** 私钥 passphrase |
| jump | 跳板：host/port/username/secretRef（可嵌套 1 级，P0） |
| keepAliveSec / timeoutMs | 保活与超时 |
| term / cols / rows 默认 | 打开终端时的初始 PTY |
| env | `prod` / `staging` / `dev` / 自定义 |
| tags[] / color | 多标签 + 颜色 |
| groupId | 所属分组 |
| note | 备注、用途、负责人 |
| favorite / lastConnectedAt | 收藏与最近使用 |
| fingerprintPolicy | `strict` / `accept-new` / `tofu`（known_hosts 策略，P0 做 tofu + 展示指纹） |

**操作：**

- 新建 / 编辑 / 复制连接 / 删除（删除时可选同步删 vault 密钥）  
- 「测试连接」：TCP 可达 → SSH 握手 → 返回延迟 ms + 指纹 + 服务器识别串  
- 密码输入框：保存时 `vault.set('profile:{id}:auth', secret)`，表单只显示「已保存/未保存/清除」  
- 强制校验：name/host/username 非空；prod 连接名称唯一性提示  

### A2 认证细节

| 模式 | 行为 |
|------|------|
| password | 仅 vault；支持「本次连接使用、不保存」（ephemeral secret，内存传递不落 vault） |
| key | 私钥路径 + 可选 passphrase（vault）；校验文件存在与可读 |
| agent | SSH_AUTH_SOCK（宿主环境）；失败时明确提示 |

### A3 跳板 / 网络

- ProxyJump：先连 jump 再 `direct-tcpip` 到目标  
- 连接超时、keepalive 失败计数 → 自动断开并事件通知  
- 代理兼容：遵循壳子 `general.proxy` 时 **不** 劫持 SSH TCP（SSH 直连目标）

### A4 导入 / 导出（连接资产）

| 方向 | 格式 | 内容 |
|------|------|------|
| 导出 | JSON | profiles + groups + tags；`secretRef` 剥离或保留为空；可选「导出加密包」P1 |
| 导入 | JSON | `merge`（按 name+host+user 去重）/ `replace`（整库替换需确认） |
| 导入 | OpenSSH config 片段（P1） | 解析 Host/HostName/User/Port/IdentityFile |
| 导出 | 命令行 `ssh user@host -p port` 文本（便于复制到终端） | 无密钥 |

宿主不提供 profile CRUD；导出文件由插件组装 storage 数据后经宿主 `shell.saveFileDialog`（或 clipboard）落盘——P0：**下载/写入用户选择的路径**，路径选择走宿主对话框。

## SSH-B 服务器分组

| ID | 功能 | 深度说明 |
|----|------|----------|
| B1 | 多级分组树 | `SshGroup { id, name, parentId, color, sort, collapsed }`；支持 3+ 层（生产/华东/订单集群） |
| B2 | 分组操作 | 新建子组、重命名、删除（策略：`orphan` 连接移到未分组 / `cascade` 连接一并删需二次确认） |
| B3 | 连接归属 | 右键/拖拽移动到分组；多选批量移动 |
| B4 | 标签体系 | 自由标签；标签面板过滤；标签与分组正交 |
| B5 | 搜索 | 防抖搜索 name/host/ip/note/tags；高亮命中 |
| B6 | 筛选器 | env、分组、标签、收藏、「最近连接过」 |
| B7 | 视图 | 树视图 / 紧凑列表切换；组内按 name/lastConnected 排序 |
| B8 | 状态记忆 | 折叠状态、排序、筛选写入 storage `ssh.ui` |
| B9 | 在线探测（P1） | 后台 TCP 22 探测，树节点绿/灰点 |

## SSH-C 终端会话

| ID | 功能 | 深度说明 |
|----|------|----------|
| C1 | 多 Tab | 每 Tab = 一 sessionId；标题 `name` 或 `user@host` |
| C2 | xterm.js | 本地 vendored；主题跟随壳子 Token（`--bg/--text/--accent`） |
| C3 | PTY | cols/rows 与容器同步；ResizeObserver → `ssh.resize` |
| C4 | 数据通道 | 宿主 `ssh.data` 事件 utf-8 流式写入 xterm；输入 `ssh.write` |
| C5 | 连接生命周期 | connecting → connected → disconnected/exited；失败原因内联展示 |
| C6 | 重连 | 断线后保留缓冲，按钮「重连」用同一 profile 入参新建 session |
| C7 | 复制粘贴 | 选中即复制（可关）；`Cmd/Ctrl+Shift+V` 粘贴；右键菜单 |
| C8 | 清屏 / 查找 | xterm clear；缓冲搜索 next/prev |
| C9 | 字体 | 字号 ± ；字体族跟随壳子 mono 设置 |
| C10 | 滚动 | 回滚缓冲 ≥ 5000 行；触摸板滚动 |
| C11 | 关闭策略 | 关 Tab → `ssh.disconnect`；未退出进程时提示「会话将断开」 |
| C12 | 命令行输入辅助条 | 终端上方/下方 hint bar：显示当前补全候选（见 SSH-E），Enter 下发 |
| C13 | 分屏（P1） | 左右两终端同主机 |

## SSH-D 命令历史与片段

| ID | 功能 | 深度说明 |
|----|------|----------|
| D1 | 写入时机 | 用户在 hint bar 确认执行或终端检测到完整命令行 + 回车时记录（可配置开关） |
| D2 | 字段 | `{ id, profileId, command, exitCode?, durationMs?, ts, tags? }` |
| D3 | 作用域 | 当前服务器 / 全部；storage 键 `ssh.history` 上限 2000，LRU 淘汰非 pinned |
| D4 | 搜索 | 子串 + 可选正则；按时间倒序 |
| D5 | 片段库 | `{ id, title, command, tags[], sort, pinned }`；常用运维模板 |
| D6 | 回填 | 点击历史/片段 → 写入 hint bar 或 xterm 输入行，**不自动执行** |
| D7 | 重跑 | 显式「执行」按钮；prod 连接对危险命令二次确认 |
| D8 | 脱敏 | 可选规则：命令中 `password=***`、`-p***`、token 形态打码后再入库 |
| D9 | 导出历史 | CSV/JSON（P1） |
| D10 | 清空 | 按 profile / 全局 |

## SSH-E 命令提示与补全（生产终端体验）

> 插件 hint bar + 宿主词典/远程路径；排序与 IDEA 补全同思路。

### E1 候选来源（合并去重）

| 优先级 | 来源 | 说明 |
|--------|------|------|
| 1 | 当前会话远程路径 | 已连接时对路径参数 `ls`/`compgen -f` 节流查询 |
| 2 | 片段 | 标题/命令前缀命中 |
| 3 | 历史 | 本 profile 前缀 → 全局前缀 |
| 4 | 静态词典 | 命令 + flags + 中文说明 |
| 5 | 上下文推断 | `sudo` 后、`\|` 后子命令、`systemctl` 后动词等 |

### E2 静态词典范围（P0 必含）

- 系统：`ls cd pwd mkdir rm cp mv chmod chown ps top free df du uname uptime kill nice`  
- 网络：`ss netstat ping curl wget iptables scp rsync`  
- 服务：`systemctl journalctl service`  
- 文本：`grep sed awk tail head less cat echo xargs find`  
- 容器/编排：`docker docker-compose kubectl helm`  
- 版本：`git`  
- 数据/中间件：`redis-cli mysql nginx`  
- 压缩：`tar gzip gunzip zip unzip`  

每条：`{ cmd, flags: [{ name, desc }], desc, category }`。

### E3 交互

- 输入防抖 80ms 触发补全  
- `↑/↓` 选择，`Tab/Enter` 填入，`Esc` 关闭  
- kind 徽章：`cmd` / `flag` / `path` / `history` / `snippet`  
- 副标题：词典说明或历史相对时间  
- **危险命令**：规则表匹配 → 红色「危险」徽章 + 确认框（可记住本 profile 豁免）  

### E4 危险规则（P0）

`rm -rf`（尤其 `/`、`/*`）、`mkfs`、`dd of=/dev/`、`> /dev/sd`、`kill -9 1`、`shutdown`/`reboot`、`DROP DATABASE`、`chmod -R 777 /`、生产 env 上的 `systemctl stop` 等。

### E5 远程路径补全

- 仅 `sessionId` 已连接且前缀像路径时请求  
- 宿主 `ssh.completion.suggest`；失败静默降级  
- 结果缓存 session 级 3s  

### E6 用户词典（P1）

storage `ssh.userDict`：自定义 cmd/alias 提示。

## SSH-F 性能监控

| ID | 功能 | 深度说明 |
|----|------|----------|
| F1 | 采样项 | CPU%、Mem used/total/%、Load1、磁盘分区 used%、网卡 rx/tx KB/s、Uptime、Top 进程 10 条 |
| F2 | 采集 | 复用 session 或临时 exec；Linux `/proc` + `df` + `ps`；macOS 降级命令 |
| F3 | 间隔 | 默认 5000ms，可 2s–60s；仅前端打开监控面板时采样 |
| F4 | 推送 | `ssh.metrics` 事件 → 插件环形缓冲（最近 120 点） |
| F5 | 可视化 | CPU/Mem 折线 sparkline；磁盘横向条；进程表 |
| F6 | 阈值 | CPU/Mem ≥85% 警告色；≥95% 危险色；可配置 |
| F7 | 失败 | `sample.error` 展示；不中断终端 |
| F8 | 启停 | 面板开关；关 Tab 自动 stop |
| F9 | 多机对比（P1） | 多 profile 同屏指标表 |
| F10 | 告警通知（P1） | 越阈值 `enest.notify` |

## SSH-G SFTP（P0 最小）

| ID | 功能 |
|----|------|
| G1 | 侧栏列出远程目录（路径导航、上一级） |
| G2 | 刷新、进入目录 |
| G3 | 下载单文件 → 宿主目录选择器 / 默认 `~/Downloads` |
| G4 | 上传：宿主选文件 → 当前远程路径 |
| G5 | 显示 name/size/mtime/type |
| G6 | P1：删除/重命名/多选/传输队列/进度条 |

## SSH-H 会话与数据持久化

| ID | 功能 |
|----|------|
| H1 | profiles/groups/tags/snippets/history → `enest.storage` |
| H2 | UI：折叠、筛选、字号、监控间隔、当前打开 Tab 列表（profileId 列表，**不**持久化 PTY 缓冲） |
| H3 | 应用重启后：恢复左侧资产树与「最近会话」列表，终端需手动点连接（安全默认） |
| H4 | 可选设置「启动时自动重连上次会话」（默认关） |

## SSH-I 导出导入汇总

| 数据 | 导出 | 导入 |
|------|------|------|
| 连接+分组 | JSON | JSON merge/replace |
| 片段 | JSON/Markdown | JSON |
| 历史 | CSV/JSON（P1） | — |
| 监控截图 | P1 PNG | — |

## SSH-J UX 骨架

```
┌────────────┬─────────────────────────────┬──────────────┐
│ 分组树/搜索 │  Tab: 终端 | 监控 | SFTP      │ 历史/片段     │
│ 连接卡片    │  xterm / hint bar           │ 过滤搜索      │
│ + 新建连接  │  补全浮层                    │              │
└────────────┴─────────────────────────────┴──────────────┘
```

快捷键（P0）：`Cmd/Ctrl+T` 新终端 · `Cmd/Ctrl+W` 关 Tab · `Cmd/Ctrl+F` 终端搜索 · `Cmd/Ctrl+Space` 补全。

---

# 插件二：数据库（`com.enest.database`）

**产品定位：** 桌面级 SQL 客户端（IDEA DataGrip 核心路径）。驱动统一抽象，UI 统一 Token。

**实现优先级（用户指定）：**

| 优先级 | 模块 |
|--------|------|
| P0-1 | SQL 代码提示 / 补全（本文件 DB-E，写得最深） |
| P0-2 | 查询结果数据表：查看 + 新增/修改/删除/批量 |
| P0-3 | 控制台会话保存与持久化 |
| P0-4 | 导入 / 导出 |
| P0-5 | 连接管理、对象树、执行器、基础结果展示 |
| P1 | 表设计器 GUI、ER 图、SSH 隧道、就地多表事务高级流 |

## DB-A 标准连接层（架构）

```ts
interface DbDriver {
  id: DbDriverId
  label: string
  dialect: 'mysql' | 'sqlite' | 'postgres' | 'influxql' | 'tdengine'
  defaultPort?: number
  capabilities: {
    multiStatement: boolean
    explain: boolean
    schemas: boolean
    timeSeries: boolean
    fileBased: boolean
    /** 结果集是否支持按主键定位做 UPDATE/DELETE */
    updatableResult: boolean
    ddl: boolean
    import: boolean
  }
  test(input): Promise<{ ok; message; version? }>
  open(input): Promise<Handle>
  close(h): Promise<void>
  execute(h, sql, opts): Promise<QueryResult>
  explain?(h, sql): Promise<QueryResult>
  listDatabases(h): Promise<string[]>
  listSchemas(h, db?): Promise<string[]>
  listTables(h, scope): Promise<SchemaObject[]>
  describeTable(h, scope, table): Promise<TableDetail>
  getDdl?(h, scope, table): Promise<string>
  completionCatalog(h, scope): Promise<CompletionCatalog>
  /** 结果集 DML */
  applyRowChange?(h, change: RowChange): Promise<{ affected: number }>
  applyBatch?(h, changes: RowChange[]): Promise<BatchResult>
  importCsv?(h, req): Promise<ImportResult>
}
```

| 驱动 | 传输 | updatableResult | 备注 |
|------|------|-----------------|------|
| mysql | mysql2 | 是 | information_schema；事务批 |
| sqlite | node:sqlite / better-sqlite3 | 是 | 用户文件，不共用壳子 enest.db |
| timescale | pg | 是 | PG 方言 + timescale 视图 |
| influxdb | HTTP v2 | 否（P1 行写入） | InfluxQL/bucket |
| tdengine | REST | 部分 | SQL 批；超级表限制 |

**统一 QueryResult**

```ts
interface QueryResult {
  columns: Array<{ name; dataType?; nullable?; primaryKey?: boolean }>
  rows: unknown[][]
  rowCount: number
  affectedRows?: number
  durationMs: number
  truncated?: boolean
  messages?: string[]
  warnings?: string[]
  /** 可更新结果集时：主键列名与每行主键值（与 rows 对齐） */
  rowIdentity?: { keyColumns: string[]; keys: unknown[][] }
  sql?: string
}
```

## DB-B 连接管理

| ID | 功能 | 说明 |
|----|------|------|
| B1 | 连接 CRUD | name、driver、host/port、database、username、color、env、note |
| B2 | 驱动动态表单 | MySQL/PG：charset/ssl；Influx：org/bucket/token(secretRef)；SQLite：file、createIfMissing |
| B3 | 测试连接 | 版本、延迟、错误分类（网络/认证/权限/驱动） |
| B4 | 只读 | `options.readOnly`；UI 徽章；宿主拒绝写 SQL 与 applyRowChange |
| B5 | 只写确认 | prod env 上 DML/DDL 需 `confirmed:true` |
| B6 | 收藏/最近 | 排序收藏置顶 |
| B7 | 复制连接 | 复制除 secretRef 外配置，便于建从库连接 |
| B8 | 分组展示 | P0 按 env 分区显示；P1 自定义文件夹 |
| B9 | vault | 保存密码/token → secretRef 入 storage |
| B10 | SQLite 文件 | 宿主 `db.pickSqliteFile`；最近文件列表 |
| B11 | 会话列表 | 已 open 的 sessionKey 展示与强制关闭 |
| B12 | 导入导出连接 | JSON（可剥离密钥） |

## DB-C 对象浏览器（Schema 树）

| ID | 功能 | 说明 |
|----|------|----------|
| C1 | 树层级 | 连接 → 数据库 → schema（如有）→ 表/视图/测量/存储过程/函数 |
| C2 | 懒加载 | 展开才 `db.schema.tree` 子节点 |
| C3 | 刷新 | 节点/整树刷新；使 completion catalog 缓存失效 |
| C4 | 搜索框 | 过滤对象名；命中高亮；可搜列名（描述缓存内） |
| C5 | 表节点 | 展开列：名称、类型、可空、PK、注释 |
| C6 | 表详情面板 | 列表 + 索引 + 外键 + 注释 + 行数估算 |
| C7 | DDL | 查看/复制/「在编辑器打开」 |
| C8 | 右键 | 打开数据、SELECT *、SELECT COUNT、复制名称、刷新、查看 DDL |
| C9 | 收藏对象 | 常用表置顶区 |
| C10 | 时序 | bucket/measurement；字段类型 tag/field 区分（驱动可得时） |
| C11 | 驱动徽章 | 节点/连接头显示 MySQL/SQLite/… |

## DB-D SQL 控制台与会话持久化（P0-3）

> 「控制台会话」= 一个可保存的工作区：绑定连接 + 编辑器 Tab 集 + 每 Tab 的 SQL 草稿 + 执行历史引用 + 结果状态。

### D1 会话模型（storage）

```ts
interface DbConsoleSession {
  id: string
  name: string                    // 用户可重命名，如「订单库排查」
  connectionId: string
  database?: string
  schema?: string
  activeEditorId: string
  editors: DbEditorTab[]
  createdAt: number
  updatedAt: number
  pinned?: boolean
}

interface DbEditorTab {
  id: string
  title: string                   // 如 query-1.sql
  sql: string                     // 草稿全文
  cursor?: { line: number; ch: number }
  /** 最近一次成功执行的摘要，便于恢复上下文 */
  lastRun?: {
    sql: string
    durationMs: number
    rowCount: number
    ts: number
    truncated?: boolean
  }
  /** 结果网格 UI 状态：排序、列宽、页码 — 恢复布局不自动重查 */
  gridState?: {
    page: number
    pageSize: number
    sort?: Array<{ column: string; dir: 'asc' | 'desc' }>
    filters?: Array<{ column: string; op: string; value: string }>
  }
  dirty?: boolean
}
```

storage 键：

- `db.sessions`：`DbConsoleSession[]`（KV，整键覆盖或读改写）  
- `db.activeSessionId`  
- `db.connections`、`db.queryHistory`、`db.ui`、`db.completionUsage`  

> 均为 `enest.storage.set(key, value)`，无独立会话文件/JSON 契约。

### D2 持久化行为

| 行为 | 规则 |
|------|------|
| 自动保存 | 编辑器防抖 800ms 写 `sql`/`cursor`/`dirty` |
| 显式保存 | `Cmd/Ctrl+S` 立即写 storage；标题去掉 `*` |
| 打开应用 | 恢复上次 activeSession + editors 列表 + 文本；**不**自动 `db.open`（可设置「自动恢复连接」默认关） |
| 切换连接 | 会话绑定 connectionId；切换连接询问「新会话 / 复制草稿到新会话」 |
| 关闭 Tab | 脏 Tab 确认；从 session.editors 移除并保存 |
| 删除会话 | 确认后删 storage；不影响连接配置 |
| 会话列表 | 左侧「控制台」区：重命名、置顶、复制、导出会话 JSON |
| 崩溃恢复 | storage 为真相源；内存态与 storage 冲突时以 storage 较新 `updatedAt` 为准 |
| 上限 | 会话 ≤ 50；单会话编辑器 ≤ 20；单 SQL 文本 ≤ 1MB |

### D3 执行器

| ID | 功能 |
|----|------|
| D3.1 | 执行全部 SQL |
| D3.2 | 执行选中 |
| D3.3 | 执行当前语句（光标位置语句切分，识别字符串/注释内分号） |
| D3.4 | `Cmd/Ctrl+Enter` 执行当前语句；`Cmd/Ctrl+Shift+Enter` 执行全部 |
| D3.5 | Explain（驱动支持时） |
| D3.6 | 取消进行中查询（`db.cancel`） |
| D3.7 | 多语句 → 多结果集，结果区 Tab 切换 |
| D3.8 | 危险 SQL 拦截：无 WHERE 的 UPDATE/DELETE、DROP/TRUNCATE/ALTER；prod/只读策略 |
| D3.9 | 参数：`?` / `:name` 执行前弹出参数表（可记忆本次会话值） |
| D3.10 | 状态栏：连接、库、耗时、行数、truncated、readOnly |

## DB-E SQL 代码提示（P0-1，对标 IDEA）

> 目标：编辑器内自然输入即可获得**上下文正确**的补全，而不是只弹关键字列表。

### E1 编辑器基础

| ID | 能力 |
|----|------|
| E1.1 | 自研轻量 SQL 编辑器（无 Monaco/CDN）：行号、当前行高亮 |
| E1.2 | 语法高亮：关键字/函数/字符串/数字/注释/标识符/运算符/标点；按 dialect 词表 |
| E1.3 | 括号匹配、自动缩进、Tab/Shift+Tab 缩进选区 |
| E1.4 | 注释切换 `Cmd/Ctrl+/` |
| E1.5 | 多 Tab 编辑器，标题可改，脏标记 `*` |
| E1.6 | 查找/替换（会话内） |
| E1.7 | 字体与 Token 跟随壳子 |
| E1.8 | 大文件保护：>200KB 提示性能模式（关闭部分高亮） |

### E2 补全触发

| 触发 | 行为 |
|------|------|
| 输入字母/下划线/反引号/双引号 | 防抖 50–80ms 请求补全 |
| `.`（成员） | 立即请求「表别名/库名」下的列/子对象 |
| `Cmd/Ctrl+Space` | 强制打开补全（空上下文给关键字+片段） |
| `Esc` | 关闭浮层 |
| 连续输入 | 过滤本地已获取列表，减少 IPC |

### E3 补全项模型

```ts
interface CompletionItem {
  label: string
  kind: 'keyword'|'table'|'view'|'column'|'function'|'database'|'schema'|'snippet'|'alias'|'measurement'
  detail?: string        // 类型、所属表、函数签名
  doc?: string           // 注释 / 函数说明
  insertText: string     // 含必要引号或括号
  sortText: string       // 排序键
  filterText?: string
  /** 列：所属表；表：schema */
  owner?: string
}

interface CompletionResponse {
  replace: { from: number; to: number }  // 文档中标识符范围
  items: CompletionItem[]
  isIncomplete?: boolean
}
```

### E4 Catalog（宿主缓存）

```ts
interface CompletionCatalog {
  dialect: string
  databases: string[]
  schemas: string[]
  tables: Array<{
    name: string
    schema?: string
    type: 'table'|'view'|'measurement'|'supertable'
    columns: Array<{ name: string; type?: string; comment?: string; pk?: boolean }>
    comment?: string
  }>
  functions: Array<{ name: string; signature: string; doc?: string; kind: 'native'|'aggregate' }>
  keywords: string[]
  /** 本连接历史高频标识符（宿主可选） */
  usageBoost?: Record<string, number>
}
```

- 缓存：`sessionKey + scope` → Catalog，**TTL 60s**  
- 失效：执行 DDL 检测（CREATE/ALTER/DROP/TRUNCATE）后失效；树上手动刷新；切库失效  
- 加载：`db.open` 后预热表名；列懒加载（首次 `t.` 或首次 WHERE 时拉表列）  
- 大库：表 > 5000 时只预热表名，列按需  

### E5 上下文解析（编辑器本地 + 宿主补全）

宿主接收 `{ sql, cursor, scope }`，解析光标上下文类型：

| 上下文 | 解析线索 | 提示内容 | 排序加权 |
|--------|----------|----------|----------|
| stmt_start | 行首/分号后 | 关键字、片段 | 片段+关键字 |
| select_list | SELECT 与 FROM 之间 | 列（带 alias 前缀）、函数、`*` | 当前 FROM 表的列 |
| from_item | FROM/JOIN 后 | 表/视图/测量、schema.table | 当前库优先 |
| join_on | ON 后 | 两侧表列 | |
| where/having/group/order | 对应子句 | 列、函数 | |
| qualified | `ident.` | 该 ident 作为别名时 → 表列；作为库/schema 时 → 子对象 | |
| function_arg | 函数括号内 | 依函数签名提示参数语义（列/字面量）P1 | |
| quoted_ident | 反引号/双引号内 | 仍按标识符列表，insertText 带引号 | |
| after_from_alias | `FROM t AS ` / `FROM t ` | 别名建议 `t1/t2/a` | |

**别名解析（P0 必须）：**

- 从光标向前扫描当前语句（注意字符串/注释）  
- `FROM tbl [AS] alias`、`JOIN tbl [AS] alias`  
- `alias.col` → 查 `tbl` 的 columns  
- 无别名 `tbl.col` → 直接表名  
- 多表 SELECT 无前缀时，列名带 `owner` detail：`users.id`  

### E6 方言词库（P0）

| 方言 | 关键字 | 函数示例 |
|------|--------|----------|
| mysql | SELECT…、JOIN、UNION、EXPLAIN、SHOW、DESCRIBE、USE… | COUNT SUM AVG MIN MAX CONCAT IFNULL DATE_FORMAT NOW JSON_EXTRACT |
| sqlite | 同上 + PRAGMA、GLOB、LIMIT… | COALESCE STRFTIME TOTAL RANDOM |
| postgres/timescale | + RETURNING、ILIKE、SERIAL、time_bucket… | date_trunc now() generate_series |
| influxql | SELECT FROM WHERE GROUP BY fill()… | MEAN SUM LAST FIRST |
| tdengine | SELECT FROM STABLE/TABLE INTERVAL… | NOW TIMEDIFF |

片段（snippet）例：

- `sel` → `SELECT * FROM ${table} WHERE 1=1 LIMIT 200;`  
- `ins` → `INSERT INTO ${table} (${cols}) VALUES ();`  
- `join` → `JOIN ${table} AS ${alias} ON ${alias}.${col} = ${lhs}`  

### E7 补全 UI

| ID | 行为 |
|----|------|
| E7.1 | 浮层：kind 图标/色点 + label + detail（右对齐灰字） |
| E7.2 | 选中项第二行：doc（截断） |
| E7.3 | 键盘：↑↓ 选择、Enter/Tab 应用、PageUp/Down、Esc 关 |
| E7.4 | 鼠标双击应用 |
| E7.5 | 应用列名：按 catalog 是否需要引号；`alias.col` 自动补前缀 |
| E7.6 | 应用表名：FROM/JOIN 后自动可带默认别名（设置项） |
| E7.7 | 应用函数：插入 `name(`，签名 doc 在列表展示 |
| E7.8 | 无结果时显示「无建议」 |
| E7.9 | 请求失败：静默 + 状态栏提示「补全暂不可用」 |
| E7.10 | 性能：IPC 超时 300ms 超时降级为本地关键字缓存 |

### E8 使用频率与个性化

- 插件记录 `db.completionUsage`：`{ [itemKey]: count }`，参与 sortText  
- 最近在本会话选过的表/列加权  
- 可在设置关闭「学习使用频率」  

### E9 时序库补全

| 驱动 | FROM 后 | 特殊 |
|------|---------|------|
| influxdb | measurements（bucket 内） | tag/field 分色；时间函数 |
| tdengine | table/stable | INTERVAL/STATEWINDOW 片段 |

### E10 静态回退

Catalog 未就绪时：仅关键字 + 片段 + 本地 usage，保证编辑器不卡死。

## DB-F 查询结果数据表（P0-2：新增/修改/删除/批量）

### F1 结果网格基础

| ID | 功能 |
|----|------|
| F1.1 | 表格：表头、列宽拖拽、行高紧凑 |
| F1.2 | 虚拟滚动：≥500 行仅渲染视口 |
| F1.3 | 列类型与 PK 锁标记 |
| F1.4 | NULL 灰色斜体；空串与 NULL 区分 |
| F1.5 | 单元格选中、行列选择、框选（P1） |
| F1.6 | 滚动加载/分页：默认 pageSize 200；执行时 maxRows 1000 截断提示 |
| F1.7 | 状态栏：行数、耗时、connection、truncated |
| F1.8 | 多结果集 Tab |
| F1.9 | 单元格查看器：长文本、JSON 格式化、HEX、只读 |

### F2 行状态与变更集（核心）

每行携带状态，网格可视化：

| 状态 | 样式 | 含义 |
|------|------|------|
| clean | 默认 | 未改 |
| dirty | 左侧橙条 + 单元格底色 | 本地已改未提交 |
| inserted | 左侧绿条 + `+` | 新增行 |
| deleted | 删除线 + 红条 | 标记删除未提交 |
| failed | 红角标 | 上次提交失败，可查看错误 |

```ts
type RowChange =
  | { type: 'update'; table: TableRef; key: Record<string, unknown>; set: Record<string, unknown>; original: Record<string, unknown> }
  | { type: 'insert'; table: TableRef; values: Record<string, unknown> }
  | { type: 'delete'; table: TableRef; key: Record<string, unknown> }

interface TableRef { database?: string; schema?: string; table: string }
```

### F3 单元格编辑

| ID | 功能 |
|----|------|
| F3.1 | 双击/F2 进入编辑；Esc 取消；Enter 提交单元格到本地变更集（不立即写库） |
| F3.2 | 类型感知编辑器：string/number/bool/NULL/json/date |
| F3.3 | NULL 置空按钮；表达式模式（P1：写入 SQL 表达式） |
| F3.4 | 不可更新结果（无 PK / 驱动不支持）→ 网格只读 + 说明 |
| F3.5 | 编辑时显示原值 vs 新值 |

### F4 新增行

| ID | 功能 |
|----|------|
| F4.1 | 工具栏「+ 新增」或底部空行；按表结构生成列输入 |
| F4.2 | 非空无默认值的列标红校验 |
| F4.3 | 多行连续新增；每行 inserted 状态 |
| F4.4 | 「从当前行复制」新增 |
| F4.5 | 提交时生成多条 INSERT 或批量 INSERT（驱动能力内） |

### F5 删除行

| ID | 功能 |
|----|------|
| F5.1 | 选中行「删除」→ 标记 deleted（可撤销标记） |
| F5.2 | 多选批量标记删除 |
| F5.3 | 提交时按 PK 生成 DELETE；无 PK 拒绝并提示 |
| F5.4 | prod 连接删除需确认文案展示 WHERE 键值 |

### F6 批量操作（核心）

| ID | 功能 |
|----|------|
| F6.1 | **变更集面板**（侧栏或底部）：列出全部 pending change，按类型分组 |
| F6.2 | 全选/反选；单条放弃 |
| F6.3 | **提交（Commit）**：驱动 `applyBatch`；建议包在事务中（MySQL/PG/SQLite）；失败策略 `stop-on-error` / `continue` |
| F6.4 | **回滚本地（Revert）**：清空变更集，网格回到上次查询快照 |
| F6.5 | 提交前 SQL 预览：展示将执行的 INSERT/UPDATE/DELETE 列表，可复制 |
| F6.6 | 提交结果：成功 affected 行数；失败行标记 failed + 错误信息 |
| F6.7 | 部分成功后可「仅重试失败行」 |
| F6.8 | 批量更新选定列：多行同列粘贴/填充（Excel 风格，P1） |
| F6.9 | 从结果生成 UPDATE 脚本到编辑器（不直接执行） |
| F6.10 | 只读连接/无权限：禁用 F2–F6 写路径 |

### F7 由 SQL 结果进入可编辑的前提

1. 查询基表单表（或驱动能定位 row identity）  
2. `rowIdentity.keyColumns` 非空  
3. 连接非 readOnly  
4. 驱动 `capabilities.updatableResult`  

不满足时：仍可浏览/导出；写操作引导「打开表数据」或手写 SQL。

### F8 打开表数据（表级编辑器）

- 树右键「打开数据」→ 自动 `SELECT * FROM t LIMIT 200` + 绑定 TableRef  
- 支持筛选条件构建器（列 op 值，生成 WHERE）与排序  
- 分页：LIMIT/OFFSET 或 PK 游标（P1）  
- 同一套变更集/提交逻辑  

### F9 结果内生成 DML

| 动作 | 输出 |
|------|------|
| 生成 INSERT | 选中行 → INSERT 语句到编辑器/剪贴板 |
| 生成 UPDATE | 按 PK |
| 生成 DELETE | 按 PK |
| 复制为 JSON/CSV/Markdown | 见导出 |

## DB-G 导入 / 导出（P0-4）

### G1 结果导出

| ID | 格式 | 说明 |
|----|------|------|
| G1.1 | CSV | 当前结果集或选中行；UTF-8 BOM 可选；分隔符/引用符选项 |
| G1.2 | JSON | 行对象数组；NULL 处理选项 |
| G1.3 | SQL | INSERT 语句文件；表名/事务包裹选项 |
| G1.4 | Markdown | 表格（适合文档） |
| G1.5 | 复制 | TSV（可直接贴 Excel）、JSON、SQL |
| G1.6 | 范围 | 当前页 / 全部（截断时提示仅导出已取回） / 选中行 |
| G1.7 | 目标 | 宿主保存对话框路径 |

### G2 数据导入

| ID | 功能 |
|----|------|
| G2.1 | CSV 导入向导：选文件 → 编码/分隔符/表头 → 目标表/列映射预览 → 采样 20 行 |
| G2.2 | 冲突策略：insert / upsert（驱动支持时）/ 跳过 |
| G2.3 | 预览生成的 INSERT 或 LOAD 语句 |
| G2.4 | 执行进度与成功/失败行报告 |
| G2.5 | SQLite：从另一 db 文件附加拷贝（P1） |
| G2.6 | 时序：Influx 行协议粘贴导入（P1） |

### G3 配置与会话导入导出

| 数据 | 格式 | 说明 |
|------|------|------|
| 连接列表 | JSON | 可剥离 secret |
| 控制台会话 | JSON | editors SQL 草稿 + 会话名 |
| 查询历史 | JSON/CSV | |
| 片段/用户模板 | JSON | |
| 全量备份包 | ZIP（P1） | connections + sessions + snippets（无密钥） |

### G4 对象导出（P1）

- 表 DDL + 数据 SQL dump  
- 多表导出顺序（外键）  

## DB-H 执行与查询历史

| ID | 功能 |
|----|------|
| H1 | 每次执行写 `db.queryHistory`：{ id, connectionId, sql, durationMs, rowCount, ts, error?, sessionName? } |
| H2 | 上限 500，可搜索、置顶 |
| H3 | 双击回填到当前编辑器 |
| H4 | 「从历史创建新 Tab」 |
| H5 | 敏感 SQL 打码选项（WHERE 中的 token） |

## DB-I 结果与编辑器 UX 布局

```
┌──────────┬────────────────────────────────────┬─────────────┐
│ 连接/对象树│ 会话 Tabs → SQL 编辑器 Tabs          │ 补全 doc     │
│ 搜索      │ 执行/Explain/格式化                  │ 变更集面板   │
│ 控制台会话 │────────────────────────────────────│             │
│ 历史      │ 结果网格（可编辑）分页/导出/提交回滚    │             │
└──────────┴────────────────────────────────────┴─────────────┘
```

快捷键：

| 键 | 动作 |
|----|------|
| Cmd/Ctrl+Enter | 执行当前语句 |
| Cmd/Ctrl+Shift+Enter | 执行全部 |
| Cmd/Ctrl+Space | 补全 |
| Cmd/Ctrl+S | 保存控制台会话 |
| Cmd/Ctrl+Shift+E | 导出结果 |
| Cmd/Ctrl+Shift+C | 提交变更集（需确认） |
| F5 | 执行 |
| Cmd/Ctrl+/ | 注释 |

## DB-J 标准层展示一致性

| ID | 功能 |
|----|------|
| J1 | 全部使用壳子 Token，themeAware |
| J2 | 驱动徽章、readOnly/prod 徽章统一组件 |
| J3 | 空态/错误/Loading 骨架统一 |
| J4 | Toast 经 `enest.ui.toast` |
| J5 | 危险操作确认框文案统一（含 SQL 预览） |

## DB-K 宿主 API 增补（相对前稿）

```ts
// 结果集变更
db.applyChanges({ sessionKey, changes: RowChange[], mode: 'stop-on-error'|'continue', confirmed: boolean })
  : Promise<BatchResult>
// BatchResult: { ok, results: Array<{ index; ok; affected?; error?; sql }>, durationMs }

// 导入
db.importPreview({ sessionKey, table: TableRef, csvText/路径, options })
db.importRun({ sessionKey, table, options, confirmed })

// 控制台会话不经过宿主 —— 插件 storage 即可
// （宿主不实现 db.session.* 业务存储）
```

`db.execute` 返回值必须含 `rowIdentity`（当 updatable 时）。

## DB-L 错误与边界

| 场景 | 行为 |
|------|------|
| 无 PK 更新 | 拒绝并说明 |
| 批量部分失败 | failed 行保留变更，可重试 |
| catalog 超时 | 关键字回退补全 |
| 会话 storage 损坏 | 重建空列表并 toast |
| 导出路径无权限 | 宿主错误信息透传 |
| 只读连接提交 | 直接禁用 + 提示 |
| 超大 CSV 导入 | 流式预览限制采样，避免撑爆内存 |

---

# 权限与文档同步

| 权限 | 方法前缀 |
|------|----------|
| `vault.write` | vault.set/remove |
| `ssh.session` | ssh.connect/write/resize/disconnect/listSessions |
| `ssh.exec` | ssh.exec/metrics.*/completion.suggest |
| `ssh.sftp` | ssh.sftp.* / ssh.pickLocalFile |
| `db.connect` | db.open/close/test/listSessions/pickSqliteFile |
| `db.query` | db.execute/explain/cancel/applyChanges/importRun/importPreview |
| `db.schema` | db.schema.*/db.completion/db.dialects.list |

manifest 均含 `storage.local` + `ui.*` + `notify` + `clipboard.write`。

## [S3] Out of Scope

- SSH：分屏、完整 SFTP 柜、多机广播、监控落盘告警中心  
- DB：ER 图、可视化表设计器、跨库事务、SSH 隧道实做、Flux IDE  
- 宿主独立 profile JSON 旁路  
- Redis/Mongo/ClickHouse 驱动  
- 运行时权限弹窗、云同步  

## Tasks

- [x] T1: 权限/类型/`DATA_DIR_NAME='.eNest'`/schema — acceptance: typecheck 通过（covers: 2.0）
- [ ] T2: secretVault + vault IPC — acceptance: set→secretRef；无权限拒绝（covers: 2.0）
- [ ] T3: sshSessionManager（connect/exec/metrics/sftp/completion）— acceptance: 入参 secretRef 可建连；事件契约正确（covers: SSH-C/E/F/G）
- [ ] T4: db 驱动层 + completion catalog/上下文 + applyChanges — acceptance: 五驱动 QueryResult+rowIdentity；补全上下文 E5 表可测（covers: DB-A/E/F）
- [x] T5: preload/handlers 暴露 vault/ssh/db — acceptance: METHOD_PERMISSION 全覆盖（covers: 2.0）
- [ ] T6: `com.enest.ssh` UI — acceptance: 资产/终端/补全/历史/监控/会话 storage 恢复（covers: SSH-A–I）
- [ ] T7: `com.enest.database` UI — acceptance: SQL 补全优先；结果集增删改批；控制台会话持久化；导入导出（covers: DB-B–I）
- [x] T8: mockMarket/permissions.md/typecheck/build — acceptance: 全绿（covers: 权限文档）
