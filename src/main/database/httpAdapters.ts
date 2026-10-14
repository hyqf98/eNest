import { Readable } from 'node:stream'
import { fetch as proxyFetch, EnvHttpProxyAgent } from 'undici'
import { parse as csvParser } from 'csv-parse'
import { parse as parseLossless } from 'lossless-json'
import type { DbDriver, DriverExecuteOptions, DriverHandle } from '@main/database/drivers'
import type { DbDriverId } from '@shared/types/ssh-db'
import { adapterBase, endpoint, objectResult, tableResult } from '@main/database/adapterUtils'
import { normalizeLimit, quoteIdentifier, sqlTokens, ResultBudget, wireValue } from '@main/database/queryPolicy'

export function preciseJson(text: string): unknown {
  return parseLossless(text, undefined, value => /^-?\d+$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : value)
}
let proxyKey = '', proxyAgent: EnvHttpProxyAgent | undefined
function agent(): EnvHttpProxyAgent {
  const key = JSON.stringify([process.env.HTTP_PROXY, process.env.HTTPS_PROXY, process.env.NO_PROXY])
  if (!proxyAgent || key !== proxyKey) { if (proxyAgent) void proxyAgent.close(); proxyKey = key; proxyAgent = new EnvHttpProxyAgent({ httpProxy: process.env.HTTP_PROXY, httpsProxy: process.env.HTTPS_PROXY, noProxy: process.env.NO_PROXY }) }
  return proxyAgent
}
async function http(h: DriverHandle, path: string, init: RequestInit, opts?: DriverExecuteOptions, port = 8086): Promise<Response> {
  // The utility inherits the application proxy environment and refreshes its dispatcher on changes.
  const dispatcher = agent()
  const timeout = AbortSignal.timeout(Math.max(100, opts?.timeoutMs || 30000))
  const response = await proxyFetch(endpoint(h, port) + path, { ...init as Parameters<typeof proxyFetch>[1], dispatcher, signal: opts?.signal ? AbortSignal.any([opts.signal, timeout]) : timeout })
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${(await boundedText(response as unknown as Response)).slice(0, 2000)}`)
  return response as unknown as Response
}

async function boundedText(response: Response, maximum = 6 * 1024 * 1024): Promise<string> {
  if (!response.body) return ''
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let bytes = 0
  try { while (true) { const { done, value } = await reader.read(); if (done) break; bytes += value.byteLength; if (bytes > maximum) throw new Error('HTTP result exceeds 6 MiB; narrow the query'); chunks.push(value) } }
  finally { await reader.cancel().catch(() => undefined); reader.releaseLock() }
  return Buffer.concat(chunks).toString('utf8')
}

export function influxAdapter(id: 'influxdb' | 'influxdb1' | 'influxdb3'): DbDriver {
  const driver = adapterBase(id, id === 'influxdb' ? 'InfluxDB 2 (Flux)' : id === 'influxdb1' ? 'InfluxDB 1 (InfluxQL)' : 'InfluxDB 3 (SQL)', id === 'influxdb' ? 'flux' : id === 'influxdb1' ? 'influxql' : 'influx3', id === 'influxdb3' ? 8181 : 8086)
  driver.capabilities.timeSeries = true
  driver.open = async (config, password) => {
    const h: DriverHandle = { id, raw: null, config, password, database: config.bucket || config.database, readOnly: !!config.options?.readOnly }
    await http(h, '/health', { headers: password ? { Authorization: `${id === 'influxdb3' ? 'Bearer' : 'Token'} ${password}` } : {} }, undefined, driver.defaultPort)
    return h
  }
  driver.execute = async (h, text, opts) => {
    const started = Date.now(), max = normalizeLimit(opts?.maxRows)
    if (id === 'influxdb1') {
      const query = new URLSearchParams({ db: h.database || '', q: text })
      if (h.config.username) query.set('u', h.config.username)
      if (h.password) query.set('p', h.password)
      const response = await http(h, '/query', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: query.toString() }, opts)
      const data = preciseJson(await boundedText(response)) as { results?: Array<{ error?: string; series?: Array<{ columns: string[]; values: unknown[][] }> }> }
      const result = data.results?.[0]
      if (result?.error) throw new Error(result.error)
      const series = result?.series || []
      if (series.length > 1) throw new Error('InfluxQL returned multiple series; select one measurement/tag group to avoid merging incompatible schemas')
      return tableResult(text, started, series[0]?.columns || [], series[0]?.values || [], max)
    }
    if (id === 'influxdb3') {
      const response = await http(h, '/api/v3/query_sql', { method: 'POST', headers: { Authorization: `Bearer ${h.password || ''}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ db: h.database, q: text, format: 'json' }) }, opts, 8181)
      return objectResult(text, started, preciseJson(await boundedText(response)) as Record<string, unknown>[], max)
    }
    const response = await http(h, `/api/v2/query?org=${encodeURIComponent(h.config.org || String(h.config.options?.org || ''))}`, {
      method: 'POST', headers: { Authorization: `Token ${h.password || ''}`, 'Content-Type': 'application/vnd.flux', Accept: 'application/csv' }, body: text
    }, opts)
    if (!response.body) return tableResult(text, started, [], [], max)
    const stream = Readable.fromWeb(response.body as never).pipe(csvParser({ comment: '#', skip_empty_lines: true, relax_column_count: true, max_record_size: 1024 * 1024 }))
    let names: string[] = []; const rows: unknown[][] = []; const budget = new ResultBudget()
    try {
      for await (const row of stream) {
        if (!names.length) names = row as string[]
        else if ((row as string[]).join('\0') !== names.join('\0')) { if (row[1] === 'result' && row[2] === 'table') throw new Error('Flux returned incompatible table schemas; select a single table or align columns'); budget.add(row); rows.push(row) }
        if (rows.length > max) break
      }
    } finally { stream.destroy(); await response.body.cancel().catch(() => undefined) }
    return tableResult(text, started, names, rows, max)
  }
  driver.listDatabases = async h => {
    if (id === 'influxdb') {
      const response = await http(h, '/api/v2/buckets', { headers: { Authorization: `Token ${h.password || ''}` } })
      const data = preciseJson(await boundedText(response)) as { buckets: Array<{ name: string }> }; return data.buckets.map(b => b.name)
    }
    return h.database ? [h.database] : []
  }
  driver.listTables = async h => {
    const text = id === 'influxdb' ? `import "influxdata/influxdb/schema"\nschema.measurements(bucket: ${JSON.stringify(h.database)})` : id === 'influxdb1' ? 'SHOW MEASUREMENTS' : 'SHOW TABLES'
    const result = await driver.execute(h, text)
    return result.rows.map(row => ({ name: String(row[result.columns.findIndex(c => c.name === '_value')] ?? row[0] ?? ''), type: 'measurement', database: h.database }))
  }
  return driver
}

