import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const adapters = {
  fixture: `export const state={launches:[],preparations:0,focused:0,hidden:0,quickRevision:0,placementRevision:0,gate:null,onCommit:null};`,
  '@shared/pluginPresentation': `export const resolvePluginLaunchPresentation=(_views,mode)=>({target:mode,layoutMode:mode});`,
  '@main/plugin/PluginRegistry': `export const pluginRegistry={get:id=>({id,installed:true,enabled:true}),getManifest:()=>({})};`,
  '@main/settings/SettingsStore': `export const settingsStore={getPluginLaunchConfig:()=>({mode:'shell'})};`,
  '@main/clipboard/nativeClipboard': `export const capturePasteTarget=async()=>{};`,
  '@main/window/createQuickWindow': `import {state} from 'fixture';
    export const getQuickShowRevision=()=>state.quickRevision;
    export const isQuickVisible=()=>true;
    export const prepareQuickWindowForPlugin=async guard=>{state.preparations++;await state.gate;return guard()};
    export const hideQuickWindow=()=>{state.hidden++;state.quickRevision++};`,
  '@main/window/createShellWindow': `import {EventEmitter} from 'node:events';import {state} from 'fixture';
    const window=Object.assign(new EventEmitter(),{isDestroyed:()=>false,isMinimized:()=>false,isVisible:()=>true,show:()=>{},focus:()=>state.focused++});
    export const getMainWindow=()=>window;export const sendShellEvent=()=>{};`,
  '@main/plugin/PluginHost': `import {state} from 'fixture';export const pluginHost={
    getPlacement:()=>({kind:'shell'}),getPlacementRevision:()=>state.placementRevision,
    async launchPluginIn(id,target,enter,guard){await state.gate;if(!guard())throw Error('plugin launch cancelled');state.launches.push({id,target,enter});state.placementRevision++;state.onCommit?.()},
    async openPlugin(id,enter,{guard}){await state.gate;if(!guard())throw Error('plugin launch cancelled');state.launches.push({id,enter});state.onCommit?.()},
    focusPlugin:()=>state.focused++
  };`,
  '@main/logs/logService': `export const logWarn=()=>{};`
}

async function fixture() {
  const output = await build({
    stdin: { contents: `export * from '@main/launcher/pluginLauncher';export {state} from 'fixture';export const nonce=${Math.random()}`, resolveDir: root },
    tsconfig: `${root}tsconfig.node.json`, bundle: true, write: false, platform: 'node', format: 'esm',
    plugins: [{ name: 'launch-guard-fixture', setup(builder) {
      builder.onResolve({ filter: /.*/ }, ({ path }) => path in adapters ? { path, namespace: 'fixture' } : undefined)
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({ contents: adapters[path] }))
    } }]
  })
  return import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`)
}

function gate() {
  let release
  const promise = new Promise(resolve => { release = resolve })
  return { promise, release }
}

test('a retired caller cannot allocate native preparation or commit a pending launch', async () => {
  const { state, launchPlugin } = await fixture()
  assert.deepEqual(await launchPlugin({ pluginId: 'notes', mode: 'quick', source: 'settings', guard: () => false }), { ok: false, cancelled: true })
  assert.equal(state.preparations, 0)
  let current = true
  const waiting = gate()
  state.gate = waiting.promise
  const result = launchPlugin({ pluginId: 'notes', mode: 'shell', source: 'settings', guard: () => current })
  current = false
  waiting.release()
  assert.deepEqual(await result, { ok: false, cancelled: true })
  assert.deepEqual(state.launches, [])
  assert.equal(state.focused, 0)
})

test('launch deduplication does not reuse another caller guard or a guarded request without a guard', async () => {
  for (const guardedSecond of [true, false]) {
    const { state, launchPlugin } = await fixture()
    const waiting = gate()
    state.gate = waiting.promise
    const first = launchPlugin({ pluginId: 'notes', mode: 'shell', source: 'settings', guard: () => true })
    const second = launchPlugin({ pluginId: 'notes', mode: 'shell', source: 'settings', ...(guardedSecond ? { guard: () => true } : {}) })
    assert.notEqual(first, second)
    waiting.release()
    assert.deepEqual(await first, { ok: false, cancelled: true })
    assert.deepEqual(await second, { ok: true })
    assert.equal(state.launches.length, 1)
  }
})

test('native commit can deactivate its caller without turning a successful launch into cancellation', async () => {
  const { state, launchPlugin } = await fixture()
  let current = true
  state.onCommit = () => { current = false }
  assert.deepEqual(await launchPlugin({ pluginId: 'notes', mode: 'shell', source: 'settings', guard: () => current }), { ok: true })
  assert.equal(state.launches.length, 1)
  assert.equal(state.focused, 1)
})

test('guard exceptions fail closed before native allocation', async () => {
  const { state, launchPlugin } = await fixture()
  assert.deepEqual(await launchPlugin({ pluginId: 'notes', mode: 'quick', source: 'settings', guard: () => { throw Error('retired source') } }), { ok: false, cancelled: true })
  assert.equal(state.preparations, 0)
  assert.deepEqual(state.launches, [])
})
