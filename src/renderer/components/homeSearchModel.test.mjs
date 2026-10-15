import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import ts from 'typescript'

function load(path, imports = {}) {
  const javascript = ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  const module = { exports: {} }
  new Function('require', 'module', 'exports', javascript)(name => {
    if (!(name in imports)) throw new Error(`Unexpected import: ${name}`)
    return imports[name]
  }, module, module.exports)
  return module.exports
}
const model = load('./homeSearchModel.ts', {
  '@shared/search': load('../../shared/search.ts'),
  './quickGrid': load('./quickGrid.ts'),
})
const app = (id, title = id) => ({ kind: 'app', id, title, subtitle: 'Local application', path: `/Applications/${title}.app` })
const plugin = (id, installed = false, extra = {}) => ({ id, name: id, description: 'Translation', author: 'eNest', installed, ...extra })
const deferred = () => {
  let resolve, reject
  const promise = new Promise((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
const settle = () => new Promise(resolve => setImmediate(resolve))

test('Quick ranking and provider payloads are retained while catalog matches fill missing plugins only', () => {
  const commands = [app('app:qq', 'QQ'), { kind: 'plugin', id: 'plugin:qq:lookup', pluginId: 'qq-plugin', title: 'QQ Search', subtitle: '', code: 'lookup', payload: { query: 'qq' } }]
  const result = model.homeSearchEntries(commands, [plugin('qq-plugin', true), plugin('qq-market'), plugin('qq-local', true)], 'ＱＱ', 'all')
  assert.deepEqual(result.map(entry => entry.id), ['app:qq', 'plugin:qq:lookup', 'market:qq-market', 'plugin:qq-local:'])
  assert.equal(result[1].command, commands[1])
})

test('search scopes include installed marketplace entries but never turn a disabled plugin into a runnable command', () => {
  const plugins = [plugin('qq-installed', true), plugin('qq-disabled', true, { enabled: false }), plugin('qq-market')]
  const all = model.homeSearchEntries([app('app:qq', 'QQ')], plugins, 'qq', 'app')
  assert.deepEqual(all.map(entry => entry.id), ['app:qq'])
  assert.deepEqual(model.homeSearchEntries([], plugins, 'qq', 'plugin').map(entry => [entry.id, entry.kind]), [
    ['plugin:qq-installed:', 'command'], ['market:qq-disabled', 'market'],
  ])
  assert.ok(model.homeSearchEntries([], plugins, 'qq', 'market').every(entry => entry.kind === 'market'))
  assert.equal(model.homeSearchEntries([], plugins, 'unrelated', 'all').length, 0)
})

test('main-window opening reuses Quick requests with explicit shell placement and complete dynamic payload', () => {
  const command = { kind: 'plugin', id: 'dynamic', pluginId: 'com.example.search', code: 'lookup', type: 'regex', payload: { content: 'https://example.test' } }
  assert.deepEqual(model.homeSearchOpenRequest(command, 'https://example.test'), { kind: 'plugin', pluginId: command.pluginId, code: command.code, type: 'regex', payload: command.payload, query: 'https://example.test', container: 'shell' })
  assert.deepEqual(model.homeSearchOpenRequest(app('qq', 'QQ'), 'qq'), { kind: 'app', path: '/Applications/QQ.app', query: 'qq' })
  assert.deepEqual(model.homeSearchOpenRequest({ kind: 'action', action: 'refresh-apps' }, 'refresh'), { kind: 'action', action: 'refresh-apps', query: 'refresh' })
  assert.equal(model.homeSearchOpenRequest({ kind: 'app' }, 'qq'), null)
})

test('static commands appear before independent enrichment and provider results, regardless of response order', async () => {
  const gates = { static: deferred(), enriched: deferred(), providers: deferred() }
  const calls = [], updates = []
  const searching = model.searchHomeCommands('qq', undefined, async (query, limit, kind, phase) => {
    calls.push({ query, limit, kind, phase })
    return gates[phase].promise
  }, (items, initial) => updates.push({ items, initial }), () => true)
  assert.deepEqual(calls.map(call => call.phase), ['static'])
  gates.static.resolve({ items: [app('qq', 'QQ')] })
  await settle()
  assert.equal(updates[0].initial, true)
  assert.deepEqual(calls.map(call => call.phase), ['static', 'enriched', 'providers'])
  const provider = { id: 'provider:qq', kind: 'plugin', title: 'QQ Lookup', pluginId: 'com.example.lookup', payload: 'qq' }
  gates.providers.resolve({ items: [provider] })
  await settle()
  gates.enriched.resolve({ items: [{ ...app('qq', 'QQ'), icon: 'data:image/png;base64,icon' }] })
  assert.equal(await searching, false)
  assert.deepEqual(updates.at(-1).items.map(item => item.id), ['qq', 'provider:qq'])
  assert.equal(updates.at(-1).items[0].icon, 'data:image/png;base64,icon')
  assert.equal(updates.at(-1).items[1].payload, 'qq')
})

test('a superseded query cannot start extra phases or publish late results', async () => {
  const pending = deferred(), calls = [], updates = []
  let current = true
  const searching = model.searchHomeCommands('older', undefined, async (_query, _limit, _kind, phase) => { calls.push(phase); return pending.promise }, items => updates.push(items), () => current)
  current = false
  pending.resolve({ items: [app('old')] })
  await searching
  assert.deepEqual(calls, ['static'])
  assert.deepEqual(updates, [])
})

test('enrichment failures preserve usable static and provider results', async () => {
  const updates = []
  const partial = await model.searchHomeCommands('qq', 'app', async (_query, _limit, kind, phase) => {
    assert.equal(kind, 'app')
    if (phase === 'enriched') throw new Error('Icon service unavailable')
    return { items: phase === 'static' ? [app('qq')] : [] }
  }, items => updates.push(items), () => true)
  assert.equal(partial, true)
  assert.equal(updates.at(-1)[0].id, 'qq')
})
