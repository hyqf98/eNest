# SQL 脚本执行边界

`sqlScript.ts` 是没有宿主依赖的纯解析模块。它输出 server SQL、原文 UTF-16 偏移、行范围和单元类型；不执行 SQL。插件通过 `eNest_plugin/scripts/generate-db-execution-parser.mjs` 生成 `executionParser.js`，运行时不依赖宿主源码目录。修改解析规则后生成一次，使用 `--check` 校验。`executionRange.js` 只负责选区、光标和整文档选择。

- MySQL / MariaDB：识别行首 `DELIMITER`，保留过程、函数、触发器及复合块。自定义分隔符必须为 1–16 个标点，且不能与注释冲突；分隔符与指令不发往服务器。
- SQL Server：每个 `GO` 区间作为一个请求，保留 `DECLARE`、条件和过程的批次作用域。接受 `GO` / `GO 1`；明确拒绝重复次数和 SQLCMD 指令。事务命令使用工具栏，或各自放在一个 GO 批次。
- Oracle：识别 q/nq 引号、匿名块、局部过程声明和包；独立 `/` 行只作分隔符，不重复执行前条 SQL。PL/SQL 的末尾分号保留，普通 SQL 的末尾分号移除。包定义通过 `/` 或选区末尾结束。
- SQLite：触发器的 BEGIN/END 与 CASE 不按内部分号切开。
- PostgreSQL：保留 dollar quote、E 字符串和 SQL BEGIN ATOMIC 函数体。

这些是客户端边界规则，语句本身是否被某个兼容数据库版本支持仍由其服务端判定。解析器不尝试模拟完整 SQL 语法或执行客户端文件/命令。

`executionPolicy.ts` 在首个请求前检查整个执行计划，并在每个请求前根据实时事务状态再检查一次。它拒绝无法跟踪的嵌入式事务控制、脚本中切换转义规则，以及 MySQL / Oracle 活跃事务中的隐式提交 DDL / 过程执行。过程定义中的事务词不会当作正在执行的事务命令。只读、Quick、写确认、参数限制仍在 `dbExecute` 统一验证。

MySQL 和 SQL Server 控制台持有同一物理连接，临时对象和会话变量跨语句保持一致。MySQL 从 OK 状态包同步事务；失败 CALL 通过无副作用 DO 0 获取状态，读取失败销毁连接。SQL Server 每批次后回读 `@@TRANCOUNT`，Oracle 在 PL/SQL 失败后读取 `transactionInProgress`，保留可提交/回滚的入口。所有脚本单元沿用同一 executionId、取消和超时控制；错误给出单元序号与输入 SQL 行范围。

CALL、SQL Server batch 和 Oracle implicit results 使用已有 `QueryResult.results` 返回独立结果集。过程/批次达到界面行数上限后只丢弃多余行，继续接收后续语句，避免用显示限制取消后面的写入。用户取消和超时仍会停止执行。

验证：`sqlScript.test.ts`（边界/策略）、`sqlAdapters.test.mjs`（适配器契约）、`dbLifecycle.test.mjs`（任务/归属/预检）、插件 `database-execution-range.test.mjs`（编辑器范围）。真实适配器用 `sqlScript.integration.test.ts`，按文件开头环境变量分别运行 MySQL、PostgreSQL、SQLite；Oracle/SQL Server 的模拟测试不代表原生服务验证。
