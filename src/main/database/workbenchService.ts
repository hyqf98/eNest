import { randomUUID } from 'node:crypto'
import type { DbDriverDescriptor, DbInspection, DbInspectionKind, DbWorkbenchRequest } from '@shared/types/db-workbench'
import type { DbDriverId, QueryResult, TableRef } from '@shared/types/ssh-db'
import { DRIVER_REGISTRY, getDriver } from '@main/database/drivers'
import { COMPATIBILITY_ENGINES, DRIVER_FAMILIES, isStructuredRead, supportsIsolatedReadOnly } from '@main/database/driverCatalog'
import { dbOpen, dbClose, dbExecute, dbCancel, dbTransaction, dbTest, dbSchemaDescribe, requireSession } from '@main/database/dbService'
import { isReadQuery, normalizeLimit, quoteIdentifier, splitSql } from '@main/database/queryPolicy'
import { buildBrowseQuery, previewTableDesign, tableOperationsFlavor } from '@main/database/tableOperations'
import { compareResults } from '@main/database/compare'

export function driverDescriptors(): DbDriverDescriptor[] {
  return Object.values(DRIVER_REGISTRY).map(driver => {
    const family = DRIVER_FAMILIES[driver.id]
    const flags = { connect: true, query: true, schema: true, completion: true, explain: !!driver.explain, transaction: !!driver.transaction,
      crud: driver.capabilities.updatableResult, edit: driver.capabilities.updatableResult, import: driver.capabilities.import,
      ddl: !!driver.getDdl, cancel: !!driver.cancel || ['mongodb','flux','influxql','influx3','search','neo4j'].includes(family), inspect: true, compare: supportsIsolatedReadOnly(driver.id), tableDesign: !!tableOperationsFlavor(driver.id), tablePage: !!tableOperationsFlavor(driver.id), keyScan: family === 'redis' }
    return { id: driver.id, label: driver.label, family, language: family === 'mongodb' ? 'mongodb' : family === 'redis' ? 'redis' : family === 'flux' ? 'flux' : family === 'neo4j' ? 'cypher' : family === 'cassandra' ? 'cql' : family === 'search' ? 'json' : 'sql',
      defaultPort: driver.defaultPort, transport: family === 'tdengine' ? 'websocket' : ['flux','influxql','influx3','clickhouse','search'].includes(family) ? 'http' : driver.capabilities.fileBased ? 'file' : 'native',
      compatibility: driver.id === 'scylladb' ? 'Cassandra native CQL protocol. Scylla-specific administration is not implemented.' : COMPATIBILITY_ENGINES[driver.id]?.note,
      capabilities: Object.fromEntries(Object.entries(flags).map(([key, available]) => [key, { state: available ? 'available' : 'unsupported', ...(!available ? { reason: 'This adapter does not implement this capability' } : {}) }])) }
  })
}

