import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import ts from 'typescript'
const require = createRequire(import.meta.url)
function load(file, mocks) {
  const source = readFileSync(new URL(file, import.meta.url), 'utf8').replaceAll('import.meta.url', "'file:///tmp/enest-main/index.js'")
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const module = { exports: {} }
  new Function('require', 'module', 'exports', js)(name => mocks[name] ?? require(name), module, module.exports)
  return module.exports
}
const scriptParser = load('./sqlScript.ts', {})
const queryPolicy = load('./queryPolicy.ts', { '@main/database/sqlScript': scriptParser })
const executionPolicy = load('./executionPolicy.ts', { '@main/database/sqlScript': scriptParser })
function fixture(driver) {
  let catalogWrites = 0
  const api = load('./dbService.ts', {
    '@main/database/drivers': { getDriver: () => driver, DEFAULT_MAX_ROWS: 1000 },
    '@main/database/completion': { getCatalog: () => null, setCatalog: () => catalogWrites++, invalidateCatalog() {}, buildCompletion: () => ({}), isWriteSql: () => false, isDdlSql: () => false },
    '@main/database/dialects': { listDialects: () => [] },
    '@main/database/queryPolicy': queryPolicy,
    '@main/database/sqlScript': scriptParser,
    '@main/database/executionPolicy': executionPolicy,
    '@main/database/driverCatalog': load('./driverCatalog.ts', {}),
    '@main/database/nativeCompletion': load('./nativeCompletion.ts', {}),
    '@main/database/rowChanges': load('./rowChanges.ts', { '@main/database/queryPolicy': queryPolicy })
  })
  return { api, catalogWrites: () => catalogWrites }
}
const handle = () => ({ id: 'timescale', config: {}, raw: {}, readOnly: false })

test('opening a database while the owner closes disposes the late handle', async () => {
  let opened, closed = 0
  const { api } = fixture({ open: () => new Promise(resolve => opened = resolve), close: async () => closed++ })
  const pending = api.dbOpen('plugin', { driver: 'timescale' })
  await api.releaseDbSessions('plugin')
  opened(handle())
  await assert.rejects(pending, /opening cancelled/)
  assert.equal(closed, 1)
  assert.deepEqual(api.dbListSessions('plugin'), [])
})

test('concurrent same-key opens cannot overwrite an unclosed handle', async () => {
  const resolvers = []; let closed = 0
  const { api } = fixture({ open: () => new Promise(resolve => resolvers.push(resolve)), close: async () => closed++ })
  const first = api.dbOpen('plugin', { config: { driver: 'timescale' }, sessionKey: 'fixed' })
  const second = api.dbOpen('plugin', { config: { driver: 'timescale' }, sessionKey: 'fixed' })
  resolvers[1](handle()); await second
  resolvers[0](handle()); await assert.rejects(first, /opening cancelled/)
  assert.equal(closed, 1)
  assert.equal(api.dbListSessions('plugin').length, 1)
})

test('cancel closes the session and suppresses a late successful query', async () => {
  let execute; let closed = 0
  const { api } = fixture({ open: async () => handle(), close: async () => closed++, execute: () => new Promise(resolve => execute = resolve) })
  const session = await api.dbOpen('plugin', { driver: 'timescale' })
  const pending = api.dbExecute('plugin', { sessionKey: session.sessionKey, sql: 'SELECT 1' })
  await api.dbCancel('plugin', session.sessionKey)
  execute({ columns: [], rows: [[1]] })
  await assert.rejects(pending, /cancelled/)
  assert.equal(closed, 1)
})

test('catalog completion after close cannot refill a removed session cache', async () => {
  let finish
  const { api, catalogWrites } = fixture({ open: async () => handle(), close: async () => {}, completionCatalog: () => new Promise(resolve => finish = resolve) })
  const session = await api.dbOpen('plugin', { driver: 'timescale' })
  const pending = api.dbCompletion('plugin', { sessionKey: session.sessionKey, sql: '' })
  await api.dbClose('plugin', session.sessionKey)
  finish({ tables: [] }); await pending
  assert.equal(catalogWrites(), 0)
})

