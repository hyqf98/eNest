import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const state = {}

const adapters = {
  fixture: `export const state=globalThis.homeFixtureState`,
  electron: `import {EventEmitter} from 'node:events'; import {state} from 'fixture';
    export const dialog={showMessageBox:async(_parent,options)=>{state.confirmations.push(options);return state.confirm?await state.confirm():{response:1}}};
    export class WebContents extends EventEmitter { id=++ids; constructor(){super()} }
    let ids=0;`,
  '@main/plugin/PluginRegistry': `import {state} from 'fixture';
    import {localCatalogResources,remoteCatalogResources} from '@main/plugin/catalogResources';
    export const pluginRegistry=state.registry;
    pluginRegistry.getCatalogResources??=id=>{
      const manifest=pluginRegistry.getAssetManifest(id);
      if(manifest)return localCatalogResources({id,version:'1.0.0',...manifest},'/fixture','installed');
      const remote=pluginRegistry.getRemoteEntry?.(id);
      return remote?remoteCatalogResources(remote):{screenshots:[]};
    };`,
  '@main/plugin/PluginHost': `import {state} from 'fixture'; export const pluginHost={blockPlugin:id=>{state.blocks.push(id);return()=>state.releases.push(id)},closePlugin:async id=>{state.closed.push(id)}};`,
  '@main/plugin/PluginUninstaller': `import {state} from 'fixture'; export const uninstallPlugin=async id=>{state.uninstalls.push(id);return state.uninstallResult??{ok:true}};`,
  '@main/timer/deadlineTaskService': `import {state} from 'fixture'; export const cancelPluginDeadlineTasks=async id=>{state.cancelledTasks.push(id)};`,
  '@main/plugin/pluginBackgroundRuntime': `export const refreshPluginBackgrounds=()=>{};export const stopPluginBackground=()=>{};`,
  '@main/hotkey/pluginLaunchHotkeys': `import {state} from 'fixture'; export const applyPluginLaunchHotkeys=()=>state.hotkeys.push('apply');export const releasePluginLaunchHotkey=id=>state.hotkeys.push(id);export const clearPluginLaunch=async id=>state.clearedLaunch.push(id);`,
  '@main/settings/SettingsStore': `export const settingsStore={getAll:()=>({general:{locale:'zh-CN'}})};`,
  '@main/theme/appearanceResources': `import {state} from 'fixture'; export const publicAppearanceFonts=()=>state.fonts??[]; export const publicAppearanceMedia=media=>media;`,
  '@main/window/modalSurface': `import {state} from 'fixture'; export const openNativeModal=async(owner,request)=>{state.confirmations.push({owner,request});return state.confirm?await state.confirm():true};`,
  '@main/plugin/installQueue': `import {state} from 'fixture'; export const enqueueInstallFromUrl=(url,meta)=>{state.queue.push({url,meta});return {id:'job-1'}};`,
  '@main/launcher/pluginLauncher': `import {state} from 'fixture'; export const launchPlugin=async request=>{state.launchRequests.push(request);if(state.launchWait)await state.launchWait;if(request.guard&&!request.guard())return {ok:false,cancelled:true};state.launches.push(request);state.onLaunch?.();return state.launchResult??{ok:state.launchOk && Boolean(request.pluginId)}};`,
  '@main/launcher/appLauncher': `import {state} from 'fixture'; export const launchLocalApp=async path=>{state.appLaunches.push(path);if(state.appLaunchError)throw state.appLaunchError};`,
  '@main/launcher/appScanner': `import {state} from 'fixture'; export const scanApplications=async force=>{state.appScans.push(force);return state.scanResult??{complete:true,errors:[]}};`,
  '@main/launcher/commandIndex': `import {state} from 'fixture'; export const searchQuickCommands=async(query,limit,recent,kind)=>{state.searches.push({query,limit,kind});if(state.searchWait)await state.searchWait;return state.commands};`,
  '@main/window/createShellWindow': `import {state} from 'fixture'; export const getMainWindow=()=>state.window; export const sendShellEvent=payload=>{state.shellEvents.push(payload)};`,
  '@main/logs/logService': `import {state} from 'fixture';export const logInfo=()=>{}; export const logWarn=(...args)=>state.logs.push(args);`
}