const queries: Partial<Record<string, Partial<Record<DbInspectionKind, string>>>> = {
  mysql: { sessions: 'SHOW FULL PROCESSLIST', resources: "SHOW GLOBAL STATUS WHERE Variable_name IN ('Threads_connected','Threads_running','Connections','Questions','Bytes_received','Bytes_sent','Uptime','Innodb_buffer_pool_bytes_data')", locks: 'SELECT * FROM performance_schema.data_lock_waits LIMIT 200', queries: 'SELECT DIGEST_TEXT, COUNT_STAR, SUM_TIMER_WAIT, SUM_ROWS_EXAMINED FROM performance_schema.events_statements_summary_by_digest ORDER BY SUM_TIMER_WAIT DESC LIMIT 100' },
  postgres: { sessions: 'SELECT pid, usename, datname, application_name, client_addr::text, state, wait_event_type, wait_event, query_start, query FROM pg_stat_activity', resources: 'SELECT datname, numbackends, xact_commit, xact_rollback, blks_read, blks_hit, tup_returned, tup_fetched, deadlocks FROM pg_stat_database', locks: 'SELECT a.pid, a.query, a.wait_event, pg_blocking_pids(a.pid)::text AS blocked_by FROM pg_stat_activity a WHERE cardinality(pg_blocking_pids(a.pid)) > 0', queries: 'SELECT query, calls, total_exec_time, rows FROM pg_stat_statements ORDER BY total_exec_time DESC LIMIT 100' },
  sqlite: { resources: 'SELECT page_count,page_size,page_count*page_size AS database_bytes,freelist_count FROM pragma_page_count(),pragma_page_size(),pragma_freelist_count()', locks: undefined },
  duckdb: { resources: 'SELECT * FROM duckdb_memory()', queries: undefined },
  mssql: { sessions: 'SELECT session_id, login_name, host_name, program_name, status FROM sys.dm_exec_sessions', resources: 'SELECT DB_NAME(database_id) AS database_name, SUM(size) * 8192 AS bytes FROM sys.master_files GROUP BY database_id', locks: 'SELECT request_session_id, resource_type, request_mode, request_status FROM sys.dm_tran_locks', queries: 'SELECT session_id, status, command, wait_type, blocking_session_id, cpu_time, total_elapsed_time FROM sys.dm_exec_requests' },
  oracle: { sessions: 'SELECT sid, serial#, username, status, machine, program FROM v$session', resources: 'SELECT name, value FROM v$sysstat WHERE name IN (\'session logical reads\',\'physical reads\',\'physical writes\')', locks: 'SELECT sid, type, id1, id2, lmode, request, block FROM v$lock', queries: 'SELECT sql_id, executions, elapsed_time, sql_text FROM v$sql ORDER BY elapsed_time DESC FETCH FIRST 100 ROWS ONLY' },
  clickhouse: { sessions: 'SELECT query_id, user, elapsed, read_rows, memory_usage, query FROM system.processes', resources: 'SELECT metric, value FROM system.metrics', queries: 'SELECT query_id, query_duration_ms, read_rows, memory_usage, query FROM system.query_log ORDER BY event_time DESC LIMIT 100', jobs: 'SELECT database, table, elapsed, progress FROM system.merges' },
  tdengine: { sessions: 'SELECT * FROM performance_schema.perf_connections', queries: 'SELECT * FROM performance_schema.perf_queries', jobs: 'SELECT * FROM performance_schema.perf_trans' },
  redis: { resources: '["INFO"]', queries: '["SLOWLOG","GET","100"]', sessions: '["CLIENT","LIST"]' }
}

function withMetricUnits(family: string, kind: DbInspectionKind, result: QueryResult): Pick<DbInspection,'columns'|'rows'> {
  const known: Record<string,string> = { bytes: 'bytes', database_bytes: 'bytes', page_size: 'bytes/page', page_count: 'pages', freelist_count: 'pages', numbackends: 'connections', xact_commit: 'transactions', xact_rollback: 'transactions', blks_read: 'blocks', blks_hit: 'blocks', tup_returned: 'rows', tup_fetched: 'rows', deadlocks: 'count', cpu_time: 'ms', total_elapsed_time: 'ms', total_exec_time: 'ms', query_duration_ms: 'ms', elapsed: 's', progress: 'ratio', read_rows: 'rows', rows: 'rows', calls: 'count', count_star: 'count', sum_timer_wait: 'ps', sum_rows_examined: 'rows', memory_usage: 'bytes', memory_usage_bytes: 'bytes', temporary_storage_bytes: 'bytes' }
  if (kind === 'resources' && ['mysql','oracle','clickhouse'].includes(family) && result.columns.length === 2) {
    const units: Record<string,string> = { threads_connected: 'connections', threads_running: 'threads', connections: 'connections (cumulative)', questions: 'queries', bytes_received: 'bytes', bytes_sent: 'bytes', uptime: 's', innodb_buffer_pool_bytes_data: 'bytes', 'session logical reads': 'blocks', 'physical reads': 'blocks', 'physical writes': 'blocks', memorytracking: 'bytes' }
    return { columns: [...result.columns.map(column => ({ ...column, unit: column === result.columns[0] ? 'label' : 'see unit column' })), { name: 'unit' }], rows: result.rows.map(row => [...row, units[String(row[0]).toLowerCase()] || 'unit unavailable']) }
  }
  return { columns: result.columns.map(column => ({ ...column, unit: known[column.name.toLowerCase()] || 'server-defined / unavailable' })), rows: result.rows }
}