test('CSV preview retains only its bounded sample and preserves quoted newlines', async () => {
  const { api } = fixture({ open: async () => handle(), close: async () => {} })
  const session = await api.dbOpen('plugin', { driver: 'timescale' })
  const result = await api.dbImportPreview('plugin', { sessionKey: session.sessionKey, table: { table: 'sample' }, csvText: 'name,note\r\na,"line1\nline2"\r\nb,"quote ""inside"""\nc,last', options: { sampleRows: 1 } })
  assert.deepEqual(result.sampleRows, [['a', 'line1\nline2']])
  assert.equal(result.totalRowsEstimate, 3)
})

function facade(options = {}) {
  const children = []; let activities = 0
  let currentScope
  const abort = new AbortController()
  const disposers = new Set()
  const scope = { owner: { pluginId: 'plugin', generation: 1, wcId: 42 }, signal: abort.signal, isCurrent: () => currentScope === scope,
    acquireActivity: () => { activities++; let done = false; return () => { if (!done) { done = true; activities-- } } },
    addDisposer: fn => { disposers.add(fn); return () => disposers.delete(fn) } }
  currentScope = scope
  class Child extends EventEmitter {
    messages = []; killed = false; spawned = false; killCalls = 0
    postMessage(message) { this.messages.push(message) }
    kill() { this.killCalls++; if (options.requireSpawn && !this.spawned) return false; this.killed = true; if (!options.manualExit) this.emit('exit', 0); return true }
  }
  const api = load('./dbSessionManager.ts', {
    electron: { dialog: {}, utilityProcess: { fork() { const child = new Child(); children.push(child); return child } } },
    '@main/plugin/PluginRuntimeScope': { getRuntimeScope: () => currentScope },
    '@main/plugin/localFiles': { resolveLocalFileHandle: async (_id, handleId, access) => { if (handleId !== 'selected') throw new Error('invalid handle'); return '/selected/database.sqlite' }, pickLocalFiles: async () => [], pickLocalSaveFile: async () => null },
    '@main/vault/secretVault': { resolveSecret: () => 'resolved-test-secret' },
    '@main/window/createShellWindow': { getMainWindow: () => null },
    '@main/logs/logService': { logWarn() {} }, '@main/database/dialects': { listDialects: () => [] }
  })
  return { api, children, scope, abort, activities: () => activities, replaceScope: () => {
    const replacement = { ...scope, owner: { ...scope.owner, generation: scope.owner.generation + 1 }, signal: new AbortController().signal, isCurrent: () => currentScope === replacement }
    currentScope = replacement
    return replacement
  } }
}

const sessionInfo = (sessionKey = 'session') => ({ sessionKey, driver: 'mysql', openedAt: Date.now(), readOnly: false, transactionActive: false })
function reply(child, message, data) { child.emit('message', { id: message.id, ok: true, data }) }
async function opened(api, children, sessionKey = 'session') {
  const pending = api.dbOpen('plugin', { config: { driver: 'mysql' }, sessionKey })
  await Promise.resolve()
  const child = children.at(-1)
  reply(child, child.messages.at(-1), sessionInfo(sessionKey))
  return pending
}

test('DB facade keeps idle connected sessions active until close', async () => {
  const { api, children, activities } = facade()
  const first = api.dbOpen('plugin', { driver: 'mysql', secretRef: 'vault-id' })
  await Promise.resolve()
  const second = api.dbListSessions('plugin')
  assert.equal(children.length, 1)
  const child = children[0]
  assert.equal(child.messages[0].args[0].ephemeralSecret, 'resolved-test-secret')
  reply(child, child.messages[1], [])
  reply(child, child.messages[0], sessionInfo())
  await Promise.all([first, second])
  assert.equal(activities(), 1, 'the connection itself protects the runtime from idle/LRU eviction')
  const closing = api.dbClose('plugin', 'session')
  reply(child, child.messages.at(-1), true)
  await closing
  assert.equal(activities(), 0)
})

test('session listing releases a connection that the server closed externally', async () => {
  const { api, children, activities } = facade()
  await opened(api, children)
  const listing = api.dbListSessions('plugin')
  reply(children[0], children[0].messages.at(-1), [])
  assert.deepEqual(await listing, [])
  assert.equal(activities(), 0)
})

