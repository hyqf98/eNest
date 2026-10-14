import type { HostDbImportPreviewInput as DbImportPreviewInput, HostDbImportRunInput as DbImportRunInput } from '@main/database/hostDbConfig'
import type { HostDbConnectionConfig as DbConnectionConfig } from '@main/database/hostDbConfig'
/**
 * dbService — utility process only; no Electron main APIs.
 * 数据库会话 / 查询 / 补全 / applyChanges / 导入宿主 API
 * 职责：注册表管理 open 会话；提供 pluginHandlers 所需 db.* 全部分发入口。
 *      业务连接配置/控制台会话存 enest.storage（插件 KV）；宿主只管运行态会话。
 * 被 pluginHandlers 分发调用。
 * Only validated IPC input enters this process; native dialogs and secrets stay in the facade.
 */
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import type {
  BatchResult,
  CompletionCatalog,
  CompletionResponse,
  DbApplyChangesInput,
  DbCompletionInput,
  DbDialectInfo,
  DbDriverId,
  DbExecuteInput,
  DbImportPreviewResult,
  DbImportRunResult,
  DbSchemaTreeInput,
  DbSessionInfo,
  DbTestResult,
  QueryResult,
  RowChange,
  SchemaObject,
  TableDetail
} from '@shared/types/ssh-db'
import { getDriver, DEFAULT_MAX_ROWS } from '@main/database/drivers'
import {
  buildCompletion,
  getCatalog,
  invalidateCatalog,
  isDdlSql,
  isWriteSql,
  setCatalog
} from '@main/database/completion'
import { listDialects } from '@main/database/dialects'
import { isReadQuery, splitSql, normalizeLimit, sqlTokens } from '@main/database/queryPolicy'
import { isStructuredRead, DRIVER_FAMILIES, supportsIsolatedReadOnly } from '@main/database/driverCatalog'
import { nativeCompletion } from '@main/database/nativeCompletion'
import { rowChangeSql } from '@main/database/rowChanges'
const logInfo = (_source: string, _message: string): void => {}
const logWarn = (_source: string, _message: string): void => {}
import type { DriverHandle } from '@main/database/drivers'

export interface DbSession {
  sessionKey: string
  pluginId: string
  driverId: DbDriverId
  handle: DriverHandle
  config: DbConnectionConfig
  readOnly: boolean
  openedAt: number
  busyOperation?: string
  /** 进行中的查询（cancel 用） */
  running: Map<string, { aborted: boolean; controller: AbortController; finished: Promise<void>; finish: () => void }>
}

const sessions = new Map<string, DbSession>()
let sessionSeq = 0
const opening = new Map<string, symbol>()
let stopped = false

async function inSession<T>(session: DbSession, operation: string, work: () => Promise<T>): Promise<T> {
  if (session.running.size || session.busyOperation) throw new Error(`This console is busy with ${session.busyOperation || 'a query'}; wait or open another console`)
  session.busyOperation = operation
  try { return await work() } finally { session.busyOperation = undefined }
}

function makeSessionKey(pluginId: string, driver: DbDriverId, hint?: string): string {
  sessionSeq += 1
  return `${pluginId}:${driver}:${hint ?? sessionSeq}:${Date.now().toString(36)}`
}

export function requireSession(pluginId: string, sessionKey: string): DbSession {
  const s = sessions.get(sessionKey)
  if (!s || s.handle.closed) throw new Error(`db session not found or closed: ${sessionKey}; reconnect`)
  if (s.pluginId !== pluginId) throw new Error('session does not belong to this plugin')
  return s
}

export async function dbTest(pluginId: string, config: DbConnectionConfig): Promise<DbTestResult> {
  const driver = getDriver(config.driver)
  const password = config.ephemeralSecret
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
  const password = config.ephemeralSecret
  if (stopped) throw new Error('database service is closing')
  const key = sessionKey || makeSessionKey(pluginId, config.driver)
  const epoch = Symbol(key)
  opening.set(key, epoch)
  const previous = sessions.get(key)
  if (previous) await closeSession(previous)
  if (stopped || opening.get(key) !== epoch) throw new Error('database opening cancelled')
  const handle = await driver.open(
    { ...config, options: { ...(config.options ?? {}), readOnly: normalizeReadOnly(config) } },
    password
  ).catch(error => { if (opening.get(key) === epoch) opening.delete(key); throw error })
  if (stopped || opening.get(key) !== epoch) { await driver.close(handle); throw new Error('database opening cancelled') }
  opening.delete(key)
  handle.controller = new AbortController()
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
    openedAt: s.openedAt,
    transactionActive: !!s.handle.runtime?.transaction
  }
}