async function inspect(pluginId: string, sessionKey: string, kind: DbInspectionKind): Promise<DbInspection> {
  if (!['client','sessions','resources','locks','queries','jobs'].includes(kind)) throw new Error('Unknown inspection kind')
  const session = requireSession(pluginId, sessionKey), driver = getDriver(session.driverId), family = DRIVER_FAMILIES[session.driverId]
  const base = { kind, source: kind === 'client' ? 'enest-client' as const : 'database-server' as const, sampledAt: Date.now() }
  if (kind === 'client') {
    const runtime = session.handle.runtime || {}
    const counters = Object.entries(runtime).filter(([key, value]) => ['created','activeCount','total','active','waiting','transaction','backendPid'].includes(key) && ['number','boolean'].includes(typeof value))
    return { ...base, state: 'available', columns: [{ name: 'metric' }, { name: 'value' }], rows: [['transport', driver.capabilities.fileBased ? 'local file handle' : family === 'mysql' || family === 'mongodb' ? 'client pool' : 'client connection'], ['active queries', session.running.size], ...counters], note: 'Only eNest client connections are shown. These are not all database-server sessions; cumulative created connections are not current pool size.' }
  }
  try {
    let result: QueryResult
    if (family === 'mongodb' && ['sessions','resources','queries'].includes(kind)) {
      const db = (session.handle.raw as import('mongodb').MongoClient).db('admin')
      const value = await db.command(kind === 'resources' ? { serverStatus: 1 } : { currentOp: 1, $all: true })
      const { BSON } = await import('mongodb')
      result = { columns: [{ name: 'document' }], rows: [[BSON.EJSON.serialize(value, { relaxed: false })]], rowCount: 1, durationMs: 0 }
    } else {
      const query = session.driverId === 'timescale' && kind === 'jobs' ? 'SELECT * FROM timescaledb_information.jobs' : queries[family]?.[kind]
      if (!query) return { ...base, state: 'unsupported', columns: [], rows: [], reason: 'No server API is implemented for this view; host CPU/memory and absent server sessions are not inferred.' }
      if (session.running.size || session.busyOperation || session.handle.runtime?.transaction) return { ...base, state: 'not-configured', columns: [], rows: [], reason: 'This console is busy or holds a transaction. Open a dedicated monitoring console.' }
      result = await driver.execute(session.handle, query, { maxRows: 500, timeoutMs: 5000, signal: AbortSignal.timeout(5000) })
    }
    return { ...base, state: 'available', ...withMetricUnits(family, kind, result), note: kind === 'queries' ? 'Server-provided data: cumulative query digests and local eNest history are distinct; unavailable collectors are not enabled automatically.' : undefined }
  } catch (error) {
    const reason = (error as Error).message
    return { ...base, state: /permission|denied|privilege|authorized|ORA-01031/i.test(reason) ? 'permission-denied' : /exist|unknown table|undefined|not found|ORA-00942/i.test(reason) ? 'not-configured' : 'error', columns: [], rows: [], reason }
  }
}