let tdengineHandles = 0
export function tdengineAdapter(): DbDriver {
  const driver = adapterBase('tdengine', 'TDengine', 'tdengine', 6041)
  driver.capabilities.timeSeries = true; driver.capabilities.ddl = true
  driver.open = async (config, password) => {
    const td = await import('@tdengine/websocket')
    const uri = String(config.options?.uri || `${config.options?.ssl ? 'wss' : 'ws'}://${config.host || '127.0.0.1'}:${config.port ?? 6041}`)
    const conf = new td.WSConfig(uri); conf.setUser(config.username || 'root'); conf.setPwd(password || ''); conf.setTimeOut(30000); conf.setUserApp('eNest')
    if (config.database) conf.setDb(config.database)
    tdengineHandles++
    let raw: import('@tdengine/websocket').WsSql
    try { raw = await td.sqlConnect(conf) } catch (error) { if (--tdengineHandles === 0) await td.destroy(); throw error }
    return { id: 'tdengine', raw, config, password, database: config.database, readOnly: !!config.options?.readOnly, runtime: {} }
  }
  driver.close = async h => { if (h.closed) return; h.closed = true; try { await (h.raw as import('@tdengine/websocket').WsSql).close() } finally { if (--tdengineHandles === 0) { const td = await import('@tdengine/websocket'); await td.destroy() } } }
  driver.cancel = async h => { await driver.close(h); return true }
  driver.execute = async (h, sql, opts) => {
    const started = Date.now(), max = normalizeLimit(opts?.maxRows), client = h.raw as import('@tdengine/websocket').WsSql
    const abort = () => { void driver.cancel!(h) }; opts?.signal?.throwIfAborted(); opts?.signal?.addEventListener('abort', abort, { once: true })
    try {
      if (!/^(SELECT|WITH|SHOW|DESCRIBE|EXPLAIN)\b/i.test(sqlTokens(sql).trim())) {
        const result = await client.exec(sql)
        return { ...tableResult(sql, started, result.getMeta()?.map(m => m.name) || [], result.getData() || [], max), affectedRows: result.getAffectRows() ?? undefined }
      }
      const cursor = await client.query(sql); const rows: unknown[][] = []; const budget = new ResultBudget()
      try {
        while (await cursor.next()) { const row = cursor.getData(); if (row) { const safe = row.map(wireValue); budget.add(safe); rows.push(safe) }; if (rows.length > max) break }
        return tableResult(sql, started, cursor.getMeta()?.map(m => m.name) || [], rows, max)
      } finally { await cursor.close() }
    } finally { opts?.signal?.removeEventListener('abort', abort) }
  }
  driver.listDatabases = async h => (await driver.execute(h, 'SHOW DATABASES')).rows.map(row => String(row[0]))
  driver.listTables = async h => {
    const [tables, stables] = await Promise.all([driver.execute(h, 'SHOW TABLES'), driver.execute(h, 'SHOW STABLES')])
    return [...tables.rows.map(r => ({ name: String(r[0]), type: 'table' as const, database: h.database })), ...stables.rows.map(r => ({ name: String(r[0]), type: 'supertable' as const, database: h.database }))]
  }
  driver.describeTable = async (h, _scope, table) => {
    const columns = (await driver.execute(h, `DESCRIBE ${quoteIdentifier(table, 'mysql')}`)).rows.map(r => ({ name: String(r[0]), dataType: String(r[1]), comment: String(r[3] || '') }))
    return { table, columns, metadata: { tags: columns.filter(column => column.comment.toUpperCase() === 'TAG').map(column => ({ name: column.name, dataType: column.dataType })) } }
  }
  driver.getDdl = async (h, _scope, table) => String((await driver.execute(h, `SHOW CREATE TABLE ${quoteIdentifier(table, 'mysql')}`)).rows[0]?.[1] || '')
  return driver
}

