import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const root = fileURLToPath(new URL('../../../', import.meta.url))

const adapters = {
  fixture: `export const f={views:[],children:new Set(),raised:0,transients:0,appearances:[],commands:[],snapshotCalls:0,recoveries:[],retryRecoveries:0}; export const resetFixture=()=>{f.views.length=0;f.children.clear();f.raised=0;f.transients=0;f.appearances.length=0;f.commands.length=0;f.snapshotCalls=0;f.recoveries.length=0;f.retryRecoveries=0};`,
  electron: `import {EventEmitter} from 'node:events'; import {f} from 'fixture';
    let ids=0;
    class WC extends EventEmitter {
      id=++ids; destroyed=false; sent=[]; loads=[];
      loadFile(path){this.loads.push(path);if(!f.holdLoad)queueMicrotask(()=>this.__finish(path));return Promise.resolve()}
      loadURL(url){this.loads.push(url);if(!f.holdLoad)queueMicrotask(()=>this.__finish(url));return Promise.resolve()}
      __finish(url){this.__url=url;this.emit('did-finish-load')}
      isDestroyed(){return this.destroyed}
      send(channel,payload){this.sent.push({channel,payload});if(payload?.appearance)f.appearances.push(payload.appearance);if(payload?.command)f.commands.push(payload.command); return true}
      close(){if(this.destroyed)return;this.destroyed=true;this.emit('destroyed');this.removeAllListeners()}
    }
    export const app={getAppPath:()=>'/app'};
    class Session extends EventEmitter { constructor(partition){super();this.partition=partition} setPermissionRequestHandler(){} }
    export const session={fromPartition:partition=>new Session(partition)};
    export class WebContentsView{
      constructor(options={}){this.webContents=new WC();this.webContents.session=options.webPreferences?.session;f.views.push(this);this.visible=true;this.bounds={}}
      setVisible(value){this.visible=value}
      setBounds(bounds){this.bounds=bounds}
    }`,
  '@shared/types/ipc': `export const IpcChannels={HomeEvent:'home:event'};`,
  '@main/ipc/ipcSecurity': `export const registerTrustedSurface=()=>{}; export const revokeTrustedSurface=()=>{};`,
  '@main/window/createShellWindow': `import {f} from 'fixture'; let sink=null; export const getMainWindow=()=>({isDestroyed:()=>false,contentView:{addChildView:v=>f.children.add(v),removeChildView:v=>f.children.delete(v)}}); export const getShellBounds=()=>({x:0,y:0,width:1000,height:700}); export const getPluginTopInset=()=>f.topInset??0; export const resolvePreload=x=>x; export const sendShellEvent=()=>{}; export const setHomeEventSink=next=>{sink=next}; export const __emitHomeShellEvent=payload=>sink?.(payload);`,
  shellWindow: `import {f} from 'fixture'; let sink=null; export const getMainWindow=()=>({isDestroyed:()=>false,contentView:{addChildView:v=>f.children.add(v),removeChildView:v=>f.children.delete(v)}}); export const getShellBounds=()=>({x:0,y:0,width:1000,height:700}); export const getPluginTopInset=()=>f.topInset??0; export const resolvePreload=x=>x; export const sendShellEvent=()=>{}; export const setHomeEventSink=next=>{sink=next}; export const __emitHomeShellEvent=payload=>sink?.(payload);`,
  '@main/window/orbRailViews': `import {f} from 'fixture'; export const raiseOrbRailViews=()=>{f.raised++}; export const refreshOrbRailContribEntries=()=>{};`,
  '@main/window/transientViews': `import {f} from 'fixture'; export const raiseTransientViews=()=>{f.transients++};`,
  '@main/logs/logService': `export const logInfo=()=>{}; export const logWarn=()=>{};`,
  '@main/contrib/ContributionRegistry': `export const contributionRegistry={listSlot:()=>[]};`,
  '@main/paths/pathsService': `export const getAppPaths=()=>({themes:'/tmp'}); export const setAppPathsRoot=()=>{};`,
  '@main/theme/resolveThemeCss': `export const resolveThemeTokens=()=>({mode:'light',tokens:{}});`,
  '@main/theme/appearanceService': `import {f} from 'fixture'; let snapshot={appearance:{version:2,revision:0,home:{source:'enest.builtin',id:'home',variant:'default'}},profile:{},packs:[],customFonts:[]}; export const __setSnapshot=next=>{snapshot=next}; export const appearanceService={getAppearanceSnapshot:()=>{f.snapshotCalls++;return snapshot}}; export const getAppearance=()=>snapshot.appearance;`,
  appearanceAdapter: `import {f} from 'fixture'; let snapshot={appearance:{version:2,revision:0,home:{source:'enest.builtin',id:'home',variant:'default'}},profile:{},packs:[],customFonts:[]}; const listeners=new Set(); export const __setSnapshot=next=>{snapshot=next;for(const fn of listeners)fn(next)}; export const appearanceService={getAppearanceSnapshot:()=>{f.snapshotCalls++;return snapshot},subscribeAppearance:fn=>{listeners.add(fn);return()=>listeners.delete(fn)},isActiveThemeAvailable:()=>true,recoverToBuiltin:async message=>{f.recoveries.push(message)},hasRecovery:()=>Boolean(snapshot.recovery),retryRecovery:async()=>{f.retryRecoveries++}}; export const getAppearance=()=>snapshot.appearance;`,
  fixtureRegistry: `import {f} from 'fixture'; export let resolveHomePage=async()=>{if(f.registryGate)await f.registryGate;return {contribution:{source:'enest.builtin',id:'home',version:1,entry:'home.html',variants:['default']},rootPath:'/renderer',entryPath:'/renderer/home.html'}}; export const __usePluginPage=()=>{resolveHomePage=async()=>({contribution:{source:'com.plugin.demo',id:'home',version:1,entry:'home.html',variants:['default']},rootPath:'/plugins/demo',entryPath:'/plugins/demo/home.html'})};`,
  '@main/plugin/PluginHost': `export const pluginHost={openPlugin:async()=>{}};`,
  '@main/plugin/PluginRegistry': `export const pluginRegistry={get:()=>null,getMarketStatus:async()=>({state:'offline'}),list:()=>[],getRemoteEntry:()=>null,refreshRemoteMarket:async()=>({})};`,
  '@main/plugin/installQueue': `export const enqueueInstallFromUrl=async()=>({id:'mock'});`,
  '@main/launcher/commandIndex': `export const searchQuickCommands=async()=>([]);`,
  '@main/settings/SettingsStore': `export const settingsStore={getAll:()=>({general:{} })};`,
  './homeDataService': `export const getHomeAppearanceSnapshot=appearance=>({appearance});`,
  './homeSessionPolicy': `import {session} from 'electron'; export const homeEntryUrl=()=> 'enest-home://surface/home.html'; export const createHomeSession=(_page,generation)=>session.fromPartition('home-test-'+generation); export const disposeHomeSession=async()=>{};`,
  './homeRegistry': `export let resolveHomePage=async()=>({contribution:{source:'enest.builtin',id:'home',version:1,entry:'home.html',variants:['default']},rootPath:'/renderer',entryPath:'/renderer/home.html'});
    export const __usePluginPage=()=>{resolveHomePage=async()=>({contribution:{source:'com.plugin.demo',id:'home',version:1,entry:'home.html',variants:['default']},rootPath:'/plugins/demo',entryPath:'/plugins/demo/home.html'})};`,
  './homeSecurity': `export const parseHomeReference=value=>value; export const isInsideDirectory=()=>true;`,
  './homeContract': `export const BUILT_IN_HOME_SOURCE='enest.builtin'; export const BUILT_IN_HOME_ID='home'; export const BUILT_IN_HOME_VARIANTS=['default']; export const validateHomeContribution=()=>null;`,
  './userPath': `export const resolveLocalUserPath=()=>'/tmp';`,
}
const electronAdapter = adapters.electron

