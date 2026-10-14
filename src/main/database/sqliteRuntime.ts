import { Worker } from 'node:worker_threads'
import { mkdirSync, existsSync } from 'node:fs'
import { dirname } from 'node:path'
import type { DbDriver, DriverHandle } from '@main/database/drivers'
import { adapterBase } from '@main/database/adapterUtils'
import { normalizeLimit, quoteIdentifier } from '@main/database/queryPolicy'
import type { QueryResult } from '@shared/types/ssh-db'

// The worker is an embedded build asset: no filesystem-relative worker path or eval of user SQL as JS.
const source = `
const { parentPort, workerData } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');
let db;
try { db = new DatabaseSync(workerData.path, {readOnly:workerData.readOnly,allowExtension:false});
  if(typeof db.setAuthorizer!=='function')throw new Error('SQLite host authorizer is unavailable');
  db.exec('PRAGMA trusted_schema=OFF; PRAGMA temp_store=MEMORY');
  const C=require('node:sqlite').constants;
  db.setAuthorizer((action,arg1,arg2)=> {
    if(action===C.SQLITE_ATTACH || action===C.SQLITE_DETACH)return C.SQLITE_DENY;
    if(action===C.SQLITE_PRAGMA && ['temp_store_directory','data_store_directory','writable_schema','trusted_schema','temp_store'].includes(String(arg1).toLowerCase()))return C.SQLITE_DENY;
    if(action===C.SQLITE_FUNCTION && ['load_extension','readfile','writefile','eval'].includes(String(arg2 || arg1).toLowerCase()))return C.SQLITE_DENY;
    if(action===C.SQLITE_CREATE_VTABLE && !['fts3','fts4','fts5','rtree','rtree_i32'].includes(String(arg2).toLowerCase()))return C.SQLITE_DENY;
    return C.SQLITE_OK;
  }); parentPort.postMessage({ready:true}); }
catch(e) { parentPort.postMessage({ready:false,error:e.message}); }
function wire(v) { if(typeof v==='bigint')return v.toString(); if(v instanceof Uint8Array)return {$binary:Buffer.from(v).toString('base64')}; return v; }
parentPort.on('message', ({id,sql,params,maxRows}) => {
  try {
    const started=Date.now(), stmt=db.prepare(sql); stmt.setReadBigInts(true); if(stmt.setReturnArrays)stmt.setReturnArrays(true);
    const cols=stmt.columns().map(c=>({name:c.name,dataType:c.type})); let rows=[],affectedRows,truncated=false,bytes=0;
    const bindings=Array.isArray(params)?params:(params?[params]:[]);
    if(cols.length) { for(const row of stmt.iterate(...bindings)) { if(rows.length>=maxRows){truncated=true;break;} const values=Array.isArray(row)?row.map(wire):cols.map(c=>wire(row[c.name]));bytes+=Buffer.byteLength(JSON.stringify(values));if(bytes>6*1024*1024)throw new Error('Result exceeds 6 MiB; narrow the query');rows.push(values); } }
    else {const result=stmt.run(...bindings);affectedRows=Number(result.changes);}
    parentPort.postMessage({id,result:{sql,columns:cols,rows,rowCount:rows.length,affectedRows,truncated,durationMs:Date.now()-started}});
  } catch(e) { parentPort.postMessage({id,error:e.message}); }
});`

class SqliteConnection {
  readonly worker: Worker
  readonly ready: Promise<void>
  private sequence = 0
  private pending = new Map<number, { resolve: (value: QueryResult) => void; reject: (error: Error) => void }>()
  constructor(path: string, readOnly: boolean) {
    this.worker = new Worker(source, { eval: true, workerData: { path, readOnly } })
    this.ready = new Promise((resolve, reject) => {
      this.worker.once('message', message => { if (message.ready) resolve(); else reject(new Error(message.error)) })
      this.worker.once('error', reject)
    })
    this.worker.on('message', message => {
      const pending = this.pending.get(message.id); if (!pending) return
      this.pending.delete(message.id)
      if (message.error) pending.reject(new Error(message.error)); else pending.resolve(message.result)
    })
    this.worker.on('error', error => this.fail(error))
    this.worker.on('exit', () => this.fail(new Error('SQLite connection closed; reconnect to continue')))
  }
  fail(error: Error): void { for (const pending of this.pending.values()) pending.reject(error); this.pending.clear() }
  async execute(sql: string, params?: unknown[] | Record<string, unknown>, maxRows = 1000): Promise<QueryResult> {
    await this.ready
    const id = ++this.sequence
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.worker.postMessage({ id, sql, params, maxRows }) })
  }
  async close(): Promise<void> { await this.worker.terminate() }
}

