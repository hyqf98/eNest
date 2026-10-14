import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
const root = fileURLToPath(new URL('../../../', import.meta.url))
const adapters = {
  '@main/ipc/ipcSecurity': 'export const registerTrustedSurface=()=>{};',
  'test-state': 'export const state={capture:null,constructed:0};',
  electron: `
    import {state} from 'test-state';
    export const app={}; export const screen={};
    export const systemPreferences={getAnimationSettings:()=>({prefersReducedMotion:false})};
    export class View{constructor(){throw Error('unexpected view creation')}}
    export class BrowserWindow{constructor(){state.constructed++;throw Error('unexpected window creation')}}
    export class BaseWindow extends BrowserWindow{}
    export class WebContentsView{constructor(){throw Error('unexpected web contents view creation')}}
  `,
  '@main/clipboard/nativeClipboard': `import {state} from 'test-state';export const capturePasteTarget=()=>state.capture();`,
  '@main/plugin/pluginProtocol':
    'export const ensureShellSessionProtocol=()=>{};',
  '@main/logs/logService':
    'export const logInfo=()=>{};export const logError=()=>{};',
  '@main/settings/SettingsStore':
    'export const settingsStore={getAll:()=>({general:{}})};',
  './createShellWindow':
    'export const resolvePreload=()=>"";export const setQuickEventSink=()=>{};',
}
const output = await build({
  stdin: {
    resolveDir: root,
    contents:
      "export * from '@main/window/createQuickWindow';export {state} from 'test-state';",
  },
  tsconfig: join(root, 'tsconfig.node.json'),
  bundle: true,
  write: false,
  platform: 'node',
  format: 'esm',
  plugins: [
    {
      name: 'quick-adapters',
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
const gate = () => {
  let release
  const promise = new Promise((resolve) => {
    release = resolve
  })
  return { promise, release }
}

test('restore owner closing or migrating during target capture never creates or focuses Quick', async () => {
  for (const reason of ['closed', 'migrated', 'reopened']) {
    const waiting = gate()
    let current = true
    api.state.capture = () => waiting.promise
    const showing = api.showQuickWindow(() => current)
    current = false
    waiting.release()
    assert.equal(await showing, false, reason)
    assert.equal(api.state.constructed, 0)
  }
})

test('a later hide invalidates recovery even while its runtime remains current', async () => {
  const waiting = gate()
  api.state.capture = () => waiting.promise
  const showing = api.showQuickWindow(() => true)
  api.hideQuickWindow('user-dismiss')
  waiting.release()
  assert.equal(await showing, false)
  assert.equal(api.state.constructed, 0)
})
