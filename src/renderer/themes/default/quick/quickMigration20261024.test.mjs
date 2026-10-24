import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import test from 'node:test'
import ts from 'typescript'
import { build } from 'esbuild'

// Fixture-only migration checks. No Electron, GUI, network, user history or package writes.
const root = fileURLToPath(new URL('../../../../../', import.meta.url))
const require = createRequire(import.meta.url)
const read = path => readFileSync(join(root, path), 'utf8')
const plain = value => JSON.parse(JSON.stringify(value))
const bundle = async (entry, plugins = []) => {
  const result = await build({ absWorkingDir: root, entryPoints: [entry], bundle: true, write: false,
    platform: 'node', format: 'cjs', tsconfig: join(root, 'tsconfig.web.json'), plugins })
  return result.outputFiles[0].text
}
const evaluate = (source, globals = {}) => {
  const module = { exports: {} }
  vm.runInNewContext(source, { module, exports: module.exports, require, AbortController, ...globals })
  return module.exports
}

test('default renderer owns name, pinyin, fullwidth, preference and recent policy', async () => {
  const { rankDefaultQuickCatalog: rank } = evaluate(await bundle('src/renderer/themes/default/quick/searchPolicy.ts'))
  const catalog = [
    { id: 'notes', kind: 'plugin', title: '笔记', aliases: ['笔记'] },
    { id: 'editor', kind: 'app', title: 'Editor', aliases: ['Editor'] },
    { id: 'other', kind: 'plugin', title: 'unrelated', aliases: ['unrelated'], lastUsedTs: 1_000, useCount: 2 },
    { id: 'settings', kind: 'action', title: 'open-settings', action: 'open-settings' },
  ]
  assert.equal(rank(catalog, 'bj')[0].id, 'notes')
  assert.equal(rank(catalog, 'ＥＤＩＴＯＲ')[0].id, 'editor')
  assert.deepEqual(plain(rank(catalog, '设置').map(item => [item.id, item.title])), [['settings', '打开设置']])
  assert.deepEqual(plain(rank(catalog, '', undefined, 60, new Set(), 2_000).map(item => item.id)), ['other', 'notes', 'editor'])
  assert.deepEqual(plain(rank(catalog, '', 'action').map(item => item.id)), ['settings'])
  const preferred = [{ id: 'exact', kind: 'plugin', title: 'edit', aliases: ['edit'] },
    { id: 'preference', kind: 'app', title: 'Editor', aliases: ['Editor'], preferred: true }]
  assert.equal(rank(preferred, 'edit')[0].id, 'preference')
})