export function sqliteAdapter(): DbDriver {
  const driver = adapterBase('sqlite', 'SQLite', 'sqlite')
  driver.capabilities = { ...driver.capabilities, explain: true, fileBased: true, ddl: true, updatableResult: true, import: true }
  driver.open = async config => {
    const path = config.filePath || config.sqlitePath
    if (!path) throw new Error('SQLite filePath is required')
    if (path !== ':memory:' && !config.createIfMissing && !existsSync(path)) throw new Error('SQLite file does not exist; enable createIfMissing to create it')
    if (config.createIfMissing && !config.options?.readOnly) mkdirSync(dirname(path), { recursive: true })
    const raw = new SqliteConnection(path, !!config.options?.readOnly)
    try { await raw.ready } catch (error) { await raw.close(); throw error }
    return { id: 'sqlite', raw, config, database: 'main', readOnly: !!config.options?.readOnly, runtime: { transaction: false } }
  }
  driver.close = async h => { await (h.raw as SqliteConnection).close(); h.closed = true }
  driver.cancel = async h => { await driver.close(h); return true }
  driver.execute = async (h, sql, opts) => {
    opts?.signal?.throwIfAborted()
    const abort = () => { void driver.cancel!(h) }
    opts?.signal?.addEventListener('abort', abort, { once: true })
    try { return await (h.raw as SqliteConnection).execute(sql, opts?.params, normalizeLimit(opts?.maxRows)) }
    finally { opts?.signal?.removeEventListener('abort', abort) }
  }
  driver.transaction = async (h, operation) => {
    if ((operation === 'begin') === !!h.runtime?.transaction) throw new Error('Invalid transaction state')
    await driver.execute(h, operation.toUpperCase()); h.runtime!.transaction = operation === 'begin'
  }
  driver.explain = (h, sql) => driver.execute(h, `EXPLAIN QUERY PLAN ${sql}`)
  driver.listDatabases = async () => ['main']
  driver.listTables = async h => {
    const result = await driver.execute(h, "SELECT name, type FROM sqlite_schema WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%'", { maxRows: 10000 })
    return result.rows.map(row => ({ name: String(row[0]), type: row[1] === 'view' ? 'view' : 'table', database: 'main' }))
  }
  driver.describeTable = async (h, _scope, table) => {
    const result = await driver.execute(h, `PRAGMA table_info(${quoteIdentifier(table)})`)
    const columns = result.rows.map(row => ({ name: String(row[1]), dataType: String(row[2]), nullable: row[3] === '0', default: row[4], defaultValue: row[4], primaryKey: Number(row[5]) > 0 }))
    const indexList = await driver.execute(h, `PRAGMA index_list(${quoteIdentifier(table)})`)
    const indexes: NonNullable<import('@shared/types/ssh-db').TableDetail['indexes']> = []
    for (const row of indexList.rows) { const name = String(row[1]); const info = await driver.execute(h, `PRAGMA index_info(${quoteIdentifier(name)})`); indexes.push({ name, unique: Number(row[2]) === 1, columns: info.rows.map(item => String(item[2])) }) }
    const references = await driver.execute(h, `PRAGMA foreign_key_list(${quoteIdentifier(table)})`), foreignKeys = new Map<string, NonNullable<import('@shared/types/ssh-db').TableDetail['foreignKeys']>[number]>()
    for (const row of references.rows) { const name = `fk_${row[0]}`, fk = foreignKeys.get(name) || { name, columns: [], referencedTable: String(row[2]), referencedColumns: [] }; fk.columns.push(String(row[3])); fk.referencedColumns.push(String(row[4])); foreignKeys.set(name, fk) }
    return { table, columns, primaryKey: result.rows.filter(row => Number(row[5]) > 0).sort((a,b) => Number(a[5])-Number(b[5])).map(row => String(row[1])), indexes, foreignKeys: [...foreignKeys.values()] }
  }
  driver.completionCatalog = async h => {
    const tables = await driver.listTables(h, {}), result: import('@shared/types/ssh-db').CompletionCatalog = { dialect: 'sqlite', databases: ['main'], schemas: [], tables: [] }
    for (const table of tables.slice(0, 300)) { const detail = await driver.describeTable(h, {}, table.name); result.tables.push({ name: table.name, type: table.type, columns: detail.columns.map(column => ({ name: column.name, type: column.dataType, pk: column.primaryKey })), fks: detail.foreignKeys?.flatMap(fk => fk.columns.map((column, index) => ({ column, refTable: fk.referencedTable, refColumn: fk.referencedColumns[index] }))) }) }
    return result
  }
  driver.getDdl = async (h, _scope, table) => {
    const result = await driver.execute(h, 'SELECT sql FROM sqlite_schema WHERE name = ?', { params: [table] }); return String(result.rows[0]?.[0] || '')
  }
  return driver
}