export function searchAdapter(id: 'elasticsearch' | 'opensearch'): DbDriver {
  const driver = adapterBase(id, id === 'elasticsearch' ? 'Elasticsearch' : 'OpenSearch', 'json', 9200)
  const headers = (h: DriverHandle) => ({ 'Content-Type': 'application/json', ...(h.config.username ? { Authorization: `Basic ${Buffer.from(`${h.config.username}:${h.password || ''}`).toString('base64')}` } : h.password ? { Authorization: `ApiKey ${h.password}` } : {}) })
  driver.open = async (config, password) => { const h: DriverHandle = { id, raw: null, config, password, database: config.database, readOnly: true }; await http(h, '/', { headers: headers(h) }, undefined, 9200); return h }
  driver.execute = async (h, text, opts) => {
    const started = Date.now(), max = normalizeLimit(opts?.maxRows), body = JSON.parse(text)
    if (body.size !== undefined && (!Number.isFinite(body.size) || body.size < 0)) throw new Error('Invalid search size')
    body.size = Math.min(body.size ?? max + 1, max + 1)
    const index = typeof body.index === 'string' ? body.index : h.database || '_all'; delete body.index
    const response = await http(h, `/${encodeURIComponent(index)}/_search`, { method: 'POST', headers: headers(h), body: JSON.stringify(body) }, opts, 9200)
    const data = preciseJson(await boundedText(response)) as { hits?: { hits?: Record<string, unknown>[] } }
    return { ...objectResult(text, started, data.hits?.hits || [], max), format: 'document' }
  }
  driver.listDatabases = async h => {
    const response = await http(h, '/_cat/indices?format=json&h=index', { headers: headers(h) }, undefined, 9200)
    return (preciseJson(await boundedText(response)) as Array<{ index: string }>).map(row => row.index)
  }
  driver.listTables = async h => (await driver.listDatabases(h)).map(name => ({ name, type: 'collection', database: name }))
  driver.describeTable = async (_h, _scope, table) => ({ table, columns: [{ name: '_source', dataType: 'JSON document' }] })
  return driver
}