async function load(initial = {}) {
  for (const key of Object.keys(state)) delete state[key]
  Object.assign(state, {
    queue: [], launches: [], launchRequests: [], appLaunches: [], appScans: [], searches: [], shellEvents: [],
    commands: [], searchHandles: {}, visibility: [], workspaceNavigations: [], launchOk: true,
    confirmations: [], blocks: [], releases: [], closed: [], uninstalls: [], cancelledTasks: [], hotkeys: [], clearedLaunch: [], logs: [],
    registry: { get: () => null, list: () => [], getRemoteMarket: () => [], getAssetManifest: () => null }, window: null
  }, initial)
  state.registry.list ??= () => []
  state.registry.getAssetManifest ??= () => null
  const manifests = new Map()
  state.registry.getManifest ??= id => {
    if (!manifests.has(id)) manifests.set(id, { id, ...state.registry.getAssetManifest(id) })
    return manifests.get(id)
  }
  state.registry.getBuildRevision ??= () => 'fixture-build'
  globalThis.homeFixtureState = state
  const source = `export * from '@main/home/homeDataService'; export const nonce=${Math.random()};`
  const bundle = await build({
    stdin: { contents: source, resolveDir: root, sourcefile: 'home-data-fixture.js' },
    bundle: true, write: false, format: 'esm', platform: 'node', tsconfig: `${root}/tsconfig.node.json`,
    plugins: [{
      name: 'home-data-fixture',
      setup(builder) {
        builder.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'fixture' }))
        builder.onResolve({ filter: /.*/ }, ({ path }) => path in adapters ? { path, namespace: 'fixture' } : undefined)
        builder.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => {
          const contents = path === 'fixture' ? `export const state=globalThis.homeFixtureState` : adapters[path]
          return { contents, loader: 'js' }
        })
        builder.onLoad({ filter: /.*/ }, () => undefined)
      }
    }]
  })
  return await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`)
}

function appearance() {
  return {
    version: 2,
    revision: 7,
    theme: { source: 'enest.builtin', id: 'theme', name: 'Theme', version: 1, legacy: false },
    requestedMode: 'system',
    mode: 'dark',
    tokens: { '--bg': '#111111' },
    fonts: { body: 'Sans', heading: 'Heading', mono: 'Mono', scale: 1 },
    components: { controlRadius: 1, cardRadius: 2, panelRadius: 3, borderWidth: 4 },
    notifications: { layout: 'compact', accent: 'icon', radius: 14, borderWidth: 1, density: 0.8, shadow: 'soft' },
    background: { media: { type: 'image', value: '/private/path.png', opacity: 1, fit: 'cover' }, effect: 'ripple', texture: 'none', intensity: 1, speed: 2, direction: 3 },
    layout: { variant: 'warm', tabStyle: 'orb', density: 1, gap: 8, sidebarWidth: 9, contentWidth: 10, columns: 4 },
    animation: { requested: 'high', effective: 'medium', continuous: true },
    home: { source: 'enest.builtin', id: 'home', variant: 'ink' },
    diagnostics: [{ path: '/private', code: 'x', message: 'secret' }]
  }
}

function context(current = true) {
  return {
    wcId: 11,
    generation: 3,
    owner: { id: 11, isDestroyed: () => false },
    isCurrent: typeof current === 'function' ? current : () => current,
    setHomeVisible: visible => state.visibility.push(visible),
    navigateWorkspace: async route => state.workspaceNavigations.push(route)
  }
}

test('appearance snapshot keeps rendering data and removes host-private bags/media', async () => {
  const api = await load()
  const snapshot = api.getHomeAppearanceSnapshot(appearance())
  assert.equal(snapshot.appearance.revision, 7)
  assert.equal(snapshot.appearance.background.media, null)
  assert.equal('diagnostics' in snapshot.appearance, false)
  assert.equal('profile' in snapshot, false)
  assert.equal('packs' in snapshot, false)
  assert.equal('customFonts' in snapshot, false)
  assert.equal(snapshot.appearance.layout.tabStyle, 'orb')
  assert.deepEqual(snapshot.appearance.notifications, appearance().notifications)
  const candidate = appearance()
  Object.assign(candidate.notifications, { privatePath: '/private/notifications' })
  Object.assign(candidate.layout, { privatePath: '/private/layout' })
  const projected = api.getHomeAppearanceSnapshot(candidate)
  assert.equal('privatePath' in projected.appearance.notifications, false)
  assert.equal('privatePath' in projected.appearance.layout, false)
  Object.assign(candidate.background, { warmth: 0.4, grain: 0.3, scale: 1.7, wash: 0.6 })
  const material = api.getHomeAppearanceSnapshot(candidate).appearance.background
  assert.deepEqual([material.warmth, material.grain, material.scale, material.wash], [0.4, 0.3, 1.7, 0.6])
  Object.assign(candidate.background, { warmth: NaN, grain: -1, scale: 9, wash: Infinity })
  const invalid = api.getHomeAppearanceSnapshot(candidate).appearance.background
  assert.deepEqual([invalid.warmth, invalid.grain, invalid.scale, invalid.wash], [undefined, undefined, undefined, undefined])
})

test('boot catalog is immediate and offline; manual refresh is the only network path', async () => {
  const commands = [
    { kind: 'plugin', id: 'p1', title: 'Plugin', subtitle: '', pluginId: 'p1', code: 'feature' },
    { kind: 'app', id: 'app', title: 'App', subtitle: '/private/App.app', path: '/private/App.app' }
  ]
  const pluginRegistry = {
    list: () => [{ id: 'installed' }, { id: 'remote' }],
    get: id => id === 'installed'
      ? { id, name: 'Installed', description: '', version: '1.0.0', installed: true, enabled: true, icon: 'enest://plugin/installed/assets/icon.svg', color: '#112233', glyph: 'I' }
      : id === 'remote'
        ? { id, name: 'Remote', description: '', version: '2.0.0', installed: false, permissions: ['net.fetch'], packageSize: 12, icon: 'https://example.com/icon.png', color: 'blue', glyph: 'R' }
        : null,
    getAssetManifest: id => id === 'installed' ? { icon: 'assets/icon.svg' } : null,
    getRemoteMarket: () => [{ id: 'remote' }],
    refreshRemoteMarket: async force => { state.refreshes = [force] }
  }
  const api = await load({ commands, registry: pluginRegistry })
  const boot = await api.getHomeCatalog()
  assert.deepEqual(state.refreshes ?? [], [])
  assert.equal(boot.items.length, 2)
  assert.equal(boot.items[0].pluginId, 'installed')
  assert.equal('assetUrl' in boot.items[0], false)
  assert.equal('installedAt' in boot.items[0], false)
  assert.equal(boot.items[0].icon, 'enest-home://catalog/installed/icon')
  assert.equal('permissions' in boot.items[1], false)
  assert.equal(boot.items[1].icon, null, 'home has no arbitrary outbound icon permission')
  assert.equal(boot.items[1].color, undefined)
  const refreshed = await api.getHomeCatalog('manual')
  assert.deepEqual(state.refreshes, [true])
  assert.equal(refreshed.items.length, 2)
})

test('remote catalog, detail and search publish only controlled slots and positive byte sizes', async () => {
  const id = 'com.github.eNest.anything'
  const base = 'https://github.com/hyqf98/eNest_plugin/releases/download/v1/'
  const row = { id, name: 'Anything', version: '1.0.0', packageSize: 136698, installed: false,
    icon: base + 'anything%401.0.0-icon.svg', screenshots: [base + 'anything%401.0.0-screenshot-1.png'],
    readmeUrl: base + 'anything%401.0.0-README.md', readmeImages: {
      'screenshots/01-main.png': base + 'anything%401.0.0-screenshot-1.png',
      'private.png': 'https://example.com/tracker.png'
    } }
  const registry = { get: key => key === id ? row : null, list: () => [row], getRemoteEntry: key => key === id ? row : null }
  const api = await load({ registry })
  const detail = await api.getHomeDetail(id)
  assert.equal(detail.icon, `enest-home://catalog/${id}/icon`)
  assert.equal(detail.readmeUrl, `enest-home://catalog/${id}/readme`)
  assert.deepEqual(detail.readmeImages, { 'screenshots/01-main.png': `enest-home://catalog/${id}/screenshot/0` })
  assert.equal(detail.packageSize, 136698)
  assert.doesNotMatch(JSON.stringify(detail), /https:|raw\.github|release|private\.png/)
  const search = await api.searchHome({ query: 'Anything', scope: 'market' }, context())
  assert.equal(search.items[0].icon, detail.icon)
  for (const packageSize of [0, -1, Infinity, 1.5]) {
    row.packageSize = packageSize
    assert.equal((await api.getHomeCatalog()).items[0].packageSize, undefined)
  }
  state.commands = [{ kind: 'plugin', title: 'Anything', pluginId: id, icon: 'https://renderer-selected.example/evil.png' }]
  row.installed = true
  const installed = await api.searchHome({ query: 'Anything', scope: 'plugin' }, context())
  assert.equal(installed.items[0].icon, detail.icon, 'command URLs never select resource bytes')
})