export async function browse(pluginId: string, input: { sessionKey: string; table: TableRef; maxRows?: number; surface?: 'quick' | 'shell' }): Promise<QueryResult> {
  const session = requireSession(pluginId, input.sessionKey), driver = getDriver(session.driverId), family = DRIVER_FAMILIES[session.driverId], max = normalizeLimit(input.maxRows, input.surface === 'quick')
  const table = input.table
  if (!table?.table) throw new Error('Object name required')
  const scope = family === 'mysql' || family === 'clickhouse' ? table.database || session.handle.database : table.schema
  const quoted = [scope, table.table].filter(Boolean).map(value => quoteIdentifier(value!, family)).join('.')
  const sql = family === 'mongodb' ? JSON.stringify({ collection: table.table, operation: 'find', filter: {} }) : family === 'redis' ? JSON.stringify(['GET', table.table]) : family === 'mssql' ? `SELECT TOP (${max + 1}) * FROM ${quoted}` : family === 'oracle' ? `SELECT * FROM ${quoted} FETCH FIRST ${max + 1} ROWS ONLY` : family === 'search' ? JSON.stringify({ index: table.table, query: { match_all: {} }, size: max + 1 }) : family === 'flux' ? `from(bucket: ${JSON.stringify(session.handle.database)}) |> range(start: -1h) |> filter(fn: (r) => r._measurement == ${JSON.stringify(table.table)}) |> limit(n: ${max + 1})` : `SELECT * FROM ${quoted} LIMIT ${max + 1}`
  if (family === 'neo4j') throw new Error('Use the Cypher console to browse graph data')
  let browseSql = sql
  if (family === 'redis') {
    const detail = await driver.describeTable(session.handle, table, table.table), type = detail.metadata?.type
    const command = type === 'hash' ? ['HGETALL',table.table] : type === 'list' ? ['LRANGE',table.table,'0',String(max-1)] : type === 'set' ? ['SSCAN',table.table,'0','COUNT',String(max)] : type === 'zset' ? ['ZRANGE',table.table,'0',String(max-1),'WITHSCORES'] : type === 'stream' ? ['XRANGE',table.table,'-','+','COUNT',String(max)] : ['GET',table.table]
    browseSql = JSON.stringify(command)
  }
  const result = await dbExecute(pluginId, { sessionKey: input.sessionKey, sql: browseSql, maxRows: max, surface: input.surface })
  if (driver.capabilities.updatableResult) {
    const detail = await driver.describeTable(session.handle, table, table.table)
    const keyColumns = detail.primaryKey || detail.columns.filter(column => column.primaryKey || column.pk).map(column => column.name)
    const indices = keyColumns.map(name => result.columns.findIndex(column => column.name === name))
    if (keyColumns.length && indices.every(index => index >= 0)) {
      result.rowIdentity = { keyColumns, keys: result.rows.map(row => indices.map(index => row[index])) }
      for (const column of result.columns) column.primaryKey = keyColumns.includes(column.name)
    }
  }
  result.editable = !session.readOnly && !!result.rowIdentity && driver.capabilities.updatableResult
  return result
}

