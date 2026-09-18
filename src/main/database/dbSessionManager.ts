/**
 * dbSessionManager — 数据库会话 / 查询 / 补全 / applyChanges / 导入宿主 API
 * 职责：注册表管理 open 会话；提供 pluginHandlers 所需 db.* 全部分发入口。
 *      业务连接配置/控制台会话存 enest.storage（插件 KV）；宿主只管运行态会话。
 * 被 pluginHandlers 分发调用。
 * 关键依赖：@main/database/drivers、completion、dialects、@main/vault/secretVault、
 *          node:fs/csv、electron dialog。
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { dialog } from 'electron'
import type {
  BatchResult,
  CompletionCatalog,
  CompletionResponse,
  DbApplyChangesInput,
  DbCompletionInput,
  DbConnectionConfig,
  DbDialectInfo,
  DbDriverId,
  DbExecuteInput,
  DbImportPreviewInput,
  DbImportPreviewResult,
  DbImportRunInput,
  DbImportRunResult,
  DbSchemaTreeInput,
  DbSessionInfo,
  DbTestResult,
  QueryResult,
  RowChange,
  SchemaObject,
  TableDetail
} from '@shared/types/ssh-db'
import { getDriver, DRIVER_REGISTRY, DEFAULT_MAX_ROWS } from '@main/database/drivers'
import {
  buildCompletion,
  getCatalog,
  invalidateCatalog,
  isDdlSql,
  isWriteSql,
  setCatalog
} from '@main/database/completion'
import { listDialects } from '@main/database/dialects'
import { resolveSecret } from '@main/vault/secretVault'
import { getMainWindow } from '@main/window/createShellWindow'
import { logInfo, logWarn } from '@main/logs/logService'
import type { DriverHandle } from '@main/database/drivers'

interface DbSession {
  sessionKey: string
  pluginId: string
  driverId: DbDriverId
  handle: DriverHandle
  config: DbConnectionConfig
  readOnly: boolean
  openedAt: number
  /** 进行中的查询（cancel 用） */
  running: Map<string, { aborted: boolean }>
}

const sessions = new Map<string, DbSession>()
let sessionSeq = 0

function makeSessionKey(pluginId: string, driver: DbDriverId, hint?: string): string {
  sessionSeq += 1
  return `${pluginId}:${driver}:${hint ?? sessionSeq}:${Date.now().toString(36)}`
}

function requireSession(pluginId: string, sessionKey: string): DbSession {
  const s = sessions.get(sessionKey)
  if (!s) throw new Error(`db session not found: ${sessionKey}`)
  if (s.pluginId !== pluginId) throw new Error('session does not belong to this plugin')
  return s
}

function resolvePassword(pluginId: string, config: DbConnectionConfig): string | undefined {
  if (config.ephemeralSecret) return config.ephemeralSecret
  if (config.secretRef) return resolveSecret(pluginId, config.secretRef) ?? undefined
  return undefined
}

export async function dbTest(pluginId: string, config: DbConnectionConfig): Promise<DbTestResult> {
  const driver = getDriver(config.driver)
  const password = resolvePassword(pluginId, config)
  return driver.test(config, password)
}

export async function dbOpen(
  pluginId: string,
  input: { config: DbConnectionConfig; sessionKey?: string } | DbConnectionConfig
): Promise<DbSessionInfo> {
  const config =
    input && typeof input === 'object' && 'config' in input && (input as { config?: DbConnectionConfig }).config
      ? (input as { config: DbConnectionConfig; sessionKey?: string }).config
      : (input as DbConnectionConfig)
  const sessionKey =
    input && typeof input === 'object' && 'sessionKey' in input
      ? (input as { sessionKey?: string }).sessionKey
      : undefined
  if (!config?.driver) throw new Error('driver required')
  const driver = getDriver(config.driver)
  const password = resolvePassword(pluginId, config)
  const key = sessionKey || makeSessionKey(pluginId, config.driver)
  // 同 key 重复 open：先关旧的
  if (sessions.has(key)) {
    await dbClose(pluginId, key).catch(() => undefined)
  }
  const handle = await driver.open(
    { ...config, options: { ...(config.options ?? {}), readOnly: normalizeReadOnly(config) } },
    password
  )
  const readOnly = normalizeReadOnly(config)
  handle.readOnly = readOnly
  const session: DbSession = {
    sessionKey: key,
    pluginId,
    driverId: config.driver,
    handle,
    config,
    readOnly,
    openedAt: Date.now(),
    running: new Map()
  }
  sessions.set(key, session)
  // 预热 catalog（表名；列懒加载由 completion 触发）
  void driver
    .completionCatalog(handle, { database: config.database, schema: config.options?.schema })
    .then((catalog) => {
      setCatalog(key, config.database, config.options?.schema, catalog)
    })
    .catch(() => undefined)
  logInfo('db', `session opened ${key} driver=${config.driver}`)
  return toSessionInfo(session)
}

