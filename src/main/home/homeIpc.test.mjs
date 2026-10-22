import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../../', import.meta.url))

async function fixture() {
  const adapters = {
    fixture: `export const state={handlers:new Map(),calls:[],shellEvents:[],generation:4,activityRevision:1,active:true,role:'home',resolveCatalog:null,listener:null,actionWait:null,failure:null,logs:[]};
      export const fail=name=>{if(state.failure===name)throw new Error('EACCES /Users/private https://account:secret@example.invalid/private')};`,
    electron: `import {state} from 'fixture'; export const ipcMain={handle:(channel,handler)=>state.handlers.set(channel,handler)};`,
    '@main/ipc/ipcSecurity': `import {state} from 'fixture'; export const assertSurfaceSender=()=>{}; export const getTrustedSurfaceRole=()=>state.role;`,
    '@main/logs/logService': `import {state} from 'fixture';export const logWarn=(...args)=>state.logs.push(args);`,
    '@main/window/createShellWindow': `import {state} from 'fixture';export const sendShellEvent=event=>state.shellEvents.push(event);`,
    './homeDataService': `import {state,fail} from 'fixture';
      export const bindHomeContents=()=>{};
      export const getHomeConfig=()=>{fail('config');return {locale:'en-US'}};
      export const getHomeDetail=async id=>{fail('detail');return {pluginId:id}};
      export const getHomeCatalog=reason=>{state.calls.push(reason);fail('catalog');return new Promise(resolve=>{state.resolveCatalog=resolve})};
      export const searchHome=async()=>{fail('search');return {items:[],revision:1}};
      export const runHomeAction=async(action,context)=>{fail('action');if(state.actionWait)await state.actionWait;if(!context.isCurrent())return {ok:false};await context.navigateWorkspace(action.type==='navigate'?action.route:action.pluginId?{page:'detail',pluginId:action.pluginId}:{page:'catalog'});return {ok:true}};`
  }
  const result = await build({
    stdin: { contents: `export {registerHomeIpc} from '@main/home/homeIpc'; export {IpcChannels} from '@shared/types/ipc'; export {state,fail} from 'fixture'; export const nonce=${Math.random()};`, resolveDir: root },
    bundle: true, write: false, format: 'esm', platform: 'node', tsconfig: `${root}/tsconfig.node.json`,
    plugins: [{ name: 'home-ipc-fixture', setup(builder) {
      builder.onResolve({ filter: /.*/ }, ({ path }) => path in adapters ? { path, namespace: 'fixture' } : undefined)
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({ contents: adapters[path], loader: 'js' }))
    } }]
  })
  const api = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`)
  const { state } = api
  api.registerHomeIpc({
    onContents: listener => { state.listener = listener },
    getContentsGeneration: () => state.generation,
    getContentsActivityRevision: () => state.activityRevision,
    getAppearanceForContents: () => { api.fail('appearance'); return { appearance: { revision: 1 } } },
    handleReady: () => { api.fail('ready') },
    handleNavigationAck: (_wcId, payload) => { api.fail('ack'); state.calls.push(['ack', payload]) },
    isContentsActive: () => state.active,
    setVisible: () => {},
    navigate: route => { state.calls.push(route) }
  })
  const sender = { id: 11, isDestroyed: () => false }
  return { ...api, invoke: (name, payload) => state.handlers.get(api.IpcChannels[name])({ sender }, payload) }
}

test('home catalog IPC is offline-first and rejects generation changes around awaits', async () => {
  const api = await fixture()
  const pending = api.invoke('HomeGetCatalog')
  assert.deepEqual(api.state.calls, ['boot'])
  api.state.generation = null
  api.state.resolveCatalog({ items: [], revision: 1 })
  await assert.rejects(pending, /retired/)
  await assert.rejects(api.invoke('HomeGetCatalog'), /retired/)
  assert.deepEqual(api.state.calls, ['boot'])
  assert.equal(typeof api.state.listener, 'function')
})

test('home actions require the active home and bind navigation to its generation', async () => {
  const api = await fixture()
  api.state.active = false
  await assert.rejects(api.invoke('HomeAction', { type: 'openMarket' }), /not active/)
  api.state.active = true
  api.state.role = 'shell'
  await assert.rejects(api.invoke('HomeAction', { type: 'openMarket' }), /not active/)
  api.state.role = 'home'
  assert.deepEqual(await api.invoke('HomeAction', { type: 'openMarket', pluginId: 'notes' }), { ok: true })
  assert.deepEqual(api.state.calls, [{ page: 'detail', pluginId: 'notes' }])
  assert.deepEqual(api.state.shellEvents, [{ type: 'set-view', view: 'home', workspaceRoute: { page: 'detail', pluginId: 'notes' } }])
})

test('a Home action cannot outlive visibility or generation changes during an awaited confirmation', async () => {
  const api = await fixture()
  let resolveAction
  api.state.actionWait = new Promise(resolve => { resolveAction = resolve })
  const pending = api.invoke('HomeAction', { type: 'openMarket', pluginId: 'notes' })
  api.state.active = false
  resolveAction()
  assert.equal((await pending).ok, false)
  assert.deepEqual(api.state.calls, [])
  api.state.active = true
  api.state.actionWait = new Promise(resolve => { resolveAction = resolve })
  const replacing = api.invoke('HomeAction', { type: 'openMarket', pluginId: 'notes' })
  api.state.generation += 1
  resolveAction()
  assert.equal((await replacing).ok, false)
  assert.deepEqual(api.state.calls, [])
})

test('every Home IPC data boundary replaces synchronous and asynchronous host failures with a fixed public error', async () => {
  const api = await fixture()
  const failures = {
    HomeReady: 'ready', HomeGetAppearance: 'appearance', HomeGetConfig: 'config', HomeGetCatalog: 'catalog',
    HomeGetDetail: 'detail', HomeSearch: 'search', HomeRefresh: 'catalog', HomeAction: 'action', HomeAck: 'ack'
  }
  for (const [channel, failure] of Object.entries(failures)) {
    api.state.failure = failure
    await assert.rejects(api.invoke(channel, { type: 'openMarket' }), error => {
      assert.equal(error.message, 'Home request failed', channel)
      assert.doesNotMatch(String(error), /Users|private|secret|account|EACCES/)
      return true
    })
  }
  assert.equal(api.state.logs.length, Object.keys(failures).length)
  assert.ok(api.state.logs.every(args => args.join(' ').includes('/Users/private')))
})

test('navigation accepts only identity routes before dispatching trusted shell view events', async () => {
  const api = await fixture()
  // settings 不再是 Workspace 路由：设置由原生壳渲染层独占。
  for (const route of [{ page: 'settings' }, { page: 'settings', sectionId: 'general' }, { page: 'detail', pluginId: '../other' }, { page: 'catalog', url: 'https://example.com' }]) {
    await assert.rejects(api.invoke('HomeAction', { type: 'navigate', route }), /Home request failed/)
  }
  assert.deepEqual(api.state.shellEvents, [])
  assert.deepEqual(api.state.calls, [])
})
