import { pinMssqlSession } from '@main/database/mssqlSession'
import type { QueryResult } from '@shared/types/ssh-db'
import type { DbDriver } from '@main/database/drivers'
import { adapterBase, endpoint, objectResult, tableResult } from '@main/database/adapterUtils'
import { normalizeLimit, quoteIdentifier, sqlTokens, wireValue, ResultBudget } from '@main/database/queryPolicy'

export function duckdbAdapter(): DbDriver {
  const driver = adapterBase('duckdb', 'DuckDB', 'duckdb')
  driver.capabilities = { ...driver.capabilities, fileBased: true, schemas: true, ddl: true, explain: true }
  driver.open = async config => {
    const duck = await import('@duckdb/node-api')
    const instance = await duck.DuckDBInstance.create(config.filePath || ':memory:', { ...(config.options?.readOnly ? { access_mode: 'READ_ONLY' } : {}), enable_external_access: 'false', autoload_known_extensions: 'false', autoinstall_known_extensions: 'false', allow_community_extensions: 'false', lock_configuration: 'true' })
    const connection = await instance.connect()
    return { id: 'duckdb', raw: connection, config, database: config.filePath || ':memory:', readOnly: !!config.options?.readOnly, runtime: { instance, transaction: false } }
  }
  driver.close = async h => { (h.raw as import('@duckdb/node-api').DuckDBConnection).closeSync(); (h.runtime?.instance as import('@duckdb/node-api').DuckDBInstance).closeSync(); h.closed = true }
  driver.cancel = async h => { (h.raw as import('@duckdb/node-api').DuckDBConnection).interrupt(); return true }
  driver.execute = async (h, sql, opts) => {
    const started = Date.now(), max = normalizeLimit(opts?.maxRows)
    const abort = () => { void driver.cancel!(h) }; opts?.signal?.throwIfAborted(); opts?.signal?.addEventListener('abort', abort, { once: true })
    try {
      const result = await (h.raw as import('@duckdb/node-api').DuckDBConnection).stream(sql, opts?.params as import('@duckdb/node-api').DuckDBValue[] | undefined)
      const rows: unknown[][] = []; const budget = new ResultBudget()
      for await (const chunk of result.yieldRowsJson()) { for (const row of chunk) { budget.add(row); rows.push(row); if (rows.length > max) break }; if (rows.length > max) break }
      return { ...tableResult(sql, started, result.columnNames(), rows, max), affectedRows: result.rowsChanged }
    } finally { opts?.signal?.removeEventListener('abort', abort) }
  }
  driver.transaction = async (h, operation) => { await driver.execute(h, operation.toUpperCase()); h.runtime!.transaction = operation === 'begin' }
  driver.listSchemas = async h => (await driver.execute(h, 'SELECT schema_name FROM information_schema.schemata')).rows.map(r => String(r[0]))
  driver.listTables = async (h, scope) => (await driver.execute(h, 'SELECT table_name, table_type FROM information_schema.tables WHERE table_schema = $1', { params: [scope.schema || 'main'] })).rows.map(r => ({ name: String(r[0]), type: r[1] === 'VIEW' ? 'view' : 'table', schema: scope.schema || 'main' }))
  driver.describeTable = async (h, scope, table) => ({ table, columns: (await driver.execute(h, 'SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position', { params: [scope.schema || 'main', table] })).rows.map(r => ({ name: String(r[0]), dataType: String(r[1]), nullable: r[2] === 'YES' })) })
  driver.explain = (h, sql) => driver.execute(h, `EXPLAIN ${sql}`)
  return driver
}