function toSessionInfo(s: DbSession): DbSessionInfo {
  return {
    sessionKey: s.sessionKey,
    driver: s.driverId,
    host: s.config.host,
    database: s.config.database,
    filePath: s.config.filePath,
    readOnly: s.readOnly,
    openedAt: s.openedAt
  }
}

export async function dbClose(pluginId: string, sessionKey: string): Promise<boolean> {
  const s = sessions.get(sessionKey)
  if (!s) return true
  if (s.pluginId !== pluginId) throw new Error('session does not belong to this plugin')
  const driver = getDriver(s.driverId)
  try {
    await driver.close(s.handle)
  } catch (err) {
    logWarn('db', `close failed ${sessionKey}: ${(err as Error).message}`)
  }
  invalidateCatalog(sessionKey)
  sessions.delete(sessionKey)
  return true
}

/** 宿主文件选择器选中的路径白名单（防插件任意 filePath 读盘） */
const pickedFilePaths = new Set<string>()

function notePickedFile(p: string | null | undefined): string | null {
  if (!p) return null
  const abs = resolve(p)
  pickedFilePaths.add(abs)
  return abs
}

function normalizeReadOnly(config: DbConnectionConfig): boolean {
  return (
    config.options?.readOnly === true ||
    (config as { readOnly?: boolean }).readOnly === true
  )
}

/** prod / requireConfirm 连接上的写操作必须 confirmed:true */
function assertWriteConfirmed(s: DbSession, confirmed?: boolean, action = 'write'): void {
  const env = String((s.config as { env?: string }).env || s.config.options?.env || '').toLowerCase()
  const need =
    s.config.options?.requireConfirm === true ||
    env === 'prod' ||
    env === 'production' ||
    env === '生产'
  if (need && confirmed !== true) {
    throw new Error(`${action} requires confirmed=true on prod/protected connection`)
  }
}

export function dbListSessions(pluginId: string): DbSessionInfo[] {
  return [...sessions.values()].filter((s) => s.pluginId === pluginId).map(toSessionInfo)
}