test('search returns one-use owner-bound handles and activates main-side command data', async () => {
  const command = { kind: 'plugin', id: 'p1', title: 'Plugin', subtitle: 'detail', pluginId: 'p1', code: 'feature', payload: { query: 'secret' } }
  const pluginRegistry = {
    get: id => ({ id, installed: true, enabled: true, color: '#123456', glyph: 'P', tags: ['work'] })
  }
  const api = await load({ commands: [command], registry: pluginRegistry })
  const result = await api.searchHome({ query: 'plug', limit: 4, scope: 'installed' }, context())
  assert.equal(result.items.length, 1)
  assert.equal(result.items[0].subtitle, 'detail')
  assert.equal('payload' in result.items[0], false)
  assert.equal('detailCode' in result.items[0], false)
  const activated = await api.runHomeAction({ type: 'activateSearchResult', handle: result.items[0].handle }, context())
  assert.equal(activated.ok, true)
  assert.deepEqual(state.launches, [{
    pluginId: 'p1', source: 'quick', mode: 'shell', enter: { code: 'feature', payload: { query: 'secret' } }
  }])
  assert.deepEqual(state.visibility, [false])
  assert.equal(state.searches[0].kind, 'plugin')
  const replay = await api.runHomeAction({ type: 'activateSearchResult', handle: result.items[0].handle }, context())
  assert.equal(replay.ok, false)
})

test('app search hides paths and only activates cached main-side paths', async () => {
  const command = { kind: 'app', id: 'app:/private/App.app', title: 'App', subtitle: '/private/App.app', path: '/private/App.app' }
  const api = await load({ commands: [command] })
  const result = await api.searchHome({ query: 'app' }, context())
  assert.equal(result.items[0].subtitle, '')
  assert.equal('path' in result.items[0], false)
  const activated = await api.runHomeAction({ type: 'activateSearchResult', handle: result.items[0].handle }, context())
  assert.equal(activated.ok, true)
  assert.deepEqual(state.appLaunches, ['/private/App.app'])
})