async function closeSession(s: DbSession): Promise<void> {
  if (sessions.get(s.sessionKey) === s) sessions.delete(s.sessionKey)
  s.handle.controller?.abort(new Error('database session closed'))
  for (const active of s.running.values()) { active.aborted = true; active.controller.abort(new Error('database session closed')) }
  invalidateCatalog(s.sessionKey)
  await getDriver(s.driverId).close(s.handle)
}
export async function dbClose(pluginId: string, sessionKey: string): Promise<boolean> {
  const s = sessions.get(sessionKey)
  if (s && s.pluginId !== pluginId) throw new Error('session does not belong to this plugin')
  opening.delete(sessionKey)
  if (s) await closeSession(s)
  return true
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
  return [...sessions.values()].filter((s) => s.pluginId === pluginId && !s.handle.closed).map(toSessionInfo)
}

export async function dbTransaction(pluginId: string, input: { sessionKey: string; operation: 'begin' | 'commit' | 'rollback' }): Promise<{ active: boolean }> {
  const s = requireSession(pluginId, input.sessionKey), driver = getDriver(s.driverId)
  if (!['begin','commit','rollback'].includes(input.operation)) throw new Error('Invalid transaction operation')
  if (!driver.transaction) throw new Error('Transactions are not supported by this driver')
  if (s.running.size || s.busyOperation) throw new Error('Wait for the active query before changing transaction state')
  return inSession(s, 'transaction control', async () => { await driver.transaction!(s.handle, input.operation); return { active: input.operation === 'begin' } })
}

export async function dbExecute(pluginId: string, input: DbExecuteInput): Promise<QueryResult> {
  const s = requireSession(pluginId, input.sessionKey), driver = getDriver(s.driverId)
  const sql = String(input.sql ?? '')
  if (!sql.trim()) throw new Error('Query text is required')
  if (s.running.size || s.busyOperation) throw new Error('This console already has an active query; use another console for concurrent work')
  if (input.surface === 'quick' && s.handle.runtime?.transaction) throw new Error('Quick needs a separate console while a desktop transaction is active')
  if (input.surface === 'quick' && (!s.readOnly || !supportsIsolatedReadOnly(s.driverId))) throw new Error('Quick requires an independent read-only console supported by this driver; reopen with options.readOnly=true or continue in the desktop workspace')
  const structuredRead = isStructuredRead(s.driverId, sql)
  const read = structuredRead ?? isReadQuery(sql)
  if ((s.readOnly || input.surface === 'quick') && !read) throw new Error('Read-only/Quick console rejects writes; continue in the desktop workspace')
  if (!read) assertWriteConfirmed(s, input.confirmed, 'database write')
  const statements = structuredRead === undefined ? splitSql(sql) : [sql]
  if (input.surface === 'quick' && statements.length !== 1) throw new Error('Quick accepts one read-only statement at a time')
  if (input.params && statements.length !== 1) throw new Error('Parameters require one statement per execution')
  const runId = input.executionId || `run_${++sessionSeq}`
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(runId)) throw new Error('Invalid executionId')
  const controller = new AbortController()
  let finish!: () => void
  const finished = new Promise<void>(resolve => { finish = resolve })
  const active = { aborted: false, controller, finished, finish }
  s.running.set(runId, active)
  const timeout = setTimeout(() => controller.abort(new Error('Query timed out')), Math.max(100, Math.min(600000, input.timeoutMs || 30000)))
  const results: QueryResult[] = []
  try {
    for (const statement of statements) {
      controller.signal.throwIfAborted()
      const command = structuredRead === undefined ? sqlTokens(statement).trim().toUpperCase() : ''
      let result: QueryResult
      if (/^(SET\s+(?:(?:SESSION|LOCAL|GLOBAL)\s+)?(?:@@(?:SESSION\.)?)?AUTOCOMMIT|XA\s|PREPARE\s+TRANSACTION)/.test(command)) throw new Error('Use the transaction toolbar or BEGIN/COMMIT/ROLLBACK so this console can track transaction ownership')
      if (/^(BEGIN(?:\s+(?:TRANSACTION|WORK))?|START\s+TRANSACTION|COMMIT(?:\s+WORK)?|END(?:\s+WORK)?|ROLLBACK(?:\s+WORK)?|ABORT)$/.test(command)) {
        if (!driver.transaction) throw new Error('Transactions unsupported by this driver')
        await driver.transaction(s.handle, command.startsWith('BEGIN') || command.startsWith('START') ? 'begin' : command.startsWith('COMMIT') || command.startsWith('END') ? 'commit' : 'rollback')
        result = { columns: [], rows: [], rowCount: 0, durationMs: 0, sql: statement }
      } else {
        if (/^(BEGIN|START\s+TRANSACTION|COMMIT|END|ABORT)\b/.test(command) || /^ROLLBACK\b/.test(command) && !/^ROLLBACK\s+TO\b/.test(command)) throw new Error('Unsupported transaction variant; use the transaction toolbar or plain BEGIN/COMMIT/ROLLBACK')
        result = await driver.execute(s.handle, statement, { maxRows: normalizeLimit(input.maxRows, input.surface === 'quick'), timeoutMs: input.timeoutMs, params: input.params, signal: controller.signal, executionId: runId })
      }
      if (sessions.get(s.sessionKey) !== s || active.aborted || controller.signal.aborted) throw new Error('database query cancelled')
      result.executionId = runId; result.transactionActive = !!s.handle.runtime?.transaction
      if (!read) invalidateCatalog(s.sessionKey)
      results.push(result)
    }
    const first = results[0] || { columns: [], rows: [], rowCount: 0, durationMs: 0 }
    return { ...first, executionId: runId, transactionActive: !!s.handle.runtime?.transaction, ...(results.length > 1 ? { results } : {}) }
  } catch (error) { if (controller.signal.aborted) throw new Error(active.aborted ? 'database query cancelled' : 'database query timed out'); throw error }
  finally { clearTimeout(timeout); s.running.delete(runId); finish() }
}

