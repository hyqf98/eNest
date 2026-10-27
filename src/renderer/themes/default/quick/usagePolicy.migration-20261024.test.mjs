import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import test from 'node:test'
import { build } from 'esbuild'
import ts from 'typescript'

// New migration fixtures only: in-memory state, no Electron, real user history or filesystem writes.
const root = fileURLToPath(new URL('../../../../../', import.meta.url))
const require = createRequire(import.meta.url)
const plain = value => JSON.parse(JSON.stringify(value))
const evaluate = source => {
  const module = { exports: {} }
  vm.runInNewContext(source, { module, exports: module.exports, require, TextEncoder, console })
  return module.exports
}
const bundle = async (entry, extraExports) => {
  const source = extraExports ? { stdin: {
    contents: `${readFileSync(join(root, entry), 'utf8')}\nexport { ${extraExports} };`,
    sourcefile: entry, resolveDir: dirname(join(root, entry)), loader: 'tsx'
  } } : { entryPoints: [entry] }
  const output = await build({ absWorkingDir: root, ...source, bundle: true, write: false, platform: 'node',
    format: 'cjs', tsconfig: join(root, 'tsconfig.web.json'), external: ['react', 'react/jsx-runtime'], loader: { '.css': 'empty' } })
  return evaluate(output.outputFiles[0].text)
}
let policyPromise, sessionPromise, bridgePromise
const policy = () => policyPromise ??= bundle('src/renderer/themes/default/quick/usagePolicy.ts')
const sessions = () => sessionPromise ??= bundle('src/renderer/themes/default/quick/usageState.ts')
const bridge = () => bridgePromise ??= bundle('src/renderer/components/QuickThemeSurface.tsx', 'readAction, readResult')
const opened = (sequence, stateKey = 'opaque-one', query = ' EDITOR ') => ({ sequence, stateKey, at: 1_000 + sequence, query })

function privateState(initial, legacy) {
  let snapshot = { revision: initial ? 1 : 0, value: initial ?? null, ...(legacy === undefined ? {} : { legacy }) }
  const writes = [], encodings = []
  return {
    writes, encodings,
    get snapshot() { return snapshot },
    set snapshot(value) { snapshot = value },
    read: async () => structuredClone(snapshot),
    write: async (expectedRevision, value) => {
      assert.equal(expectedRevision, snapshot.revision)
      writes.push(structuredClone(value))
      snapshot = { revision: snapshot.revision + 1, value: structuredClone(value) }
      return structuredClone(snapshot)
    },
    encodeIdentities: async identities => {
      encodings.push([...identities])
      return identities.map((_, index) => `opaque-legacy-${index}`)
    }
  }
}

function controllerExecute(environment) {
  const path = 'src/renderer/components/QuickLauncherApp.tsx'
  const source = ts.createSourceFile(path, readFileSync(join(root, path), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  let callback
  const visit = node => {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === 'execute' && node.initializer && ts.isCallExpression(node.initializer)) callback = node.initializer.arguments[0]
    ts.forEachChild(node, visit)
  }
  visit(source)
  assert.ok(callback, 'fixture executes the actual native controller callback')
  const module = { exports: {} }
  const output = ts.transpileModule(`module.exports = ${callback.getText(source)}`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  }).outputText
  vm.runInNewContext(output, { module, ...environment })
  return module.exports
}

