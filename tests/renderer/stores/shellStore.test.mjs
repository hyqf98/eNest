import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import test from 'node:test'
import ts from 'typescript'

function fixture(initialSettings = { general: { sessionTabs: [{ pluginId: 'a' }, { pluginId: 'b' }], sessionActivePluginId: 'b' } }) {
  let receive
  const calls = []
  const notifications = []
  let settings = structuredClone(initialSettings)
  const persisted = [], timers = new Map()
  let nextTimer = 0
  const plugins = ['a', 'b', 'c'].map(id => ({ id, name: id, installed: true, color: '#fff', glyph: id, icon: `enest://plugin/${id}/assets/market/icon.svg` }))
  const orbStates = []
  const api = {
    onEvent: cb => { receive = cb; return () => {} },
    syncOrbState: async state => { orbStates.push(state) }, setSettings: async patch => { persisted.push(patch); settings = { ...settings, general: { ...settings.general, ...patch.general } } },
    getPlugins: async () => plugins,
    getSettings: async () => structuredClone(settings),
    restoreTabs: async ids => {
      calls.push(['restore', ids])
      receive({ type: 'plugin-tabs', revision: 1, tabs: ids.map(id => ({ id: `t-${id}`, title: id, status: 'hibernated' })), activeTabId: null })
    },
    openPlugin: async id => { calls.push(['open', id]) },
    activatePlugin: async id => { calls.push(['activate', id]) },
    closePlugin: async id => { calls.push(['close', id]) },
    hidePlugins: async () => { calls.push(['hide']) },
    setHomeVisible: async visible => { calls.push(['home-visible', visible]) },
    navigateWorkspace: async route => { calls.push(['workspace', route]) },
  }
  const create = initialize => {
    let state
    const get = () => state
    const set = update => { state = { ...state, ...(typeof update === 'function' ? update(state) : update) } }
    state = initialize(set, get)
    return { getState: get, setState: set }
  }
  const module = { exports: {} }
  const stubs = {
    zustand: { create },
    '@shared/constants': { PLUGIN_CATEGORY_COLOR_DEFAULT: '#fff' },
    '@renderer/services/shellApi': { shellApi: api },
    '@renderer/hooks/useToast': { toastStore: { getState: () => ({ push: (...args) => notifications.push(args) }) } },
  }
  const source = readFileSync(new URL('../../../src/renderer/stores/shellStore.ts', import.meta.url), 'utf8').replaceAll('import.meta.hot', 'undefined')
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  vm.runInNewContext(compiled, { module, exports: module.exports,
    require: name => { if (!(name in stubs)) throw new Error(name); return stubs[name] },
    window: { addEventListener() {}, removeEventListener() {} },
    document: { documentElement: { dataset: {} }, addEventListener() {}, removeEventListener() {} },
    setTimeout: callback => { const id = ++nextTimer; timers.set(id, callback); return id }, clearTimeout: id => timers.delete(id),
  })
  const store = module.exports.useShellStore
  store.setState({ plugins })
  store.getState().setNativeChromeSyncEnabled(true)
  orbStates.length = 0
  return { api, calls, store, emit: event => receive(event), notifications, persisted, orbStates,
    flushTimers: () => { const pending = [...timers.values()]; timers.clear(); pending.forEach(callback => callback()) } }
}

const tabs = (...ids) => ids.map(id => ({ id: `t-${id}`, title: id, status: 'ready' }))

test('view switches hide the Workspace surface for native views; host events do not replay IPC', () => {
  const { store, calls } = fixture()
  // settings 由原生壳渲染层独占：隐藏 Home 表面即可，不再导航 Workspace 设置路由
  store.getState().setView('settings')
  assert.equal(JSON.stringify(calls), JSON.stringify([['home-visible', false], ['hide']]))
  calls.length = 0
  store.getState().applyView('home')
  assert.equal(store.getState().view, 'home')
  assert.deepEqual(calls, [])
  store.getState().goHome()
  // goHome 先 setView('home')（home 不需要隐藏 Home 表面），再导航回目录
  assert.equal(JSON.stringify(calls), JSON.stringify([['hide'], ['workspace', { page: 'catalog' }]]))
})