export async function dbExecute(pluginId: string, input: DbExecuteInput): Promise<QueryResult> {
  const s = requireSession(pluginId, input.sessionKey)
  const driver = getDriver(s.driverId)
  const sql = String(input.sql ?? '')
  if (!sql.trim()) throw new Error('sql required')
  if (s.readOnly && (isWriteSql(sql) || isDdlSql(sql))) {
    throw new Error('read-only connection rejects write SQL')
  }
  if (!s.readOnly && isWriteSql(sql)) {
    assertWriteConfirmed(s, input.confirmed, 'write SQL')
  }
  const runId = `run_${Date.now().toString(36)}`
  s.running.set(runId, { aborted: false })
  try {
    const result = await driver.execute(s.handle, sql, {
      maxRows: input.maxRows && input.maxRows > 0 ? input.maxRows : DEFAULT_MAX_ROWS,
      timeoutMs: input.timeoutMs,
      params: input.params
    })
    if (isDdlSql(sql)) invalidateCatalog(s.sessionKey)
    // 补全 catalog：SELECT * FROM t 且缺列时懒加载
    if (result.columns.length > 0) {
      const cache = getCatalog(s.sessionKey, s.config.database, s.config.options?.schema)
      if (cache) {
        const simple = /^\s*SELECT\s+\*\s+FROM\s+["`]?([\w.]+)["`]?/i.exec(sql)
        if (simple) {
          const tableName = simple[1]!.split('.').pop()!
          const t = cache.tables.find((x) => x.name.toLowerCase() === tableName.toLowerCase())
          if (t && t.columns.length === 0) {
            t.columns = result.columns.map((c) => ({
              name: c.name,
              type: c.dataType,
              pk: c.primaryKey
            }))
          }
        }
      }
    }
    return result
  } finally {
    s.running.delete(runId)
  }
}

export async function dbExplain(pluginId: string, input: { sessionKey: string; sql: string }): Promise<QueryResult> {
  const s = requireSession(pluginId, input.sessionKey)
  const driver = getDriver(s.driverId)
  if (!driver.explain) throw new Error(`driver ${s.driverId} does not support explain`)
  return driver.explain(s.handle, String(input.sql ?? ''))
}

export function dbCancel(pluginId: string, sessionKeyOrInput: string | { sessionKey?: string }): boolean {
  const sessionKey =
    typeof sessionKeyOrInput === 'string'
      ? sessionKeyOrInput
      : String(sessionKeyOrInput?.sessionKey ?? '')
  const s = requireSession(pluginId, sessionKey)
  for (const r of s.running.values()) r.aborted = true
  // HTTP 驱动无法真正中断在途 fetch；标记后 execute 结果丢弃由上层处理
  logInfo('db', `cancel requested ${sessionKey}`)
  return true
}

export async function dbApplyChanges(pluginId: string, input: DbApplyChangesInput): Promise<BatchResult> {
  const s = requireSession(pluginId, input.sessionKey)
  const driver = getDriver(s.driverId)
  if (!driver.applyBatch) throw new Error(`driver ${s.driverId} does not support applyChanges`)
  if (s.readOnly) throw new Error('read-only connection rejects applyChanges')
  assertWriteConfirmed(s, input.confirmed, 'applyChanges')
  const mode = input.mode === 'continue' ? 'continue' : 'stop-on-error'
  return driver.applyBatch(s.handle, (input.changes ?? []) as RowChange[], mode)
}

export async function dbSchemaTree(
  pluginId: string,
  input: DbSchemaTreeInput & { node?: { type?: string; database?: string; schema?: string; table?: string } }
): Promise<SchemaObject[]> {
  const s = requireSession(pluginId, input.sessionKey)
  const driver = getDriver(s.driverId)
  // 兼容插件传 node.type 作为 parent
  const parent =
    input.parent ??
    (input.node?.type === 'root' || !input.node?.type
      ? 'root'
      : input.node.type === 'table' || input.node.type === 'view'
        ? 'table'
        : input.node.type)
  const scope = {
    database: input.database ?? input.node?.database ?? s.config.database,
    schema: input.schema ?? input.node?.schema ?? s.config.options?.schema
  }
  const filter = input.filter?.toLowerCase()

  if (!parent || parent === 'root') {
    // 连接层：库列表 +（无 schemas 的驱动直接表）
    const databases = await driver.listDatabases(s.handle)
    if (!driver.capabilities.schemas && databases.length <= 1) {
      const tables = await driver.listTables(s.handle, scope)
      const filtered = filter ? tables.filter((t) => t.name.toLowerCase().includes(filter)) : tables
      return [
        {
          name: databases[0] ?? scope.database ?? 'main',
          type: 'database',
          children: filtered
        }
      ]
    }
    return databases
      .filter((d) => !filter || d.toLowerCase().includes(filter))
      .map((d) => ({ name: d, type: 'database' as const, database: d }))
  }

  if (parent === 'database') {
    if (driver.capabilities.schemas) {
      const schemas = await driver.listSchemas(s.handle, scope.database)
      return schemas
        .filter((sc) => !filter || sc.toLowerCase().includes(filter))
        .map((sc) => ({ name: sc, type: 'schema' as const, schema: sc, database: scope.database }))
    }
    const tables = await driver.listTables(s.handle, scope)
    const filtered = filter ? tables.filter((t) => t.name.toLowerCase().includes(filter)) : tables
    return filtered
  }

  if (parent === 'schema') {
    const tables = await driver.listTables(s.handle, scope)
    const filtered = filter ? tables.filter((t) => t.name.toLowerCase().includes(filter)) : tables
    return filtered
  }

  const tableName = input.table ?? input.node?.table
  if (parent === 'table' && tableName) {
    const detail = await driver.describeTable(s.handle, scope, tableName)
    return detail.columns
      .filter((c) => !filter || c.name.toLowerCase().includes(filter))
      .map((c) => ({
        name: c.name,
        type: 'column' as const,
        schema: scope.schema,
        database: scope.database,
        column: c
      }))
  }

  return []
}

export async function dbSchemaDescribe(
  pluginId: string,
  input: { sessionKey: string; database?: string; schema?: string; table: string }
): Promise<TableDetail> {
  const s = requireSession(pluginId, input.sessionKey)
  const driver = getDriver(s.driverId)
  return driver.describeTable(s.handle, { database: input.database, schema: input.schema }, input.table)
}

export async function dbSchemaDdl(
  pluginId: string,
  input: { sessionKey: string; database?: string; schema?: string; table: string }
): Promise<string> {
  const s = requireSession(pluginId, input.sessionKey)
  const driver = getDriver(s.driverId)
  if (!driver.getDdl) throw new Error(`driver ${s.driverId} does not support ddl`)
  return driver.getDdl(s.handle, { database: input.database, schema: input.schema }, input.table)
}

export async function dbCompletion(
  pluginId: string,
  input: DbCompletionInput
): Promise<CompletionResponse> {
  const s = requireSession(pluginId, input.sessionKey)
  const driver = getDriver(s.driverId)
  const database = input.database ?? s.config.database
  const schema = input.schema ?? s.config.options?.schema
  let catalog: CompletionCatalog | null = getCatalog(s.sessionKey, database, schema)
  if (!catalog) {
    try {
      catalog = await driver.completionCatalog(s.handle, { database, schema })
      setCatalog(s.sessionKey, database, schema, catalog)
    } catch (err) {
      logWarn('db', `completion catalog load failed: ${(err as Error).message}`)
      catalog = null
    }
  }
  return buildCompletion({ input, driverId: s.driverId, catalog })
}

export function dbDialectsList(): DbDialectInfo[] {
  return listDialects()
}

export async function dbPickSqliteFile(
  _pluginId: string,
  _opts?: { createIfMissing?: boolean }
): Promise<string | null> {
  const win = getMainWindow()
  const dialogOpts = {
    properties: ['openFile' as const],
    title: '选择 SQLite 数据库文件',
    filters: [
      { name: 'SQLite', extensions: ['db', 'sqlite', 'sqlite3'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  }
  const result = win ? await dialog.showOpenDialog(win as never, dialogOpts) : await dialog.showOpenDialog(dialogOpts)
  if (result.canceled || result.filePaths.length === 0) return null
  return notePickedFile(result.filePaths[0])
}

/** 导入 CSV：宿主选择器；返回路径并加入 import 白名单 */
export async function dbPickImportFile(_pluginId: string): Promise<string | null> {
  const win = getMainWindow()
  const dialogOpts = {
    properties: ['openFile' as const],
    title: '选择要导入的 CSV',
    filters: [
      { name: 'CSV', extensions: ['csv', 'tsv', 'txt'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  }
  const result = win ? await dialog.showOpenDialog(win as never, dialogOpts) : await dialog.showOpenDialog(dialogOpts)
  if (result.canceled || result.filePaths.length === 0) return null
  return notePickedFile(result.filePaths[0])
}

// —— CSV 导入（Spec DB-G P0 最小）——

function parseCsv(text: string, opts?: { delimiter?: string; hasHeader?: boolean }): {
  columns: string[]
  rows: string[][]
} {
  const delimiter = opts?.delimiter && opts.delimiter.length > 0 ? opts.delimiter : ','
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0)
  if (lines.length === 0) return { columns: [], rows: [] }
  const parseLine = (line: string): string[] => {
    const out: string[] = []
    let cur = ''
    let inQ = false
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]!
      if (inQ) {
        if (ch === '"') {
          if (line[i + 1] === '"') {
            cur += '"'
            i++
          } else {
            inQ = false
          }
        } else {
          cur += ch
        }
      } else if (ch === '"') {
        inQ = true
      } else if (ch === delimiter) {
        out.push(cur)
        cur = ''
      } else {
        cur += ch
      }
    }
    out.push(cur)
    return out
  }
  const hasHeader = opts?.hasHeader !== false
  if (hasHeader) {
    return { columns: parseLine(lines[0]!), rows: lines.slice(1).map(parseLine) }
  }
  const first = parseLine(lines[0]!)
  return {
    columns: first.map((_, i) => `col_${i + 1}`),
    rows: lines.map(parseLine)
  }
}

function loadCsvText(input: { csvText?: string; filePath?: string }): string {
  if (input.csvText) return input.csvText
  if (input.filePath) {
    const abs = resolve(input.filePath)
    if (!pickedFilePaths.has(abs)) {
      throw new Error('import filePath must be selected via host file picker')
    }
    return readFileSync(abs, 'utf-8')
  }
  throw new Error('csvText or filePath required')
}

function quoteIdent(name: string): string {
  return `\`${String(name).replace(/`/g, '``')}\``
}

function assertSafeTableIdent(name: string, what = 'identifier'): string {
  const s = String(name ?? '')
  if (!s || s.length > 256 || /[`"';\\]|--|\/\*|\u0000/.test(s)) {
    throw new Error(`invalid ${what}: ${s}`)
  }
  return s
}

function tableRefSql(t: { database?: string; schema?: string; table: string }, driverId: DbDriverId): string {
  if (driverId === 'timescale') {
    const schema = t.schema
      ? `"${assertSafeTableIdent(t.schema, 'schema').replace(/"/g, '""')}".`
      : ''
    return `${schema}"${assertSafeTableIdent(t.table, 'table').replace(/"/g, '""')}"`
  }
  if (driverId === 'mysql' && t.database) {
    return `${quoteIdent(assertSafeTableIdent(t.database, 'database'))}.${quoteIdent(assertSafeTableIdent(t.table, 'table'))}`
  }
  return quoteIdent(assertSafeTableIdent(t.table, 'table'))
}

function importPlaceholders(driverId: DbDriverId, n: number): string {
  if (driverId === 'timescale') {
    return Array.from({ length: n }, (_, i) => `$${i + 1}`).join(', ')
  }
  return Array.from({ length: n }, () => '?').join(', ')
}

export async function dbImportPreview(
  pluginId: string,
  input: DbImportPreviewInput
): Promise<DbImportPreviewResult> {
  const s = requireSession(pluginId, input.sessionKey)
  const text = loadCsvText(input)
  const sampleN = input.options?.sampleRows && input.options.sampleRows > 0 ? input.options.sampleRows : 20
  const { columns, rows } = parseCsv(text, input.options)
  const sampleRows = rows.slice(0, sampleN)
  const tref = tableRefSql(input.table, s.driverId)
  const targetCols = (input.options?.columns ?? columns).map((c) => assertSafeTableIdent(c, 'column'))
  const sqlPreview = sampleRows.slice(0, 3).map((row) => {
    const ph = importPlaceholders(s.driverId, targetCols.length)
    return `INSERT INTO ${tref} (${targetCols.map(quoteIdent).join(', ')}) VALUES (${ph}); /* ${row
      .map((v) => (v === '' ? 'NULL' : String(v).slice(0, 24)))
      .join(' | ')} */`
  })
  return {
    columns,
    sampleRows,
    totalRowsEstimate: rows.length,
    mappedColumns: columns.map((c, i) => ({ source: c, target: targetCols[i] ?? c })),
    sqlPreview
  }
}

export async function dbImportRun(
  pluginId: string,
  input: DbImportRunInput
): Promise<DbImportRunResult> {
  const s = requireSession(pluginId, input.sessionKey)
  if (s.readOnly) throw new Error('read-only connection rejects import')
  assertWriteConfirmed(s, input.confirmed, 'import')
  const driver = getDriver(s.driverId)
  const t0 = Date.now()
  const text = loadCsvText(input)
  const { columns, rows } = parseCsv(text, input.options)
  const targetCols = (input.options?.columns ?? columns).map((c) => assertSafeTableIdent(c, 'column'))
  const tref = tableRefSql(input.table, s.driverId)
  const ph = importPlaceholders(s.driverId, targetCols.length)
  let inserted = 0
  let failed = 0
  const errors: string[] = []
  for (const row of rows) {
    const params = row.map((v) => (v === '' ? null : v))
    const sql = `INSERT INTO ${tref} (${targetCols.map(quoteIdent).join(', ')}) VALUES (${ph})`
    try {
      if (s.driverId === 'mysql') {
        const pool = s.handle.raw as import('mysql2/promise').Pool
        await pool.query(sql, params)
      } else if (s.driverId === 'timescale') {
        const client = s.handle.raw as import('pg').Client
        await client.query(sql, params as unknown[])
      } else if (s.driverId === 'sqlite') {
        const db = s.handle.raw as import('node:sqlite').DatabaseSync
        db.prepare(sql).run(...(params as never[]))
      } else {
        // HTTP 驱动：退回字面量（仍经 assertSafe 标识符）
        const lit = params
          .map((v) => (v === null ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`))
          .join(', ')
        await driver.execute(s.handle, `INSERT INTO ${tref} (${targetCols.map(quoteIdent).join(', ')}) VALUES (${lit})`)
      }
      inserted++
    } catch (err) {
      failed++
      if (errors.length < 20) errors.push((err as Error).message)
      if (input.options?.conflict === 'insert' || !input.options?.conflict) {
        if (failed > 0 && errors.length >= 20) break
      }
    }
  }
  return {
    ok: failed === 0,
    inserted,
    failed,
    errors: errors.length > 0 ? errors : undefined,
    durationMs: Date.now() - t0
  }
}

/** 插件关闭时清理其 DB 会话 */
export function releaseDbSessions(pluginId: string): void {
  for (const s of [...sessions.values()]) {
    if (s.pluginId !== pluginId) continue
    const driver = getDriver(s.driverId)
    void driver.close(s.handle).catch((err) => {
      logWarn('db', `release close failed ${s.sessionKey}: ${(err as Error).message}`)
    })
    invalidateCatalog(s.sessionKey)
    sessions.delete(s.sessionKey)
  }
}

export { DRIVER_REGISTRY }
