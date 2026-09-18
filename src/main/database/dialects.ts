/**
 * database/dialects — 方言词库（关键字/函数/片段）
 * 职责：为 completion 与 db.dialects.list 提供各驱动静态词表。
 * 被 completion / dbSessionManager 引用。
 */
import type { DbDialectInfo, DbDriverId, DbDialect } from '@shared/types/ssh-db'

const SQL_COMMON_KW = [
  'SELECT','FROM','WHERE','AND','OR','NOT','INSERT','INTO','VALUES','UPDATE','SET','DELETE',
  'CREATE','TABLE','ALTER','DROP','INDEX','VIEW','DATABASE','SCHEMA','JOIN','LEFT','RIGHT',
  'INNER','OUTER','FULL','CROSS','ON','GROUP','BY','HAVING','ORDER','ASC','DESC','LIMIT',
  'OFFSET','UNION','ALL','DISTINCT','AS','IN','BETWEEN','LIKE','IS','NULL','TRUE','FALSE',
  'CASE','WHEN','THEN','ELSE','END','EXISTS','COUNT','PRIMARY','KEY','FOREIGN','REFERENCES',
  'CONSTRAINT','DEFAULT','UNIQUE','CHECK','EXPLAIN','DESCRIBE','SHOW','USE','TRUNCATE',
  'BEGIN','COMMIT','ROLLBACK','TRANSACTION'
]

const MYSQL_KW = [...SQL_COMMON_KW, 'REPLACE','DUPLICATE','KEY','ENGINE','CHARSET','COLLATE','AUTO_INCREMENT','IFNULL','NOW','SHOW','PROCESSLIST','KILL']

const SQLITE_KW = [...SQL_COMMON_KW, 'PRAGMA','GLOB','ATTACH','DETACH','VACUUM','WITHOUT','ROWID','AUTOINCREMENT','IF','NULLS','FIRST','LAST']

const PG_KW = [
  ...SQL_COMMON_KW, 'RETURNING','ILIKE','SERIAL','BIGSERIAL','TIMESTAMPTZ','JSONB','ARRAY',
  'LATERAL','WITH','RECURSIVE','CONFLICT','DO','NOTHING','ANALYZE','VACUUM','GRANT','REVOKE'
]

const INFLUX_KW = ['SELECT','FROM','WHERE','GROUP','BY','ORDER','LIMIT','OFFSET','FILL','SHOW','MEASUREMENTS','TAG','FIELD','KEYS','DATABASES','DROP','CREATE','RETENTION','POLICY','INTO','TZ']

const TDENGINE_KW = ['SELECT','FROM','WHERE','GROUP','BY','ORDER','LIMIT','OFFSET','INTERVAL','STATE_WINDOW','SHOW','STABLES','TABLES','DATABASES','CREATE','STABLE','TABLE','DROP','INSERT','INTO','VALUES','TAGS']

const AGG = (n: string): { name: string; signature: string; doc?: string; kind: 'aggregate' } => ({
  name: n,
  signature: `${n}(expr)`,
  doc: `聚合函数 ${n}`,
  kind: 'aggregate'
})
const FN = (n: string, sig: string, doc?: string): { name: string; signature: string; doc?: string; kind: 'native' } => ({
  name: n,
  signature: sig,
  doc,
  kind: 'native'
})