test('authoritative snapshots set order/readiness and ignore old snapshots and legacy activation', async () => {
  const { store, emit } = fixture()
  emit({ type: 'plugin-tabs', revision: 3, tabs: [{ id: 't-b', title: 'B', status: 'loading' }], activeTabId: 't-b' })
  assert.equal(store.getState().pluginReady, false)
  await store.getState().activateTab('t-b')
  assert.equal(store.getState().pluginReady, false, 'IPC completion is not page readiness')
  emit({ type: 'plugin-ready', pluginId: 'a', generation: 1 })
  emit({ type: 'plugin-active', tabId: 't-a' })
  emit({ type: 'plugin-tabs', revision: 2, tabs: tabs('a'), activeTabId: 't-a' })
  assert.equal(store.getState().activeTabId, 't-b')
  emit({ type: 'plugin-tabs', revision: 4, tabs: tabs('b', 'a'), activeTabId: 't-b' })
  assert.equal(store.getState().pluginReady, true)
  assert.equal(store.getState().tabs.map(tab => tab.id).join(','), 't-b,t-a')
})

test('close removes UI before teardown settles, suppresses duplicate requests and takes host successor', async () => {
  const { store, emit, api, calls } = fixture()
  emit({ type: 'plugin-tabs', revision: 1, tabs: tabs('a', 'b', 'c'), activeTabId: 't-b' })
  let finish
  api.closePlugin = id => { calls.push(['close', id]); return new Promise(resolve => { finish = resolve }) }
  const closing = store.getState().closeTab('t-b')
  assert.equal(store.getState().tabs.map(tab => tab.id).join(','), 't-a,t-c')
  assert.equal(store.getState().activeTabId, 't-c')
  await store.getState().closeTab('t-b')
  assert.equal(calls.filter(call => call[0] === 'close').length, 1)
  emit({ type: 'plugin-tabs', revision: 2, tabs: tabs('a', 'c'), activeTabId: 't-a' })
  finish()
  await closing
  assert.equal(store.getState().activeTabId, 't-a', 'late IPC return must not overwrite host state')
})

test('closing a background tab while in settings does not navigate', async () => {
  const { store, emit } = fixture()
  emit({ type: 'plugin-tabs', revision: 1, tabs: tabs('a', 'b'), activeTabId: null })
  store.setState({ view: 'settings' })
  await store.getState().closeTab('t-a')
  emit({ type: 'plugin-tabs', revision: 2, tabs: tabs('b'), activeTabId: null })
  assert.equal(store.getState().view, 'settings')
  assert.equal(store.getState().activeTabId, null)
})

test('restore keeps even the saved active plugin lazy until the user opens its tab', async () => {
  const { store, calls } = fixture()
  await Promise.all([store.getState().hydrateSessionTabs(), store.getState().hydrateSessionTabs()])
  assert.equal(JSON.stringify(calls), JSON.stringify([['restore', ['a', 'b']]]))
  assert.equal(store.getState().tabs.length, 2)
  assert.ok(store.getState().tabs.every(tab => tab.lazy))
  assert.equal(store.getState().pluginReady, false)
  await store.getState().activateTab('t-b')
  assert.equal(JSON.stringify(calls), JSON.stringify([['restore', ['a', 'b']], ['activate', 't-b']]))
})

test('startup session restore reuses the already-read IDs without another settings request', async () => {
  const { store, api, calls } = fixture()
  api.getSettings = async () => { throw Error('Startup must reuse its settings read') }
  await store.getState().hydrateSessionTabs(['b', 'a'])
  assert.equal(JSON.stringify(calls), JSON.stringify([['restore', ['b', 'a']]]))
  assert.equal(store.getState().tabs.every(tab => tab.lazy), true)
  assert.equal(store.getState().activeTabId, null)
})