export function oracleAdapter(): DbDriver {
  const driver = adapterBase('oracle', 'Oracle (Thin)', 'oracle', 1521)
  driver.capabilities.schemas = true
  driver.open = async (config, password) => {
    const oracle = await import('oracledb')
    const connection = await oracle.getConnection({ user: config.username, password, connectString: String(config.options?.connectString || `${config.host || '127.0.0.1'}:${config.port ?? 1521}/${config.database || 'FREEPDB1'}`) })
    if (config.options?.readOnly) await connection.execute('SET TRANSACTION READ ONLY')
    return { id: 'oracle', raw: connection, config, password, database: config.database, readOnly: !!config.options?.readOnly, runtime: { transaction: false } }
  }
  driver.close = async h => { await (h.raw as import('oracledb').Connection).close(); h.closed = true }
  driver.cancel = async h => { await (h.raw as import('oracledb').Connection).break(); return true }
  driver.execute = async (h, sql, opts) => {
    const oracle = await import('oracledb'), started = Date.now(), max = normalizeLimit(opts?.maxRows), connection = h.raw as import('oracledb').Connection
    const abort = () => { void driver.cancel!(h) }; opts?.signal?.throwIfAborted(); opts?.signal?.addEventListener('abort', abort, { once: true })
    connection.callTimeout = opts?.timeoutMs || 30000
    const hadActualTransaction = connection.transactionInProgress
    try {
      const result = await connection.execute<unknown[]>(sql, (opts?.params || []) as import('oracledb').BindParameters, { resultSet: true, outFormat: oracle.OUT_FORMAT_ARRAY, autoCommit: !h.runtime?.transaction && !h.readOnly,
        fetchTypeHandler: metadata => metadata.dbType === oracle.DB_TYPE_NUMBER ? { type: oracle.STRING } : undefined })
      const cursors = [result.resultSet, ...(result.implicitResults || [])].filter((cursor): cursor is import('oracledb').ResultSet<unknown[]> => !!cursor && 'getRows' in cursor && typeof cursor.getRows === 'function')
      const results: QueryResult[] = []
      try {
        for (const cursor of cursors) results.push(tableResult(sql, started, cursor.metaData?.map(column => column.name) || [], await cursor.getRows(max + 1) as unknown[][], max))
      } finally { await Promise.allSettled(cursors.map(cursor => cursor.close())) }
      const first = results[0] || tableResult(sql, started, result.metaData?.map(column => column.name) || [], [], max)
      first.affectedRows = result.rowsAffected
      return { ...first, ...(results.length > 1 ? { results } : {}) }
    } finally {
      opts?.signal?.removeEventListener('abort', abort)
      // Failed PL/SQL may leave pending writes even with autoCommit enabled. Keep an
      // accessible commit/rollback entry; a virtual BEGIN with no DML remains active.
      if (!h.readOnly && (connection.transactionInProgress || hadActualTransaction)) h.runtime!.transaction = !!connection.transactionInProgress
    }
  }
  driver.transaction = async (h, operation) => {
    const connection = h.raw as import('oracledb').Connection
    if (operation === 'begin') { if (h.runtime?.transaction) throw new Error('Transaction already active'); h.runtime!.transaction = true }
    else { if (!h.runtime?.transaction) throw new Error('No active transaction'); if (operation === 'commit') await connection.commit(); else await connection.rollback(); h.runtime.transaction = false; if (h.readOnly) await connection.execute('SET TRANSACTION READ ONLY') }
  }
  driver.listSchemas = async h => (await driver.execute(h, 'SELECT username FROM all_users')).rows.map(r => String(r[0]))
  driver.listTables = async (h, scope) => (await driver.execute(h, 'SELECT object_name, object_type FROM all_objects WHERE owner = :1 AND object_type IN (\'TABLE\',\'VIEW\')', { params: [scope.schema || h.config.username?.toUpperCase()] })).rows.map(r => ({ name: String(r[0]), type: r[1] === 'VIEW' ? 'view' : 'table', schema: scope.schema || h.config.username?.toUpperCase() }))
  driver.describeTable = async (h, scope, table) => ({ table, columns: (await driver.execute(h, 'SELECT column_name, data_type, nullable FROM all_tab_columns WHERE owner = :1 AND table_name = :2 ORDER BY column_id', { params: [scope.schema || h.config.username?.toUpperCase(), table] })).rows.map(r => ({ name: String(r[0]), dataType: String(r[1]), nullable: r[2] === 'Y' })) })
  return driver
}

