import assert from 'node:assert/strict'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { build } from 'esbuild'

const projectRoot = fileURLToPath(new URL('../../../', import.meta.url))
let fixtureId = 0
async function fixture() {
  const adapters = {
    '@main/paths/pathsService': `export const pluginStorageDir = () => '/nonexistent/enest-storage-regression-test';`,
    '@main/db/sqliteService': `
      export const state = {
        local: new Map(), snapshots: new Map(), reads: [], available: true,
        failWriteAfter: null, failTransaction: false, failClear: false, failSnapshot: false,
        transactions: 0
      };
      const keyOf = (id, key) => id + '\\0' + key;
      const write = () => {
        if (state.failWriteAfter === null) return;
        if (state.failWriteAfter-- === 0) throw Error('fixture write failed');
      };
      const db = {
        exec() {},
        prepare(sql) {
          if (sql.includes('plugin_session_snapshot')) return {
            run(id,json) {
              if(state.failSnapshot) throw Error('fixture snapshot failed');
              if(sql.startsWith('DELETE')) state.snapshots.delete(id);
              else state.snapshots.set(id,json);
            },
            get(id) { const json = state.snapshots.get(id); return json === undefined ? undefined : {json}; }
          };
          if (sql.startsWith('INSERT INTO plugin_storage')) return {run(id,key,json) {write(); state.local.set(keyOf(id,key),json);}};
          if (sql.startsWith('DELETE FROM plugin_storage') && sql.includes('AND key')) return {run(id,key) {write(); state.local.delete(keyOf(id,key));}};
          if (sql.startsWith('DELETE FROM plugin_storage')) return {run(id) {
            if(state.failClear) throw Error('fixture clear failed');
            for(const key of state.local.keys()) if(key.startsWith(id+'\\0')) state.local.delete(key);
          }};
          if (sql.startsWith('SELECT value')) return {get(id,key) {
            state.reads.push({sql,id,key});
            const value = state.local.get(keyOf(id,key)); return value === undefined ? undefined : {value};
          }};
          if (sql.startsWith('SELECT key')) return {all(id) {
            state.reads.push({sql,id});
            return [...state.local.keys()].filter(key => key.startsWith(id+'\\0')).map(key => ({key:key.slice(id.length+1)}));
          }};
          throw Error('Unhandled fixture SQL: '+sql);
        }
      };
      export const kvStore = {getDatabase: () => state.available ? db : null};
      export function runInTransaction(_db, action) {
        state.transactions++;
        const before = new Map(state.local);
        try { const result = action(); if(state.failTransaction) throw Error('fixture commit failed'); return result; }
        catch(error) {state.local = before; throw error;}
      }
    `
  }
  const result = await build({
    stdin: {
      contents: `export * from '@main/db/pluginStorage'; export * from '@main/plugin/PluginSessionStore'; export {state} from '@main/db/sqliteService'; export const fixtureId = ${fixtureId++};`,
      resolveDir: projectRoot
    },
    tsconfig: join(projectRoot, 'tsconfig.node.json'), bundle: true, write: false,
    platform: 'node', format: 'esm',
    plugins: [{ name: 'storage-fixtures', setup(builder) {
      builder.onResolve({filter: /.*/}, ({path}) => path in adapters ? {path, namespace: 'fixture'} : undefined)
      builder.onLoad({filter: /.*/, namespace: 'fixture'}, ({path}) => ({contents: adapters[path], loader: 'js'}))
    } }]
  })
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`)
}

test('JSON serialization rejects silent coercion and local values use UTF-8 byte quotas', async () => {
  const api = await fixture()
  const cycle = {}; cycle.self = cycle
  const sparse = new Array(2); sparse[1] = 1
  const invalid = [undefined, NaN, Infinity, 1n, () => {}, Symbol(), new Date(), new Map(), cycle, sparse, {a: undefined}, {[Symbol()]: 1}]
  for (const value of invalid) assert.throws(() => api.serializeJson(value), /JSON|string keys/)
  assert.deepEqual(JSON.parse(api.serializeJson({nested: [null, true, 1, '中文'], empty: Object.create(null)})), {nested: [null, true, 1, '中文'], empty: {}})
  const limit = 512 * 1024
  const accepted = '界'.repeat(Math.floor((limit - 2) / 3))
  assert.ok(Buffer.byteLength(JSON.stringify(accepted)) <= limit)
  api.setPluginStorageValue('utf8', 'key', accepted)
  assert.throws(() => api.setPluginStorageValue('utf8', 'key', accepted + '界'), /quota/)
  assert.equal(api.getPluginStorageValue('utf8', 'key'), accepted)
  assert.equal(api.flushAll(), true)
  assert.throws(() => api.setPluginStorageValue('bad\0id', 'key', 1), /invalid storage key/)
  assert.throws(() => api.getPluginStorageValue('id', 'bad\0key'), /invalid storage key/)
})

test('session storage copies JSON values and enforces plugin/global payload budgets atomically', async () => {
  const api = await fixture()
  const input = {list: [{value: 1}]}
  api.setSessionValue('copy', 'key', input)
  input.list[0].value = 2
  assert.equal(api.getSessionValue('copy', 'key').list[0].value, 1)
  const revision = api.getSessionRevision('copy')
  const output = api.getSessionValue('copy', 'key')
  output.list[0].value = 3
  assert.equal(api.getSessionValue('copy', 'key').list[0].value, 1)
  assert.equal(api.getSessionRevision('copy'), revision)
  api.clearPluginSession('copy')

  const {pluginLimit, globalLimit} = api.getSessionDiagnostics()
  const nearlyFull = 'x'.repeat(pluginLimit - 64)
  api.setSessionValue('large', 'value', nearlyFull)
  const before = api.getSessionDiagnostics().bytes
  const beforeRevision = api.getSessionRevision('large')
  assert.throws(() => api.setSessionValue('large', 'extra', 'x'.repeat(128)), /quota/)
  assert.equal(api.getSessionDiagnostics().bytes, before)
  assert.equal(api.getSessionRevision('large'), beforeRevision)
  assert.equal(api.getSessionValue('large', 'extra'), undefined)
  api.clearPluginSession('large')

  for (let i = 0; i < 8; i++) api.setSessionValue(`global${i}`, 'value', nearlyFull)
  assert.ok(api.getSessionDiagnostics().bytes <= globalLimit)
  const charged = api.getSessionDiagnostics().bytes
  const identity = {buildRevision: 'budget-build', tabSessionId: 'budget-tab'}
  assert.equal(api.saveSessionSnapshot('global0', identity), true)
  api.releaseSessionMemory('global0')
  assert.equal(api.getSessionDiagnostics().bytes, charged, 'hibernation retains its logical session budget')
  assert.ok(api.getSessionDiagnostics().residentBytes < charged)
  assert.throws(() => api.setSessionValue('global8', 'value', 'x'.repeat(1024)), /quota/)
  assert.ok(api.getSessionDiagnostics().bytes <= globalLimit)
  assert.equal(api.loadSessionSnapshot('global0', identity), true)
  assert.equal(api.getSessionDiagnostics().bytes, charged + 2, 'failed writes only retain their empty session bag')
  for (let i = 0; i <= 8; i++) api.clearPluginSession(`global${i}`)
  assert.equal(api.getSessionDiagnostics().bytes, 0)
})

test('session snapshots bind build and tab identity and failed writes preserve live state', async (t) => {
  const api = await fixture()
  t.mock.method(console, 'error', () => {})
  const identity = {buildRevision: 'build-a', tabSessionId: 'tab-a'}
  api.setSessionValue('plugin', 'draft', {text: 'unsaved'})
  assert.equal(api.saveSessionSnapshot('plugin', {...identity, view: new Map(), scope: {unserializable: () => {}}}), true)
  assert.deepEqual(Object.keys(JSON.parse(api.state.snapshots.get('plugin'))).sort(), ['buildRevision', 'formatVersion', 'payload', 'stateRevision', 'tabSessionId'])
  api.clearPluginSession('plugin')
  assert.equal(api.loadSessionSnapshot('plugin', {...identity, buildRevision: 'build-b'}), false)
  assert.equal(api.loadSessionSnapshot('plugin', {...identity, tabSessionId: 'tab-b'}), false)
  assert.equal(api.getSessionDiagnostics().plugins, 0)
  assert.equal(api.loadSessionSnapshot('plugin', identity), true)
  assert.deepEqual(api.getSessionValue('plugin', 'draft'), {text: 'unsaved'})
  const validSnapshot = api.state.snapshots.get('plugin')
  const invalidVersion = {...JSON.parse(validSnapshot), formatVersion: 2, payload: {draft: 'wrong'}}
  api.state.snapshots.set('plugin', JSON.stringify(invalidVersion))
  assert.equal(api.loadSessionSnapshot('plugin', identity), false)
  assert.deepEqual(api.getSessionValue('plugin', 'draft'), {text: 'unsaved'})
  for (const invalid of [{payload: []}, {payload: 'string'}, {payload: null}, {stateRevision: -1}, {stateRevision: 1.5}]) {
    api.state.snapshots.set('plugin', JSON.stringify({...JSON.parse(validSnapshot), ...invalid}))
    assert.equal(api.loadSessionSnapshot('plugin', identity), false)
    assert.deepEqual(api.getSessionValue('plugin', 'draft'), {text: 'unsaved'})
  }
  api.state.snapshots.set('plugin', validSnapshot)
  api.state.failSnapshot = true
  api.setSessionValue('plugin', 'draft', {text: 'newer'})
  assert.equal(api.saveSessionSnapshot('plugin', identity), false)
  assert.deepEqual(api.getSessionValue('plugin', 'draft'), {text: 'newer'})
  assert.equal(api.state.snapshots.get('plugin'), validSnapshot)
  api.state.failSnapshot = false
  api.deleteSessionSnapshot('plugin')
  assert.equal(api.state.snapshots.has('plugin'), false)
})

test('failed transactions retain pending local writes and deletes until a successful retry', async (t) => {
  const api = await fixture()
  t.mock.method(console, 'error', () => {})
  api.state.local.set('plugin\0old', JSON.stringify('old'))
  api.setPluginStorageValue('plugin', 'a', {value: 1})
  api.setPluginStorageValue('plugin', 'b', {value: 2})
  api.removePluginStorageValue('plugin', 'old')
  api.state.failWriteAfter = 1
  assert.equal(api.flushAll(), false)
  assert.equal(api.getStorageDiagnostics().dirtyKeys, 3)
  assert.equal(api.state.local.has('plugin\0a'), false, 'partial database transaction must roll back')
  assert.equal(api.state.local.has('plugin\0old'), true)
  assert.deepEqual(api.getPluginStorageValue('plugin', 'a'), {value: 1})
  assert.equal(api.getPluginStorageValue('plugin', 'old'), undefined)
  api.state.failWriteAfter = null
  api.state.failTransaction = true
  assert.equal(api.flushAll(), false, 'commit failure also retains all dirty entries')
  assert.equal(api.getStorageDiagnostics().dirtyKeys, 3)
  api.state.failTransaction = false
  assert.equal(api.flushAll(), true)
  assert.equal(api.getStorageDiagnostics().dirtyKeys, 0)
  assert.equal(api.state.local.get('plugin\0a'), JSON.stringify({value: 1}))
  assert.equal(api.state.local.has('plugin\0old'), false)

  api.setPluginStorageValue('plugin', 'a', {value: 3})
  api.state.failClear = true
  assert.throws(() => api.clearPluginStorage('plugin'), /clear failed/)
  assert.deepEqual(api.getPluginStorageValue('plugin', 'a'), {value: 3})
  assert.equal(api.getStorageDiagnostics().dirtyKeys, 1)
  api.state.failClear = false
  api.state.available = false
  assert.equal(api.releasePluginStorage('plugin'), false)
  assert.deepEqual(api.getPluginStorageValue('plugin', 'a'), {value: 3})
  api.state.available = true
  assert.equal(api.flushAll(), true)
  api.clearPluginStorage('plugin')
  assert.equal(api.state.local.size, 0)
  assert.equal(api.getStorageDiagnostics().cacheBytes, 0)
})

test('local reads load one key, return isolated values and evict clean cache within both budgets', async () => {
  const api = await fixture()
  api.state.local.set('copy\0one', JSON.stringify({nested: {value: 1}}))
  const first = api.getPluginStorageValue('copy', 'one')
  first.nested.value = 2
  assert.equal(api.getPluginStorageValue('copy', 'one').nested.value, 1)
  assert.equal(api.state.reads.length, 1)
  assert.match(api.state.reads[0].sql, /WHERE plugin_id = \? AND key = \?/)
  assert.equal(api.getStorageDiagnostics().hits, 1)
  api.releasePluginStorage('copy')

  const json = JSON.stringify('x'.repeat(500 * 1024))
  for (let i = 0; i < 10; i++) {
    api.state.local.set(`large\0${i}`, json)
    assert.equal(api.getPluginStorageValue('large', String(i)).length, 500 * 1024)
  }
  assert.ok(api.getStorageDiagnostics().cacheBytes <= 4 * 1024 * 1024)
  const readsBefore = api.state.reads.length
  api.getPluginStorageValue('large', '0')
  assert.equal(api.state.reads.length, readsBefore + 1, 'evicted clean values reload from SQLite')
  assert.ok(api.getStorageDiagnostics().evictions >= 2)
  for (let plugin = 0; plugin < 10; plugin++) {
    for (let key = 0; key < 8; key++) {
      api.state.local.set(`budget${plugin}\0${key}`, json)
      api.getPluginStorageValue(`budget${plugin}`, String(key))
    }
  }
  assert.ok(api.getStorageDiagnostics().cacheBytes <= 32 * 1024 * 1024)
  assert.ok(api.state.reads.every(item => item.key !== undefined), 'reads never select a full plugin value bag')
  assert.equal(api.state.local.size, 91, 'cache eviction does not delete persisted data')
})

test('local key quota includes pending changes and permits replacing existing keys', async () => {
  const api = await fixture()
  for (let i = 0; i < 1000; i++) api.state.local.set(`plugin\0${i}`, '1')
  assert.throws(() => api.setPluginStorageValue('plugin', 'overflow', 1), /quota/)
  api.setPluginStorageValue('plugin', '0', 2)
  api.removePluginStorageValue('plugin', '1')
  api.setPluginStorageValue('plugin', 'new', 3)
  assert.throws(() => api.setPluginStorageValue('plugin', 'another', 4), /quota/)
  assert.equal(api.flushAll(), true)
  assert.equal(api.state.local.size, 1000)
  assert.equal(api.state.local.get('plugin\0new'), '3')
  assert.equal(api.state.local.has('plugin\0' + '1'), false)
})


test('hibernation frees resident payload but retains the global checkpoint budget', async () => {
  const api = await fixture()
  const identity = {buildRevision: 'build', tabSessionId: 'tab', nativeHandle: {notJson: undefined}}
  for (let i = 0; i < 8; i++) {
    const id = 'sleep' + i
    api.setSessionValue(id, 'draft', 'x'.repeat(8 * 1024 * 1024 - 64))
    assert.equal(api.saveSessionSnapshot(id, identity), true, 'snapshot copies identity fields, not native entry handles')
    api.releaseSessionMemory(id)
  }
  assert.equal(api.getSessionDiagnostics().residentBytes, 0)
  assert.throws(() => api.setSessionValue('extra', 'draft', 'x'.repeat(1024)), /quota/)
  assert.equal(api.loadSessionSnapshot('sleep0', identity), true)
  api.removeSessionValue('sleep0', 'draft')
  api.setSessionValue('extra', 'draft', 'x'.repeat(1024))
  for (let i = 0; i < 8; i++) api.clearPluginSession('sleep'+i)
  api.clearPluginSession('extra')
  assert.equal(api.getSessionDiagnostics().bytes, 0)
})

test('failed persistence bounds dirty UTF-8 bytes across plugins and rejects atomically', async t => {
  const api = await fixture()
  t.mock.method(console, 'error', () => {})
  api.state.failTransaction = true
  const value = 'x'.repeat(512 * 1024 - 2)
  for (let n = 0; n < 15; n++) api.setPluginStorageValue('p0', `key${n}`, value)
  const before = api.getStorageDiagnostics()
  assert.throws(() => api.setPluginStorageValue('p0', 'overflow', value), /pending storage quota/)
  assert.equal(api.getStorageDiagnostics().dirtyBytes, before.dirtyBytes)
  assert.equal(api.getPluginStorageValue('p0', 'overflow'), undefined)
  assert.equal(api.flushAll(), false)
  assert.equal(api.getStorageDiagnostics().dirtyBytes, before.dirtyBytes)
  for (let p = 1; p < 8; p++) for (let n = 0; n < 15; n++) api.setPluginStorageValue(`p${p}`, `key${n}`, value)
  for (let n = 0; n < 7; n++) api.setPluginStorageValue('p8', `key${n}`, value)
  assert.throws(() => api.setPluginStorageValue('p8', 'overflow', value), /pending storage quota/)
  assert.ok(api.getStorageDiagnostics().dirtyBytes <= api.getStorageDiagnostics().globalDirtyLimit)
  api.setPluginStorageValue('p0', 'key0', 'smaller')
  api.removePluginStorageValue('p0', 'key1')
  api.setPluginStorageValue('p8', 'after-shrink', value)
  api.state.failTransaction = false
  assert.equal(api.flushAll(), true)
  assert.equal(api.getStorageDiagnostics().dirtyBytes, 0)
  assert.equal(api.state.local.get('p0\0key0'), '"smaller"')
  assert.equal(api.state.local.has('p0\0key1'), false)
  assert.throws(() => api.setPluginStorageValue('p0', '界'.repeat(342), 1), /key quota/)
  assert.throws(() => api.removePluginStorageValue('p0', '界'.repeat(342)), /key quota/)
  api.setPluginStorageValue('p0', 'clear', 1)
  api.clearPluginStorage('p0')
  assert.equal(api.getStorageDiagnostics().dirtyBytes, 0)
})
