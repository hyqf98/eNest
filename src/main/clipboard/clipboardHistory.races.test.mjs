import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'enest-history-test-'))
  const adapters = {
    fixture: `export const state={text:'',sourceGate:null,writeGate:null,fail:false,reads:0,writes:[]};`,
    electron: `import {state} from 'fixture';export class ClipboardItem{};export const clipboard={read:async()=>[],readText:async()=>{state.reads++;return state.text},writeText:async text=>{state.writes.push(text);if(state.writeGate)await state.writeGate;if(state.fail)throw Error('fixture write failure');state.text=text}};export const nativeImage={};export const shell={};`,
    '@main/clipboard/nativeClipboard': `import {state} from 'fixture';export const readNativeFiles=async()=>[];export const writeNativeFiles=async()=>{};export const nativeClipboardSource=async()=>{if(state.sourceGate)await state.sourceGate;return undefined};export const pasteToOriginal=async()=>({pasted:true});export const isNativeClipboardBusy=()=>false;`,
    '@main/settings/SettingsStore': `export const settingsStore={getPluginSettings:()=>({}),getPermissionGrant:()=> 'allow'};`,
    '@main/plugin/PluginRegistry': `export const pluginRegistry={list:()=>[]};`,
    '@main/paths/pathsService': `export const getAppPaths=()=>({data:${JSON.stringify(directory)}});`,
    '@main/logs/logService': `export const logInfo=()=>{};export const logWarn=()=>{};`
  }
  const result = await build({
    stdin: { contents: `export * from '@main/clipboard/clipboardHistory';export {state} from 'fixture';`, resolveDir: process.cwd() },
    tsconfig: 'tsconfig.node.json', bundle: true, write: false, format: 'esm', platform: 'node',
    plugins: [{ name: 'fixture', setup(b) {
      b.onResolve({ filter: /.*/ }, ({ path }) => path in adapters ? { path, namespace: 'fixture' } : undefined)
      b.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({ contents: adapters[path], loader: 'js' }))
      b.onLoad({ filter: /clipboardHistory\.ts$/ }, async ({ path }) => ({ contents: (await readFile(path, 'utf8')) + '\nexport { pollOnce };', loader: 'ts' }))
    } }]
  })
  const api = await import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64'))
  return { ...api, directory, cleanup: () => rm(directory, { recursive: true, force: true }) }
}
const tick = () => new Promise(resolve => setImmediate(resolve))

test('sensitive host write invalidates an in-flight capture before its source lookup returns', async () => {
  const c = await fixture()
  try {
    let releaseSource, sourceStarted
    const started = new Promise(resolve => { sourceStarted = resolve })
    c.state.text = 'synthetic-secret'
    c.state.sourceGate = { then(resolve) { sourceStarted(); releaseSource = resolve } }
    const capture = c.pollOnce()
    await started
    await c.writeHistoryAwareText('synthetic-secret', { excludeFromHistory: true })
    releaseSource()
    await capture
    c.state.sourceGate = null
    await c.pollOnce()
    assert.equal((await c.listHistory()).length, 0)
    c.state.text = 'ordinary external copy'
    await c.pollOnce()
    assert.deepEqual((await c.listHistory()).map(entry => entry.text), ['ordinary external copy'])
    assert.doesNotMatch(await readFile(join(c.directory, 'clipboard-history.json'), 'utf8'), /synthetic-secret/)
  } finally { await c.cleanup() }
})

test('queued clipboard writes block polling, keep order and recover after failure or cancellation', async () => {
  const c = await fixture()
  try {
    let release
    c.state.writeGate = new Promise(resolve => { release = resolve })
    const first = c.writeHistoryAwareText('first', { excludeFromHistory: true })
    const second = c.writeHistoryAwareText('second', { excludeFromHistory: true })
    await tick()
    await c.pollOnce()
    assert.equal(c.state.reads, 0)
    release()
    await Promise.all([first, second])
    assert.deepEqual(c.state.writes, ['first', 'second'])
    assert.equal(c.state.text, 'second')
    c.state.fail = true
    await assert.rejects(c.writeHistoryAwareText('failure'), /fixture write failure/)
    c.state.fail = false
    const controller = new AbortController(); controller.abort()
    await assert.rejects(c.writeHistoryAwareText('cancelled', {}, controller.signal), /abort/i)
    assert.equal(c.state.writes.includes('cancelled'), false)
    c.state.text = 'after failure'
    await c.pollOnce()
    assert.equal((await c.listHistory())[0].text, 'after failure')
  } finally { await c.cleanup() }
})