test('expired owner generation cannot use a search handle', async () => {
  const command = { kind: 'app', id: 'app', title: 'App', path: '/Applications/App.app' }
  const api = await load({ commands: [command] })
  const result = await api.searchHome({ query: 'app' }, context(true))
  const stale = context(false)
  const activated = await api.runHomeAction({ type: 'activateSearchResult', handle: result.items[0].handle }, stale)
  assert.equal(activated.ok, false)
  assert.deepEqual(state.appLaunches, [])
})

test('market search uses cached metadata without exposing installer URLs', async () => {
  const registry = {
    get: id => ({ id, name: 'Notebook', description: 'Take notes', installed: false, assetUrl: 'https://private.example/pkg' }),
    list: () => [{ id: 'notes' }]
  }
  const api = await load({ registry })
  const result = await api.searchHome({ query: 'notes', scope: 'market' }, context())
  assert.equal(result.items.length, 1)
  assert.equal(result.items[0].kind, 'market')
  assert.equal(result.items[0].pluginId, 'notes')
  assert.equal('assetUrl' in result.items[0], false)
  assert.deepEqual(state.searches, [])
})

test('plugin search scopes keep disabled installed plugins viewable without duplicate launch results', async () => {
  const catalog = [
    { id: 'active', name: 'Notes Active', installed: true, enabled: true },
    { id: 'disabled', name: 'Notes Disabled', installed: true, enabled: false },
    { id: 'remote', name: 'Notes Remote', installed: false, enabled: true },
    { id: 'unrelated', name: 'Other Plugin', installed: true, enabled: false }
  ]
  const registry = {
    list: () => catalog,
    get: id => catalog.find(item => item.id === id) ?? null
  }
  const api = await load({ registry, commands: [
    { kind: 'plugin', id: 'active-feature', title: 'Notes Active Feature', pluginId: 'active', code: 'feature' },
    { kind: 'plugin', id: 'active-main', title: 'Notes Active', pluginId: 'active' },
    { kind: 'plugin', id: 'stale-disabled', title: 'Notes Disabled', pluginId: 'disabled' },
    { kind: 'plugin', id: 'stale-remote', title: 'Notes Remote', pluginId: 'remote' },
    { kind: 'plugin', id: 'stale-removed', title: 'Notes Removed', pluginId: 'removed' }
  ] })
  for (const scope of ['plugin', 'installed', 'all', undefined, 'market']) {
    const result = await api.searchHome({ query: 'notes', scope }, context())
    const disabled = result.items.filter(item => item.pluginId === 'disabled')
    assert.equal(disabled.length, 1, `${scope}: disabled installed plugin remains searchable`)
    assert.equal(disabled[0].kind, 'market')
    assert.equal(disabled[0].installed, true)
    assert.equal(disabled[0].enabled, false)
    assert.notEqual(disabled[0].disabled, true, 'detail navigation is allowed while plugin execution is disabled')
    const active = result.items.filter(item => item.pluginId === 'active')
    assert.equal(active.length, scope === 'market' ? 1 : 2, 'distinct Quick commands remain; catalog does not duplicate them')
    assert.ok(active.every(item => item.kind === (scope === 'market' ? 'market' : 'plugin')))
    assert.equal(result.items.some(item => item.pluginId === 'remote'), scope !== 'plugin' && scope !== 'installed')
    assert.equal(result.items.some(item => item.pluginId === 'removed' || item.pluginId === 'unrelated'), false)
  }
  for (const scope of ['app', 'action']) {
    const result = await api.searchHome({ query: 'notes', scope }, context())
    assert.deepEqual(result.items, [], `${scope}: does not append catalog plugins`)
  }
  const limited = await api.searchHome({ query: 'notes', scope: 'all', limit: 3 }, context())
  assert.equal(limited.items.length, 3)
  assert.deepEqual(limited.items.map(item => item.pluginId), ['active', 'active', 'disabled'])
  assert.deepEqual(state.launches, [])
  assert.deepEqual(state.queue, [])
})

test('catalog search handles await details and never launch, enable or install disabled or remote plugins', async () => {
  const catalog = [
    { id: 'disabled', name: 'Notes Disabled', installed: true, enabled: false, rootPath: '/private/notes' },
    { id: 'remote', name: 'Notes Remote', installed: false, assetUrl: 'https://private.example/pkg' }
  ]
  const registry = {
    list: () => catalog,
    get: id => catalog.find(item => item.id === id) ?? null,
    getRemoteEntry: () => undefined,
    setPluginEnabled: async (...args) => { state.enabledChanges.push(args) }
  }
  const api = await load({ registry, enabledChanges: [] })
  const result = await api.searchHome({ query: 'notes', scope: 'market' }, context())
  assert.doesNotMatch(JSON.stringify(result), /rootPath|assetUrl|private/)
  let resolveNavigation, settled = false
  const pending = api.runHomeAction({ type: 'activateSearchResult', handle: result.items[0].handle }, {
    ...context(), navigateWorkspace: route => new Promise(resolve => { state.workspaceNavigations.push(route); resolveNavigation = resolve })
  }).then(reply => { settled = true; return reply })
  await Promise.resolve()
  assert.equal(settled, false)
  assert.deepEqual(state.workspaceNavigations, [{ page: 'detail', pluginId: 'disabled' }])
  resolveNavigation()
  assert.deepEqual(await pending, { ok: true })
  assert.equal((await api.runHomeAction({ type: 'activateSearchResult', handle: result.items[0].handle }, context())).ok, false)
  assert.deepEqual(await api.runHomeAction({ type: 'activateSearchResult', handle: result.items[1].handle }, context()), { ok: true })
  assert.deepEqual(state.workspaceNavigations.at(-1), { page: 'detail', pluginId: 'remote' })
  assert.deepEqual(state.launches, [])
  assert.deepEqual(state.appLaunches, [])
  assert.deepEqual(state.enabledChanges, [])
  assert.deepEqual(state.queue, [])
  assert.deepEqual(state.confirmations, [])
  assert.deepEqual(state.visibility, [])
})

