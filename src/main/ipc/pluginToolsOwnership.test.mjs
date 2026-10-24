import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
const root = fileURLToPath(new URL('../../../', import.meta.url))
const noopExports = (names) =>
  names.map((name) => `export const ${name}=()=>{};`).join('')
const adapters = {
  'test-state':
    'export const state={current:"plugin",container:"quick",revision:0,paste:null,show:null,shown:0,opened:[]};',
  '@main/plugin/PluginHost': `import {state} from 'test-state';export const pluginHost={getQuickPlugin:()=>state.current,getContainer:()=>state.container,getPlacement:()=>({kind:state.container}),getPlacementRevision:()=>state.container,openPlugin:async(id)=>{state.opened.push(id);state.current=id}};`,
  '@main/plugin/quickInputService': noopExports([
    'bindQuickInputHost',
    'clearQuickInput',
    'configureQuickInput',
    'escapeQuickInput',
  ]),
  '@main/plugin/pluginFiles': noopExports([
    'getPluginBlob',
    'putPluginBlob',
    'removePluginBlob',
    'savePluginFile',
  ]),
  '@main/window/createShellWindow': noopExports([
    'getMainWindow',
    'sendShellEvent',
  ]),
  '@main/window/createQuickWindow': `import {state} from 'test-state';export const getQuickShowRevision=()=>state.revision;export const hideQuickWindow=()=>{state.revision++;state.current=null};export async function showQuickWindow(guard){const revision=++state.revision;if(state.show)await state.show();if(revision!==state.revision||!guard())return false;state.shown++;return true;}`,
  '@main/clipboard/nativeClipboard': `import {state} from 'test-state';export const pasteToOriginal=(signal,owner)=>state.paste={signal,owner};` + noopExports([
    'nativeCapabilities',
    'requestNativePermission',
  ]),
  '@main/plugin/localFiles': noopExports([
    'inspectGrantedFilePaths',
    'localFilesFromDrop',
    'revealLocalFile',
  ]),
  '@main/timer/deadlineTaskService': noopExports([
    'startDeadlineTask',
    'getDeadlineTask',
    'pauseDeadlineTask',
    'resumeDeadlineTask',
    'skipDeadlineTask',
    'cancelDeadlineTask',
  ]),
}
const output = await build({
  stdin: {
    resolveDir: root,
    contents:
      "export * from '@main/ipc/pluginToolsHandlers';export * from '@main/plugin/PluginRuntimeScope';export {state} from 'test-state';",
  },
  tsconfig: join(root, 'tsconfig.node.json'),
  bundle: true,
  write: false,
  platform: 'node',
  format: 'esm',
  plugins: [
    {
      name: 'owner-adapters',
      setup(b) {
        b.onResolve({ filter: /.*/ }, ({ path }) =>
          path in adapters ? { path, namespace: 'mock' } : undefined,
        )
        b.onLoad({ filter: /.*/, namespace: 'mock' }, ({ path }) => ({
          contents: adapters[path],
          resolveDir: root,
        }))
      },
    },
  ],
})
const api = await import(
  `data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`
)
let scope,
  generation = 0
test.beforeEach(() => {
  Object.assign(api.state, {
    current: 'plugin',
    container: 'quick',
    revision: 0,
    paste: null,
    show: null,
    shown: 0,
    opened: [],
  })
  scope = api.createRuntimeScope({
    pluginId: 'plugin',
    generation: ++generation,
    wcId: generation,
  })
})
test.afterEach(async () => {
  await api.getRuntimeScope('plugin')?.dispose()
})
const owner = async () => {
  await api.dispatchPluginTool('plugin', 'clipboard.paste', [])
  return api.state.paste.owner
}
const gate = () => {
  let release
  const promise = new Promise((resolve) => {
    release = resolve
  })
  return { promise, release }
}

test('owner binds original runtime and entrance; its own hide permits normal paste and restore', async () => {
  const current = await owner()
  assert.equal(current.isCurrent(), true)
  const restore = current.beforePaste()
  assert.equal(api.state.current, null)
  assert.equal(current.isCurrent(), true)
  await restore()
  assert.deepEqual(api.state.opened, ['plugin'])
  assert.equal(api.state.shown, 1)
})
test('migration or another Quick opening invalidates the old operation', async () => {
  const current = await owner()
  api.state.container = 'shell'
  assert.equal(current.isCurrent(), false)
  api.state.container = 'quick'
  api.state.revision++
  assert.equal(current.isCurrent(), false)
})
test('close/reopen while failed paste is restoring never reveals or reopens the old Quick', async () => {
  const current = await owner(),
    restore = current.beforePaste(),
    waiting = gate()
  api.state.show = () => waiting.promise
  const restoring = restore()
  await scope.dispose()
  scope = api.createRuntimeScope({
    pluginId: 'plugin',
    generation: ++generation,
    wcId: generation,
  })
  waiting.release()
  await restoring
  assert.equal(api.state.shown, 0)
  assert.deepEqual(api.state.opened, [])
})
test('desktop paste does not hide an unrelated Quick plugin', async () => {
  api.state.container = 'shell'
  api.state.current = 'other'
  const current = await owner()
  assert.equal(current.beforePaste(), undefined)
  assert.equal(api.state.current, 'other')
  assert.equal(current.isCurrent(), true)
})