async function fixture() {
  adapters.electron = electronAdapter
  const result = await build({
    stdin: { contents: `import * as registry from 'fixtureRegistry'; import * as appearanceAdapter from '@main/theme/appearanceService'; import * as shellWindow from '@main/window/createShellWindow'; import {resetFixture} from 'fixture'; export {HomeSurfaceManager,homeSurfaceManager,setHomeSurfaceVisible,prewarmHomeSurface,retryHomeSurface,destroyHomeSurface,normalizeWorkspaceRoute} from '@main/home/HomeSurfaceManager'; export {IpcChannels} from '@shared/types/ipc'; export const __appearanceService=appearanceAdapter.appearanceService; export const __usePluginPage=registry.__usePluginPage; export const __setAppearance=snapshot=>appearanceAdapter.__setSnapshot(snapshot); export const __emitHomeShellEvent=payload=>shellWindow.__emitHomeShellEvent(payload); export const __resetFixture=resetFixture; export {f} from 'fixture'; export const nonce=${Math.random()};`, resolveDir: root, sourcefile: 'home-manager-fixture.js' },
    bundle: true, write: false, format: 'esm', platform: 'node', tsconfig: `${root}/tsconfig.node.json`,
    plugins: [{ name: 'home-fixture', setup(builder) {
      builder.onResolve({ filter: /.*/ }, ({ path, importer }) => {
        if (path === '@main/home/homeRegistry' || path === './homeRegistry') return { path: 'fixtureRegistry', namespace: 'fixture' }
        if (path === '@main/window/createShellWindow') return { path: 'shellWindow', namespace: 'fixture' }
        if (path === '@main/theme/appearanceService') return { path: 'appearanceAdapter', namespace: 'fixture' }
        return path in adapters ? { path, namespace: 'fixture' } : undefined
      })
      builder.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'fixture' }))
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({ contents: adapters[path], loader: 'js' }))
    } }]
  })
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`)
}

const shellHandlersText = readFileSync(new URL('../ipc/shellHandlers.ts', import.meta.url), 'utf8')
const shellHandlersSource = ts.transpileModule(shellHandlersText, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText
const shellImports = ts.createSourceFile('shellHandlers.ts', shellHandlersText, ts.ScriptTarget.ES2022)
  .statements.filter(ts.isImportDeclaration).map(statement => statement.moduleSpecifier.text)

function workspaceShell(api) {
  const handlers = new Map(), events = []
  const orb = { projections: [], visibility: [], writes: [] }
  const sender = { id: 'main-shell' }
  let pluginLayouts = 0
  let hidden = 0
  // Register the real shell handlers; unrelated capability imports stay inert.
  const imports = Object.fromEntries(shellImports.map(name => [name, {}]))
  Object.assign(imports, {
    '@shared/types/ipc': { IpcChannels: new Proxy({}, { get: (_target, channel) => channel }) },
    '@main/ipc/ipcSecurity': { handleShellIpc: (channel, listener) => handlers.set(channel, listener), onShellIpc() {} },
    '@main/ipc/shortcutHandlers': { registerShortcutHandlers() {} },
    '@main/home/HomeSurfaceManager': api,
    '@main/home/workspaceRoute': { normalizeWorkspaceRoute: api.normalizeWorkspaceRoute },
    '@main/plugin/PluginHost': { pluginHost: { hideAllViews: () => { hidden++ }, layoutAll: () => { pluginLayouts++ } } },
    '@main/window/createShellWindow': {
      sendShellEvent: event => events.push(event), getMainWindow: () => ({ isDestroyed: () => false }),
      getShellWebContents: () => sender, setPluginTopInset: value => { api.f.topInset = value },
    },
    '@main/theme/appearanceService': { appearanceService: {
      subscribeAppearance() {},
      getAppearance: () => api.__appearanceService.getAppearanceSnapshot().appearance,
      updateThemeProfile: patch => orb.writes.push(['profile', patch]),
    } },
    '@main/settings/SettingsStore': { settingsStore: {
      setAll: patch => orb.writes.push(['settings', patch]),
      commitAppearanceSettings: value => orb.writes.push(['appearance', value]),
    } },
    '@main/window/orbRailViews': {
      setOrbRailState: state => orb.projections.push(structuredClone(state)),
      applyOrbRailVisibility: style => orb.visibility.push(style),
    },
  })
  const module = { exports: {} }
  new Function('require', 'module', 'exports', shellHandlersSource)(name => {
    assert.ok(Object.hasOwn(imports, name), `Unexpected shell handler import: ${name}`)
    return imports[name]
  }, module, module.exports)
  module.exports.registerShellHandlers()
  return {
    events,
    orb,
    get hidden() { return hidden },
    get pluginLayouts() { return pluginLayouts },
    syncTitlebar: (top, owner = sender) => handlers.get('ShellSetPluginTopInset')({ sender: owner }, top),
    navigate: route => handlers.get('ShellNavigateWorkspace')({}, route),
    syncOrbState: state => handlers.get('ShellSyncOrbState')({}, state),
  }
}

function appearance(revision = 1) {
  return {
    version: 2,
    revision,
    theme: { source: 'enest.builtin', id: 'home', name: 'Warm', version: 1, legacy: false },
    requestedMode: 'light',
    mode: 'light',
    home: { source: 'enest.builtin', id: 'home', variant: 'default' },
    tokens: {}, fonts: {}, components: {}, background: {}, layout: {}, animation: {}, diagnostics: []
  }
}

function appearanceVariant(revision, variant) {
  return { ...appearance(revision), home: { source: 'enest.builtin', id: 'home', variant }, layout: { variant } }
}

function snapshot(appearance) {
  return { appearance, profile: {}, packs: [], customFonts: [] }
}

async function firstLoadDelay() {
  await new Promise(resolve => setTimeout(resolve, 5))
}

function navigationFor(view) {
  return view.webContents.sent.filter(item => item.payload?.command?.type === 'navigate').at(-1)?.payload.command
}

function acknowledge(manager, view, command = navigationFor(view), ok = true) {
  manager.handleNavigationAck(view.webContents.id, { generation: command.generation, requestId: command.requestId, ok })
}

async function bootWorkspace(api, manager, revision = 1) {
  const pending = manager.prepare(appearance(revision))
  await firstLoadDelay()
  const view = api.f.views.at(-1)
  manager.handleReady(view.webContents.id, { revision, workspaceVersion: 1, routes: ['catalog', 'installed', 'detail'] })
  await Promise.resolve()
  acknowledge(manager, view)
  const transaction = await pending
  transaction.commit()
  return view
}

test('titlebar IPC relayouts native Home and plugin views without covering the top reveal strip', async () => {
  const api = await fixture()
  const manager = api.homeSurfaceManager
  const shell = workspaceShell(api)
  try {
    const view = await bootWorkspace(api, manager)
    api.__setAppearance(snapshot({ ...appearance(), layout: { tabStyle: 'classic', tabAutoHide: true } }))
    assert.equal(view.bounds.y, 36)
    shell.syncTitlebar(28)
    assert.equal(view.bounds.y, 8)
    assert.equal(view.bounds.height, 692)
    assert.equal(shell.pluginLayouts, 1)
    shell.syncTitlebar(0)
    assert.equal(view.bounds.y, 36)
    assert.throws(() => shell.syncTitlebar(28, {}), /Main shell required/)
    for (const value of [NaN, Infinity, '28']) assert.throws(() => shell.syncTitlebar(value), /Invalid titlebar inset/)
    api.__setAppearance(snapshot({ ...appearance(), layout: { tabStyle: 'orb', tabAutoHide: true } }))
    shell.syncTitlebar(28)
    assert.equal(view.bounds.y, 36)
  } finally { manager.destroy() }
})

test('preparing Home views use the same titlebar inset as the committed view', async () => {
  const api = await fixture()
  const manager = new api.HomeSurfaceManager(500)
  const current = await bootWorkspace(api, manager)
  api.__usePluginPage()
  const candidate = { ...appearance(2), home: { source: 'com.plugin.demo', id: 'home', variant: 'default' } }
  const pending = manager.prepare(candidate)
  await firstLoadDelay()
  const preparing = api.f.views.at(-1)
  api.f.topInset = 28
  manager.layout()
  assert.equal(current.bounds.y, 8)
  assert.equal(preparing.bounds.y, 8)
  manager.handleReady(preparing.webContents.id, { revision: 2, workspaceVersion: 1, routes: ['catalog', 'installed', 'detail'] })
  await Promise.resolve()
  acknowledge(manager, preparing)
  ;(await pending).rollback()
  manager.destroy()
})

test('prepare loads hidden, ready gates reveal, commit swaps atomically, and rollback retires', async () => {
  const api = await fixture()
  const manager = new api.HomeSurfaceManager(50)
  const firstPromise = manager.prepare(appearance(1))
  await new Promise(resolve => setTimeout(resolve, 5))
  manager.handleReady(api.f.views[0].webContents.id, { revision: 1 })
  const first = await firstPromise
  assert.equal(api.f.children.size, 1)
  assert.equal(api.f.views[0].visible, false)
  manager.setVisible(true)
  assert.equal(api.f.views[0].visible, false, 'ready handshake must gate first paint')
  manager.handleReady(api.f.views[0].webContents.id, { revision: 1 })
  assert.equal(api.f.views[0].visible, false, 'uncommitted prepare remains hidden')
  first.commit()
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(api.f.views[0].visible, true)
  assert.equal(api.f.raised, 1)
  assert.equal(api.f.transients, 1)

  const second = await manager.prepare(appearance(2))
  assert.equal(api.f.views.length, 1, 'appearance-only update preserves the runtime')
  assert.equal(manager.getAppearanceForContents(api.f.views[0].webContents.id).appearance.revision, 1, 'uncommitted candidates stay private')
  second.rollback()
  assert.equal(manager.getAppearanceForContents(api.f.views[0].webContents.id).appearance.revision, 1)
  assert.equal(api.f.views[0].webContents.isDestroyed(), false)
  assert.equal(api.f.children.has(api.f.views[0]), true)
  assert.equal(api.f.views[0].visible, true, 'current runtime survives rollback')
  manager.destroy()
  assert.equal(api.f.views[0].webContents.isDestroyed(), true)
})

test('a failed load never attaches a visible runtime and a crashed current runtime is retired', async () => {
  const api = await fixture()
  const manager = new api.HomeSurfaceManager(50)
  api.f.holdLoad = true
  const transactionPromise = manager.prepare(appearance(1))
  await new Promise(resolve => setTimeout(resolve, 1))
  const view = api.f.views[0]
  const rejection = assert.rejects(transactionPromise, /aborted/)
  view.webContents.emit('did-fail-load', {}, -3, 'aborted')
  await rejection
  assert.equal(view.visible, false)
  assert.equal(view.webContents.isDestroyed(), true)
  assert.equal(api.f.children.size, 0)

  api.f.holdLoad = false
  const nextPromise = manager.prepare(appearance(1))
  await new Promise(resolve => setTimeout(resolve, 0))
  await new Promise(resolve => setTimeout(resolve, 5))
  manager.handleReady(api.f.views[1].webContents.id, { revision: 1 })
  const next = await nextPromise
  manager.handleReady(api.f.views[1].webContents.id, { revision: 1 })
  next.commit()
  api.f.views[1].webContents.emit('render-process-gone')
  assert.equal(api.f.views[1].webContents.isDestroyed(), true)
  assert.equal(manager.isContentsActive(api.f.views[1].webContents.id), false)
})




test('plugin home contributions load their registered entry and remain isolated', async () => {
  const api = await fixture()
  const manager = new api.HomeSurfaceManager(50)
  api.__usePluginPage()
  const transactionPromise = manager.prepare(appearance(3))
  await new Promise(resolve => setTimeout(resolve, 5))
  const view = api.f.views.at(-1)
  manager.handleReady(view.webContents.id, { revision: 3 })
  const transaction = await transactionPromise
  assert.equal(view.webContents.loads[0], 'enest-home://surface/home.html')
  transaction.rollback()
  assert.equal(view.webContents.isDestroyed(), true)
})

test('appearance-only changes reuse the runtime and publish a newer revision over IPC', async () => {
  const api = await fixture()
  const manager = new api.HomeSurfaceManager(50)
  const firstPromise = manager.prepare(appearanceVariant(1, 'default'))
  await new Promise(resolve => setTimeout(resolve, 5))
  manager.handleReady(api.f.views[0].webContents.id, { revision: 1 })
  const first = await firstPromise
  first.commit()
  const nextAppearance = appearanceVariant(2, 'default')
  api.__setAppearance(snapshot(nextAppearance))
  const second = await manager.prepare(nextAppearance)
  second.commit()
  const appearanceCount = api.f.appearances.length

  assert.equal(api.f.views.length, 1, 'the same home runtime must preserve page state')
  assert.equal(api.f.views[0].webContents.isDestroyed(), false)
  assert.ok(api.f.appearances.length >= appearanceCount)
  assert.equal(api.f.snapshotCalls, 0, 'runtime candidates must not depend on persisted appearance')
  manager.destroy()
})

test('provider replacement resolves only after the ready handshake', async () => {
  const api = await fixture()
  const manager = new api.HomeSurfaceManager(200)
  const transactionPromise = manager.prepare(appearanceVariant(4, 'default'))
  await new Promise(resolve => setTimeout(resolve, 10))
  const view = api.f.views[0]
  const settled = Promise.resolve(transactionPromise).then(() => 'settled')
  await Promise.race([settled, new Promise(resolve => setTimeout(() => resolve('timeout'), 20))]).then(value => {
    assert.equal(value, 'timeout', 'load completion alone must not satisfy prepare')
  })
  manager.handleReady(view.webContents.id, { revision: 4 })
  const transaction = await transactionPromise
  transaction.commit()
  assert.equal(view.webContents.sent.filter(item => item.payload?.appearance).length, 1, 'committed appearance is sent after the runtime becomes current')
  assert.equal(api.f.snapshotCalls, 0, 'runtime candidate—not the persisted snapshot—must be exposed')
  manager.destroy()
})

test('install and catalog shell events are translated to current home commands', async () => {
  const api = await fixture()
  {
    const manager = api.homeSurfaceManager
    const transactionPromise = manager.prepare(appearanceVariant(5, 'default'))
    await new Promise(resolve => setTimeout(resolve, 5))
    manager.handleReady(api.f.views[0].webContents.id, { revision: 5 })
    const transaction = await transactionPromise
    transaction.commit()
    assert.equal(manager.hasCurrent, true)
    api.__emitHomeShellEvent({ type: 'install-progress', jobId: 'job-1', name: 'demo', progress: 42, step: 'downloading' })
    api.__emitHomeShellEvent({ type: 'install-result', jobId: 'job-1', name: 'demo', ok: true })
    api.__emitHomeShellEvent({ type: 'plugins-changed' })
    const commands = api.f.commands.filter(command => command.type === 'install' || command.type === 'refresh')
    assert.equal(commands.length, 3)
    assert.deepEqual(commands, [
      { type: 'install', jobId: 'job-1', name: 'demo', status: 'progress', progress: 42, error: '正在安装' },
      { type: 'install', jobId: 'job-1', name: 'demo', status: 'done', error: undefined },
      { type: 'refresh', reason: 'boot', revision: commands[2].revision }
    ])
    manager.destroy()
  }
})

test('Home install commands retain useful state without exposing raw steps, errors or filesystem names', async () => {
  const api = await fixture()
  const manager = api.homeSurfaceManager
  const pending = manager.prepare(appearanceVariant(7, 'default'))
  await firstLoadDelay()
  manager.handleReady(api.f.views[0].webContents.id, { revision: 7 })
  const transaction = await pending
  transaction.commit()
  const privateMessage = 'EACCES /Users/private/plugin https://account:secret@example.invalid/archive'
  const progress = { type: 'install-progress', jobId: 'job-2', name: 'demo', progress: 63, step: privateMessage }
  const failure = { type: 'install-result', jobId: 'job-2', name: 'demo', ok: false, error: privateMessage }
  api.__emitHomeShellEvent(progress)
  api.__emitHomeShellEvent(failure)
  api.__emitHomeShellEvent({ ...progress, jobId: '/private/job', name: '/private/archive.zip', progress: Infinity })
  const commands = api.f.commands.filter(command => command.type === 'install')
  assert.deepEqual(commands, [
    { type: 'install', jobId: 'job-2', name: 'demo', status: 'progress', progress: 63, error: '正在安装' },
    { type: 'install', jobId: 'job-2', name: 'demo', status: 'error', error: '安装失败，请在宿主查看详情' },
    { type: 'install', jobId: undefined, name: '插件', status: 'progress', progress: 0, error: '正在安装' }
  ])
  assert.equal(progress.step, privateMessage)
  assert.equal(failure.error, privateMessage, 'the trusted host event keeps its diagnostic detail')
  assert.doesNotMatch(JSON.stringify(commands), /private|secret|account|EACCES/)
  manager.destroy()
})

test('loaded home without ready times out and cleans up its contents identity', async () => {
  const api = await fixture()
  const manager = new api.HomeSurfaceManager(20)
  await assert.rejects(manager.prepare(appearance(8)), /ready handshake timed out/)
  assert.equal(api.f.children.size, 0)
  assert.equal(manager.getContentsGeneration(api.f.views[0].webContents.id), null)
})

test('replacing or destroying a preparing home settles its pending ready promise', async () => {
  const api = await fixture()
  const manager = new api.HomeSurfaceManager(100)
  const first = manager.prepare(appearance(9))
  const rejected = assert.rejects(first, /retired/)
  await firstLoadDelay()
  manager.destroy()
  await rejected
  assert.equal(api.f.children.size, 0)
})

test('workspace initialization requires both declared routes and an owner-bound navigation acknowledgement', async () => {
  const api = await fixture()
  const manager = new api.HomeSurfaceManager(100)
  manager.setVisible(true)
  const pending = manager.prepare(appearance(10))
  await firstLoadDelay()
  const view = api.f.views[0]
  manager.handleReady(view.webContents.id, { revision: 10, workspaceVersion: 1, routes: ['catalog'] })
  await Promise.resolve()
  const navigation = navigationFor(view)
  assert.deepEqual(navigation.route, { page: 'catalog' })
  assert.equal(view.visible, false)
  let prepared = false
  void pending.then(() => { prepared = true })
  for (const [wcId, payload] of [
    [view.webContents.id + 1, { generation: navigation.generation, requestId: navigation.requestId, ok: true }],
    [view.webContents.id, { generation: navigation.generation + 1, requestId: navigation.requestId, ok: true }],
    [view.webContents.id, { generation: navigation.generation, requestId: 'stale', ok: true }]
  ]) manager.handleNavigationAck(wcId, payload)
  await Promise.resolve()
  assert.equal(prepared, false)
  acknowledge(manager, view)
  const transaction = await pending
  assert.equal(view.visible, false)
  transaction.commit()
  assert.equal(view.visible, true)
  assert.deepEqual(manager.getState().route, { page: 'catalog' })
  manager.destroy()
})

test('route acknowledgement grants visibility and stale requests cannot change it', async () => {
  const api = await fixture()
  const manager = new api.HomeSurfaceManager(100)
  const view = await bootWorkspace(api, manager)
  manager.setVisible(true)
  const pending = manager.navigate({ page: 'detail', pluginId: 'notes' })
  const navigation = navigationFor(view)
  assert.equal(view.visible, false)
  acknowledge(manager, view, { ...navigation, requestId: 'retired' })
  assert.equal(view.visible, false)
  acknowledge(manager, view)
  await pending
  assert.equal(view.visible, true)
  const state = manager.getState()
  state.route.pluginId = 'mutated'
  assert.equal(manager.getState().route.pluginId, 'notes')
  const installed = manager.navigate({ page: 'installed' })
  acknowledge(manager, view)
  await installed
  assert.equal(view.visible, true)
  assert.deepEqual(manager.getState().route, { page: 'installed' })
  manager.destroy()
})

test('a navigation timeout exposes trusted recovery and ordinary visibility cannot reveal the failed surface', async () => {
  const api = await fixture()
  const manager = new api.HomeSurfaceManager(25)
  const view = await bootWorkspace(api, manager)
  manager.setVisible(true)
  const pending = manager.navigate({ page: 'detail', pluginId: 'notes' })
  await assert.rejects(pending, /navigation timed out/)
  assert.equal(view.visible, false)
  assert.equal(manager.getState().recovery, true)
  manager.setVisible(true)
  assert.equal(view.visible, false)
  await manager.navigate({ page: 'catalog' })
  assert.equal(view.visible, true)
  assert.equal(manager.getState().recovery, false)
  manager.suspendForRecovery()
  manager.setVisible(true)
  assert.equal(view.visible, false)
  manager.destroy()
})

test('legacy home providers retain their catalog and reject retired settings routes', async () => {
  const api = await fixture()
  const manager = new api.HomeSurfaceManager(100)
  const pending = manager.prepare(appearance())
  await firstLoadDelay()
  const view = api.f.views[0]
  manager.handleReady(view.webContents.id, { revision: 1 })
  const transaction = await pending
  transaction.commit()
  manager.setVisible(true)
  assert.equal(view.visible, true)
  await assert.rejects(manager.navigate({ page: 'settings' }), /Invalid workspace route/)
  assert.equal(view.visible, true, 'an invalid route never disturbs the visible surface')
  assert.equal(manager.getState().recovery, false)
  manager.destroy()
})

test('new navigation replaces the old request and late acknowledgements cannot restore the previous route', async () => {
  const api = await fixture()
  const manager = new api.HomeSurfaceManager(100)
  const view = await bootWorkspace(api, manager)
  manager.setVisible(true)
  const detail = manager.navigate({ page: 'detail', pluginId: 'notes' })
  const stale = navigationFor(view)
  const installed = manager.navigate({ page: 'installed' })
  acknowledge(manager, view, stale)
  assert.equal(view.visible, false)
  acknowledge(manager, view)
  await Promise.all([detail, installed])
  assert.deepEqual(manager.getState().route, { page: 'installed' })
  assert.equal(view.visible, true)
  manager.destroy()
})

test('provider changes prepare the current route hidden and keep the previous surface on unsupported routes', async () => {
  const api = await fixture()
  const manager = new api.HomeSurfaceManager(100)
  const previous = await bootWorkspace(api, manager)
  manager.setVisible(true)
  const detail = manager.navigate({ page: 'detail', pluginId: 'notes' })
  acknowledge(manager, previous)
  await detail
  api.__usePluginPage()
  const rejected = manager.prepare(appearance(2))
  await firstLoadDelay()
  const next = api.f.views.at(-1)
  manager.handleReady(next.webContents.id, { revision: 2, workspaceVersion: 1, routes: ['catalog'] })
  await assert.rejects(rejected, /route is unavailable/)
  assert.equal(previous.visible, true)
  assert.equal(previous.webContents.isDestroyed(), false)
  assert.equal(next.visible, false)
  assert.equal(next.webContents.isDestroyed(), true)
  assert.equal(manager.isContentsActive(previous.webContents.id), true)
  manager.destroy()
})

test('retirement cancels navigation promises and malformed routes never alter current visibility', async () => {
  const api = await fixture()
  const manager = new api.HomeSurfaceManager(100)
  const view = await bootWorkspace(api, manager)
  manager.setVisible(true)
  for (const route of [null, { page: 'unknown' }, { page: 'detail', pluginId: '../secret' }, { page: 'settings' }, { page: 'catalog', url: 'file:///secret' }]) {
    await assert.rejects(manager.navigate(route), /Invalid workspace route/)
    assert.equal(view.visible, true)
  }
  const pending = manager.navigate({ page: 'detail', pluginId: 'notes' })
  manager.destroy()
  await assert.rejects(pending, /retired/)
  assert.equal(api.f.children.size, 0)
})

test('settings changes notify the workspace without exposing the host event payload', async () => {
  const api = await fixture()
  const manager = api.homeSurfaceManager
  await bootWorkspace(api, manager)
  api.__emitHomeShellEvent({ type: 'settings-changed', generalKeys: ['dataRoot', 'proxy'] })
  api.__emitHomeShellEvent({ type: 'settings-sections', sections: [{ secret: '/private/config' }] })
  assert.deepEqual(api.f.commands.filter(command => command.type === 'settingsChanged'), [{ type: 'settingsChanged' }, { type: 'settingsChanged' }])
  manager.destroy()
})

test('concurrent retries share one preparation and do not replace each other', async () => {
  const api = await fixture()
  api.__setAppearance(snapshot(appearance()))
  const manager = new api.HomeSurfaceManager(100)
  const first = manager.retry()
  const second = manager.retry()
  assert.equal(first, second)
  await firstLoadDelay()
  assert.equal(api.f.views.length, 1)
  const view = api.f.views[0]
  manager.handleReady(view.webContents.id, { revision: 1, workspaceVersion: 1, routes: ['catalog'] })
  await Promise.resolve()
  acknowledge(manager, view)
  await first
  assert.equal(manager.hasCurrent, true)
  manager.destroy()
})

test('automatic prewarm stays hidden through ready and route ACK, then hands off the same Workspace', async () => {
  const api = await fixture()
  api.__setAppearance(snapshot(appearance()))
  const manager = api.homeSurfaceManager
  const first = api.prewarmHomeSurface()
  const second = api.prewarmHomeSurface()
  assert.equal(first, second, 'automatic requests share the existing startup flight')
  await firstLoadDelay()
  assert.equal(api.f.views.length, 1)
  const view = api.f.views[0]
  assert.equal(view.visible, false)
  manager.handleReady(view.webContents.id, { revision: 1, workspaceVersion: 1, routes: ['catalog'] })
  await Promise.resolve()
  assert.equal(view.visible, false)
  assert.equal(manager.hasCurrent, false, 'ready alone cannot commit an unacknowledged route')
  acknowledge(manager, view)
  await first
  assert.equal(manager.hasCurrent, true)
  assert.equal(view.visible, false, 'prewarm cannot change desired visibility')
  assert.equal(manager.isContentsActive(view.webContents.id), false)

  await manager.navigate({ page: 'catalog' })
  await api.prewarmHomeSurface()
  assert.equal(view.visible, false, 'awaited startup navigation also remains hidden')
  api.setHomeSurfaceVisible(true)
  assert.equal(view.visible, true)
  assert.equal(manager.isContentsActive(view.webContents.id), true)
  assert.equal(api.f.views.length, 1)
  assert.equal(view.webContents.loads.length, 1, 'the Splash handoff cannot reload the prepared Workspace')
  api.destroyHomeSurface()
})

test('startup navigation joins the prewarm commit while concurrent show requests keep one surface', async () => {
  const api = await fixture()
  api.__setAppearance(snapshot(appearance()))
  const manager = api.homeSurfaceManager
  const prepare = manager.prepare.bind(manager)
  let releaseCommit
  const commitGate = new Promise(resolve => { releaseCommit = resolve })
  manager.prepare = async candidate => {
    const transaction = await prepare(candidate)
    await commitGate
    return transaction
  }
  const prewarm = api.prewarmHomeSurface()
  await firstLoadDelay()
  const view = api.f.views[0]
  let navigated = false
  const navigation = manager.navigate({ page: 'installed' }).then(() => { navigated = true })
  api.setHomeSurfaceVisible(true)
  api.setHomeSurfaceVisible(true)
  assert.equal(api.prewarmHomeSurface(), prewarm)
  manager.handleReady(view.webContents.id, { revision: 1, workspaceVersion: 1, routes: ['catalog', 'installed'] })
  await Promise.resolve()
  assert.deepEqual(navigationFor(view).route, { page: 'installed' })
  assert.equal(view.visible, false)
  acknowledge(manager, view)
  await firstLoadDelay()
  assert.equal(navigated, false, 'navigation must not resolve between route ACK and the startup commit')
  assert.equal(manager.hasCurrent, false)
  assert.equal(view.visible, false)

  releaseCommit()
  await Promise.all([prewarm, navigation])
  assert.equal(manager.hasCurrent, true, 'a resolved startup navigation is committed, not merely prepared')
  assert.equal(view.visible, true)
  assert.equal(api.f.views.length, 1)
  assert.equal(view.webContents.loads.length, 1)
  api.destroyHomeSurface()
})

test('navigation during an appearance transaction does not wait for its caller-owned commit', async () => {
  const api = await fixture()
  const manager = new api.HomeSurfaceManager(100)
  const pending = manager.prepare(appearance())
  await firstLoadDelay()
  const view = api.f.views[0]
  const navigation = manager.navigate({ page: 'installed' })
  manager.handleReady(view.webContents.id, { revision: 1, workspaceVersion: 1, routes: ['catalog', 'installed'] })
  await Promise.resolve()
  acknowledge(manager, view)
  await navigation
  assert.equal(manager.hasCurrent, false, 'external transactions retain their own commit boundary')
  const transaction = await pending
  transaction.commit()
  assert.equal(manager.hasCurrent, true)
  assert.equal(view.visible, false)
  manager.destroy()
})

test('shell startup navigation waits for the paired fallback to commit instead of rejecting the first provider', async () => {
  const api = await fixture()
  api.__setAppearance(snapshot(appearance()))
  const manager = api.homeSurfaceManager
  const shell = workspaceShell(api)
  const order = []
  let releaseFallback
  const fallbackGate = new Promise(resolve => { releaseFallback = resolve })
  api.__appearanceService.recoverToBuiltin = async () => {
    order.push('fallback-started')
    await fallbackGate
    const nextAppearance = appearance(2)
    nextAppearance.theme.id = 'default'
    const transaction = await manager.prepare(nextAppearance)
    transaction.commit()
    api.__setAppearance(snapshot(nextAppearance))
    order.push('fallback-committed')
  }
  const prewarm = api.prewarmHomeSurface()
  const navigation = shell.navigate({ page: 'catalog' }).then(() => { order.push('navigation-resolved') })
  let settled = false
  void navigation.then(() => { settled = true }, () => { settled = true })
  await firstLoadDelay()
  api.f.views[0].webContents.close()
  await firstLoadDelay()
  assert.deepEqual(order, ['fallback-started'])
  assert.equal(settled, false, 'the original ready failure is not the final startup result')
  assert.deepEqual(shell.events, [], 'a pending fallback cannot project a successful shell handoff')
  releaseFallback()
  await firstLoadDelay()
  const fallback = api.f.views[1]
  manager.handleReady(fallback.webContents.id, { revision: 2, workspaceVersion: 1, routes: ['catalog'] })
  await Promise.resolve()
  assert.equal(settled, false)
  acknowledge(manager, fallback)
  await Promise.all([prewarm, navigation])
  assert.deepEqual(order, ['fallback-started', 'fallback-committed', 'navigation-resolved'])
  assert.equal(manager.hasCurrent, true)
  assert.equal(manager.getState().status, 'ready')
  assert.equal(fallback.visible, false)
  assert.deepEqual(shell.events, [{ type: 'set-view', view: 'home', workspaceRoute: { page: 'catalog' } }])
  api.setHomeSurfaceVisible(true)
  assert.equal(fallback.visible, true)
  assert.equal(fallback.webContents.loads.length, 1)
  api.destroyHomeSurface()
})

test('shell startup navigation rejects when the paired default also fails without projecting home', async () => {
  const api = await fixture()
  api.__setAppearance(snapshot(appearance()))
  const shell = workspaceShell(api)
  let fallbackCalls = 0
  api.__appearanceService.recoverToBuiltin = async () => {
    fallbackCalls++
    throw new Error('paired default failed')
  }
  const rejected = assert.rejects(shell.navigate({ page: 'catalog' }), /paired default failed/)
  await firstLoadDelay()
  api.f.views[0].webContents.close()
  await rejected
  assert.equal(fallbackCalls, 1)
  assert.equal(api.homeSurfaceManager.hasCurrent, false)
  assert.deepEqual(shell.events, [])
  api.destroyHomeSurface()
})

test('recovery suspension during provider lookup invalidates the old navigation without unlocking recovery', async () => {
  const api = await fixture()
  api.__setAppearance(snapshot(appearance()))
  const manager = api.homeSurfaceManager
  const shell = workspaceShell(api)
  let releaseLookup
  api.f.registryGate = new Promise(resolve => { releaseLookup = resolve })
  const rejected = assert.rejects(shell.navigate({ page: 'catalog' }), /cancelled by recovery/)
  await firstLoadDelay()
  assert.equal(api.f.views.length, 0, 'provider lookup has not attached a cancellable preparing view yet')
  const epoch = manager.recoveryEpoch
  manager.suspendForRecovery()
  assert.ok(manager.recoveryEpoch > epoch)
  releaseLookup()
  await firstLoadDelay()
  const view = api.f.views[0]
  manager.handleReady(view.webContents.id, { revision: 1, workspaceVersion: 1, routes: ['catalog', 'installed'] })
  await Promise.resolve()
  acknowledge(manager, view)
  await rejected
  assert.equal(manager.isRecoverySuspended, true)
  assert.equal(view.visible, false)
  assert.deepEqual(api.f.recoveries, [])
  assert.deepEqual(shell.events, [], 'the cancelled navigation never projected a view switch')

  const explicit = shell.navigate({ page: 'installed' })
  await firstLoadDelay()
  acknowledge(manager, view)
  await explicit
  assert.equal(manager.isRecoverySuspended, false, 'a new explicit navigation can leave an already-open recovery panel')
  assert.equal(manager.getState().status, 'ready')
  assert.deepEqual(shell.events.at(-1), { type: 'set-view', view: 'home', workspaceRoute: { page: 'installed' } })
  api.destroyHomeSurface()
})

test('concurrent shell navigations share prewarm but only the latest intent is dispatched after startup', async () => {
  const api = await fixture()
  api.__setAppearance(snapshot(appearance()))
  const manager = api.homeSurfaceManager
  const shell = workspaceShell(api)
  const superseded = assert.rejects(shell.navigate({ page: 'detail', pluginId: 'notes' }), /navigation was replaced/)
  const latest = shell.navigate({ page: 'installed' })
  await firstLoadDelay()
  const view = api.f.views[0]
  manager.handleReady(view.webContents.id, { revision: 1, workspaceVersion: 1, routes: ['catalog', 'installed'] })
  await Promise.resolve()
  acknowledge(manager, view)
  await firstLoadDelay()
  await superseded
  assert.deepEqual(navigationFor(view).route, { page: 'installed' })
  assert.deepEqual(shell.events, [{ type: 'set-view', view: 'home', workspaceRoute: { page: 'installed' } }])
  acknowledge(manager, view)
  await latest
  assert.deepEqual(manager.getState().route, { page: 'installed' })
  assert.equal(api.f.views.length, 1)
  assert.equal(view.webContents.loads.length, 1)
  api.destroyHomeSurface()
})

test('shell navigation rejects malformed routes before any prewarm or native side effect', async () => {
  const api = await fixture()
  const shell = workspaceShell(api)
  for (const route of [null, { page: 'detail', pluginId: '../private' }, { page: 'catalog', url: 'https://example.invalid' }]) {
    await assert.rejects(shell.navigate(route), /Invalid workspace route/)
  }
  assert.equal(api.f.views.length, 0)
  assert.equal(shell.hidden, 0)
  assert.deepEqual(shell.events, [])
  api.destroyHomeSurface()
})

test('shell chrome visibility hides and restores native orb without persisting or trusting the projected tab style', async () => {
  const api = await fixture()
  const initial = snapshot({ ...appearance(), layout: { tabStyle: 'orb' } })
  initial.profile = { identity: { source: 'enest.builtin', id: 'home' }, values: { tabStyle: 'orb' } }
  api.__setAppearance(initial)
  const shell = workspaceShell(api)
  const before = structuredClone(initial)
  const projected = { view: 'home', tabStyle: 'classic', activeTabId: null, tabs: [] }

  assert.deepEqual(await shell.syncOrbState({ ...projected, chromeVisible: false }), { ok: true })
  assert.deepEqual(shell.orb.visibility, ['classic'])
  assert.deepEqual(shell.orb.projections[0], { ...projected, tabStyle: 'orb' })
  assert.equal(Object.hasOwn(shell.orb.projections[0], 'chromeVisible'), false)
  assert.deepEqual(api.__appearanceService.getAppearanceSnapshot(), before)

  await shell.syncOrbState({ ...projected, chromeVisible: true })
  assert.deepEqual(shell.orb.visibility, ['classic', 'orb'])
  assert.equal(shell.orb.projections.at(-1).tabStyle, 'orb')
  assert.deepEqual(api.__appearanceService.getAppearanceSnapshot(), before)
  assert.deepEqual(shell.orb.writes, [], 'visibility is transient and must not rewrite the theme profile')

  await shell.syncOrbState(projected)
  assert.equal(shell.orb.visibility.at(-1), 'orb', 'older host projections without a visibility hint retain normal behavior')
  const classic = snapshot({ ...appearance(2), layout: { tabStyle: 'classic' } })
  api.__setAppearance(classic)
  await shell.syncOrbState({ ...projected, tabStyle: 'orb', chromeVisible: true })
  assert.equal(shell.orb.projections.at(-1).tabStyle, 'classic', 'a renderer cannot enable orb against the authoritative theme')
  assert.equal(shell.orb.visibility.at(-1), 'classic')
  assert.deepEqual(api.__appearanceService.getAppearanceSnapshot(), classic)
  assert.deepEqual(shell.orb.writes, [])
  assert.equal(api.f.views.length, 0)
  api.destroyHomeSurface()
})

test('unexpected view destruction rejects pending navigation immediately and enables recovery', async () => {
  const api = await fixture()
  const manager = new api.HomeSurfaceManager(100)
  const view = await bootWorkspace(api, manager)
  manager.setVisible(true)
  const faults = []
  manager.onFault(message => faults.push(message))
  const pending = manager.navigate({ page: 'detail', pluginId: 'notes' })
  view.webContents.close()
  await assert.rejects(pending, /retired/)
  assert.equal(manager.hasCurrent, false)
  assert.equal(manager.getState().recovery, true)
  assert.equal(api.f.children.size, 0)
  assert.equal(faults.length, 1)
  manager.destroy()
})

test('singleton visibility cannot create a missing Workspace behind a recovery lock; explicit retry can', async () => {
  const api = await fixture()
  api.__setAppearance(snapshot(appearance()))
  const manager = api.homeSurfaceManager
  manager.suspendForRecovery()
  await manager.ensure()
  await api.prewarmHomeSurface()
  await api.prewarmHomeSurface()
  api.setHomeSurfaceVisible(true)
  api.setHomeSurfaceVisible(true)
  await firstLoadDelay()
  assert.equal(manager.hasCurrent, false)
  assert.equal(manager.isRecoverySuspended, true)
  assert.equal(manager.getState().recovery, true)
  assert.equal(api.f.views.length, 0)
  assert.deepEqual(api.f.recoveries, [])

  const pending = api.retryHomeSurface()
  await firstLoadDelay()
  const view = api.f.views[0]
  manager.handleReady(view.webContents.id, { revision: 1, workspaceVersion: 1, routes: ['catalog'] })
  await Promise.resolve()
  acknowledge(manager, view)
  await pending
  assert.equal(manager.isRecoverySuspended, false)
  assert.equal(manager.getState().recovery, false)
  assert.equal(view.visible, true)
  api.destroyHomeSurface()
})

test('prewarm cancelled by recovery stays locked without fallback or another automatic surface', async () => {
  const api = await fixture()
  api.__setAppearance(snapshot(appearance()))
  const prewarm = api.prewarmHomeSurface()
  const rejected = assert.rejects(prewarm, /retired/)
  await firstLoadDelay()
  const view = api.f.views[0]
  api.homeSurfaceManager.suspendForRecovery()
  await rejected
  assert.equal(view.visible, false)
  assert.equal(view.webContents.isDestroyed(), true)
  assert.equal(api.f.children.size, 0)
  assert.deepEqual(api.f.recoveries, [], 'safety recovery must cancel paired automatic fallback too')
  await api.prewarmHomeSurface()
  assert.equal(api.f.views.length, 1)
  assert.equal(api.homeSurfaceManager.isRecoverySuspended, true)
  assert.equal(api.homeSurfaceManager.getState().recovery, true)
  api.destroyHomeSurface()
})

test('automatic preparation cancelled by recovery cannot run fallback or restart on later visibility', async () => {
  const api = await fixture()
  api.__setAppearance(snapshot(appearance()))
  api.setHomeSurfaceVisible(true)
  await firstLoadDelay()
  assert.equal(api.f.views.length, 1, 'normal startup still prepares automatically')
  const view = api.f.views[0]
  api.homeSurfaceManager.suspendForRecovery()
  await firstLoadDelay()
  assert.equal(view.webContents.isDestroyed(), true)
  assert.deepEqual(api.f.recoveries, [], 'a cancelled startup must not launch an asynchronous fallback')
  api.setHomeSurfaceVisible(true)
  await firstLoadDelay()
  assert.equal(api.f.views.length, 1)
  assert.equal(api.homeSurfaceManager.isRecoverySuspended, true)
  assert.equal(api.homeSurfaceManager.getState().recovery, true)
  api.destroyHomeSurface()
})

test('an active built-in default crash remains locked when singleton visibility requests startup again', async () => {
  const api = await fixture()
  const currentAppearance = appearance()
  currentAppearance.theme.id = 'default'
  api.__setAppearance(snapshot(currentAppearance))
  const manager = api.homeSurfaceManager
  const view = await bootWorkspace(api, manager)
  api.setHomeSurfaceVisible(true)
  assert.equal(view.visible, true)
  view.webContents.emit('render-process-gone', {}, { reason: 'crashed' })
  assert.equal(manager.hasCurrent, false)
  assert.equal(manager.isRecoverySuspended, true)
  api.setHomeSurfaceVisible(true)
  await firstLoadDelay()
  assert.equal(api.f.views.length, 1)
  assert.equal(manager.getState().recovery, true)
  assert.deepEqual(api.f.recoveries, [])
  api.destroyHomeSurface()
})

test('an explicit paired recovery retry clears the lock before its coordinator runs', async () => {
  const api = await fixture()
  api.__setAppearance({ ...snapshot(appearance()), recovery: true })
  api.homeSurfaceManager.suspendForRecovery()
  await api.retryHomeSurface(true)
  assert.equal(api.f.retryRecoveries, 1)
  assert.equal(api.homeSurfaceManager.isRecoverySuspended, false)
  assert.equal(api.f.views.length, 0, 'paired recovery owns its own preparation')
  api.destroyHomeSurface()
})