export const DIALECT_INFO: Record<DbDriverId, DbDialectInfo> = {
  mysql: {
    id: 'mysql',
    dialect: 'mysql',
    label: 'MySQL',
    defaultPort: 3306,
    keywords: MYSQL_KW,
    functions: [
      AGG('COUNT'), AGG('SUM'), AGG('AVG'), AGG('MIN'), AGG('MAX'),
      FN('CONCAT', 'CONCAT(a, b, ...)', '字符串拼接'),
      FN('IFNULL', 'IFNULL(expr, alt)', '空值替换'),
      FN('DATE_FORMAT', "DATE_FORMAT(date, fmt)", '日期格式化'),
      FN('NOW', 'NOW()', '当前时间'),
      FN('JSON_EXTRACT', 'JSON_EXTRACT(json, path)', 'JSON 提取'),
      FN('COALESCE', 'COALESCE(a, b, ...)', '首个非空'),
      FN('IF', 'IF(cond, a, b)', '条件表达式')
    ],
    snippets: [
      { prefix: 'sel', body: 'SELECT * FROM ${table} WHERE 1=1 LIMIT 200;', detail: '查询样例' },
      { prefix: 'ins', body: 'INSERT INTO ${table} (${cols}) VALUES ();', detail: '插入' },
      { prefix: 'join', body: 'JOIN ${table} AS ${alias} ON ${alias}.${col} = ${lhs}', detail: 'JOIN' },
      { prefix: 'cnt', body: 'SELECT COUNT(*) FROM ${table};', detail: '计数' }
    ]
  },
  sqlite: {
    id: 'sqlite',
    dialect: 'sqlite',
    label: 'SQLite',
    keywords: SQLITE_KW,
    functions: [
      AGG('COUNT'), AGG('SUM'), AGG('AVG'), AGG('MIN'), AGG('MAX'), AGG('TOTAL'),
      FN('COALESCE', 'COALESCE(a, b, ...)', '首个非空'),
      FN('STRFTIME', "STRFTIME(fmt, date)", '日期格式化'),
      FN('RANDOM', 'RANDOM()', '随机整数'),
      FN('ABS', 'ABS(x)', '绝对值'),
      FN('LENGTH', 'LENGTH(s)', '长度')
    ],
    snippets: [
      { prefix: 'sel', body: 'SELECT * FROM ${table} LIMIT 200;', detail: '查询样例' },
      { prefix: 'ins', body: 'INSERT INTO ${table} (${cols}) VALUES ();', detail: '插入' },
      { prefix: 'pragma', body: 'PRAGMA table_info(${table});', detail: '表结构' }
    ]
  },
  timescale: {
    id: 'timescale',
    dialect: 'postgres',
    label: 'TimescaleDB',
    defaultPort: 5432,
    keywords: PG_KW,
    functions: [
      AGG('COUNT'), AGG('SUM'), AGG('AVG'), AGG('MIN'), AGG('MAX'),
      FN('time_bucket', 'time_bucket(width, time)', 'Timescale 时间桶'),
      FN('date_trunc', "date_trunc(field, ts)", '时间截断'),
      FN('now', 'now()', '当前时间'),
      FN('generate_series', 'generate_series(start, stop, step)', '序列生成'),
      FN('COALESCE', 'COALESCE(a, b, ...)', '首个非空')
    ],
    snippets: [
      { prefix: 'sel', body: 'SELECT * FROM ${table} LIMIT 200;', detail: '查询样例' },
      { prefix: 'bucket', body: "SELECT time_bucket('1 hour', time) AS bucket, avg(value) FROM ${table} GROUP BY bucket;", detail: '时间桶聚合' }
    ]
  },
  influxdb: {
    id: 'influxdb',
    dialect: 'influxql',
    label: 'InfluxDB',
    defaultPort: 8086,
    keywords: INFLUX_KW,
    functions: [
      AGG('MEAN'), AGG('SUM'), AGG('COUNT'), AGG('MIN'), AGG('MAX'),
      FN('LAST', 'LAST(field)', '末值'), FN('FIRST', 'FIRST(field)', '首值'),
      FN('SPREAD', 'SPREAD(field)', '极差')
    ],
    snippets: [
      { prefix: 'sel', body: 'SELECT * FROM "${measurement}" WHERE time > now() - 1h LIMIT 200;', detail: '近 1 小时' },
      { prefix: 'mean', body: 'SELECT MEAN("value") FROM "${measurement}" WHERE time > now() - 1h GROUP BY time(1m);', detail: '分钟均值' }
    ]
  },
  tdengine: {
    id: 'tdengine',
    dialect: 'tdengine',
    label: 'TDengine',
    defaultPort: 6030,
    keywords: TDENGINE_KW,
    functions: [
      FN('NOW', 'NOW()', '当前时间'),
      FN('TIMEDIFF', 'TIMEDIFF(ts1, ts2, unit)', '时间差'),
      AGG('AVG'), AGG('SUM'), AGG('COUNT'), AGG('MIN'), AGG('MAX')
    ],
    snippets: [
      { prefix: 'sel', body: 'SELECT * FROM ${table} LIMIT 200;', detail: '查询样例' },
      { prefix: 'interval', body: 'SELECT _wstart, AVG(col) FROM ${table} INTERVAL(1m);', detail: '窗口聚合' }
    ]
  }
}

export function dialectKeywords(dialect: DbDialect): string[] {
  for (const info of Object.values(DIALECT_INFO)) {
    if (info.dialect === dialect) return info.keywords ?? SQL_COMMON_KW
  }
  return SQL_COMMON_KW
}

export function dialectFunctions(dialect: DbDialect): NonNullable<DbDialectInfo['functions']> {
  for (const info of Object.values(DIALECT_INFO)) {
    if (info.dialect === dialect) return info.functions ?? []
  }
  return []
}

export function dialectSnippets(dialect: DbDialect): NonNullable<DbDialectInfo['snippets']> {
  for (const info of Object.values(DIALECT_INFO)) {
    if (info.dialect === dialect) return info.snippets ?? []
  }
  return []
}

export function listDialects(): DbDialectInfo[] {
  return Object.values(DIALECT_INFO)
}

export function driverDefaultPort(id: DbDriverId): number | undefined {
  return DIALECT_INFO[id]?.defaultPort
}

export function driverDialect(id: DbDriverId): DbDialect {
  return DIALECT_INFO[id]?.dialect ?? 'mysql'
}