test('catalog search handles revalidate owner, availability and generation before completing detail navigation', async () => {
  let available = true, current = true
  const registry = {
    list: () => [{ id: 'disabled' }],
    get: id => available ? { id, name: 'Notes Disabled', installed: true, enabled: false } : null
  }
  const api = await load({ registry })
  const result = await api.searchHome({ query: 'notes', scope: 'plugin' }, context())
  const handle = result.items[0].handle
  assert.equal((await api.runHomeAction({ type: 'activateSearchResult', handle }, { ...context(), wcId: 12 })).ok, false)
  available = false
  assert.deepEqual(await api.runHomeAction({ type: 'activateSearchResult', handle }, context()), { ok: false, error: 'plugin is no longer available' })
  assert.deepEqual(state.workspaceNavigations, [])
  available = true
  const next = await api.searchHome({ query: 'notes', scope: 'installed' }, context())
  assert.deepEqual(await api.runHomeAction({ type: 'activateSearchResult', handle: next.items[0].handle }, {
    ...context(() => current), navigateWorkspace: async route => { state.workspaceNavigations.push(route); current = false }
  }), { ok: false, error: 'home surface retired' })
  assert.deepEqual(state.launches, [])
  assert.deepEqual(state.queue, [])
})

test('stale actions and searches never start host operations', async () => {
  const api = await load()
  assert.equal((await api.runHomeAction({ type: 'openPlugin', pluginId: 'notes' }, context(false))).ok, false)
  assert.deepEqual((await api.searchHome({ query: 'notes' }, context(false))).items, [])
  assert.deepEqual(state.launches, [])
  assert.deepEqual(state.searches, [])
})

test('settings, catalog and details stay inside the restricted workspace', async () => {
  const api = await load({ launchOk: false })
  assert.equal((await api.runHomeAction({ type: 'openPlugin', pluginId: 'notes' }, context())).ok, false)
  assert.deepEqual(state.visibility, [])
  assert.equal((await api.runHomeAction({ type: 'openSettings' }, context())).ok, true)
  assert.deepEqual(state.visibility, [])
  // 设置由原生壳渲染层独占：openSettings 发 set-view 而不是导航 Workspace 路由
  assert.deepEqual(state.shellEvents, [{ type: 'set-view', view: 'settings' }])
  assert.equal((await api.runHomeAction({ type: 'openMarket' }, context())).ok, true)
  assert.deepEqual(state.workspaceNavigations, [{ page: 'catalog' }])
  assert.deepEqual(state.visibility, [])
})

test('workspace navigation is awaited and search settings actions do not expose shell APIs', async () => {
  const registry = { get: id => ({ id, installed: true, enabled: true }) }
  const api = await load({ registry, commands: [{ kind: 'action', title: 'Settings', action: 'open-settings' }] })
  const result = await api.searchHome({ query: 'settings', scope: 'action' }, context())
  assert.equal((await api.runHomeAction({ type: 'activateSearchResult', handle: result.items[0].handle }, context())).ok, true)
  assert.deepEqual(state.shellEvents, [{ type: 'set-view', view: 'settings' }])
  assert.deepEqual(state.workspaceNavigations, [])
  assert.deepEqual(state.visibility, [])
  let resolveNavigation, settled = false
  const pending = api.runHomeAction({ type: 'openMarket', pluginId: 'notes' }, {
    ...context(), navigateWorkspace: route => new Promise(resolve => { state.workspaceNavigations.push(route); resolveNavigation = resolve })
  }).then(reply => { settled = true; return reply })
  await Promise.resolve()
  assert.equal(settled, false)
  assert.deepEqual(state.workspaceNavigations.at(-1), { page: 'detail', pluginId: 'notes' })
  resolveNavigation()
  assert.deepEqual(await pending, { ok: true })
  for (const route of [{ page: 'catalog' }, { page: 'detail', pluginId: 'notes' }]) {
    assert.deepEqual(await api.runHomeAction({ type: 'navigate', route }, context()), { ok: true })
    assert.deepEqual(state.workspaceNavigations.at(-1), route)
  }
})

