import { attachRelationalMetadata } from '@main/database/relationalMetadata'
import type { DbDriver, DriverHandle } from '@main/database/drivers'
import type { QueryResult } from '@shared/types/ssh-db'
import { normalizeLimit, sqlTokens, wireValue, ResultBudget } from '@main/database/queryPolicy'

interface MysqlRuntime { lease?: import('mysql2/promise').PoolConnection; active?: import('mysql2/promise').PoolConnection; transaction?: boolean; created: number; activeCount: number }
function mysqlRuntime(h: DriverHandle): MysqlRuntime { return h.runtime as unknown as MysqlRuntime }

/** Fixed transaction lease, bounded streaming and actual protocol cancellation. */
export function upgradeMysql(base: DbDriver): DbDriver {
  const driver: DbDriver = { ...base }
  driver.open = async (config, password) => {
    const mysql = await import('mysql2/promise')
    const pool = mysql.createPool({ host: config.host, port: config.port ?? 3306, user: config.username, password, database: config.database,
      connectionLimit: Math.max(1, Math.min(20, Number(config.options?.poolSize) || 5)), waitForConnections: true, queueLimit: 100,
      connectTimeout: 10000, supportBigNumbers: true, bigNumberStrings: true, dateStrings: true, multipleStatements: false,
      ssl: config.options?.ssl ? { rejectUnauthorized: config.options?.rejectUnauthorized !== false, ca: typeof config.options.ca === 'string' ? config.options.ca : undefined } : undefined })
    const runtime: MysqlRuntime = { created: 0, activeCount: 0 }
    pool.on('connection', () => runtime.created++)
    try { await pool.query('SELECT 1') } catch (error) { await pool.end(); throw error }
    return { id: config.driver, raw: pool, config, password, database: config.database, readOnly: !!config.options?.readOnly, runtime: runtime as unknown as Record<string, unknown> }
  }
  driver.cancel = async h => {
    const active = mysqlRuntime(h).active
    if (!active) return false
    const mysql = await import('mysql2/promise')
    const control = await mysql.createConnection({ host: h.config.host, port: h.config.port ?? 3306, user: h.config.username, password: h.password, connectTimeout: 5000,
      ssl: h.config.options?.ssl ? { rejectUnauthorized: h.config.options?.rejectUnauthorized !== false, ca: typeof h.config.options.ca === 'string' ? h.config.options.ca : undefined } : undefined })
    try { await control.query(`KILL QUERY ${Number(active.threadId)}`); return true } finally { await control.end() }
  }
  driver.execute = async (h, sql, opts) => {
    opts?.signal?.throwIfAborted()
    const pool = h.raw as import('mysql2/promise').Pool, runtime = mysqlRuntime(h)
    const conn = runtime.lease ?? await pool.getConnection(); runtime.active = conn; runtime.activeCount++
    const started = Date.now(), max = normalizeLimit(opts?.maxRows)
    let capped = false, cancellation: Promise<unknown> | undefined
    const stop = () => cancellation ||= driver.cancel!(h)
    const abort = () => { void stop().catch(() => { conn.destroy(); h.closed = !!runtime.lease }) }
    opts?.signal?.addEventListener('abort', abort, { once: true })
    try {
      if (h.readOnly && !runtime.transaction) await conn.query('SET SESSION TRANSACTION READ ONLY')
      // mysql2 streaming bounds retained rows; reaching the limit cancels the server SELECT.
      return await new Promise<QueryResult>((resolve, reject) => {
        const rows: unknown[][] = []; const budget = new ResultBudget(); let columns: QueryResult['columns'] = [], affectedRows: number | undefined, failure: unknown
        const query = (conn.connection as unknown as import('mysql2').PoolConnection).query({ sql, rowsAsArray: true }, Array.isArray(opts?.params) ? opts.params : [])
        query.on('fields', (fields: import('mysql2').FieldPacket[]) => { columns = (fields || []).map(f => ({ name: f.name, dataType: String(f.type) })) })
        const stream = query.stream({ highWaterMark: 32 })
        stream.on('data', (row: unknown) => {
          if (Array.isArray(row)) {
            if (rows.length < max) { try { const safe = row.map(wireValue); budget.add(safe); rows.push(safe) } catch (error) { failure = error; void stop().catch(() => stream.destroy(error as Error)); return } }
            else if (!capped) { capped = true; void stop().catch(reject) }
          } else if (row && typeof row === 'object' && 'affectedRows' in row) affectedRows = Number(row.affectedRows)
        })
        const result = () => ({ sql, columns, rows, rowCount: rows.length, affectedRows, truncated: capped, durationMs: Date.now() - started })
        stream.once('end', () => failure ? reject(failure) : resolve(result()))
        stream.once('error', (error: Error) => { if (failure) reject(failure); else if (capped && !opts?.signal?.aborted && ['ER_QUERY_INTERRUPTED','ER_QUERY_TIMEOUT'].includes(String((error as Error & { code?: string }).code))) resolve(result()); else reject(error) })
      })
    } finally {
      await cancellation?.catch(() => undefined)
      opts?.signal?.removeEventListener('abort', abort); runtime.active = undefined; runtime.activeCount--
      if (!runtime.lease) conn.release()
    }
  }
  driver.transaction = async (h, operation) => {
    const runtime = mysqlRuntime(h)
    if (operation === 'begin') {
      if (runtime.transaction) throw new Error('Transaction already active')
      const conn = await (h.raw as import('mysql2/promise').Pool).getConnection()
      try { if (h.readOnly) await conn.query('SET SESSION TRANSACTION READ ONLY'); await conn.beginTransaction(); runtime.lease = conn; runtime.transaction = true }
      catch (error) { conn.release(); throw error }
    } else {
      if (!runtime.lease || !runtime.transaction) throw new Error('No active transaction')
      try { if (operation === 'commit') await runtime.lease.commit(); else await runtime.lease.rollback() }
      finally { runtime.lease.release(); runtime.lease = undefined; runtime.transaction = false }
    }
  }
  driver.close = async h => { if (mysqlRuntime(h).transaction) await driver.transaction!(h, 'rollback'); await (h.raw as import('mysql2/promise').Pool).end(); h.closed = true }
  driver.explain = (h, sql) => driver.execute(h, `EXPLAIN ${sql}`)
  attachRelationalMetadata(driver, 'mysql')
  return driver
}

