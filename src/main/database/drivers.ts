/**
 * database/drivers — 统一 DbDriver 抽象与五驱动实现
 * 职责：mysql2 / pg(Timescale) / node:sqlite / InfluxDB HTTP / TDengine REST
 *      统一 test/open/close/execute/explain/schema/completionCatalog/applyBatch/importCsv。
 * 被 dbSessionManager 调用；不直接暴露给插件。
 * 关键依赖：mysql2/promise、pg、node:sqlite、electron safeStorage（经 vault 解密后的明文由上层传入）。
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type {
  BatchResult,
  BatchResultItem,
  CompletionCatalog,
  DbColumnMeta,
  DbConnectionConfig,
  DbDriverId,
  DbTestResult,
  QueryResult,
  QueryResultColumn,
  RowChange,
  SchemaObject,
  TableDetail,
  TableRef
} from '@shared/types/ssh-db'
import { driverDefaultPort, DIALECT_INFO } from '@main/database/dialects'

export const DEFAULT_MAX_ROWS = 1000

export interface DriverHandle {
  id: DbDriverId
  /** mysql2 pool / pg Client / DatabaseSync / null for http */
  raw: unknown
  config: DbConnectionConfig
  readOnly: boolean
  password?: string
  database?: string
}

export interface DbDriver {
  id: DbDriverId
  label: string
  dialect: string
  defaultPort?: number
  capabilities: {
    multiStatement: boolean
    explain: boolean
    schemas: boolean
    timeSeries: boolean
    fileBased: boolean
    updatableResult: boolean
    ddl: boolean
    import: boolean
  }
  test(config: DbConnectionConfig, password?: string): Promise<DbTestResult>
  open(config: DbConnectionConfig, password?: string): Promise<DriverHandle>
  close(h: DriverHandle): Promise<void>
  execute(
    h: DriverHandle,
    sql: string,
    opts?: { maxRows?: number; timeoutMs?: number; params?: unknown[] | Record<string, unknown> }
  ): Promise<QueryResult>
  explain?(h: DriverHandle, sql: string): Promise<QueryResult>
  listDatabases(h: DriverHandle): Promise<string[]>
  listSchemas(h: DriverHandle, database?: string): Promise<string[]>
  listTables(h: DriverHandle, scope: { database?: string; schema?: string }): Promise<SchemaObject[]>
  describeTable(
    h: DriverHandle,
    scope: { database?: string; schema?: string },
    table: string
  ): Promise<TableDetail>
  getDdl?(h: DriverHandle, scope: { database?: string; schema?: string }, table: string): Promise<string>
  completionCatalog(
    h: DriverHandle,
    scope: { database?: string; schema?: string }
  ): Promise<CompletionCatalog>
  applyBatch?(h: DriverHandle, changes: RowChange[], mode: 'stop-on-error' | 'continue'): Promise<BatchResult>
}

function durationSince(t0: number): number {
  return Date.now() - t0
}

function emptyResult(sql: string, t0: number, affectedRows?: number): QueryResult {
  return {
    columns: [],
    rows: [],
    rowCount: 0,
    affectedRows,
    durationMs: durationSince(t0),
    sql
  }
}

function truncateRows(
  columns: QueryResultColumn[],
  rows: unknown[][],
  rowIdentityKeys: unknown[][] | null,
  maxRows: number
): { rows: unknown[][]; truncated: boolean; keys: unknown[][] | null } {
  if (rows.length <= maxRows) return { rows, truncated: false, keys: rowIdentityKeys }
  return {
    rows: rows.slice(0, maxRows),
    truncated: true,
    keys: rowIdentityKeys ? rowIdentityKeys.slice(0, maxRows) : null
  }
}

function quoteIdent(name: string): string {
  return `\`${String(name).replace(/`/g, '``')}\``
}

function quotePg(name: string): string {
  return `"${String(name).replace(/"/g, '""')}"`
}

/** 标识符安全校验：拒绝引号/注释/控制字符，防止拼接注入 */
function assertSafeIdent(name: string, what = 'identifier'): string {
  const s = String(name ?? '')
  if (!s || s.length > 256) throw new Error(`invalid ${what}`)
  if (/[`"';\\]|--|\/\*|\u0000/.test(s)) throw new Error(`invalid ${what}: ${s}`)
  return s
}

function tableRefToMysql(t: TableRef): string {
  return t.database
    ? `${quoteIdent(assertSafeIdent(t.database, 'database'))}.${quoteIdent(assertSafeIdent(t.table, 'table'))}`
    : quoteIdent(assertSafeIdent(t.table, 'table'))
}

function tableRefToPg(t: TableRef): string {
  const schema = t.schema ? `${quotePg(assertSafeIdent(t.schema, 'schema'))}.` : ''
  return `${schema}${quotePg(assertSafeIdent(t.table, 'table'))}`
}

function sqlLiteral(v: unknown): string {
  if (v === null || v === undefined) return 'NULL'
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL'
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE'
  return `'${String(v).replace(/'/g, "''")}'`
}

function phSeq(flavor: 'mysql' | 'pg' | 'sqlite', count: number, offset = 0): string {
  if (flavor === 'pg') {
    return Array.from({ length: count }, (_, i) => `$${offset + i + 1}`).join(', ')
  }
  return Array.from({ length: count }, () => '?').join(', ')
}