test('session projections and view changes cannot show native orb chrome over the launch screen', async () => {
  const { store, emit, orbStates } = fixture()
  store.getState().setNativeChromeSyncEnabled(false)
  assert.equal(orbStates.at(-1).chromeVisible, false, 'hides an existing native rail during preview or renderer remount')
  orbStates.length = 0
  await store.getState().hydrateSessionTabs(['a'])
  emit({ type: 'plugin-tabs', revision: 2, tabs: tabs('a', 'b'), activeTabId: null })
  store.getState().applyView('home')
  store.getState().applyTabStyle('orb')
  assert.equal(orbStates.length, 0)
  store.getState().setNativeChromeSyncEnabled(true)
  assert.equal(orbStates.length, 1)
  assert.equal(orbStates[0].tabStyle, 'orb')
  assert.equal(orbStates[0].chromeVisible, true)
  assert.equal(orbStates[0].tabs.length, 2)
})

test('early plugin open and close cannot overwrite startup settings or resurrect the transient tab', async () => {
  const { store, emit, calls, persisted, flushTimers } = fixture({ general: { sessionTabs: [], sessionActivePluginId: '' } })
  emit({ type: 'plugin-tabs', revision: 1, tabs: tabs('a'), activeTabId: 't-a' })
  flushTimers()
  assert.equal(persisted.length, 0, 'startup read must precede any session persistence')
  emit({ type: 'plugin-tabs', revision: 2, tabs: [], activeTabId: null })
  // Splash finishes before the close projection's next debounce would run.
  await store.getState().hydrateSessionTabs()
  assert.equal(JSON.stringify(calls), JSON.stringify([['restore', []]]))
  assert.equal(store.getState().tabs.length, 0)
  flushTimers()
  assert.equal(persisted.length, 0, 'renderer projections never overwrite the host-owned global session')
})

test('tab projection carries package images and authoritative title/glyph/badge overrides to orb', () => {
  const { store, emit, orbStates } = fixture()
  emit({ type: 'plugin-tabs', revision: 1, tabs: tabs('a'), activeTabId: 't-a' })
  assert.equal(store.getState().tabs[0].icon, 'enest://plugin/a/assets/market/icon.svg')
  emit({ type: 'plugin-tabs', revision: 3, tabs: [{ id: 't-a', title: 'Running task', icon: null, glyph: '✓', badge: '7', status: 'hibernated' }], activeTabId: null })
  const tab = store.getState().tabs[0]
  assert.equal(tab.icon, null, 'glyph overrides must not fall back to the manifest image')
  assert.equal(tab.glyph, '✓'); assert.equal(tab.title, 'Running task'); assert.equal(tab.badge, '7'); assert.equal(tab.lazy, true)
  assert.equal(orbStates.at(-1).tabs[0].icon, null); assert.equal(orbStates.at(-1).tabs[0].badge, '7')
  emit({ type: 'plugin-tabs', revision: 2, tabs: tabs('a'), activeTabId: 't-a' })
  assert.equal(store.getState().tabs[0].glyph, '✓')
  emit({ type: 'plugin-tabs', revision: 4, tabs: [{ id: 't-a', title: 'a', icon: 'enest://plugin/a/assets/market/icon.svg', glyph: 'a', badge: '', status: 'ready' }], activeTabId: 't-a' })
  assert.equal(store.getState().tabs[0].icon, 'enest://plugin/a/assets/market/icon.svg'); assert.equal(store.getState().tabs[0].badge, '')
})


test('removing a development registration preserves installed packages and plugin data', async () => {
  const f = fixture()
  f.api.forgetDevPlugin = async id => f.calls.push(['forget', id])
  f.api.uninstallPlugin = async () => { throw new Error('developer removal must never invoke uninstall') }
  await f.store.getState().removeDevPlugin('a')
  assert.deepEqual(f.calls, [['close', 't-a'], ['forget', 'a']])
  assert.match(f.store.getState().devLogs.at(-1).text, /removed a/)
})