export async function dbExplain(pluginId: string, input: { sessionKey: string; sql: string }): Promise<QueryResult> {
  const s = requireSession(pluginId, input.sessionKey)
  if (!getDriver(s.driverId).explain) throw new Error('Execution plan unavailable for this driver')
  if (!isReadQuery(input.sql)) throw new Error('Execution plan only accepts read queries')
  return dbExecute(pluginId, { ...input, sql: `${s.driverId === 'sqlite' ? 'EXPLAIN QUERY PLAN' : 'EXPLAIN'} ${input.sql}` })
}

export async function dbCancel(pluginId: string, input: string | { sessionKey?: string; executionId?: string }): Promise<boolean> {
  const key = typeof input === 'string' ? input : String(input.sessionKey || '')
  const s = sessions.get(key)
  if (!s) return true
  if (s.pluginId !== pluginId) throw new Error('session does not belong to this plugin')
  const executionId = typeof input === 'string' ? undefined : input.executionId
  const running = [...s.running.entries()].filter(([id]) => !executionId || executionId === id)
  if (!running.length) { if (s.busyOperation) await dbClose(pluginId, key); return true }
  for (const [, run] of running) { run.aborted = true; run.controller.abort(new Error('database query cancelled')) }
  const driver = getDriver(s.driverId)
  if (!driver.cancel && !['mongodb','influxdb','influxdb1','influxdb3','elasticsearch','opensearch','neo4j'].includes(s.driverId)) { await dbClose(pluginId, key); return true }
  await Promise.all(running.map(([, run]) => run.finished))
  return true
}

export async function dbApplyChanges(pluginId: string, input: DbApplyChangesInput): Promise<BatchResult> {
  const s = requireSession(pluginId, input.sessionKey)
  const driver = getDriver(s.driverId)
  if (!driver.applyBatch) throw new Error(`driver ${s.driverId} does not support applyChanges`)
  if (s.readOnly) throw new Error('read-only connection rejects applyChanges')
  assertWriteConfirmed(s, input.confirmed, 'applyChanges')
  const mode = input.mode === 'continue' ? 'continue' : 'stop-on-error'
  return inSession(s, 'row changes', () => driver.applyBatch!(s.handle, (input.changes ?? []) as RowChange[], mode))
}