export function upgradePostgres(base: DbDriver): DbDriver {
  const driver = { ...base }
  driver.open = async (config, password) => {
    const pg = await import('pg')
    const client = new pg.Client({ host: config.host, port: config.port ?? 5432, user: config.username, password, database: config.database,
      connectionTimeoutMillis: 10000, application_name: 'eNest',
      ssl: config.options?.ssl ? { rejectUnauthorized: config.options?.rejectUnauthorized !== false, ca: typeof config.options.ca === 'string' ? config.options.ca : undefined } : undefined,
      types: { getTypeParser(oid, format) { return [20, 1700, 1082, 1114, 1184].includes(oid) ? (value: string) => value : pg.types.getTypeParser(oid, format) } } })
    try { await client.connect(); if (config.options?.readOnly) await client.query('SET default_transaction_read_only = on') }
    catch (error) { await client.end().catch(() => undefined); throw error }
    let result: import('pg').QueryResult
    try { result = await client.query('SELECT pg_backend_pid() AS pid') } catch (error) { await client.end(); throw error }
    const handle: DriverHandle = { id: config.driver, raw: client, config, password, database: config.database, readOnly: !!config.options?.readOnly, runtime: { backendPid: result.rows[0].pid, transaction: false, activeCount: 0 } }
    client.on('error', () => { handle.closed = true })
    return handle
  }
  driver.cancel = async h => {
    const pg = await import('pg')
    const control = new pg.Client({ host: h.config.host, port: h.config.port ?? 5432, user: h.config.username, password: h.password, database: h.database,
      connectionTimeoutMillis: 5000, ssl: h.config.options?.ssl ? { rejectUnauthorized: h.config.options?.rejectUnauthorized !== false, ca: typeof h.config.options.ca === 'string' ? h.config.options.ca : undefined } : undefined })
    try { await control.connect(); const result = await control.query('SELECT pg_cancel_backend($1) AS cancelled', [h.runtime?.backendPid]); return result.rows[0]?.cancelled === true }
    finally { await control.end() }
  }
  driver.execute = async (h, sql, opts) => {
    const client = h.raw as import('pg').Client, started = Date.now(), max = normalizeLimit(opts?.maxRows)
    opts?.signal?.throwIfAborted()
    let cancellation: Promise<unknown> | undefined
    const abort = () => { cancellation ||= driver.cancel!(h).catch(() => undefined) }
    opts?.signal?.addEventListener('abort', abort, { once: true }); h.runtime!.activeCount = 1
    try {
      if (/^(SELECT|WITH|VALUES)\b/i.test(sqlTokens(sql).trim())) {
        const { default: QueryStream } = await import('pg-query-stream')
        const stream = client.query(new QueryStream(sql, Array.isArray(opts?.params) ? opts.params : [], { batchSize: Math.min(max + 1, 128), rowMode: 'array' }))
        const rows: unknown[][] = []; const budget = new ResultBudget(); let truncated = false
        for await (const row of stream) { if (rows.length >= max) { truncated = true; break }; const safe = (row as unknown[]).map(wireValue); budget.add(safe); rows.push(safe) }
        // pg-query-stream exposes cursor result metadata after first fetch, including empty SELECTs.
        const fields = (stream as unknown as { cursor: { _result: { fields: Array<{ name: string; dataTypeID: number }> } } }).cursor._result.fields
        return { sql, columns: fields.map(f => ({ name: f.name, dataType: String(f.dataTypeID) })), rows, rowCount: rows.length, truncated, durationMs: Date.now() - started }
      }
      // The row listener disables pg's internal result accumulation for commands with RETURNING/SHOW/EXPLAIN.
      const pg = await import('pg')
      return await new Promise<QueryResult>((resolve, reject) => {
        const rows: unknown[][] = [], budget = new ResultBudget(); let truncated = false, failure: unknown
        const query = new pg.Query({ text: sql, values: Array.isArray(opts?.params) ? opts.params : [], rowMode: 'array' } as import('pg').QueryConfig)
        query.on('row', row => { if (rows.length >= max) { truncated = true; return }; if (failure) return; try { const safe = (row as unknown[]).map(wireValue); budget.add(safe); rows.push(safe) } catch (error) { failure = error; abort() } })
        query.once('error', error => reject(failure || error))
        query.once('end', result => failure ? reject(failure) : resolve({ sql, columns: result.fields.map((f: import('pg').FieldDef) => ({ name: f.name, dataType: String(f.dataTypeID) })), rows, rowCount: rows.length, affectedRows: result.rowCount ?? undefined, truncated, durationMs: Date.now() - started }))
        client.query(query)
      })
    } finally { await cancellation; opts?.signal?.removeEventListener('abort', abort); h.runtime!.activeCount = 0 }
  }
  driver.transaction = async (h, operation) => {
    if ((operation === 'begin') === !!h.runtime?.transaction) throw new Error(operation === 'begin' ? 'Transaction already active' : 'No active transaction')
    await (h.raw as import('pg').Client).query(operation.toUpperCase()); h.runtime!.transaction = operation === 'begin'
  }
  driver.close = async h => { await (h.raw as import('pg').Client).end(); h.closed = true }
  driver.explain = (h, sql) => driver.execute(h, `EXPLAIN ${sql}`)
  attachRelationalMetadata(driver, 'postgres')
  return driver
}
