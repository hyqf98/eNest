import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../', import.meta.url))

test('Home preload exposes only the restricted bridge and preserves envelope subscriptions', async () => {
  const result = await build({
    stdin: { contents: `import '@preload/homePreload';export {state} from 'electron';export {IpcChannels} from '@shared/types/ipc';`, resolveDir: root },
    bundle: true, write: false, format: 'esm', platform: 'node', tsconfig: `${root}/tsconfig.node.json`,
    plugins: [{ name: 'home-preload-fixture', setup(builder) {
      builder.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'fixture' }))
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: `
        import {EventEmitter} from 'node:events';
        export const state={globals:{},calls:[],events:new EventEmitter()};
        export const contextBridge={exposeInMainWorld:(key,value)=>state.globals[key]=value};
        export const ipcRenderer={invoke:async(channel,payload)=>{state.calls.push({channel,payload});return {channel,payload}},on:(...args)=>state.events.on(...args),removeListener:(...args)=>state.events.removeListener(...args)};
      ` }))
    } }]
  })
  const { state, IpcChannels } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`)
  assert.deepEqual(Object.keys(state.globals), ['enestHome', 'enestWorkspace'])
  const api = state.globals.enestHome
  assert.equal(state.globals.enestWorkspace, api)
  assert.deepEqual(Object.keys(api).sort(), ['action', 'ackNavigation', 'getAppearance', 'getCatalog', 'getConfig', 'getDetail', 'onAppearance', 'onCommand', 'ready', 'refresh', 'search'].sort())
  const appearances = [], commands = []
  const disposeAppearance = api.onAppearance(value => appearances.push(value))
  const disposeCommand = api.onCommand(value => commands.push(value))
  assert.equal(state.events.listenerCount(IpcChannels.HomeEvent), 2)
  await api.getAppearance()
  const snapshot = { appearance: { version: 2, revision: 3 }, generation: 4, resources: { fonts: [] } }
  const command = { type: 'openMarket', revision: 3, generation: 4 }
  state.events.emit(IpcChannels.HomeEvent, {}, { appearance: snapshot })
  state.events.emit(IpcChannels.HomeEvent, {}, { command })
  state.events.emit(IpcChannels.HomeEvent, {}, { appearance: { revision: 2 } })
  assert.deepEqual(appearances, [snapshot])
  assert.deepEqual(commands, [command])
  await api.search({ query: 'notes', scope: 'installed', limit: 4 })
  assert.deepEqual(state.calls.at(-1), { channel: IpcChannels.HomeSearch, payload: { query: 'notes', scope: 'installed', limit: 4 } })
  await api.ready({ revision: 3, workspaceVersion: 1, routes: ['catalog', 'detail'] })
  assert.equal(state.calls.at(-1).channel, IpcChannels.HomeReady)
  const navigation = { generation: 4, requestId: '4:1', ok: true }
  await api.ackNavigation(navigation)
  assert.deepEqual(state.calls.at(-1), { channel: IpcChannels.HomeAck, payload: navigation })
  disposeAppearance()
  disposeCommand()
  disposeCommand()
  assert.equal(state.events.listenerCount(IpcChannels.HomeEvent), 0)
})