export async function dbWorkbenchService(pluginId: string, request: DbWorkbenchRequest): Promise<unknown> {
  switch (request.action) {
    case 'drivers.list': return driverDescriptors()
    case 'test': return dbTest(pluginId, request.input)
    case 'browse': return browse(pluginId, request.input)
    case 'redis.scan': {
      const session = requireSession(pluginId, request.input.sessionKey)
      if (session.driverId !== 'redis') throw new Error('Key scanning requires Redis')
      const cursor = request.input.cursor || '0'; if (!/^\d+$/.test(cursor)) throw new Error('Invalid Redis scan cursor')
      const command = ['SCAN',cursor,'COUNT',String(normalizeLimit(request.input.count, true))]
      if (request.input.match) command.push('MATCH',request.input.match)
      const result = await dbExecute(pluginId, { sessionKey: request.input.sessionKey, sql: JSON.stringify(command) })
      const value = result.rows[0]?.[0] as [string,string[]]
      return { cursor: String(value[0]), keys: value[1] }
    }
    case 'table.page': {
      const session = requireSession(pluginId, request.input.sessionKey), driver = getDriver(session.driverId)
      if (session.running.size) throw new Error('Wait for the active query before browsing a table')
      const detail = await dbSchemaDescribe(pluginId, { sessionKey: request.input.sessionKey, ...request.input.table })
      const primaryKey = detail.primaryKey || detail.columns.filter(column => column.primaryKey || column.pk).map(column => column.name)
      const query = buildBrowseQuery(session.driverId, { ...request.input, limit: normalizeLimit(request.input.limit, request.input.surface === 'quick') }, detail.columns.map(column => column.name), primaryKey)
      const result = await dbExecute(pluginId, { sessionKey: request.input.sessionKey, sql: query.sql, params: query.params, maxRows: query.limit, surface: request.input.surface })
      const indices = primaryKey.map(name => result.columns.findIndex(column => column.name === name))
      if (primaryKey.length && indices.every(index => index >= 0) && driver.capabilities.updatableResult) result.rowIdentity = { keyColumns: primaryKey, keys: result.rows.map(row => indices.map(index => row[index])) }
      return { ...result, editable: !session.readOnly && !!result.rowIdentity && driver.capabilities.updatableResult, page: { offset: query.offset, limit: query.limit, hasMore: !!result.truncated, stableOrder: query.stableOrder } }
    }
    case 'table.design.preview': {
      const session = requireSession(pluginId, request.input.sessionKey)
      return previewTableDesign(session.driverId, request.input.design)
    }
    case 'table.design.apply': {
      const session = requireSession(pluginId, request.input.sessionKey)
      if (session.readOnly) throw new Error('Read-only connections cannot change table design')
      if (session.handle.runtime?.transaction) throw new Error('Finish the current transaction before applying table design')
      if (request.input.confirmed !== true) throw new Error('Review the generated SQL and confirm before applying table design')
      const preview = previewTableDesign(session.driverId, request.input.design), started = Date.now(), executionId = randomUUID()
      const result = await dbExecute(pluginId, { sessionKey: request.input.sessionKey, sql: preview.sql, confirmed: true, executionId })
      return { executionId, results: result.results || [result], durationMs: Date.now() - started, state: 'completed', transactionActive: result.transactionActive }
    }
    case 'execute': {
      const started = Date.now(), executionId = request.input.executionId || randomUUID()
      const result = await dbExecute(pluginId, { ...request.input, executionId })
      return { executionId, results: result.results || [result], durationMs: Date.now() - started, state: 'completed', transactionActive: result.transactionActive }
    }
    case 'cancel': return dbCancel(pluginId, request.input)
    case 'transaction': return dbTransaction(pluginId, request.input)
    case 'inspect': return inspect(pluginId, request.input.sessionKey, request.input.kind)
    case 'compare': {
      const readSide = async (side: { sessionKey: string; sql: string }) => {
        const original = requireSession(pluginId, side.sessionKey)
        if (!supportsIsolatedReadOnly(original.driverId)) throw new Error('This driver cannot open an isolated read-only comparison connection')
        if (original.config.filePath === ':memory:' || original.config.sqlitePath === ':memory:' || original.driverId === 'duckdb' && !original.config.filePath) throw new Error('In-memory databases cannot be compared through an independent connection; save a database file first')
        if (isStructuredRead(original.driverId, side.sql) === undefined && splitSql(side.sql, DRIVER_FAMILIES[original.driverId]).length !== 1) throw new Error('Compare one read-only statement per side')
        if (!(isStructuredRead(original.driverId, side.sql) ?? isReadQuery(side.sql, DRIVER_FAMILIES[original.driverId]))) throw new Error('Data comparison only accepts read queries')
        const clone = await dbOpen(pluginId, { config: { ...original.config, readOnly: true, ephemeralSecret: original.handle.password || original.config.ephemeralSecret, options: { ...original.config.options, readOnly: true } } })
        try { return await dbExecute(pluginId, { sessionKey: clone.sessionKey, sql: side.sql, maxRows: normalizeLimit(request.input.maxRows) }) }
        finally { await dbClose(pluginId, clone.sessionKey) }
      }
      const sides = await Promise.allSettled([readSide(request.input.left), readSide(request.input.right)])
      const failed = sides.find(side => side.status === 'rejected'); if (failed?.status === 'rejected') throw failed.reason
      return compareResults((sides[0] as PromiseFulfilledResult<QueryResult>).value, (sides[1] as PromiseFulfilledResult<QueryResult>).value, request.input)
    }
    default: throw new Error('Unknown database workbench action')
  }
}