test('foreign owners cannot consume another Home handle; expiry and retirement prevent execution', async () => {
  const command = { kind: 'app', id: 'app', title: 'App', path: '/Applications/App.app' }
  const api = await load({ commands: [command] })
  const result = await api.searchHome({ query: 'app' }, context())
  for (const other of [{ ...context(), wcId: 12 }, { ...context(), generation: 4 }]) {
    assert.equal((await api.runHomeAction({ type: 'activateSearchResult', handle: result.items[0].handle }, other)).ok, false)
  }
  assert.equal((await api.runHomeAction({ type: 'activateSearchResult', handle: result.items[0].handle }, context())).ok, true)
  const expired = await api.searchHome({ query: 'app' }, context())
  const now = Date.now
  try {
    Date.now = () => now() + 120_001
    assert.equal((await api.runHomeAction({ type: 'activateSearchResult', handle: expired.items[0].handle }, context())).ok, false)
  } finally { Date.now = now }
  const retired = await api.searchHome({ query: 'app' }, context())
  api.invalidateHomeSearchHandles(11)
  assert.equal((await api.runHomeAction({ type: 'activateSearchResult', handle: retired.items[0].handle }, context())).ok, false)
  assert.deepEqual(state.appLaunches, ['/Applications/App.app'])
})

test('a search that resolves after its Home generation retires returns no handles', async () => {
  let resolveSearch, current = true
  const searchWait = new Promise(resolve => { resolveSearch = resolve })
  const api = await load({ commands: [{ kind: 'app', id: 'app', title: 'App', path: '/Applications/App.app' }], searchWait })
  const pending = api.searchHome({ query: 'app' }, context(() => current))
  current = false
  resolveSearch()
  assert.deepEqual((await pending).items, [])
  assert.deepEqual(state.appLaunches, [])
})

test('Home detail exposes restricted public slots but no package paths or remote credentials', async () => {
  const registry = {
    get: id => ({ id, name: 'Public', installed: true, enabled: false, rootPath: '/private/plugin', permissions: ['net.fetch', 'future.permission'], packageSize: 22, icon: 'enest://plugin/public/assets/market/icon.svg' }),
    getAssetManifest: () => ({ market: { readme: 'assets/market/README.md', screenshots: ['assets/market/screenshots/1.png'] } })
  }
  const api = await load({ registry })
  const detail = await api.getHomeDetail('public')
  assert.equal(detail.readmeUrl, 'enest-home://catalog/public/readme')
  assert.deepEqual(detail.screenshots, ['enest-home://catalog/public/screenshot/0'])
  assert.deepEqual(detail.readmeImages, { 'screenshots/1.png': 'enest-home://catalog/public/screenshot/0' })
  assert.deepEqual(detail.permissions, ['net.fetch'])
  assert.equal('rootPath' in detail, false)
  assert.equal('assetUrl' in detail, false)
})

test('Home media and font references are limited to opaque public-library handles', async () => {
  const id = 'a'.repeat(64)
  const api = await load({ fonts: [
    { family: 'PrivateFont', url: `enest://appearance/font/${id}` },
    { family: 'PrivateFont', url: 'file:///private/font.ttf' },
    { family: 'UnusedFont', url: `enest://appearance/font/${id}` }
  ] })
  const candidate = appearance()
  candidate.fonts.body = 'PrivateFont, Sans'
  candidate.background.media = { type: 'image', value: `enest://appearance/media/${id}.png`, fit: 'cover', opacity: 0.4 }
  const snapshot = api.getHomeAppearanceSnapshot(candidate)
  assert.equal(snapshot.appearance.background.media.value, `enest-home://appearance/media/${id}.png`)
  assert.deepEqual(snapshot.resources.fonts, [{ family: 'PrivateFont', url: `enest-home://appearance/font/${id}` }])
  assert.equal(JSON.stringify(snapshot).includes('file:///'), false)
  for (const value of ['file:///private/image.png', '/private/image.png', 'https://example.com/image.png', `enest://appearance/media/${id}.png?path=/private`, 'enest://plugin/other/secret.png']) {
    candidate.background.media.value = value
    assert.equal(api.getHomeAppearanceSnapshot(candidate).appearance.background.media, null)
  }
})

test('direct opens and old search results cannot silently install or re-enable plugins', async () => {
  let installed = true, enabled = true
  const registry = { get: id => ({ id, installed, enabled }) }
  const api = await load({ commands: [{ kind: 'plugin', title: 'Plugin', pluginId: 'notes' }], registry })
  const result = await api.searchHome({ query: 'notes', scope: 'installed' }, context())
  installed = false
  assert.equal((await api.runHomeAction({ type: 'openPlugin', pluginId: 'notes' }, context())).ok, false)
  assert.equal((await api.runHomeAction({ type: 'activateSearchResult', handle: result.items[0].handle }, context())).ok, false)
  installed = true
  enabled = false
  assert.equal((await api.runHomeAction({ type: 'openPlugin', pluginId: 'notes' }, context())).ok, false)
  assert.deepEqual(state.launches, [])
})