export function mssqlAdapter(): DbDriver {
  const driver = adapterBase('mssql', 'SQL Server', 'tsql', 1433)
  driver.capabilities.schemas = true
  driver.open = async (config, password) => {
    const mssql = await import('mssql')
    const pool = await new mssql.ConnectionPool({ server: config.host || '127.0.0.1', port: config.port ?? 1433, user: config.username, password, database: config.database,
      connectionTimeout: 10000, requestTimeout: 30000, pool: { max: 5, min: 0 }, options: { encrypt: config.options?.ssl !== false, trustServerCertificate: config.options?.rejectUnauthorized === false, appName: 'eNest', readOnlyIntent: !!config.options?.readOnly } }).connect()
    try { const session = await pinMssqlSession(pool); return { id: 'mssql', raw: pool, config, password, database: config.database, readOnly: !!config.options?.readOnly, runtime: { session, transaction: false } } }
    catch (error) { await pool.close(); throw error }
  }
  driver.close = async h => { try { if (h.runtime?.transaction) await driver.transaction!(h, 'rollback') } finally { (h.runtime!.session as Awaited<ReturnType<typeof pinMssqlSession>>).release(); await (h.raw as import('mssql').ConnectionPool).close(); h.closed = true } }
  driver.cancel = async h => { const request = h.runtime?.request as import('mssql').Request | undefined; if (!request) return false; request.cancel(); return true }
  const refreshTransaction = async (h: Parameters<DbDriver['execute']>[0]) => {
    const mssql = await import('mssql'), parent = (h.runtime!.session as Awaited<ReturnType<typeof pinMssqlSession>>).parent
    const request = new mssql.Request(parent)
    const timeout = setTimeout(() => request.cancel(), 2000)
    let state: import('mssql').IResult<{ transaction_depth: number }>
    try { state = await request.query('SELECT @@TRANCOUNT AS transaction_depth') }
    finally { clearTimeout(timeout) }
    const depth = Number(state.recordset[0]?.transaction_depth || 0)
    h.runtime!.transactionDepth = depth; h.runtime!.transaction = depth > 0
  }
  driver.execute = async (h, sql, opts) => {
    const mssql = await import('mssql'), started = Date.now(), max = normalizeLimit(opts?.maxRows)
    const parent = (h.runtime!.session as Awaited<ReturnType<typeof pinMssqlSession>>).parent
    const request = new mssql.Request(parent)
    h.runtime!.request = request; request.stream = true; request.arrayRowMode = true
    if (opts?.params) for (const [key, value] of Object.entries(opts.params)) request.input(key, value)
    const abort = () => request.cancel(); opts?.signal?.throwIfAborted(); opts?.signal?.addEventListener('abort', abort, { once: true })
    try {
      return await new Promise<QueryResult>((resolve, reject) => {
        const results: QueryResult[] = [], budget = new ResultBudget()
        let current: QueryResult | undefined, failure: unknown
        request.on('recordset', columns => {
          const metadata = Object.values(columns) as Array<{ name: string; type: unknown }>
          current = tableResult(sql, started, metadata.map(column => column.name), [], max); results.push(current)
          if (metadata.some(column => [mssql.Decimal, mssql.Numeric, mssql.Money, mssql.SmallMoney].includes(column.type as never))) { failure = new Error('For exact SQL Server decimal/money values, CAST those columns AS varchar(80) in the query; this client cannot preserve their precision automatically'); request.cancel() }
        })
        request.on('row', row => {
          if (failure || !current) return
          if (current.rows.length >= max) { current.truncated = true; return }
          try { const safe = (row as unknown[]).map(wireValue); budget.add(safe); current.rows.push(safe); current.rowCount++ }
          catch (error) { failure = error; request.cancel() }
        })
        request.on('error', error => { failure ||= error })
        request.on('done', result => {
          if (failure) { reject(failure); return }
          for (const item of results) item.durationMs = Date.now() - started
          const first = results[0] || tableResult(sql, started, [], [], max)
          first.affectedRows = result.rowsAffected.reduce((a: number, b: number) => a + b, 0)
          resolve({ ...first, ...(results.length > 1 ? { results } : {}) })
        })
        // batch preserves DECLARE/temp-table scope and CREATE PROCEDURE batch rules.
        // Reaching a row display limit discards extra rows; it never cancels later writes.
        void request.batch(sql).catch(error => reject(failure || error))
      })
    } finally {
      opts?.signal?.removeEventListener('abort', abort)
      h.runtime!.request = undefined
      // A procedure or XACT_ABORT may finish a transaction even on an error. Probe on the
      // same physical session before exposing the console's commit/rollback state again.
      try { await refreshTransaction(h) }
      catch { h.closed = true; throw new Error('SQL Server transaction state is unavailable; reconnect this console') }
    }
  }
  driver.transaction = async (h, operation) => {
    if ((operation === 'begin') === !!h.runtime?.transaction) throw new Error(operation === 'begin' ? 'Transaction already active' : 'No active transaction')
    await driver.execute(h, operation === 'begin' ? 'BEGIN TRANSACTION' : operation === 'commit' ? 'COMMIT TRANSACTION' : 'ROLLBACK TRANSACTION')
  }
  driver.listSchemas = async h => (await driver.execute(h, 'SELECT name FROM sys.schemas')).rows.map(r => String(r[0]))
  driver.listTables = async (h, scope) => (await driver.execute(h, 'SELECT TABLE_NAME, TABLE_TYPE FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = @schema', { params: { schema: scope.schema || 'dbo' } })).rows.map(r => ({ name: String(r[0]), type: r[1] === 'VIEW' ? 'view' : 'table', schema: scope.schema || 'dbo' }))
  driver.describeTable = async (h, scope, table) => ({ table, columns: (await driver.execute(h, 'SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=@schema AND TABLE_NAME=@table ORDER BY ORDINAL_POSITION', { params: { schema: scope.schema || 'dbo', table } })).rows.map(r => ({ name: String(r[0]), dataType: String(r[1]), nullable: r[2] === 'YES' })) })
  return driver
}