test('content matching executes in a renderer worker and default policy groups every source', async () => {
  const { rankDefaultQuickCatalog: rank } = evaluate(await bundle('src/renderer/themes/default/quick/searchPolicy.ts'))
  const messages = [], self = { postMessage: item => messages.push(item) }
  evaluate(ts.transpileModule(read('src/renderer/themes/default/quick/patternWorker.ts'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { self })
  const catalog = [
    { id: 'regex', kind: 'plugin', title: 'Email', content: { type: 'regex', source: '@', minLength: 3 } },
    { id: 'over', kind: 'plugin', title: 'Send text', content: { type: 'over', source: '^https:', minLength: 1, maxLength: 100 } },
    { id: 'excluded', kind: 'plugin', title: 'Short', content: { type: 'over', minLength: 1, maxLength: 2 } },
    { id: 'provider', kind: 'plugin', title: 'A background result', provider: true },
  ]
  self.onmessage({ data: { text: 'a@example.com', rules: catalog.filter(item => item.content).map(item => ({ id: item.id, ...item.content })) } })
  const matches = new Set(messages.flatMap(item => item.id ? [item.id] : []))
  assert.deepEqual([...matches], ['regex', 'over'])
  assert.deepEqual(plain(rank(catalog, 'a@example.com', undefined, 60, matches).map(item => [item.id, item.group])),
    [['regex', 'match'], ['over', 'recommendation'], ['provider', 'provider']])
  assert.match(read('src/renderer/themes/default/quick/patternMatching.ts'), /worker\.terminate\(\)/)
})

test('safe catalog strips native targets and payloads while native requests retain their owner', async () => {
  const api = evaluate(await bundle('src/renderer/components/quickCatalog.ts'))
  const raw = ' user@example.com '
  const commands = [
    { id: 'app:/Applications/Fixture.app', kind: 'app', title: 'Fixture', subtitle: '/private/path', path: '/Applications/Fixture.app', aliases: ['Fixture', '/private/path'] },
    { id: 'plugin:fixture:mail', kind: 'plugin', title: 'Mail', subtitle: 'fixture', pluginId: 'fixture.private', code: 'mail', content: { type: 'regex', source: '@', minLength: 1 }, payload: { secret: 'not-public' } },
    { id: 'provider:fixture:item', kind: 'plugin', title: 'Provider', subtitle: 'fixture', pluginId: 'fixture.private', code: 'item', group: 'provider', payload: { key: 123 } },
  ]
  const records = api.updateQuickCatalog(commands, 'query-one')
  const directory = api.publicQuickCatalog(records)
  const serialized = JSON.stringify(directory)
  for (const privateValue of ['/private/path', '/Applications/', 'fixture.private', 'not-public', '"payload"', '"code"']) assert.ok(!serialized.includes(privateValue), privateValue)
  assert.deepEqual(plain(directory[0].aliases), ['Fixture'])
  assert.equal(api.quickRequestFromRecord(records[1], raw).payload, raw)
  assert.deepEqual(plain(api.quickRequestFromRecord(records[2], raw, 'shell')), {
    kind: 'plugin', pluginId: 'fixture.private', code: 'item', payload: { key: 123 }, query: raw, container: 'shell',
  })
  const next = api.updateQuickCatalog([...commands, { id: 'new', kind: 'action', title: 'Action', subtitle: '' }], 'query-one', records)
  assert.equal(next[0].id, records[0].id)
  assert.notEqual(api.updateQuickCatalog(commands, 'query-two')[0].id, records[0].id)
})

test('theme result projections reject stale, unknown and duplicate capabilities', async () => {
  const api = evaluate(await bundle('src/renderer/components/quickCatalog.ts'))
  const catalog = [{ id: 'opaque-one', kind: 'app', title: 'Fixture', subtitle: 'Application', aliases: [] }]
  const expected = { catalogRevision: 4, queryRevision: 6 }
  const action = { type: 'results', ...expected, items: [{ id: 'opaque-one', title: 'Theme title', group: 'my-order' }] }
  assert.equal(api.projectQuickThemeResults(catalog, action, expected)[0].title, 'Theme title')
  assert.equal(api.projectQuickThemeResults(catalog, { ...action, queryRevision: 5 }, expected), null)
  assert.equal(api.projectQuickThemeResults(catalog, { ...action, catalogRevision: 3 }, expected), null)
  assert.equal(api.projectQuickThemeResults(catalog, { ...action, items: [{ id: 'foreign' }] }, expected), null)
  assert.equal(api.projectQuickThemeResults(catalog, { ...action, items: [...action.items, ...action.items] }, expected), null)
  assert.equal(api.projectQuickThemeResults(catalog, { ...action, selectedId: 'foreign' }, expected), null)
})

test('main supplies a neutral directory and generic background results, never default search policy', async () => {
  const manifest = { id: 'fixture.provider', name: 'Fixture', description: 'A fixture', icon: 'icon.png',
    features: [{ code: 'text', cmds: ['Fixture', { type: 'regex', label: 'Email', match: '/@/' }] }] }
  let enabled = true
  const fixture = { calls: [], apps: { apps: [{ name: 'Fixture App', path: '/fixture/App.app' }] },
    registry: { getInstalledRevision: () => 1, getInstalledDescriptors: () => enabled ? [{ id: manifest.id, enabled, manifest }] : [],
      getManifest: id => id === manifest.id ? manifest : undefined, isEnabled: id => id === manifest.id && enabled } }
  const stubs = {
    '@main/plugin/PluginRegistry': 'export const pluginRegistry = globalThis.__quickFixture.registry',
    '@main/hotkey/pluginLaunchHotkeys': 'export const getPluginLaunchAliases=()=>[]; export const getPluginLaunchAliasRevision=()=>0',
    '@main/plugin/pluginBackgroundRuntime': `export const searchAll=async(query,limit)=>{globalThis.__quickFixture.calls.push([query,limit]);return [{pluginId:'fixture.provider',items:[{id:'record',title:'Provider title',code:'open',payload:{record:7}}]}]}`,
    './appScanner': 'export const getCachedApps=()=>globalThis.__quickFixture.apps; export const scanApplications=async()=>globalThis.__quickFixture.apps',
    './appLauncher': 'export const getAppIconDataUrl=async()=>"data:image/png;base64,AA=="',
    './quickProviders': 'export const queryQuickProviders=async()=>[]',
    './catalogIcons': 'export const getCatalogPluginIcon=async()=>"data:image/png;base64,AA=="',
  }
  const source = await bundle('src/main/launcher/commandIndex.ts', [{ name: 'native-fixtures', setup(build) {
    build.onResolve({ filter: /.*/ }, args => args.path in stubs ? { path: args.path, namespace: 'fixture' } : undefined)
    build.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: stubs[args.path], loader: 'js' }))
  } }])
  const api = evaluate(source, { __quickFixture: fixture })
  const directory = await api.searchQuickCommands('does-not-match', 1, [], undefined, undefined, 'catalog')
  assert.ok(directory.some(item => item.kind === 'app'))
  assert.ok(directory.some(item => item.content?.type === 'regex'))
  assert.equal(directory[0].title, 'open-market', 'default action copy is not part of main')
  assert.deepEqual(plain((await api.searchQuickCommands('anything-else', 1, [], undefined, undefined, 'static')).map(item => item.id)), plain(directory.map(item => item.id)))
  assert.deepEqual(plain(await api.searchQuickCommands('', 20, [], undefined, undefined, 'enriched', ['unknown'])), [])
  const provider = await api.searchQuickCommands('fixture query', 20, [], undefined, undefined, 'providers')
  assert.deepEqual(plain(fixture.calls), [['fixture query', 20]])
  assert.deepEqual(plain(provider[0].payload), { record: 7 })
  assert.equal(provider[0].pluginId, manifest.id)
  assert.equal(await api.validateQuickOpenTarget({ kind: 'app', path: '/not-enumerated/app' }), false)
  assert.equal(await api.validateQuickOpenTarget({ kind: 'app', path: '/fixture/App.app' }), true)
  assert.equal(await api.validateQuickOpenTarget({ kind: 'unknown' }), false)
  enabled = false
  assert.equal(await api.validateQuickOpenTarget({ kind: 'plugin', pluginId: manifest.id }), false)
  assert.equal(await api.validateQuickOpenTarget({ kind: 'plugin-pin', pluginId: manifest.id }), false)
  assert.doesNotMatch(read('src/main/launcher/commandIndex.ts'), /pinyin-pro|scoreQuickName|rankDefaultQuick|searchHistory|clipboardHistory/)
})

test('host is policy-free and default UI preserves native modes and legacy presentation delegation', () => {
  const host = read('src/renderer/components/QuickLauncherApp.tsx')
  assert.doesNotMatch(host, /pinyin|scoreQuickName|rankDefaultQuick|moveQuickGridSelection|groupQuickCommands/)
  assert.match(host, /projectQuickThemeResults/)
  assert.match(host, /defaultView\.current\?\.navigate/)
  assert.match(host, /provider === themeKey\.current/)
  assert.match(host, /bindPluginDropTarget/)
  assert.match(host, /generation: plugin\.generation/)
  assert.match(host, /customSearchRef\.current = false/)
  const theme = read('src/renderer/themes/default/quick/DefaultQuickSurface.tsx')
  assert.doesNotMatch(theme, /shellApi|window\.enestWindows|window\.enestShell|pluginId:|path:/)
  for (const behavior of ['onCompositionStart', 'plugin-detach', 'plugin-pin', 'getQuickSearchResults', 'moveQuickGridSelection', 'QuickAccessMenu']) assert.ok(theme.includes(behavior), behavior)
  assert.match(read('src/renderer/themes/default/DefaultWorkspaceSearch.tsx'), /activateSearchResult'.*query: state\.query/)
})
