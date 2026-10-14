# 数据库宿主验证记录（2026-10-13）

当前注册 **27 个可调用驱动入口**。入口数量不等于已完成各引擎全部功能验收；兼容协议入口也不等于该产品专有功能均已支持。

## 本次实际连接验证

| 引擎 | 验证环境 | 已通过内容 |
| --- | --- | --- |
| MySQL | 临时 MySQL 8.4 容器 | 原生连接；int64 精度；事务隔离/回滚；批量编辑失败回滚；真实列/默认值/索引/外键；DDL 导出；上下文补全；建表/特殊文本默认值/外键/索引；服务端筛选排序分页；Quick 只读 200 行；取消 SLEEP 后复用连接；服务端资源指标及单位 |
| PostgreSQL | 临时 PostgreSQL 17 容器 | 与上列相同的核心路径；pg_cancel_backend 实际取消；结果流及独立只读事务连接 |
| SQLite | 本地真实文件与内存数据库，Node SQLite worker | int64；独立只读文件句柄；事务隔离/回滚；失败编辑批次回滚；200 行限制；取消抑制迟到结果；独立连接对比；表设计辅助测试另含外键/索引/列修改 |
| DuckDB | 官方 node-api 本地原生驱动 | 建表/写入；int64；事务回滚；有界流式结果 |
| Redis | 临时 Redis 8 容器 | 原生命令；INCR 大整数精确返回；TYPE/TTL；SCAN 游标分页；字符串/列表按类型浏览；Quick 拒绝写命令 |
| MongoDB | 临时 MongoDB 8 容器 | 官方驱动；JSON 操作协议；BSON int64/decimal128 精确 EJSON；collection/索引/字段样本；结果截断；Quick 只读；拒绝写聚合阶段 |
| InfluxDB 2 | 临时 InfluxDB 2.7 容器 | Flux 查询；原生 annotated CSV 解析；measurement 发现；int64 字符串保值 |
| TDengine | 临时官方服务，6041 WebSocket | 官方 SDK；超级表/子表/TAG；int64；结果限制；实际在途取消后关闭会话；重新连接；最后句柄关闭时销毁 SDK 全局连接池 |

以下入口已实现客户端适配和类型检查，但本次没有该引擎实机验收：TimescaleDB、InfluxDB 1、InfluxDB 3、SQL Server、Oracle Thin、ClickHouse、Cassandra、ScyllaDB、Neo4j、Elasticsearch、OpenSearch。

以下入口显式复用兼容协议，专有行为仍需对应产品验收：MariaDB、TiDB、OceanBase MySQL 模式、Doris、StarRocks、CockroachDB、YugabyteDB YSQL、QuestDB PGWire。Doris/StarRocks/QuestDB 不声明事务或结果编辑能力。

## 执行、只读与资源边界

- 每个控制台拥有独立 sessionKey；同会话查询、事务、编辑、导入、元数据读取避免并发占用同一连接。Quick 必须独立只读连接、每次一条只读语句、最多 200 行。
- 成功连接期间持有会话 activity，避免普通空闲连接被插件的三分钟回收或 LRU 提前断开；关闭、取消导致断连、会话列表确认外部断连或 utility 实际退出后释放。同名重连与运行时 generation 使用独立身份，迟到响应不能释放后续连接。
- Quick 与数据对比只开放已有原生只读连接/事务，或受限查询 API 的驱动：常规 MySQL/PG 家族、SQLite、DuckDB、Oracle、ClickHouse、MongoDB、Redis、Elasticsearch/OpenSearch。其余驱动返回明确限制，完整工作台查询仍可用。只读模式不代替数据库账号本身的权限控制。
- 数据对比新建独立只读连接，不使用用户当前事务；内存数据库无法通过另一个连接复用原数据，明确拒绝。两端查询全部清理后才结束请求。支持列映射、严格/文本/精确数值/JSON 规则；重复键显示歧义；结果截断明确标记部分数据。
- 行数和约 6 MiB 结果预算在流/转换阶段检查，utility IPC 另设 8 MiB 上限；utility 256 MiB JS 堆限制不能代替引擎端资源限制。HTTP 有代理配置和有界响应读取。部分客户端先收到一个数据块或一页后才能检查字节预算。
- MySQL/PostgreSQL 有实际查询取消；DuckDB interrupt、Oracle break、SQL Server request.cancel、ClickHouse query_id、HTTP AbortSignal 等按客户端能力实现。SQLite 同步本地计算不能可靠地由 worker.terminate 即时打断，宿主使用 250 ms utility 取消截止和实际进程退出兜底。SQLite/Redis/TDengine 某些取消会关闭连接，必须重连。
- utility 退役一直保留 owner/PID/exitPromise，只有真实 exit 事件才能删除记录并释放保留的 activity；kill 返回值不作为已退出的证据；晚 spawn 补发终止，必要时只对已记录的自有 child PID 强杀；未确认退出时拒绝重建同插件 utility。