export function clickhouseAdapter(): DbDriver {
  const driver = adapterBase('clickhouse', 'ClickHouse', 'clickhouse', 8123)
  driver.capabilities.ddl = true
  driver.open = async (config, password) => {
    const { createClient } = await import('@clickhouse/client')
    const raw = createClient({ url: endpoint({ config }, 8123), username: config.username, password, database: config.database, request_timeout: 30000,
      clickhouse_settings: { output_format_json_quote_64bit_integers: 1, output_format_json_quote_decimals: 1 } })
    const health = await raw.ping(); if (!health.success) { await raw.close(); throw new Error('ClickHouse connection failed') }
    return { id: 'clickhouse', raw, config, password, database: config.database, readOnly: !!config.options?.readOnly, runtime: {} }
  }
  driver.close = async h => { await (h.raw as import('@clickhouse/client').ClickHouseClient).close(); h.closed = true }
  driver.execute = async (h, sql, opts) => {
    const started = Date.now(), max = normalizeLimit(opts?.maxRows), client = h.raw as import('@clickhouse/client').ClickHouseClient
    if (!/^(SELECT|WITH|SHOW|DESCRIBE|EXPLAIN)\b/i.test(sqlTokens(sql).trim())) { await client.command({ query: sql, abort_signal: opts?.signal, query_id: opts?.executionId }); return tableResult(sql, started, [], [], max) }
    const result = await client.query({ query: sql, format: 'JSONEachRow', abort_signal: opts?.signal, query_id: opts?.executionId,
      query_params: opts?.params && !Array.isArray(opts.params) ? opts.params : undefined,
      clickhouse_settings: { max_result_rows: String(max + 1), result_overflow_mode: 'break', max_execution_time: Math.ceil((opts?.timeoutMs || 30000) / 1000), ...(h.readOnly ? { readonly: '2' } : {}) } })
    const rows: Record<string, unknown>[] = []; const budget = new ResultBudget()
    try { for await (const chunk of result.stream()) { for (const row of chunk) { const value = row.json<Record<string, unknown>>(); budget.add(value); rows.push(value); if (rows.length > max) break }; if (rows.length > max) break } }
    finally { result.close() }
    return objectResult(sql, started, rows, max)
  }
  driver.cancel = async (h, executionId) => { if (!executionId) return false; await (h.raw as import('@clickhouse/client').ClickHouseClient).command({ query: 'KILL QUERY WHERE query_id = {id:String} SYNC', query_params: { id: executionId } }); return true }
  driver.listDatabases = async h => (await driver.execute(h, 'SHOW DATABASES')).rows.map(r => String(r[0]))
  driver.listTables = async (h, scope) => (await driver.execute(h, `SHOW TABLES FROM ${quoteIdentifier(scope.database || h.database || 'default')}`)).rows.map(r => ({ name: String(r[0]), type: 'table', database: scope.database || h.database }))
  driver.describeTable = async (h, scope, table) => ({ table, columns: (await driver.execute(h, `DESCRIBE TABLE ${quoteIdentifier(scope.database || h.database || 'default')}.${quoteIdentifier(table)}`)).rows.map(r => ({ name: String(r[0]), dataType: String(r[1]) })) })
  driver.getDdl = async (h, scope, table) => String((await driver.execute(h, `SHOW CREATE TABLE ${quoteIdentifier(scope.database || h.database || 'default')}.${quoteIdentifier(table)}`)).rows[0]?.[0] || '')
  return driver
}
