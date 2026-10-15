import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import ts from 'typescript'
const require = createRequire(import.meta.url)
function load(file, mocks = {}) {
  const js = ts.transpileModule(readFileSync(new URL(file, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const module = { exports: {} }
  new Function('require', 'module', 'exports', js)(name => mocks[name] ?? require(name), module, module.exports)
  return module.exports
}
const parser = load('./sqlScript.ts')
const policy = load('./queryPolicy.ts', { '@main/database/sqlScript': parser })
const adapter = load('./adapterUtils.ts', { '@main/database/queryPolicy': policy })
const pin = load('./mssqlSession.ts')

test('MySQL pins a session, separates CALL resultsets and probes transactions after failed CALL', async () => {
  let acquired = 0, released = 0, killed = 0, transaction = false
  const connection = new EventEmitter()
  connection.query = ({ sql }) => {
    const query = new EventEmitter()
    queueMicrotask(() => {
      if (sql === 'CALL failing()') { transaction = true; query.emit('error', new Error('procedure failed')); return }
      query.emit('fields', [{ name: 'left', type: 3 }]); query.emit('result', [1]); query.emit('result', [2]); query.emit('result', [3])
      query.emit('fields', [{ name: 'right', type: 3 }]); query.emit('result', [9])
      query.emit('fields', undefined); query.emit('result', { affectedRows: 1, serverStatus: transaction ? 1 : 2 }); query.emit('end')
    })
    return query
  }
  const session = { connection, threadId: 1, query: async () => [{ serverStatus: transaction ? 1 : 2 }], beginTransaction: async () => { transaction = true }, commit: async () => { transaction = false }, rollback: async () => { transaction = false }, release: () => released++, destroy() {} }
  const pool = { on() {}, getConnection: async () => { acquired++; return session }, end: async () => {} }
  const mysql = { createPool: () => pool, createConnection: async () => ({ query: async () => killed++, end: async () => {} }) }
  const { upgradeMysql } = load('./relationalRuntime.ts', { '@main/database/queryPolicy': policy, '@main/database/relationalMetadata': { attachRelationalMetadata() {} }, 'mysql2/promise': mysql })
  const driver = upgradeMysql(adapter.adapterBase('mysql', 'MySQL', 'mysql')), h = await driver.open({ driver: 'mysql' })
  const result = await driver.execute(h, 'CALL p()', { maxRows: 1 })
  assert.equal(acquired, 1); assert.equal(released, 0); assert.equal(killed, 0)
  assert.deepEqual(result.results.map(set => set.columns.map(column => column.name)), [['left'], ['right'], []])
  assert.equal(result.results[0].truncated, true); assert.deepEqual(result.results[1].rows, [[9]])
  await assert.rejects(driver.execute(h, 'CALL failing()'), /procedure failed/)
  assert.equal(h.runtime.transaction, true)
  await driver.transaction(h, 'rollback'); assert.equal(h.runtime.transaction, false)
  await driver.close(h); assert.equal(released, 1)
})

test('SQL Server batches drain limited recordsets, retain session and refresh transaction ownership', async () => {
  let acquired = 0, released = 0, cancelled = 0, writesAfterResult = 0, depth = 0
  const requests = []
  class Pool {
    connected = true; config = {}; async connect() { return this } async acquire() { acquired++; return {} } release() { released++ } async close() {}
  }
  class Request extends EventEmitter {
    constructor(parent) { super(); this.parent = parent }
    input() { return this }
    cancel() { cancelled++ }
    async query(sql) { assert.match(sql, /@@TRANCOUNT/); return { recordset: [{ transaction_depth: depth }] } }
    async batch(sql) {
      requests.push(sql)
      if (sql === 'ROLLBACK TRANSACTION') { depth = 0; this.emit('done', { rowsAffected: [] }); return }
      await new Promise(resolve => this.parent.acquire(this, () => resolve()))
      this.emit('recordset', [{ name: 'left', type: 'int' }]); this.emit('row', [1]); this.emit('row', [2]); this.emit('row', [3])
      writesAfterResult++; depth = 1
      this.emit('recordset', [{ name: 'right', type: 'int' }]); this.emit('row', [9]); this.emit('done', { rowsAffected: [1] })
      this.parent.release({})
    }
  }
  const mssql = { ConnectionPool: Pool, Request, Decimal: 'decimal', Numeric: 'numeric', Money: 'money', SmallMoney: 'smallmoney' }
  const { mssqlAdapter } = load('./additionalSqlAdapters.ts', { '@main/database/queryPolicy': policy, '@main/database/adapterUtils': adapter, '@main/database/mssqlSession': pin, mssql })
  const driver = mssqlAdapter(), h = await driver.open({ driver: 'mssql' })
  const result = await driver.execute(h, 'DECLARE @v INT; SELECT @v; UPDATE x SET n=1; SELECT 9;', { maxRows: 1 })
  assert.equal(acquired, 1); assert.equal(released, 0); assert.equal(cancelled, 0); assert.equal(writesAfterResult, 1)
  assert.equal(result.results[0].truncated, true); assert.deepEqual(result.results[1].rows, [[9]])
  assert.equal(h.runtime.transaction, true)
  await driver.close(h); assert.equal(requests.at(-1), 'ROLLBACK TRANSACTION'); assert.equal(released, 1)
})

test('Oracle implicit cursors remain independent and all close; failed PL/SQL exposes pending transaction', async () => {
  const closed = []
  const cursor = (name, value) => ({ metaData: [{ name }], getRows: async () => [[value]], close: async () => closed.push(name) })
  const connection = { transactionInProgress: false, close: async () => {}, rollback: async () => { connection.transactionInProgress = false }, async execute(sql) {
    if (sql === 'BEGIN broken; END;') { this.transactionInProgress = true; throw new Error('block failed') }
    return { implicitResults: [cursor('left', 1), cursor('right', 2)] }
  } }
  const oracle = { getConnection: async () => connection, OUT_FORMAT_ARRAY: 4001 }
  const { oracleAdapter } = load('./additionalSqlAdapters.ts', { '@main/database/queryPolicy': policy, '@main/database/adapterUtils': adapter, '@main/database/mssqlSession': pin, oracledb: oracle })
  const driver = oracleAdapter(), h = await driver.open({ driver: 'oracle' })
  const result = await driver.execute(h, 'BEGIN report; END;')
  assert.deepEqual(result.results.map(set => set.columns[0].name), ['left', 'right']); assert.deepEqual(closed, ['left', 'right'])
  await assert.rejects(driver.execute(h, 'BEGIN broken; END;'), /block failed/); assert.equal(h.runtime.transaction, true)
  await driver.transaction(h, 'rollback'); assert.equal(h.runtime.transaction, false)
})