## 语法与能力的实际范围

- 离线编辑器配合宿主上下文补全：表/列/别名、CTE/派生表、JOIN 条件、WHERE、INSERT/UPDATE 已写列过滤、函数与片段。它是上下文启发式补全，不是 DataGrip 完整 SQL 解析器、静态类型检查或跨方言语义验证。
- MongoDB 使用受限 JSON 操作对象，Redis 使用 JSON 命令数组，Elasticsearch/OpenSearch 使用 search JSON；Flux/Cypher/CQL 使用对应语言词表和片段。不会把这些语言当 MySQL SQL 补全。
- 表设计与参数化服务端筛选/排序/分页开放给 MySQL、PostgreSQL、SQLite 及明确的常规兼容家族。DDL 应用由宿主重新生成、要求审阅确认、拒绝未结束事务和只读连接。只有包含真实主键且可写的表结果声明 editable。
- PostgreSQL DDL 导出包含普通表列类型/默认值/identity/生成列/约束/索引；明确不包含权限、触发器、策略、序列创建。分区/继承/物化对象要求服务端 schema 导出工具。SQLite 外键名是由 PRAGMA id 构造的显示标识。
- SQL Server 客户端 decimal/money 默认转换会损失精度，当前显式拒绝该类未转换结果并提示在 SQL 中 CAST AS varchar(80)，不把近似值伪装成精确值。
- Redis SCAN 的 COUNT 是提示值，游标到 0 才代表一轮扫描完成；Lua/EVAL 等不是 Quick 只读命令。Mongo 字段结构来自有限样本，不能视为固定全量 schema。

## 资源中心

每个驱动均可显示 eNest 自身连接/查询状态，和数据库服务端指标明确区分。客户端累计 created 不是当前池大小。

| 家族 | 已实现的服务端视图 | 限制 |
| --- | --- | --- |
| MySQL | PROCESSLIST、GLOBAL STATUS、data_lock_waits、语句摘要 | performance_schema/权限/版本决定可用性 |
| PostgreSQL | pg_stat_activity、pg_stat_database、阻塞关系、pg_stat_statements；Timescale jobs | pg_stat_statements 等扩展未配置时不自动启用 |
| SQLite / DuckDB | 页数/页大小/文件字节及空闲页 / duckdb_memory | 不是操作系统 CPU/内存推算 |
| SQL Server / Oracle | 会话、数据库文件/系统计数、锁、查询视图 | 需要对应 DMV/v$ 权限；未做本次远程验收 |
| ClickHouse | processes、metrics、query_log、merges | collectors/权限决定是否有数据 |
| TDengine | performance_schema 连接、查询、事务任务 | 版本/权限相关 |
| Redis / MongoDB | INFO/CLIENT LIST/SLOWLOG / serverStatus/currentOp | 原生返回格式，不合成缺失指标 |
| Influx / Cassandra / Scylla / Neo4j / Search | 当前仅客户端状态 | 不伪造服务端监控 |

已知指标显式标注 bytes、pages、blocks、rows、count、transactions、ms、s、ps 等。MySQL/Oracle/ClickHouse 混合指标使用逐行 unit 列；无法确定的标注 `unit unavailable` 或 `server-defined / unavailable`，不推断单位。当前 SQL 会话忙或有事务时，服务端检查要求专用监控控制台。

## 可复现检查

```sh
node --test src/main/database/dbLifecycle.test.mjs
./node_modules/.bin/tsx --tsconfig tsconfig.node.json --test src/main/database/dbWorkbench.test.ts
node --test src/main/database/tableOperations.test.mjs src/main/database/compare.test.mjs
ENEST_ELECTRON_SMOKE=1 node --test src/main/database/dbUtility.smoke.test.mjs
```

原生容器测试文件：`dbRelational.integration.test.ts`、`dbDocument.integration.test.ts`。通过 `ENEST_DB_INTEGRATION` 选择单个引擎，并提供 `ENEST_DB_PORT/USER/PASSWORD/DATABASE`；Influx 另需 `ENEST_DB_ORG/BUCKET`。测试使用临时命名对象，独立测试容器由调度方创建和回收。