test('native cancel retains live connection leases and releases disconnected sessions', async () => {
  const { api, children, activities } = facade()
  await opened(api, children)
  const child = children[0]
  for (const survives of [true, false]) {
    const cancel = api.dbCancel('plugin', 'session')
    reply(child, child.messages.at(-1), true)
    await Promise.resolve()
    assert.equal(child.messages.at(-1).method, 'dbListSessions')
    reply(child, child.messages.at(-1), survives ? [sessionInfo()] : [])
    await cancel
    assert.equal(activities(), survives ? 1 : 0)
  }
})

test('late close and list responses do not release a replacement connection with the same key', async () => {
  const { api, children, activities } = facade()
  await opened(api, children)
  const child = children[0]
  const listing = api.dbListSessions('plugin'), listMessage = child.messages.at(-1)
  const closing = api.dbClose('plugin', 'session'), closeMessage = child.messages.at(-1)
  await opened(api, children)
  reply(child, closeMessage, true); reply(child, listMessage, [])
  await Promise.all([listing, closing])
  assert.equal(activities(), 1)
  const closeReplacement = api.dbClose('plugin', 'session')
  reply(child, child.messages.at(-1), true)
  await closeReplacement
  assert.equal(activities(), 0)
})

test('connection ownership survives retirement until exit and remains isolated by runtime generation', async () => {
  const { api, children, activities, replaceScope } = facade({ manualExit: true })
  await opened(api, children)
  const retiring = api.releaseDbSessions('plugin', 1)
  reply(children[0], children[0].messages.at(-1), undefined)
  await Promise.resolve()
  assert.equal(activities(), 1, 'graceful release acknowledgement is not process exit')
  replaceScope()
  await assert.rejects(api.dbOpen('plugin', { driver: 'mysql' }), /retiring/)
  children[0].emit('exit', 0)
  await retiring
  assert.equal(activities(), 0)
  await opened(api, children)
  await api.releaseDbSessions('plugin', 1)
  assert.equal(children.length, 2)
  assert.equal(children[1].killed, false)
  assert.equal(activities(), 1)
  children[1].emit('exit', 0)
  assert.equal(activities(), 0)
})

test('cancel without acknowledgement kills only this utility within 250ms', async () => {
  const { api, children, activities } = facade()
  const query = api.dbExecute('plugin', { sessionKey: 'session', sql: 'SELECT long()' })
  const failedQuery = assert.rejects(query, /service reset/)
  await assert.rejects(api.dbCancel('plugin', 'session'), /service reset/)
  await failedQuery
  assert.equal(children[0].killed, true)
  assert.equal(activities(), 0)
})

test('runtime abort cannot publish late results and terminates the worker', async () => {
  const { api, children, abort, activities } = facade()
  const query = api.dbExecute('plugin', { sessionKey: 'session', sql: 'SELECT 1' })
  const failedQuery = assert.rejects(query, /closing/)
  abort.abort()
  children[0].emit('message', { id: children[0].messages[0].id, ok: true, data: {} })
  const shutdown = children[0].messages.find(m => m.method === 'releaseDbSessions')
  children[0].emit('message', { id: shutdown.id, ok: true })
  await failedQuery
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(children[0].killed, true)
  assert.equal(activities(), 0)
})


test('retiring utility remains owned across failed pre-spawn kill and blocks replacement until exit', async () => {
  const { api, children, activities } = facade({ requireSpawn: true, manualExit: true })
  const query = api.dbExecute('plugin', { sessionKey: 'session', sql: 'SELECT 1' })
  const failedQuery = assert.rejects(query, /service reset/)
  const cancel = api.dbCancel('plugin', 'session')
  const failedCancel = assert.rejects(cancel, /service reset/)
  await new Promise(resolve => setTimeout(resolve, 280))
  await failedQuery
  assert.ok(children[0].killCalls >= 1)
  assert.equal(children[0].killed, false)
  assert.ok(activities() > 0, 'leases remain until process exit is confirmed')
  await assert.rejects(api.dbOpen('plugin', { driver: 'mysql' }), /retiring/)
  assert.equal(children.length, 1)
  children[0].spawned = true; children[0].emit('spawn')
  assert.equal(children[0].killed, true)
  await assert.rejects(api.dbOpen('plugin', { driver: 'mysql' }), /retiring/)
  children[0].emit('exit', 0)
  await failedCancel
  assert.equal(activities(), 0)
  const reopened = api.dbOpen('plugin', { driver: 'mysql' })
  await Promise.resolve()
  assert.equal(children.length, 2)
  reply(children[1], children[1].messages[0], sessionInfo()); await reopened
  children[1].emit('exit', 0)
})