function controllerSnapshotOpened(environment) {
  const path = 'src/renderer/components/QuickLauncherApp.tsx'
  const source = ts.createSourceFile(path, readFileSync(join(root, path), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  let expression
  const visit = node => {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === 'snapshot' && node.initializer && ts.isObjectLiteralExpression(node.initializer)) {
      expression = node.initializer.properties.find(property => ts.isPropertyAssignment(property) && property.name.getText(source) === 'opened')?.initializer
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  assert.ok(expression, 'fixture executes the actual snapshot opened expression')
  const module = { exports: {} }
  const output = ts.transpileModule(`module.exports = ${expression.getText(source)}`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  }).outputText
  vm.runInNewContext(output, { module, ...environment })
  return module.exports
}

test('the default provider owns recent/count retention and normalized query preferences', async () => {
  const api = await policy()
  let state = api.emptyDefaultQuickUsage()
  for (let index = 1; index <= 125; index++) state = api.recordDefaultQuickOpened(state, opened(index, `opaque-${index}`, ` ＥＤＩＴＯＲ  ${index} `))
  assert.equal(state.recent.length, 20)
  assert.equal(state.queryPreferences.length, 100)
  assert.equal(state.recent[0].stateKey, 'opaque-125')
  assert.equal(state.queryPreferences[0].query, 'editor 125')
  state = api.recordDefaultQuickOpened(state, opened(126, 'opaque-125', 'editor\t125'))
  assert.equal(state.recent[0].count, 2)
  assert.equal(state.queryPreferences.filter(item => item.query === 'editor 125').length, 1)
})

test('long content is not a query preference and invalid identity facts are never retained', async () => {
  const api = await policy()
  let state = api.recordDefaultQuickOpened(api.emptyDefaultQuickUsage(), opened(1, 'opaque', 'x'.repeat(32)))
  assert.equal(state.queryPreferences.length, 1)
  state = api.recordDefaultQuickOpened(state, opened(2, 'opaque', 'x'.repeat(33)))
  state = api.recordDefaultQuickOpened(state, opened(3, 'opaque', 'content'.repeat(1_000)))
  assert.equal(state.queryPreferences.length, 1)
  assert.equal(state.recent[0].count, 3)
  assert.equal(api.recordDefaultQuickOpened(state, opened(4, '')), state)
  assert.equal(api.recordDefaultQuickOpened(state, { ...opened(5), at: Number.NaN }), state)
})

test('legacy interpretation converts identities, preserves counts and never persists raw targets', async () => {
  const api = await policy()
  const legacy = {
    enabled: true, hotkeys: ['Command+Space'],
    recent: [{ id: 'app:/Applications/Fixture.app', ts: 500, count: 7 }, { id: 'plugin:fixture:text', ts: 200, count: 2 }],
    queryPreferences: [{ query: ' ＦＩＸＴＵＲＥ ', id: 'app:/Applications/Fixture.app' }, { query: 'too long'.repeat(10), id: 'plugin:fixture:text' }]
  }
  assert.deepEqual(plain(api.defaultQuickLegacyIdentities(legacy)), ['app:/Applications/Fixture.app', 'plugin:fixture:text'])
  const migrated = api.migrateDefaultQuickUsage(legacy, new Map([['app:/Applications/Fixture.app', 'opaque-app'], ['plugin:fixture:text', 'opaque-plugin']]))
  assert.deepEqual(plain(migrated.recent), [{ stateKey: 'opaque-app', ts: 500, count: 7 }, { stateKey: 'opaque-plugin', ts: 200, count: 2 }])
  assert.deepEqual(plain(migrated.queryPreferences), [{ query: 'fixture', stateKey: 'opaque-app' }])
  assert.doesNotMatch(JSON.stringify(migrated), /Applications|plugin:fixture|hotkeys/)
})

test('provider-private model parsing rejects malformed versions and duplicate/invalid rows', async () => {
  const api = await policy()
  assert.deepEqual(plain(api.readDefaultQuickUsage({ version: 42, recent: [{}] })), plain(api.emptyDefaultQuickUsage()))
  const state = api.readDefaultQuickUsage({ version: 1,
    recent: [{ stateKey: 'one', ts: 1, count: 4 }, { stateKey: 'one', ts: 2, count: 20 }, { stateKey: 'invalid', ts: -1 }],
    queryPreferences: [{ query: 'one', stateKey: 'one' }, { query: 'ＯＮＥ', stateKey: 'two' }, null] })
  assert.equal(state.recent.length, 1)
  assert.equal(state.recent[0].count, 4)
  assert.equal(state.queryPreferences.length, 1)
})

test('usage metadata is a theme-local projection stable across query-generation handles', async () => {
  const api = await policy()
  const state = api.recordDefaultQuickOpened(api.emptyDefaultQuickUsage(), opened(1, 'opaque-key', ' ＥＤＩＴＯＲ '))
  const catalog = [{ id: 'generation-two', stateKey: 'opaque-key', kind: 'app', title: 'Editor', subtitle: '', aliases: ['Editor'] },
    { id: 'unknown', stateKey: '', kind: 'plugin', title: 'Unknown', subtitle: '', aliases: [] }]
  const projected = api.projectDefaultQuickUsage(catalog, state, 'editor')
  assert.equal(projected[0].preferred, true)
  assert.equal(projected[0].lastUsedTs, 1_001)
  assert.equal(projected[1].useCount, undefined)
  assert.equal(Object.hasOwn(catalog[0], 'preferred'), false)
})

test('trusted default private-state initialization imports legacy once through opaque encoding', async () => {
  const { createDefaultQuickUsageSession } = await sessions()
  const storage = privateState(undefined, { recent: [{ id: 'app:/private/Fixture.app', ts: 10, count: 9 }], queryPreferences: [] })
  const changes = [], session = createDefaultQuickUsageSession(storage, state => changes.push(state))
  await Promise.all([session.initialize(), session.initialize()])
  assert.equal(storage.writes.length, 1)
  assert.equal(storage.encodings.length, 1)
  assert.equal(changes.at(-1).recent[0].count, 9)
  assert.doesNotMatch(JSON.stringify(storage.snapshot.value), /private|app:/)
  session.dispose()
})

test('a first-import CAS conflict reloads the winning document and still records the launch', async () => {
  const { createDefaultQuickUsageSession } = await sessions()
  const api = await policy(), storage = privateState(undefined, { recent: [{ id: 'legacy-app', ts: 10, count: 7 }] })
  const originalWrite = storage.write
  let migrationConflict = true
  storage.write = async (...args) => {
    if (migrationConflict) {
      migrationConflict = false
      storage.snapshot = { revision: 1, value: api.migrateDefaultQuickUsage({ recent: [{ id: 'legacy-app', ts: 10, count: 7 }] }, new Map([['legacy-app', 'opaque-legacy-0']])) }
      throw new Error('competing import won')
    }
    return originalWrite(...args)
  }
  const session = createDefaultQuickUsageSession(storage, () => {})
  await session.recordOpened(opened(1, 'opaque-legacy-0'))
  assert.equal(storage.snapshot.revision, 2)
  assert.equal(storage.snapshot.value.recent[0].count, 8)
  await session.recordOpened(opened(1, 'opaque-legacy-0'))
  assert.equal(storage.snapshot.value.recent[0].count, 8)
  session.dispose()
})

test('launch receipts serialize, deduplicate and continue independently of provider UI visibility', async () => {
  const { createDefaultQuickUsageSession } = await sessions()
  const api = await policy(), storage = privateState(api.emptyDefaultQuickUsage()), changes = []
  const session = createDefaultQuickUsageSession(storage, state => changes.push(state))
  await Promise.all([session.recordOpened(opened(1)), session.recordOpened(opened(2)), session.recordOpened(opened(2))])
  assert.equal(storage.writes.length, 2)
  assert.equal(storage.snapshot.value.recent[0].count, 2)
  assert.equal(changes.at(-1).recent[0].count, 2)
  session.dispose()
})

test('CAS conflicts re-read and merge the successful fact instead of overwriting another update', async () => {
  const { createDefaultQuickUsageSession } = await sessions()
  const api = await policy(), storage = privateState(api.emptyDefaultQuickUsage()), originalWrite = storage.write
  let conflict = true
  storage.write = async (...args) => {
    if (conflict) {
      conflict = false
      storage.snapshot = { revision: 2, value: api.recordDefaultQuickOpened(api.emptyDefaultQuickUsage(), opened(10, 'other')) }
      throw new Error('revision conflict')
    }
    return originalWrite(...args)
  }
  const session = createDefaultQuickUsageSession(storage, () => {})
  await session.recordOpened(opened(1))
  assert.deepEqual(plain(storage.snapshot.value.recent.map(entry => entry.stateKey)), ['opaque-one', 'other'])
  assert.equal(storage.snapshot.revision, 3)
  session.dispose()
})

test('failed persistence never publishes optimistic success as persisted history', async () => {
  const { createDefaultQuickUsageSession } = await sessions()
  const api = await policy(), storage = privateState(api.emptyDefaultQuickUsage()), changes = []
  const originalWrite = storage.write
  storage.write = async () => { throw new Error('storage unavailable') }
  const session = createDefaultQuickUsageSession(storage, state => changes.push(state))
  await assert.rejects(session.recordOpened(opened(1)), /storage unavailable/)
  assert.equal(changes.at(-1).recent.length, 0)
  assert.equal(storage.snapshot.value.recent.length, 0)
  storage.write = originalWrite
  await session.recordOpened(opened(1))
  assert.equal(storage.snapshot.value.recent[0].count, 1, 'a rejected receipt may be retried after recovery')
  session.dispose()
})

test('disposing a provider generation cancels a late read before migration or receipt writes', async () => {
  const { createDefaultQuickUsageSession } = await sessions()
  let finishRead, writes = 0, encodings = 0, changes = 0
  const storage = { read: () => new Promise(resolve => { finishRead = resolve }),
    write: async () => { writes++; return { revision: 1, value: null } }, encodeIdentities: async () => { encodings++; return [] } }
  const session = createDefaultQuickUsageSession(storage, () => changes++)
  const loading = session.initialize()
  session.dispose()
  finishRead({ revision: 0, value: null, legacy: { recent: [{ id: 'private', ts: 1 }] } })
  await loading
  await session.recordOpened(opened(1))
  assert.deepEqual([writes, encodings, changes], [0, 0, 0])
})

test('default usage pending updates are bounded to 64 and disposal releases the queued work', async () => {
  const { createDefaultQuickUsageSession } = await sessions()
  const api = await policy()
  let finishRead, writes = 0
  const storage = { read: () => new Promise(resolve => { finishRead = resolve }),
    write: async () => { writes++; return { revision: 1, value: null } }, encodeIdentities: async () => [] }
  const session = createDefaultQuickUsageSession(storage, () => {})
  const initialization = session.initialize()
  const queued = Array.from({ length: 64 }, (_, index) => session.recordOpened(opened(index + 1)))
  await assert.rejects(session.recordOpened(opened(65)), /queue is full/)
  session.dispose()
  finishRead({ revision: 1, value: api.emptyDefaultQuickUsage() })
  await Promise.all([initialization, ...queued])
  assert.equal(writes, 0)
})

test('the real native execute callback records only successful opened facts and fences provider replacement', async () => {
  let finishOpen
  const defaults = [], providers = []
  const env = {
    openingRef: { current: false }, themeReadyRef: { current: true }, themeKey: { current: 'old-provider' },
    customSearchRef: { current: false }, openedSequence: { current: 0 },
    defaultView: { current: { recordOpened: receipt => defaults.push(receipt) } },
    shellApi: { quickOpen: () => new Promise(resolve => { finishOpen = resolve }) },
    setProviderOpened: value => providers.push(value), setOpening() {}, setError() {}, invalidate() {}, setRefresh() {}
  }
  const execute = controllerExecute(env)
  const launch = execute({ kind: 'plugin', pluginId: 'fixture', query: 'original query' })
  env.themeKey.current = 'replacement-provider'
  finishOpen({ ok: true, opened: { stateKey: 'opaque-success', at: 123 } })
  assert.equal(await launch, true)
  assert.equal(defaults.length, 1, 'presentation-only fallback still records in the default provider')
  assert.equal(defaults[0].query, 'original query')
  assert.equal(providers.length, 0, 'late launch does not publish into the replacement provider')
  env.customSearchRef.current = true
  const failed = execute({ kind: 'action', action: 'open-settings', query: 'failed' })
  finishOpen({ ok: false, opened: { stateKey: 'must-not-record', at: 999 } })
  assert.equal(await failed, false)
  assert.equal(defaults.length, 1)
  assert.equal(providers.length, 0)
  const ownLaunch = execute({ kind: 'action', action: 'open-settings', query: 'new query' })
  finishOpen({ ok: true, opened: { stateKey: 'opaque-new', at: 200 } })
  assert.equal(await ownLaunch, true)
  assert.equal(defaults.length, 1, 'a custom search provider owns its own history')
  assert.equal(providers[0].owner, 'replacement-provider')
  assert.equal(providers[0].receipt.sequence, 2)
})

test('the actual snapshot receipt expression handles default startup, provider replacement and its owner', () => {
  assert.equal(controllerSnapshotOpened({ providerOpened: null, themeConfig: null }), null)
  const receipt = opened(1)
  assert.equal(controllerSnapshotOpened({ providerOpened: { owner: 'previous-provider', receipt }, themeConfig: { key: 'replacement-provider' } }), null)
  assert.equal(controllerSnapshotOpened({ providerOpened: { owner: 'current-provider', receipt }, themeConfig: { key: 'current-provider' } }), receipt)
})

test('the actual sandbox parser bounds state writes and strips legacy from state results', async () => {
  const { readAction, readResult } = await bridge()
  assert.deepEqual(plain(readAction({ type: 'state-read' })), { type: 'state-read' })
  assert.equal(readAction({ type: 'state-read', providerKey: null }), null)
  const input = { type: 'state-write', expectedRevision: 0, value: { nested: [1, 'theme-owned'] } }
  const parsed = readAction(input)
  input.value.nested[0] = 99
  assert.equal(parsed.value.nested[0], 1)
  for (const value of [{ ...input, expectedRevision: -1 }, { ...input, value: 'x'.repeat(128 * 1_024) },
    { ...input, value: Number.NaN }, { ...input, value: undefined }]) assert.equal(readAction(value), null)
  const cyclic = {}; cyclic.self = cyclic
  assert.equal(readAction({ ...input, value: cyclic }), null)
  let getterCalls = 0
  const accessor = Object.defineProperty({}, 'value', { enumerable: true, get() { getterCalls++; return 1 } })
  assert.equal(readAction({ ...input, value: accessor }), null)
  assert.equal(getterCalls, 0)
  const result = readResult({ ok: true, state: { revision: 1, value: { own: 'schema' }, legacy: { private: '/secret' } } })
  assert.deepEqual(plain(result), { ok: true, state: { revision: 1, value: { own: 'schema' } } })
  assert.equal(readResult({ ok: true, state: { revision: 1, value: Infinity } }).ok, false)
})

test('public catalogs forward only opaque identity, never native ranking/history metadata', async () => {
  const { publicQuickCatalog, updateQuickCatalog } = await bundle('src/renderer/components/quickCatalog.ts')
  const command = { id: 'app:/private/Fixture.app', stateKey: 'opaque-identity', kind: 'app', title: 'Fixture', subtitle: '/private',
    path: '/private/Fixture.app', lastUsedTs: 500, useCount: 9, preferred: true }
  const first = publicQuickCatalog(updateQuickCatalog([command], 'first'))[0]
  const next = publicQuickCatalog(updateQuickCatalog([command], 'next'))[0]
  assert.notEqual(first.id, next.id)
  assert.equal(first.stateKey, next.stateKey)
  for (const key of ['path', 'lastUsedTs', 'useCount', 'preferred']) assert.equal(Object.hasOwn(first, key), false)
  assert.doesNotMatch(JSON.stringify(first), /\/private/)
})