function buildDml(
  change: RowChange,
  flavor: 'mysql' | 'pg' | 'sqlite'
): { sql: string; params: unknown[]; ok: boolean; error?: string } {
  const q =
    flavor === 'mysql'
      ? quoteIdent
      : flavor === 'pg'
        ? quotePg
        : (n: string) => `"${String(n).replace(/"/g, '""')}"`
  try {
    const tref =
      flavor === 'mysql'
        ? tableRefToMysql(change.table)
        : flavor === 'pg'
          ? tableRefToPg(change.table)
          : q(assertSafeIdent(change.table.table, 'table'))
    if (change.type === 'insert') {
      const cols = Object.keys(change.values).map((c) => assertSafeIdent(c, 'column'))
      if (cols.length === 0) return { sql: '', params: [], ok: false, error: 'insert with no columns' }
      const params = cols.map((c) => (change.values as Record<string, unknown>)[c])
      return {
        sql: `INSERT INTO ${tref} (${cols.map(q).join(', ')}) VALUES (${phSeq(flavor, cols.length)})`,
        params,
        ok: true
      }
    }
    if (change.type === 'update') {
      const keys = Object.keys(change.key).map((c) => assertSafeIdent(c, 'column'))
      const sets = Object.keys(change.set).map((c) => assertSafeIdent(c, 'column'))
      if (keys.length === 0)
        return { sql: '', params: [], ok: false, error: 'update without key (no PK?)' }
      if (sets.length === 0)
        return { sql: '', params: [], ok: false, error: 'update with empty set' }
      const setParams = sets.map((c) => (change.set as Record<string, unknown>)[c])
      const keyParams = keys.map((c) => (change.key as Record<string, unknown>)[c])
      const setPh = sets.map((c, i) => `${q(c)} = ${flavor === 'pg' ? `$${i + 1}` : '?'}`).join(', ')
      const keyPh = keys
        .map((c, i) => `${q(c)} = ${flavor === 'pg' ? `$${sets.length + i + 1}` : '?'}`)
        .join(' AND ')
      return {
        sql: `UPDATE ${tref} SET ${setPh} WHERE ${keyPh}`,
        params: [...setParams, ...keyParams],
        ok: true
      }
    }
    const keys = Object.keys(change.key).map((c) => assertSafeIdent(c, 'column'))
    if (keys.length === 0)
      return { sql: '', params: [], ok: false, error: 'delete without key (no PK?)' }
    const keyParams = keys.map((c) => (change.key as Record<string, unknown>)[c])
    const keyPh = keys
      .map((c, i) => `${q(c)} = ${flavor === 'pg' ? `$${i + 1}` : '?'}`)
      .join(' AND ')
    return {
      sql: `DELETE FROM ${tref} WHERE ${keyPh}`,
      params: keyParams,
      ok: true
    }
  } catch (err) {
    return { sql: '', params: [], ok: false, error: (err as Error).message }
  }
}

async function runBatchGeneric(
  h: DriverHandle,
  changes: RowChange[],
  mode: 'stop-on-error' | 'continue',
  flavor: 'mysql' | 'pg' | 'sqlite',
  exec: (sql: string, params: unknown[]) => Promise<{ affectedRows?: number; error?: string }>
): Promise<BatchResult> {
  if (h.readOnly) throw new Error('connection is read-only')
  const t0 = Date.now()
  const results: BatchResultItem[] = []
  let allOk = true
  for (let i = 0; i < changes.length; i++) {
    const change = changes[i]!
    const dml = buildDml(change, flavor)
    if (!dml.ok) {
      results.push({ index: i, ok: false, error: dml.error ?? 'invalid change', sql: dml.sql })
      allOk = false
      if (mode === 'stop-on-error') break
      continue
    }
    try {
      const r = await exec(dml.sql, dml.params)
      if (r.error) {
        results.push({ index: i, ok: false, error: r.error, sql: dml.sql })
        allOk = false
        if (mode === 'stop-on-error') break
      } else {
        results.push({ index: i, ok: true, affected: r.affectedRows ?? 0, sql: dml.sql })
      }
    } catch (err) {
      results.push({ index: i, ok: false, error: (err as Error).message, sql: dml.sql })
      allOk = false
      if (mode === 'stop-on-error') break
    }
  }
  return { ok: allOk, results, durationMs: durationSince(t0) }
}

// —— MySQL ——

async function loadMysql() {
  return (await import('mysql2/promise')) as typeof import('mysql2/promise')
}