test('public DB facade rejects arbitrary local paths before spawning a utility', async () => {
  const {api,children}=facade()
  for(const config of [
    {driver:'sqlite',filePath:'/etc/passwd'},
    {driver:'sqlite',sqlitePath:'/etc/passwd'},
    {driver:'duckdb',options:{file:'/etc/passwd'}},
    {driver:'sqlite',fileHandleId:'forged'}
  ]) await assert.rejects(api.dbOpen('plugin',config),/raw database paths|invalid handle/)
  await assert.rejects(api.dbImportPreview('plugin',{filePath:'/etc/passwd'}),/raw import paths/)
  await assert.rejects(api.dbImportRun('plugin',{filePath:'/etc/passwd'}),/raw import paths/)
  assert.equal(children.length,0)
})

test('DB handle resolution keeps read-only selection read-only in native driver options', async () => {
  const {api,children}=facade()
  const opening=api.dbOpen('plugin',{driver:'sqlite',fileHandleId:'selected',readOnly:true})
  await new Promise(resolve=>setImmediate(resolve))
  const child=children[0],request=child.messages[0]
  assert.equal(request.args[0].filePath,'/selected/database.sqlite')
  assert.equal(request.args[0].options.readOnly,true)
  reply(child,request,sessionInfo())
  await opening
  const closing=api.dbClose('plugin','session');reply(child,child.messages.at(-1),true);await closing
})

test('script preflight rejects malformed later input before any driver execution', async () => {
  let requests = 0
  const { api } = fixture({ open: async () => ({ ...handle(), id: 'mysql', runtime: {} }), close: async () => {}, execute: async () => { requests++; return { columns: [], rows: [], rowCount: 0, durationMs: 0 } } })
  const { sessionKey } = await api.dbOpen('plugin', { driver: 'mysql' })
  await assert.rejects(api.dbExecute('plugin', { sessionKey, sql: 'UPDATE audit SET n=1;\nDELIMITER invalid\nSELECT 1;' }), /Invalid DELIMITER/)
  await assert.rejects(api.dbExecute('plugin', { sessionKey, sql: 'UPDATE audit SET n=1; /* unterminated' }), /Unterminated/)
  assert.equal(requests, 0)
})

test('a procedure opening a transaction blocks a later implicit-commit DDL on the live state', async () => {
  const requests = [], runtime = { transaction: false }
  const { api } = fixture({ open: async () => ({ ...handle(), id: 'mysql', runtime }), close: async () => {}, transaction: async () => {}, execute: async (_h, sql) => { requests.push(sql); runtime.transaction = true; return { columns: [], rows: [], rowCount: 0, durationMs: 0 } } })
  const { sessionKey } = await api.dbOpen('plugin', { driver: 'mysql' })
  await assert.rejects(api.dbExecute('plugin', { sessionKey, sql: 'CALL p();\nCREATE TABLE should_not_commit(id INT);' }), /SQL unit 2.*implicitly commit/)
  assert.deepEqual(requests, ['CALL p()'])
  assert.equal(api.dbListSessions('plugin')[0].transactionActive, true)
})

test('SQL Server batches and nested driver recordsets retain their own schemas and one execution owner', async () => {
  const requests = []
  const { api } = fixture({ open: async () => ({ ...handle(), id: 'mssql', runtime: {} }), close: async () => {}, execute: async (_h, sql) => {
    requests.push(sql)
    const first = { columns: [{ name: 'left' }], rows: [[1]], rowCount: 1, durationMs: 0 }
    return { ...first, results: [first, { columns: [{ name: 'right' }], rows: [[2]], rowCount: 1, durationMs: 0 }] }
  } })
  const { sessionKey } = await api.dbOpen('plugin', { driver: 'mssql' })
  const result = await api.dbExecute('plugin', { sessionKey, executionId: 'one_owner', sql: 'DECLARE @v INT=1; SELECT @v AS left; SELECT 2 AS right;\nGO' })
  assert.equal(requests.length, 1); assert.match(requests[0], /^DECLARE.*SELECT.*SELECT/); assert.doesNotMatch(requests[0], /GO/)
  assert.deepEqual(result.results.map(item => item.columns[0].name), ['left', 'right'])
  assert.ok(result.results.every(item => item.executionId === 'one_owner'))
})