test('management requires native confirmation and refuses retired Home actions after the dialog', async () => {
  let current = true
  const registry = {
    get: id => ({ id, name: 'Notes', installed: true, enabled: true }),
    setPluginEnabled: async (...args) => { state.enabledChanges.push(args) },
    getRemoteEntry: () => ({ assetUrl: 'https://verified.example/notes.zip', assetSha256: 'digest', version: '2.0.0', name: 'Notes' })
  }
  const api = await load({ registry, enabledChanges: [], window: { isDestroyed: () => false } })
  state.confirm = async () => false
  assert.equal((await api.runHomeAction({ type: 'uninstallPlugin', pluginId: 'notes' }, context())).error, 'cancelled')
  assert.deepEqual(state.uninstalls, [])
  state.confirm = async () => { current = false; return true }
  assert.equal((await api.runHomeAction({ type: 'setPluginEnabled', pluginId: 'notes', enabled: false }, context(() => current))).error, 'home surface retired')
  assert.deepEqual(state.enabledChanges, [])
  assert.deepEqual(state.closed, [])
  current = true
  state.confirm = null
  assert.equal((await api.runHomeAction({ type: 'setPluginEnabled', pluginId: 'notes', enabled: false }, context())).ok, true)
  assert.deepEqual(state.enabledChanges, [['notes', false]])
  assert.deepEqual(state.closed, ['notes'])
  assert.deepEqual(state.cancelledTasks, ['notes'])
  assert.deepEqual(state.blocks, state.releases)
  assert.equal((await api.runHomeAction({ type: 'updatePlugin', pluginId: 'notes' }, context())).ok, true)
  assert.deepEqual(state.queue[0].meta.identity, { id: 'notes', version: '2.0.0' })
  assert.equal((await api.runHomeAction({ type: 'uninstallPlugin', pluginId: 'notes' }, context())).ok, true)
  assert.deepEqual(state.uninstalls, ['notes'])
  assert.deepEqual(state.clearedLaunch, ['notes'])
  assert.ok(state.confirmations.every(({ owner, request }) => owner.id === 11 && request.kind === 'confirm' && request.options.confirmLabel === '继续'))
  assert.equal(state.confirmations.at(-1).request.options.danger, true)
})

test('host action failures expose fixed public errors while diagnostic details remain in the host log', async () => {
  const detail = 'EACCES /Users/private/plugin https://account:secret@example.invalid/private'
  const registry = { get: id => ({ id, name: 'Notes', installed: true, enabled: true }) }
  const api = await load({
    registry,
    commands: [{ kind: 'app', title: 'App', path: '/Applications/Fixture.app' }],
    launchResult: { ok: false, error: detail },
    uninstallResult: { ok: false, error: detail },
    scanResult: { complete: false, errors: [detail] },
    appLaunchError: new Error(detail)
  })
  const replies = []
  replies.push(await api.runHomeAction({ type: 'openPlugin', pluginId: 'notes' }, context()))
  replies.push(await api.runHomeAction({ type: 'uninstallPlugin', pluginId: 'notes' }, context()))
  replies.push(await api.runHomeAction({ type: 'refreshApps' }, context()))
  const result = await api.searchHome({ query: 'App', scope: 'app' }, context())
  replies.push(await api.runHomeAction({ type: 'activateSearchResult', handle: result.items[0].handle }, context()))
  assert.deepEqual(replies, Array.from({ length: 4 }, () => ({ ok: false, error: 'home operation failed' })))
  assert.doesNotMatch(JSON.stringify(replies), /Users|private|secret|account|EACCES/)
  assert.equal(state.logs.filter(args => args.join(' ').includes(detail)).length, 4)
  state.launchResult = { ok: false, error: detail, cancelled: true }
  assert.deepEqual(await api.runHomeAction({ type: 'openPlugin', pluginId: 'notes' }, context()), { ok: false, error: 'cancelled' })
})

test('nested install rejections are caught before their private host message can escape the action promise', async () => {
  const detail = 'ENOENT /Users/private/archive.zip?token=secret'
  const registry = {
    get: id => ({ id, name: 'Notes', installed: false }),
    getRemoteEntry: () => { throw new Error(detail) }
  }
  const api = await load({ registry })
  const result = await api.runHomeAction({ type: 'installPlugin', pluginId: 'notes' }, context())
  assert.deepEqual(result, { ok: false, error: 'home operation failed' })
  assert.doesNotMatch(JSON.stringify(result), /Users|private|secret|ENOENT/)
  assert.ok(state.logs.some(args => args.join(' ').includes(detail)))
})

function homeCardRegistry(cards) {
  const summary = { id: 'notes', name: 'Notes', installed: true, enabled: true }
  const manifests = { notes: { id: 'notes', contributes: { homeCards: cards } } }
  const revision = { value: 'build-1' }
  return {
    summary, manifests, revision,
    registry: {
      list: () => [summary],
      get: id => id === summary.id ? summary : null,
      getManifest: id => manifests[id] ?? null,
      getBuildRevision: () => revision.value,
      getCatalogResources: () => ({ screenshots: [] })
    }
  }
}

