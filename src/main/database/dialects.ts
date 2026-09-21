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

const MYSQL_KW = [...SQL_COMMON_KW, 'WITH','REPLACE','DUPLICATE','KEY','ENGINE','CHARSET','COLLATE','AUTO_INCREMENT','IFNULL','NOW','SHOW','PROCESSLIST','KILL','WINDOW','OVER','PARTITION','CTE','RECURSIVE']

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
      AGG('GROUP_CONCAT'),
      FN('CONCAT', 'CONCAT(a, b, ...)', '字符串拼接'),
      FN('CONCAT_WS', 'CONCAT_WS(sep, a, b, ...)', '带分隔符拼接'),
      FN('SUBSTRING', 'SUBSTRING(s, pos, len)', '子串'),
      FN('LEFT', 'LEFT(s, n)', '左 n 字符'),
      FN('RIGHT', 'RIGHT(s, n)', '右 n 字符'),
      FN('LENGTH', 'LENGTH(s)', '字节长度'),
      FN('CHAR_LENGTH', 'CHAR_LENGTH(s)', '字符长度'),
      FN('TRIM', 'TRIM(s)', '去首尾空白'),
      FN('REPLACE', 'REPLACE(s, from, to)', '字符串替换'),
      FN('UPPER', 'UPPER(s)', '转大写'),
      FN('LOWER', 'LOWER(s)', '转小写'),
      FN('IFNULL', 'IFNULL(expr, alt)', '空值替换'),
      FN('NULLIF', 'NULLIF(a, b)', '相等返回 NULL'),
      FN('COALESCE', 'COALESCE(a, b, ...)', '首个非空'),
      FN('DATE_FORMAT', "DATE_FORMAT(date, fmt)", '日期格式化'),
      FN('DATE_ADD', 'DATE_ADD(date, INTERVAL n unit)', '日期加'),
      FN('DATE_SUB', 'DATE_SUB(date, INTERVAL n unit)', '日期减'),
      FN('DATEDIFF', 'DATEDIFF(d1, d2)', '日期差（天）'),
      FN('NOW', 'NOW()', '当前时间'),
      FN('CURDATE', 'CURDATE()', '当前日期'),
      FN('UNIX_TIMESTAMP', 'UNIX_TIMESTAMP(date)', '纪元秒'),
      FN('FROM_UNIXTIME', 'FROM_UNIXTIME(ts)', '纪元转时间'),
      FN('JSON_EXTRACT', 'JSON_EXTRACT(json, path)', 'JSON 提取'),
      FN('JSON_UNQUOTE', 'JSON_UNQUOTE(val)', 'JSON 去引号'),
      FN('CAST', 'CAST(expr AS type)', '类型转换'),
      FN('ROW_NUMBER', 'ROW_NUMBER() OVER (...)', '行号窗口'),
      FN('IF', 'IF(cond, a, b)', '条件表达式')
    ],
    snippets: [
      { prefix: 'sel', body: 'SELECT * FROM ${table} WHERE 1=1 LIMIT 200;', detail: '查询样例' },
      { prefix: 'ins', body: 'INSERT INTO ${table} (${cols})\nVALUES ();', detail: '插入' },
      { prefix: 'ups', body: 'INSERT INTO ${table} (${cols})\nVALUES ()\nON DUPLICATE KEY UPDATE ;', detail: 'UPSERT' },
      { prefix: 'join', body: 'JOIN ${table} AS ${alias} ON ${alias}.${col} = ${lhs}', detail: 'JOIN' },
      { prefix: 'lj', body: 'LEFT JOIN ${table} AS ${alias} ON ${alias}.${col} = ${lhs}', detail: 'LEFT JOIN' },
      { prefix: 'cnt', body: 'SELECT COUNT(*) FROM ${table};', detail: '计数' },
      { prefix: 'cte', body: 'WITH ${name} AS (\n  SELECT \n  FROM ${table}\n)\nSELECT *\nFROM ${name};', detail: 'CTE 查询' },
      { prefix: 'pg', body: 'SELECT *\nFROM ${table}\nWHERE ${col} > ${val}\nORDER BY ${col} DESC\nLIMIT 200;', detail: '分页查询' }
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
      AGG('STRING_AGG'),
      FN('time_bucket', 'time_bucket(width, time)', 'Timescale 时间桶'),
      FN('date_trunc', "date_trunc(field, ts)", '时间截断'),
      FN('date_part', "date_part(field, ts)", '时间部分'),
      FN('age', 'age(ts1, ts2)', '时间差间隔'),
      FN('now', 'now()', '当前时间'),
      FN('generate_series', 'generate_series(start, stop, step)', '序列生成'),
      FN('COALESCE', 'COALESCE(a, b, ...)', '首个非空'),
      FN('NULLIF', 'NULLIF(a, b)', '相等返回 NULL'),
      FN('concat', 'concat(a, b, ...)', '字符串拼接'),
      FN('substring', 'substring(s, from, for)', '子串'),
      FN('split_part', 'split_part(s, sep, n)', '分段取值'),
      FN('regexp_replace', 'regexp_replace(s, re, repl)', '正则替换'),
      FN('to_char', 'to_char(ts, fmt)', '格式化'),
      FN('to_timestamp', 'to_timestamp(ts)', '纪元转时间'),
      FN('extract', "extract(field FROM ts)", '提取时间字段'),
      FN('row_number', 'row_number() OVER (...)', '行号窗口'),
      FN('jsonb_build_object', 'jsonb_build_object(k, v, ...)', '构造 JSON'),
      FN('cast', 'cast(expr AS type)', '类型转换')
    ],
    snippets: [
      { prefix: 'sel', body: 'SELECT * FROM ${table} LIMIT 200;', detail: '查询样例' },
      { prefix: 'bucket', body: "SELECT time_bucket('1 hour', time) AS bucket, avg(value) FROM ${table} GROUP BY bucket;", detail: '时间桶聚合' },
      { prefix: 'ups', body: 'INSERT INTO ${table} (${cols})\nVALUES ()\nON CONFLICT (id) DO UPDATE SET ;', detail: 'UPSERT' },
      { prefix: 'cte', body: 'WITH ${name} AS (\n  SELECT \n  FROM ${table}\n)\nSELECT *\nFROM ${name};', detail: 'CTE 查询' },
      { prefix: 'pg', body: 'SELECT *\nFROM ${table}\nWHERE ${col} > ${val}\nORDER BY ${col} DESC\nLIMIT 200 OFFSET 0;', detail: '分页查询' }
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