const mysqlDriver: DbDriver = {
  id: 'mysql',
  label: 'MySQL',
  dialect: 'mysql',
  defaultPort: 3306,
  capabilities: {
    multiStatement: true,
    explain: true,
    schemas: true,
    timeSeries: false,
    fileBased: false,
    updatableResult: true,
    ddl: true,
    import: true
  },
  async test(config, password) {
    const t0 = Date.now()
    try {
      const mysql = await loadMysql()
      const conn = await mysql.createConnection({
        host: config.host,
        port: config.port ?? 3306,
        user: config.username,
        password: password ?? '',
        database: config.database,
        connectTimeout: Math.min(10_000, config.options?.timeoutMs ? Number(config.options.timeoutMs) : 8000),
        ssl: config.options?.ssl ? {} : undefined,
        charset: config.options?.charset
      })
      const [rows] = await conn.query('SELECT VERSION() AS v')
      const version = (rows as Array<{ v: string }>)[0]?.v
      await conn.end()
      return { ok: true, message: 'connected', version, latencyMs: durationSince(t0) }
    } catch (err) {
      return { ok: false, message: (err as Error).message, latencyMs: durationSince(t0) }
    }
  },
  async open(config, password) {
    const mysql = await loadMysql()
    const pool = mysql.createPool({
      host: config.host,
      port: config.port ?? 3306,
      user: config.username,
      password: password ?? '',
      database: config.database,
      waitForConnections: true,
      connectionLimit: 5,
      charset: config.options?.charset,
      ssl: config.options?.ssl ? {} : undefined,
      multipleStatements: true
    })
    return {
      id: 'mysql',
      raw: pool,
      config,
      readOnly: config.options?.readOnly === true,
      password,
      database: config.database
    }
  },
  async close(h) {
    await (h.raw as import('mysql2/promise').Pool).end()
  },
  async execute(h, sql, opts) {
    if (h.readOnly && /^\s*(INSERT|UPDATE|DELETE|DROP|TRUNCATE|ALTER|CREATE|REPLACE)\b/i.test(sql)) {
      throw new Error('read-only connection rejects write SQL')
    }
    const t0 = Date.now()
    const maxRows = opts?.maxRows && opts.maxRows > 0 ? opts.maxRows : DEFAULT_MAX_ROWS
    const pool = h.raw as import('mysql2/promise').Pool
    const queryParams = Array.isArray(opts?.params)
      ? (opts.params as Array<string | number | boolean | null>)
      : []
    const [rows, fields] = await pool.query(sql, queryParams)
    if (Array.isArray(rows)) {
      const cols: QueryResultColumn[] = (fields as Array<{ name: string; type?: number }> | undefined)?.map((f) => ({
        name: f.name,
        dataType: f.type !== undefined ? String(f.type) : undefined
      })) ?? (rows.length > 0 ? Object.keys(rows[0] as object).map((n) => ({ name: n })) : [])
      // 单表 SELECT 才尝试 rowIdentity：用 SHOW KEYS / information_schema 代价高，
      // best-effort：结果含 id 列或全部主键候选时给出 keys
      const rowObjs = rows as Array<Record<string, unknown>>
      const dataArray = rowObjs.map((r) => cols.map((c) => r[c.name]))
      let rowIdentity: QueryResult['rowIdentity']
      // 若 SQL 是简单单表 SELECT，从 information_schema 取主键
      const simple = /^\s*SELECT\s+\*\s+FROM\s+((?:`?[\w]+`?\.)?`?[\w]+`?)(\s+WHERE|\s+ORDER|\s+LIMIT|\s*;|\s*$)/i.exec(sql)
      if (simple && cols.length > 0) {
        try {
          const tableToken = simple[1]!.replace(/`/g, '')
          const [dbName, tableName] = tableToken.includes('.')
            ? tableToken.split('.').map((x) => x)
            : [h.database, tableToken]
          const [pkRows] = await pool.query(
            'SELECT COLUMN_NAME FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND CONSTRAINT_NAME = ? ORDER BY ORDINAL_POSITION',
            [dbName ?? h.database, tableName, 'PRIMARY']
          )
          const keyColumns = (pkRows as Array<{ COLUMN_NAME: string }>).map((r) => r.COLUMN_NAME)
          if (keyColumns.length > 0) {
            const keyIdx = keyColumns.map((k) => cols.findIndex((c) => c.name === k))
            if (keyIdx.every((i) => i >= 0)) {
              const keys = dataArray.map((row) => keyIdx.map((i) => row[i]))
              const truncated = truncateRows(cols, dataArray, keys, maxRows)
              for (const c of cols) if (keyColumns.includes(c.name)) c.primaryKey = true
              return {
                columns: cols,
                rows: truncated.rows,
                rowCount: truncated.rows.length,
                durationMs: durationSince(t0),
                truncated: truncated.truncated,
                rowIdentity: { keyColumns, keys: truncated.keys ?? keys },
                sql
              }
            }
          }
        } catch {
          /* rowIdentity best-effort */
        }
      }
      const truncated = truncateRows(cols, dataArray, null, maxRows)
      return {
        columns: cols,
        rows: truncated.rows,
        rowCount: truncated.rows.length,
        durationMs: durationSince(t0),
        truncated: truncated.truncated,
        sql
      }
    }
    // OK packet
    const result = rows as { affectedRows?: number }
    return emptyResult(sql, t0, result.affectedRows)
  },
  async explain(h, sql) {
    return mysqlDriver.execute(h, `EXPLAIN ${sql}`)
  },
  async listDatabases(h) {
    const pool = h.raw as import('mysql2/promise').Pool
    const [rows] = await pool.query('SHOW DATABASES')
    return (rows as Array<Record<string, string>>).map((r) => Object.values(r)[0] as string)
  },
  async listSchemas(h) {
    return mysqlDriver.listDatabases(h)
  },
  async listTables(h, scope) {
    const pool = h.raw as import('mysql2/promise').Pool
    const db = scope.database ?? h.database
    const [rows] = await pool.query(
      'SELECT TABLE_NAME, TABLE_TYPE, TABLE_COMMENT FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?',
      [db]
    )
    return (rows as Array<{ TABLE_NAME: string; TABLE_TYPE: string; TABLE_COMMENT: string }>).map((r) => ({
      name: r.TABLE_NAME,
      type: r.TABLE_TYPE?.includes('VIEW') ? 'view' : 'table',
      database: db,
      comment: r.TABLE_COMMENT || undefined
    }))
  },
  async describeTable(h, scope, table) {
    const pool = h.raw as import('mysql2/promise').Pool
    const db = scope.database ?? h.database
    const [cols] = await pool.query(
      'SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE, COLUMN_KEY, COLUMN_COMMENT, COLUMN_DEFAULT FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION',
      [db, table]
    )
    const columns: DbColumnMeta[] = (cols as Array<Record<string, string>>).map((r) => ({
      name: r.COLUMN_NAME!,
      dataType: r.DATA_TYPE,
      nullable: r.IS_NULLABLE === 'YES',
      primaryKey: r.COLUMN_KEY === 'PRI',
      comment: r.COLUMN_COMMENT || undefined,
      default: r.COLUMN_DEFAULT ?? undefined
    }))
    const [idx] = await pool.query(
      'SELECT INDEX_NAME, COLUMN_NAME, NON_UNIQUE FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY INDEX_NAME, SEQ_IN_INDEX',
      [db, table]
    )
    const idxMap = new Map<string, { name: string; columns: string[]; unique: boolean }>()
    for (const r of idx as Array<{ INDEX_NAME: string; COLUMN_NAME: string; NON_UNIQUE: number }>) {
      const e = idxMap.get(r.INDEX_NAME) ?? { name: r.INDEX_NAME, columns: [], unique: r.NON_UNIQUE === 0 }
      e.columns.push(r.COLUMN_NAME)
      idxMap.set(r.INDEX_NAME, e)
    }
    return { table, schema: db, database: db, columns, indexes: [...idxMap.values()] }
  },
  async getDdl(h, _scope, table) {
    const pool = h.raw as import('mysql2/promise').Pool
    const [rows] = await pool.query(`SHOW CREATE TABLE ${quoteIdent(table)}`)
    return (rows as Array<Record<string, string>>)[0]?.['Create Table'] ?? ''
  },
  async completionCatalog(h, scope) {
    const info = DIALECT_INFO.mysql
    const databases = await mysqlDriver.listDatabases(h)
    const tables = await mysqlDriver.listTables(h, scope)
    const db = scope.database ?? h.database
    const detailed = await Promise.all(
      tables.slice(0, 2000).map(async (t) => {
        try {
          const detail = await mysqlDriver.describeTable(h, { database: db }, t.name)
          return {
            name: t.name,
            schema: db,
            type: t.type as 'table' | 'view',
            columns: detail.columns.map((c) => ({
              name: c.name,
              type: c.dataType,
              comment: c.comment,
              pk: c.primaryKey
            })),
            comment: t.comment
          }
        } catch {
          return { name: t.name, schema: db, type: t.type as 'table' | 'view', columns: [] }
        }
      })
    )
    return {
      dialect: 'mysql',
      databases,
      schemas: databases,
      tables: detailed,
      functions: info.functions,
      keywords: info.keywords
    }
  },
  async applyBatch(h, changes, mode) {
    return runBatchGeneric(h, changes, mode, 'mysql', async (sql, params) => {
      const pool = h.raw as import('mysql2/promise').Pool
      const [result] = await pool.query(sql, params)
      return { affectedRows: (result as { affectedRows?: number }).affectedRows }
    })
  }
}

// —— SQLite (node:sqlite，用户文件库，不是壳子 enest.db) ——

const sqliteDriver: DbDriver = {
  id: 'sqlite',
  label: 'SQLite',
  dialect: 'sqlite',
  capabilities: {
    multiStatement: true,
    explain: true,
    schemas: false,
    timeSeries: false,
    fileBased: true,
    updatableResult: true,
    ddl: true,
    import: true
  },
  async test(config) {
    const t0 = Date.now()
    const filePath = config.filePath
    if (!filePath) return { ok: false, message: 'filePath required' }
    try {
      const db = new DatabaseSync(filePath)
      const row = db.prepare('SELECT sqlite_version() AS v').get() as { v?: string } | undefined
      db.close()
      return { ok: true, message: 'opened', version: row?.v, latencyMs: durationSince(t0) }
    } catch (err) {
      return { ok: false, message: (err as Error).message, latencyMs: durationSince(t0) }
    }
  },
  async open(config) {
    const filePath = config.filePath
    if (!filePath) throw new Error('filePath required')
    const readOnly = config.options?.readOnly === true || (config as { readOnly?: boolean }).readOnly === true
    const createIfMissing =
      config.createIfMissing === true || config.options?.createIfMissing === true
    if (createIfMissing && !readOnly) {
      try {
        mkdirSync(dirname(filePath), { recursive: true })
        if (!existsSync(filePath)) writeFileSync(filePath, '')
      } catch {
        /* ignore create failure; open will error if invalid */
      }
    }
    const db = new DatabaseSync(filePath, {
      open: true,
      readOnly
    })
    return { id: 'sqlite', raw: db, config, readOnly, database: filePath }
  },
  async close(h) {
    ;(h.raw as DatabaseSync).close()
  },
  async execute(h, sql, opts) {
    if (h.readOnly && /^\s*(INSERT|UPDATE|DELETE|DROP|TRUNCATE|ALTER|CREATE|REPLACE)\b/i.test(sql)) {
      throw new Error('read-only connection rejects write SQL')
    }
    const t0 = Date.now()
    const maxRows = opts?.maxRows && opts.maxRows > 0 ? opts.maxRows : DEFAULT_MAX_ROWS
    const db = h.raw as DatabaseSync
    const trimmed = sql.trim()
    const isQuery = /^\s*(SELECT|WITH|PRAGMA|EXPLAIN|VALUES)\b/i.test(trimmed)
    if (!isQuery) {
      db.exec(trimmed)
      return emptyResult(sql, t0, undefined)
    }
    const stmt = db.prepare(trimmed)
    const rawRows = stmt.all() as Array<Record<string, unknown>>
    const colNames = rawRows.length > 0 ? Object.keys(rawRows[0]!) : stmt.columns().map((c) => c.name)
    const columns: QueryResultColumn[] = colNames.map((n) => ({ name: n }))
    const dataArray = rawRows.map((r) => colNames.map((c) => r[c]))
    // 主键：PRAGMA table_info
    let rowIdentity: QueryResult['rowIdentity']
    const tableName = /^\s*SELECT\s+\*\s+FROM\s+["`]?([\w]+)["`]?/i.exec(trimmed)?.[1]
    if (tableName && colNames.length > 0) {
      try {
        const info = db.prepare(`PRAGMA table_info(${quoteIdent(tableName)})`).all() as Array<{
          name: string
          pk: number
        }>
        const keyColumns = info.filter((c) => c.pk > 0).map((c) => c.name)
        if (keyColumns.length > 0) {
          const keyIdx = keyColumns.map((k) => colNames.indexOf(k))
          if (keyIdx.every((i) => i >= 0)) {
            const keys = dataArray.map((row) => keyIdx.map((i) => row[i]))
            for (const c of columns) if (keyColumns.includes(c.name)) c.primaryKey = true
            const truncated = truncateRows(columns, dataArray, keys, maxRows)
            return {
              columns,
              rows: truncated.rows,
              rowCount: truncated.rows.length,
              durationMs: durationSince(t0),
              truncated: truncated.truncated,
              rowIdentity: { keyColumns, keys: truncated.keys ?? keys },
              sql
            }
          }
        }
      } catch {
        /* ignore */
      }
    }
    const truncated = truncateRows(columns, dataArray, null, maxRows)
    return {
      columns,
      rows: truncated.rows,
      rowCount: truncated.rows.length,
      durationMs: durationSince(t0),
      truncated: truncated.truncated,
      sql
    }
  },
  async explain(h, sql) {
    return sqliteDriver.execute(h, `EXPLAIN QUERY PLAN ${sql}`)
  },
  async listDatabases(h) {
    return [h.config.filePath ?? 'main']
  },
  async listSchemas() {
    return ['main']
  },
  async listTables(h) {
    const db = h.raw as DatabaseSync
    const rows = db
      .prepare("SELECT name, type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all() as Array<{ name: string; type: string }>
    return rows.map((r) => ({
      name: r.name,
      type: r.type === 'view' ? ('view' as const) : ('table' as const),
      schema: 'main'
    }))
  },
  async describeTable(_h, _scope, table) {
    const db = _h.raw as DatabaseSync
    const info = db.prepare(`PRAGMA table_info(${quoteIdent(table)})`).all() as Array<{
      name: string
      type: string
      notnull: number
      pk: number
      dflt_value: string | null
    }>
    return {
      table,
      schema: 'main',
      columns: info.map((c) => ({
        name: c.name,
        dataType: c.type,
        nullable: c.notnull === 0,
        primaryKey: c.pk > 0,
        default: c.dflt_value ?? undefined
      }))
    }
  },
  async getDdl(h, _scope, table) {
    const db = h.raw as DatabaseSync
    const row = db
      .prepare("SELECT sql FROM sqlite_master WHERE name = ? AND type IN ('table','view')")
      .get(table) as { sql?: string } | undefined
    return row?.sql ?? ''
  },
  async completionCatalog(h) {
    const info = DIALECT_INFO.sqlite
    const tables = await sqliteDriver.listTables(h, {})
    const detailed = await Promise.all(
      tables.map(async (t) => {
        try {
          const detail = await sqliteDriver.describeTable(h, {}, t.name)
          return {
            name: t.name,
            schema: 'main',
            type: t.type as 'table' | 'view',
            columns: detail.columns.map((c) => ({
              name: c.name,
              type: c.dataType,
              pk: c.primaryKey
            }))
          }
        } catch {
          return { name: t.name, schema: 'main', type: t.type as 'table' | 'view', columns: [] }
        }
      })
    )
    return {
      dialect: 'sqlite',
      databases: [h.config.filePath ?? 'main'],
      schemas: ['main'],
      tables: detailed,
      functions: info.functions,
      keywords: info.keywords
    }
  },
  async applyBatch(h, changes, mode) {
    return runBatchGeneric(h, changes, mode, 'sqlite', async (sql, params) => {
      const db = h.raw as DatabaseSync
      const stmt = db.prepare(sql)
      const info = stmt.run(...(params as never[]))
      return { affectedRows: Number((info as { changes?: number }).changes ?? 1) }
    })
  }
}

// —— Timescale / PostgreSQL ——

async function loadPg() {
  return (await import('pg')) as typeof import('pg')
}

const timescaleDriver: DbDriver = {
  id: 'timescale',
  label: 'TimescaleDB',
  dialect: 'postgres',
  defaultPort: 5432,
  capabilities: {
    multiStatement: false,
    explain: true,
    schemas: true,
    timeSeries: true,
    fileBased: false,
    updatableResult: true,
    ddl: true,
    import: true
  },
  async test(config, password) {
    const t0 = Date.now()
    try {
      const pg = await loadPg()
      const client = new pg.Client({
        host: config.host,
        port: config.port ?? 5432,
        user: config.username,
        password: password ?? '',
        database: config.database,
        ssl: config.options?.ssl ? { rejectUnauthorized: false } : undefined,
        statement_timeout: 10_000
      })
      await client.connect()
      const r = await client.query('SELECT version() AS v')
      await client.end()
      return {
        ok: true,
        message: 'connected',
        version: String(r.rows[0]?.v ?? ''),
        latencyMs: durationSince(t0)
      }
    } catch (err) {
      return { ok: false, message: (err as Error).message, latencyMs: durationSince(t0) }
    }
  },
  async open(config, password) {
    const pg = await loadPg()
    const client = new pg.Client({
      host: config.host,
      port: config.port ?? 5432,
      user: config.username,
      password: password ?? '',
      database: config.database,
      ssl: config.options?.ssl ? { rejectUnauthorized: false } : undefined
    })
    await client.connect()
    return {
      id: 'timescale',
      raw: client,
      config,
      readOnly: config.options?.readOnly === true,
      password,
      database: config.database
    }
  },
  async close(h) {
    await (h.raw as import('pg').Client).end()
  },
  async execute(h, sql, opts) {
    if (h.readOnly && /^\s*(INSERT|UPDATE|DELETE|DROP|TRUNCATE|ALTER|CREATE)\b/i.test(sql)) {
      throw new Error('read-only connection rejects write SQL')
    }
    const t0 = Date.now()
    const maxRows = opts?.maxRows && opts.maxRows > 0 ? opts.maxRows : DEFAULT_MAX_ROWS
    const client = h.raw as import('pg').Client
    const result = await client.query(sql, Array.isArray(opts?.params) ? opts?.params : undefined)
    const fields = result.fields ?? []
    const columns: QueryResultColumn[] = fields.map((f) => ({ name: f.name, dataType: String(f.dataTypeID) }))
    if (columns.length === 0 && result.rows.length > 0) {
      Object.keys(result.rows[0] as object).forEach((n) => columns.push({ name: n }))
    }
    const rowObjs = result.rows as Array<Record<string, unknown>>
    const dataArray = rowObjs.map((r) => columns.map((c) => r[c.name]))
    let rowIdentity: QueryResult['rowIdentity']
    const simple = /^\s*SELECT\s+\*\s+FROM\s+((?:[\w]+\.)?[\w]+)(\s+WHERE|\s+ORDER|\s+LIMIT|\s*;|\s*$)/i.exec(sql)
    if (simple && columns.length > 0) {
      try {
        const parts = simple[1]!.split('.')
        const schema = parts.length > 1 ? parts[0] : 'public'
        const table = parts[parts.length - 1]!
        const pk = await client.query(
          `SELECT a.attname FROM pg_index i
           JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
           WHERE i.indrelid = $1::regclass AND i.indisprimary`,
          [`${schema}.${table}`]
        )
        const keyColumns = pk.rows.map((r) => String(r.attname))
        if (keyColumns.length > 0) {
          const keyIdx = keyColumns.map((k) => columns.findIndex((c) => c.name === k))
          if (keyIdx.every((i) => i >= 0)) {
            const keys = dataArray.map((row) => keyIdx.map((i) => row[i]))
            for (const c of columns) if (keyColumns.includes(c.name)) c.primaryKey = true
            const truncated = truncateRows(columns, dataArray, keys, maxRows)
            return {
              columns,
              rows: truncated.rows,
              rowCount: truncated.rows.length,
              durationMs: durationSince(t0),
              truncated: truncated.truncated,
              rowIdentity: { keyColumns, keys: truncated.keys ?? keys },
              sql
            }
          }
        }
      } catch {
        /* ignore */
      }
    }
    const truncated = truncateRows(columns, dataArray, null, maxRows)
    return {
      columns,
      rows: truncated.rows,
      rowCount: truncated.rows.length,
      affectedRows: result.rowCount ?? undefined,
      durationMs: durationSince(t0),
      truncated: truncated.truncated,
      sql
    }
  },
  async explain(h, sql) {
    return timescaleDriver.execute(h, `EXPLAIN ${sql}`)
  },
  async listDatabases(h) {
    const client = h.raw as import('pg').Client
    const r = await client.query('SELECT datname FROM pg_database WHERE datistemplate = false')
    return r.rows.map((x) => String(x.datname))
  },
  async listSchemas(h) {
    const client = h.raw as import('pg').Client
    const r = await client.query(
      "SELECT schema_name FROM information_schema.schemata WHERE schema_name NOT IN ('pg_catalog','information_schema','pg_toast') ORDER BY schema_name"
    )
    return r.rows.map((x) => String(x.schema_name))
  },
  async listTables(h, scope) {
    const client = h.raw as import('pg').Client
    const schema = scope.schema ?? 'public'
    const r = await client.query(
      `SELECT table_name, table_type FROM information_schema.tables WHERE table_schema = $1 ORDER BY table_name`,
      [schema]
    )
    return r.rows.map((x) => ({
      name: String(x.table_name),
      type: String(x.table_type).includes('VIEW') ? ('view' as const) : ('table' as const),
      schema
    }))
  },
  async describeTable(h, scope, table) {
    const client = h.raw as import('pg').Client
    const schema = scope.schema ?? 'public'
    const cols = await client.query(
      `SELECT column_name, data_type, is_nullable, column_default
       FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2
       ORDER BY ordinal_position`,
      [schema, table]
    )
    const pk = await client.query(
      `SELECT a.attname FROM pg_index i
       JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
       WHERE i.indrelid = $1::regclass AND i.indisprimary`,
      [`${schema}.${table}`]
    )
    const pkSet = new Set(pk.rows.map((r) => String(r.attname)))
    return {
      table,
      schema,
      columns: cols.rows.map((r) => ({
        name: String(r.column_name),
        dataType: String(r.data_type),
        nullable: r.is_nullable === 'YES',
        primaryKey: pkSet.has(String(r.column_name)),
        default: r.column_default != null ? String(r.column_default) : undefined
      }))
    }
  },
  async getDdl(h, scope, table) {
    const schema = scope.schema ?? 'public'
    const detail = await timescaleDriver.describeTable(h, { schema }, table)
    const cols = detail.columns
      .map((c) => `  ${quotePg(c.name)} ${c.dataType}${c.primaryKey ? ' PRIMARY KEY' : ''}${c.nullable === false ? ' NOT NULL' : ''}`)
      .join(',\n')
    return `CREATE TABLE ${quotePg(schema)}.${quotePg(table)} (\n${cols}\n);`
  },
  async completionCatalog(h, scope) {
    const info = DIALECT_INFO.timescale
    const databases = await timescaleDriver.listDatabases(h)
    const schemas = await timescaleDriver.listSchemas(h)
    const schema = scope.schema ?? 'public'
    const tables = await timescaleDriver.listTables(h, { schema })
    const detailed = await Promise.all(
      tables.slice(0, 2000).map(async (t) => {
        try {
          const d = await timescaleDriver.describeTable(h, { schema }, t.name)
          return {
            name: t.name,
            schema,
            type: t.type as 'table' | 'view',
            columns: d.columns.map((c) => ({ name: c.name, type: c.dataType, pk: c.primaryKey }))
          }
        } catch {
          return { name: t.name, schema, type: t.type as 'table' | 'view', columns: [] }
        }
      })
    )
    return {
      dialect: 'postgres',
      databases,
      schemas,
      tables: detailed,
      functions: info.functions,
      keywords: info.keywords
    }
  },
  async applyBatch(h, changes, mode) {
    return runBatchGeneric(h, changes, mode, 'pg', async (sql, params) => {
      const client = h.raw as import('pg').Client
      const r = await client.query(sql, params as unknown[])
      return { affectedRows: r.rowCount ?? 0 }
    })
  }
}

// —— InfluxDB 2.x HTTP ——

function influxBase(config: DbConnectionConfig): string {
  const host = config.host || '127.0.0.1'
  const port = config.port ?? 8086
  return `http://${host}:${port}`
}

function influxAuth(config: DbConnectionConfig, password?: string): Record<string, string> {
  const token = password ?? config.ephemeralSecret
  return token ? { Authorization: `Token ${token}` } : {}
}

const influxDriver: DbDriver = {
  id: 'influxdb',
  label: 'InfluxDB',
  dialect: 'influxql',
  defaultPort: 8086,
  capabilities: {
    multiStatement: false,
    explain: false,
    schemas: false,
    timeSeries: true,
    fileBased: false,
    updatableResult: false,
    ddl: false,
    import: false
  },
  async test(config, password) {
    const t0 = Date.now()
    try {
      const res = await fetch(`${influxBase(config)}/health`, {
        headers: influxAuth(config, password)
      })
      const body = (await res.json().catch(() => ({}))) as { status?: string; message?: string }
      return {
        ok: res.ok,
        message: body.message ?? body.status ?? `HTTP ${res.status}`,
        version: (body as { version?: string }).version,
        latencyMs: durationSince(t0)
      }
    } catch (err) {
      return { ok: false, message: (err as Error).message, latencyMs: durationSince(t0) }
    }
  },
  async open(config, password) {
    return { id: 'influxdb', raw: null, config, readOnly: config.options?.readOnly !== false, password, database: config.bucket }
  },
  async close() {
    /* HTTP 无连接态 */
  },
  async execute(h, sql, opts) {
    const t0 = Date.now()
    const maxRows = opts?.maxRows && opts.maxRows > 0 ? opts.maxRows : DEFAULT_MAX_ROWS
    const bucket = h.config.bucket ?? h.config.database
    const params = new URLSearchParams({ org: h.config.org ?? '', q: sql })
    if (bucket && !/\bFROM\b/i.test(sql)) {
      // bucket 缺省时 InfluxQL 需在查询中指定
    }
    const res = await fetch(`${influxBase(h.config)}/api/v2/query?${params.toString()}`, {
      method: 'POST',
      headers: {
        ...influxAuth(h.config, h.password),
        'Content-type': 'application/vnd.flux',
        Accept: 'application/csv'
      }
    })
    const text = await res.text()
    if (!res.ok) throw new Error(text || `InfluxDB HTTP ${res.status}`)
    // annotated CSV → 简化解析：取最后 table 的记录
    const lines = text.split('\n').filter((l) => l && !l.startsWith('#'))
    if (lines.length === 0) return emptyResult(sql, t0)
    const header = lines[0]!.split(',')
    const colIdx = header.map((hname, i) => ({ name: hname, i })).filter((c) => c.name && c.name !== 'result' && c.name !== 'table')
    const rows: unknown[][] = []
    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i]!.split(',')
      rows.push(colIdx.map((c) => cols[c.i] ?? null))
    }
    const truncated = truncateRows(
      colIdx.map((c) => ({ name: c.name })),
      rows,
      null,
      maxRows
    )
    return {
      columns: colIdx.map((c) => ({ name: c.name })),
      rows: truncated.rows,
      rowCount: truncated.rows.length,
      durationMs: durationSince(t0),
      truncated: truncated.truncated,
      sql
    }
  },
  async listDatabases(h) {
    // buckets
    const res = await fetch(`${influxBase(h.config)}/api/v2/buckets`, {
      headers: influxAuth(h.config, h.password)
    })
    if (!res.ok) return [h.config.bucket ?? ''].filter(Boolean)
    const body = (await res.json()) as { buckets?: Array<{ name: string }> }
    return body.buckets?.map((b) => b.name) ?? []
  },
  async listSchemas() {
    return []
  },
  async listTables(h) {
    try {
      const r = await influxDriver.execute(h, 'SHOW MEASUREMENTS')
      return r.rows.map((row) => ({
        name: String(row[0] ?? row[row.length - 1] ?? ''),
        type: 'measurement' as const,
        database: h.config.bucket
      })).filter((x) => x.name)
    } catch {
      return []
    }
  },
  async describeTable(h, _scope, table) {
    try {
      const tagR = await influxDriver.execute(h, `SHOW TAG KEYS FROM "${table}"`)
      const fieldR = await influxDriver.execute(h, `SHOW FIELD KEYS FROM "${table}"`)
      const columns: DbColumnMeta[] = [
        { name: 'time', dataType: 'timestamp' },
        ...tagR.rows.map((r) => ({ name: String(r[0] ?? ''), dataType: 'tag' })),
        ...fieldR.rows.map((r) => ({ name: String(r[0] ?? ''), dataType: String(r[1] ?? 'field') }))
      ].filter((c) => c.name)
      return { table, columns }
    } catch (err) {
      return { table, columns: [] }
    }
  },
  async completionCatalog(h) {
    const info = DIALECT_INFO.influxdb
    const measurements = await influxDriver.listTables(h, {})
    return {
      dialect: 'influxql',
      databases: await influxDriver.listDatabases(h),
      schemas: [],
      tables: measurements.map((m) => ({
        name: m.name,
        type: 'measurement' as const,
        columns: []
      })),
      functions: info.functions,
      keywords: info.keywords
    }
  }
}

// —— TDengine REST ——

function tdBase(config: DbConnectionConfig): string {
  const host = config.host || '127.0.0.1'
  const port = config.port ?? 6030
  return `http://${host}:${port}/rest/sql`
}

const tdengineDriver: DbDriver = {
  id: 'tdengine',
  label: 'TDengine',
  dialect: 'tdengine',
  defaultPort: 6030,
  capabilities: {
    multiStatement: false,
    explain: false,
    schemas: false,
    timeSeries: true,
    fileBased: false,
    updatableResult: false,
    ddl: true,
    import: false
  },
  async test(config, password) {
    const t0 = Date.now()
    try {
      const auth = `Basic ${Buffer.from(`${config.username ?? 'root'}:${password ?? 'taosdata'}`).toString('base64')}`
      const res = await fetch(tdBase(config), {
        method: 'POST',
        headers: { Authorization: auth, 'Content-Type': 'text/plain' },
        body: 'SELECT SERVER_VERSION();'
      })
      const body = await res.json().catch(() => ({}))
      return {
        ok: res.ok,
        message: res.ok ? 'connected' : `HTTP ${res.status}`,
        version: (body as { data?: unknown[][] }).data?.[0]?.[0] as string | undefined,
        latencyMs: durationSince(t0)
      }
    } catch (err) {
      return { ok: false, message: (err as Error).message, latencyMs: durationSince(t0) }
    }
  },
  async open(config, password) {
    return { id: 'tdengine', raw: null, config, readOnly: config.options?.readOnly === true, password, database: config.database }
  },
  async close() {
    /* REST 无连接态 */
  },
  async execute(h, sql, opts) {
    if (h.readOnly && /^\s*(INSERT|UPDATE|DELETE|DROP|CREATE|ALTER)\b/i.test(sql)) {
      throw new Error('read-only connection rejects write SQL')
    }
    const t0 = Date.now()
    const maxRows = opts?.maxRows && opts.maxRows > 0 ? opts.maxRows : DEFAULT_MAX_ROWS
    const auth = `Basic ${Buffer.from(`${h.config.username ?? 'root'}:${h.password ?? 'taosdata'}`).toString('base64')}`
    const db = h.config.database
    const url = db ? `${tdBase(h.config)}/${encodeURIComponent(db)}` : tdBase(h.config)
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: auth, 'Content-Type': 'text/plain' },
      body: sql
    })
    const body = (await res.json().catch(() => ({}))) as {
      code?: number
      desc?: string
      column_meta?: Array<[string, number, number]>
      data?: unknown[][]
      rows?: number
    }
    if (!res.ok || (body.code !== undefined && body.code !== 0)) {
      throw new Error(body.desc || `TDengine HTTP ${res.status}`)
    }
    const colMeta = body.column_meta ?? []
    const columns: QueryResultColumn[] = colMeta.map((c) => ({ name: c[0], dataType: String(c[1]) }))
    const rows = body.data ?? []
    const truncated = truncateRows(columns, rows, null, maxRows)
    return {
      columns,
      rows: truncated.rows,
      rowCount: truncated.rows.length,
      affectedRows: body.rows,
      durationMs: durationSince(t0),
      truncated: truncated.truncated,
      sql
    }
  },
  async listDatabases(h) {
    try {
      const r = await tdengineDriver.execute(h, 'SHOW DATABASES')
      return r.rows.map((row) => String(row[0] ?? '')).filter(Boolean)
    } catch {
      return h.config.database ? [h.config.database] : []
    }
  },
  async listSchemas() {
    return []
  },
  async listTables(h) {
    try {
      const r = await tdengineDriver.execute(h, 'SHOW STABLES')
      const stables = r.rows
        .map((row) => ({
          name: String(row[0] ?? ''),
          type: 'supertable' as const,
          database: h.config.database
        }))
        .filter((x) => x.name)
      const r2 = await tdengineDriver.execute(h, 'SHOW TABLES')
      const tables = r2.rows
        .map((row) => ({
          name: String(row[0] ?? ''),
          type: 'table' as const,
          database: h.config.database
        }))
        .filter((x) => x.name)
      return [...stables, ...tables]
    } catch {
      return []
    }
  },
  async describeTable(h, _scope, table) {
    try {
      const r = await tdengineDriver.execute(h, `DESCRIBE ${table}`)
      return {
        table,
        columns: r.rows.map((row) => ({
          name: String(row[0] ?? ''),
          dataType: String(row[1] ?? ''),
          nullable: true
        }))
      }
    } catch {
      return { table, columns: [] }
    }
  },
  async completionCatalog(h) {
    const info = DIALECT_INFO.tdengine
    const tables = await tdengineDriver.listTables(h, {})
    return {
      dialect: 'tdengine',
      databases: await tdengineDriver.listDatabases(h),
      schemas: [] as string[],
      tables: tables.map((t) => ({
        name: t.name,
        type: t.type as 'table' | 'view' | 'measurement' | 'supertable',
        columns: [] as Array<{ name: string; type?: string; comment?: string; pk?: boolean }>
      })),
      functions: info.functions,
      keywords: info.keywords
    }
  }
}

// —— Registry ——

export const DRIVER_REGISTRY: Record<DbDriverId, DbDriver> = {
  mysql: mysqlDriver,
  sqlite: sqliteDriver,
  influxdb: influxDriver,
  timescale: timescaleDriver,
  tdengine: tdengineDriver
}

export function getDriver(id: string): DbDriver {
  const d = DRIVER_REGISTRY[id as DbDriverId]
  if (!d) throw new Error(`unknown db driver: ${id}`)
  return d
}

export { buildDml, sqlLiteral, quoteIdent }