test('home cards publish bounded presentation fields without manifest payloads or launch codes', async () => {
  const fixture = homeCardRegistry([
    { id: 'main', title: 'Notes', glyph: 'N', color: '#123456', explain: 'Open notes', openCode: 'private-code', path: '/private', payload: { secret: true } },
    { id: 'future', title: 'Future', schemaVersion: '2' },
    { id: 'control', title: 'Bad\nTitle' },
    { id: 'long', title: 'x'.repeat(129) },
    { id: 'duplicate', title: 'First' },
    { id: 'duplicate', title: 'Second' },
    { id: 'optional', title: 'Optional', glyph: 'LONG', color: 'url(file:///private)', explain: 'Bad\nText' }
  ])
  const api = await load({ registry: fixture.registry })
  const catalog = await api.getHomeCatalog()
  assert.deepEqual(catalog.items[0].homeCards, [
    { id: 'main', title: 'Notes', glyph: 'N', color: '#123456', explain: 'Open notes' },
    { id: 'optional', title: 'Optional' }
  ])
  assert.doesNotMatch(JSON.stringify(catalog), /private|openCode|payload|file:/)
  assert.equal('homeCards' in await api.getHomeDetail('notes'), false)
  fixture.manifests.notes.contributes.homeCards = Array.from({ length: 20 }, (_, index) => ({ id: `card-${index}`, title: `Card ${index}` }))
  assert.equal((await api.getHomeCatalog()).items[0].homeCards.length, 16)
  fixture.summary.enabled = false
  assert.deepEqual((await api.getHomeCatalog()).items[0].homeCards, [])
  fixture.summary.enabled = true
  fixture.summary.installed = false
  assert.deepEqual((await api.getHomeCatalog()).items[0].homeCards, [])
})

test('home card actions resolve the current source declaration and reject renderer-selected launch data', async () => {
  const fixture = homeCardRegistry([{ id: 'same-id', title: 'Notes', openCode: 'notes-entry' }])
  const other = { id: 'other', name: 'Other', installed: true, enabled: true }
  fixture.manifests.other = { id: 'other', contributes: { homeCards: [{ id: 'same-id', title: 'Other', openCode: 'other-entry' }] } }
  fixture.registry.get = id => id === 'notes' ? fixture.summary : id === 'other' ? other : null
  const api = await load({ registry: fixture.registry })
  const action = { type: 'openHomeCard', pluginId: 'other', cardId: 'same-id' }
  assert.deepEqual(await api.runHomeAction(action, context()), { ok: true })
  assert.equal(state.launches[0].pluginId, 'other')
  assert.deepEqual(state.launches[0].enter, { code: 'other-entry' })
  assert.equal(state.launches[0].mode, 'shell')
  for (const extra of [{ openCode: 'attacker' }, { code: 'attacker' }, { payload: {} }]) {
    assert.equal((await api.runHomeAction({ ...action, ...extra }, context())).ok, false)
  }
  fixture.manifests.other.contributes.homeCards = []
  assert.equal((await api.runHomeAction(action, context())).ok, false)
  assert.equal(state.launches.length, 1)
})

test('pending home card launches retire with their source, manifest, build or declaration', async () => {
  for (const mutation of ['source', 'disabled', 'manifest', 'build', 'card-code', 'removed']) {
    const fixture = homeCardRegistry([{ id: 'main', title: 'Notes', openCode: 'original' }])
    let current = true, release
    const launchWait = new Promise(resolve => { release = resolve })
    const api = await load({ registry: fixture.registry, launchWait })
    const result = api.runHomeAction({ type: 'openHomeCard', pluginId: 'notes', cardId: 'main' }, context(() => current))
    assert.equal(state.launchRequests.length, 1)
    if (mutation === 'source') current = false
    else if (mutation === 'disabled') fixture.summary.enabled = false
    else if (mutation === 'manifest') fixture.manifests.notes = { ...fixture.manifests.notes }
    else if (mutation === 'build') fixture.revision.value = 'build-2'
    else if (mutation === 'card-code') fixture.manifests.notes.contributes.homeCards[0].openCode = 'changed'
    else fixture.manifests.notes.contributes.homeCards = []
    release()
    assert.equal((await result).ok, false, mutation)
    assert.deepEqual(state.launches, [], mutation)
    assert.deepEqual(state.visibility, [], mutation)
  }
})

test('a committed home launch may deactivate its source without hiding a replacement workspace', async () => {
  const fixture = homeCardRegistry([{ id: 'main', title: 'Notes' }])
  let current = true
  const api = await load({ registry: fixture.registry, onLaunch: () => { current = false } })
  assert.deepEqual(await api.runHomeAction({ type: 'openHomeCard', pluginId: 'notes', cardId: 'main' }, context(() => current)), { ok: true })
  assert.deepEqual(state.visibility, [])
  current = true
  state.onLaunch = null
  state.launchResult = { ok: false, error: '/private/launch-error' }
  assert.equal((await api.runHomeAction({ type: 'openHomeCard', pluginId: 'notes', cardId: 'main' }, context())).ok, false)
  assert.deepEqual(state.visibility, [])
  state.launchResult = { ok: true }
  assert.deepEqual(await api.runHomeAction({ type: 'openPlugin', pluginId: 'notes' }, context()), { ok: true })
  assert.equal(typeof state.launchRequests.at(-1).guard, 'function')
})