async function schemaTree(
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
      : ['table','view','collection','key','measurement','supertable'].includes(input.node.type)
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
  if (['table','view','collection','key','measurement','supertable'].includes(parent) && tableName) {
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

export async function dbSchemaTree(pluginId: string, input: DbSchemaTreeInput): Promise<SchemaObject[]> {
  return inSession(requireSession(pluginId, input.sessionKey), 'schema discovery', () => schemaTree(pluginId, input))
}

export async function dbSchemaDescribe(
  pluginId: string,
  input: { sessionKey: string; database?: string; schema?: string; table: string }
): Promise<TableDetail> {
  const s = requireSession(pluginId, input.sessionKey)
  const driver = getDriver(s.driverId)
  return inSession(s, 'object metadata', () => driver.describeTable(s.handle, { database: input.database, schema: input.schema }, input.table))
}

export async function dbSchemaDdl(
  pluginId: string,
  input: { sessionKey: string; database?: string; schema?: string; table: string }
): Promise<string> {
  const s = requireSession(pluginId, input.sessionKey)
  const driver = getDriver(s.driverId)
  if (!driver.getDdl) throw new Error(`driver ${s.driverId} does not support ddl`)
  return inSession(s, 'DDL inspection', () => driver.getDdl!(s.handle, { database: input.database, schema: input.schema }, input.table))
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
  if (!catalog && !s.running.size && !s.busyOperation) {
    try {
      catalog = await inSession(s, 'completion metadata', () => driver.completionCatalog(s.handle, { database, schema }))
      if (sessions.get(s.sessionKey) !== s) throw new Error('database session closed')
      setCatalog(s.sessionKey, database, schema, catalog)
    } catch (err) {
      logWarn('db', `completion catalog load failed: ${(err as Error).message}`)
      catalog = null
    }
  }
  return nativeCompletion(DRIVER_FAMILIES[s.driverId], input, catalog) || buildCompletion({ input, driverId: s.driverId, catalog })
}

export function dbDialectsList(): DbDialectInfo[] {
  return listDialects()
}

// —— CSV 导入（Spec DB-G P0 最小）——

const MAX_IMPORT_BYTES = 64 * 1024 * 1024
const MAX_CSV_ROW_BYTES = 1024 * 1024

/** CSV is parsed in the utility process, one logical row at a time. */
async function* csvRows(input: { csvText?: string; filePath?: string; options?: { delimiter?: string } }): AsyncGenerator<string[]> {
  const delimiter = input.options?.delimiter || ','
  if (delimiter.length !== 1) throw new Error('CSV delimiter must be one character')
  let source: AsyncIterable<string>
  let file: ReturnType<typeof createReadStream> | undefined
  if (input.csvText !== undefined) {
    if (Buffer.byteLength(input.csvText) > MAX_IMPORT_BYTES) throw new Error('CSV input exceeds 64 MiB')
    source = (async function* () { yield input.csvText! })()
  } else if (input.filePath) {
    const path = resolve(input.filePath)
    if ((await stat(path)).size > MAX_IMPORT_BYTES) throw new Error('CSV input exceeds 64 MiB')
    file = createReadStream(path, { encoding: 'utf8' })
    source = file as AsyncIterable<string>
  } else throw new Error('csvText or filePath required')
  let cell = '', row: string[] = [], quoted = false, quotePending = false, skipLf = false, bytes = 0, rowBytes = 0
  try {
    for await (const chunk of source) {
      bytes += Buffer.byteLength(chunk)
      if (bytes > MAX_IMPORT_BYTES) throw new Error('CSV input exceeds 64 MiB')
      for (const ch of chunk) {
        rowBytes += Buffer.byteLength(ch)
        if (rowBytes > MAX_CSV_ROW_BYTES) throw new Error('CSV row exceeds 1 MiB')
        if (skipLf) { skipLf = false; if (ch === '\n') continue }
        if (quotePending) {
          quotePending = false
          if (ch === '"') { cell += '"'; continue }
          quoted = false
        }
        if (quoted) { if (ch === '"') quotePending = true; else cell += ch; continue }
        if (ch === '"' && cell.length === 0) { quoted = true; continue }
        if (ch === delimiter) { row.push(cell); cell = ''; continue }
        if (ch === '\n' || ch === '\r') {
          if (row.length || cell.length) { row.push(cell); yield row }
          cell = ''; row = []; rowBytes = 0; skipLf = ch === '\r'; continue
        }
        cell += ch
      }
    }
    if (quoted && !quotePending) throw new Error('CSV contains an unterminated quoted field')
    if (row.length || cell.length) { row.push(cell); yield row }
  } finally { file?.destroy() }
}

export async function dbImportPreview(pluginId: string, input: DbImportPreviewInput): Promise<DbImportPreviewResult> {
  const s = requireSession(pluginId, input.sessionKey)
  const sampleN = Math.max(1, Math.min(100, input.options?.sampleRows || 20))
  let columns: string[] = [], count = 0
  const sampleRows: string[][] = []
  for await (const row of csvRows(input)) {
    if (sessions.get(s.sessionKey) !== s) throw new Error('database import cancelled')
    if (!columns.length) {
      columns = input.options?.hasHeader === false ? row.map((_, i) => `col_${i + 1}`) : row
      if (input.options?.hasHeader !== false) continue
    }
    count++
    if (count % 250 === 0) await new Promise<void>(resolve => setImmediate(resolve))
    if (sampleRows.length < sampleN) sampleRows.push(row)
  }
  const targetCols = input.options?.columns ?? columns
  const family = DRIVER_FAMILIES[s.driverId]
  if (!['mysql','postgres','sqlite'].includes(family)) throw new Error('Import preview is unavailable for this driver')
  return { columns, sampleRows, totalRowsEstimate: count,
    mappedColumns: columns.map((c, i) => ({ source: c, target: targetCols[i] ?? c })),
    sqlPreview: sampleRows.slice(0, 3).map(row => rowChangeSql({ type: 'insert', table: input.table, values: Object.fromEntries(targetCols.map((name, i) => [name, row[i]])) }, family as 'mysql'|'postgres'|'sqlite').sql + ';') }
}

async function importRun(pluginId: string, input: DbImportRunInput): Promise<DbImportRunResult> {
  const s = requireSession(pluginId, input.sessionKey), driver = getDriver(s.driverId)
  if (s.readOnly) throw new Error('Read-only connection rejects import')
  if (!driver.capabilities.import || !driver.applyBatch) throw new Error('Import unavailable for this driver')
  if (input.options?.conflict && input.options.conflict !== 'insert') throw new Error('Only insert conflict policy is currently supported')
  assertWriteConfirmed(s, input.confirmed, 'import')
  const started = Date.now(); let columns: string[] = [], target: string[] = [], inserted = 0, failed = 0
  const errors: string[] = [], batch: RowChange[] = []
  const flush = async () => {
    if (!batch.length) return
    const result = await driver.applyBatch!(s.handle, batch.splice(0), 'continue')
    for (const row of result.results) { if (row.ok) inserted++; else { failed++; if (errors.length < 20) errors.push(row.error || 'Insert failed') } }
  }
  for await (const row of csvRows(input)) {
    if (sessions.get(s.sessionKey) !== s || s.handle.closed) throw new Error('database import cancelled')
    if (!columns.length) { columns = input.options?.hasHeader === false ? row.map((_, i) => `col_${i + 1}`) : row; target = input.options?.columns || columns; if (input.options?.hasHeader !== false) continue }
    if (row.length !== target.length) { failed++; if (errors.length < 20) errors.push('CSV column count does not match target'); continue }
    batch.push({ type: 'insert', table: input.table, values: Object.fromEntries(target.map((name, i) => [name, row[i] === '' ? null : row[i]])) })
    if (batch.length >= 200) await flush()
  }
  await flush()
  return { ok: failed === 0, inserted, failed, errors: errors.length ? errors : undefined, durationMs: Date.now() - started }
}

export async function dbImportRun(pluginId: string, input: DbImportRunInput): Promise<DbImportRunResult> {
  return inSession(requireSession(pluginId, input.sessionKey), 'CSV import', () => importRun(pluginId, input))
}

/** 插件关闭时清理其 DB 会话 */
export async function releaseDbSessions(pluginId: string): Promise<void> {
  stopped = true
  opening.clear()
  await Promise.allSettled([...sessions.values()].filter(s => s.pluginId === pluginId).map(s => dbClose(pluginId, s.sessionKey)))
}
