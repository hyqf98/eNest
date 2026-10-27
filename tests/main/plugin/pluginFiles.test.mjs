import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'
import { mkdtemp, readdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
const root = fileURLToPath(new URL('../../../', import.meta.url))
const adapters = {
  'test-state':
    'export const state={root:"",writes:[],dialogs:[],leases:0,writeGate:null,mkdirGate:null};',
  electron:
    "import {state} from 'test-state';export const dialog={showSaveDialog:(...args)=>new Promise(resolve=>state.dialogs.push({args,resolve}))};",
  '@main/paths/pathsService':
    "import {state} from 'test-state';export const getAppPaths=()=>({data:state.root});",
  '@main/window/createQuickWindow':
    "import {state} from 'test-state';export const getQuickWindow=()=>null;export const acquireQuickInteraction=()=>{state.leases++;let live=true;return()=>{if(live){live=false;state.leases--}}};",
  '@main/plugin/PluginHost': 'export const pluginHost={ getContainerWindow:()=>null, acquireWindowInteraction:()=>()=>{} };',
  'node:fs/promises':
    "import * as fs from 'fs/promises';import {state} from 'test-state';export const {readFile,readdir,stat,rename,rm}=fs;export async function mkdir(...args){if(state.mkdirGate)await state.mkdirGate(...args);return fs.mkdir(...args)};export async function writeFile(...args){state.writes.push(args[0]);if(state.writeGate)await state.writeGate(...args);return fs.writeFile(...args)}",
}
const output = await build({
  stdin: {
    resolveDir: root,
    contents:
      "export * from '@main/plugin/pluginFiles';export * from '@main/plugin/PluginRuntimeScope';export {state} from 'test-state';",
  },
  tsconfig: join(root, 'tsconfig.node.json'),
  bundle: true,
  write: false,
  platform: 'node',
  format: 'esm',
  plugins: [
    {
      name: 'test-adapters',
      setup(b) {
        b.onResolve({ filter: /.*/ }, ({ path }) =>
          path in adapters ? { path, namespace: 'test' } : undefined,
        )
        b.onLoad({ filter: /.*/, namespace: 'test' }, ({ path }) => ({
          contents: adapters[path],
        }))
      },
    },
  ],
})
const api = await import(
  'data:text/javascript;base64,' +
    Buffer.from(output.outputFiles[0].text).toString('base64')
)
const { state } = api,
  scopes = []
const input = { dataUrl: 'data:image/png;base64,aW1hZ2UtYnl0ZXM=' }
const deferred = () => {
  let resolve
  const promise = new Promise((r) => (resolve = r))
  return { promise, resolve }
}
const scope = (id = 'plugin', generation = 1) => {
  const s = api.createRuntimeScope({
    pluginId: id,
    generation,
    wcId: generation * 10,
  })
  scopes.push(s)
  return s
}
const dir = (id) =>
  join(
    state.root,
    'plugin-attachments',
    createHash('sha256').update(id).digest('hex'),
  )
async function until(fn) {
  for (let i = 0; i < 100; i++) {
    if (fn()) return
    await new Promise((resolve) => setImmediate(resolve))
  }
  throw Error('operation did not reach test boundary')
}
test.beforeEach(async () => {
  Object.assign(state, {
    root: await mkdtemp(join(tmpdir(), 'enest-plugin-files-')),
    writes: [],
    dialogs: [],
    leases: 0,
    writeGate: null,
    mkdirGate: null,
  })
})
test.afterEach(async () => {
  state.writeGate = null
  state.mkdirGate = null
  for (const d of state.dialogs) d.resolve({ canceled: true })
  for (const s of scopes.splice(0)) await s.dispose()
  await api.clearPluginBlobs('plugin')
  await api.clearPluginBlobs('other')
  await rm(state.root, { recursive: true, force: true })
})

test('附件队列最多两个；成功和失败 settle 都释放名额与 activity', async () => {
  const s = scope(),
    gate = deferred()
  state.mkdirGate = () => gate.promise
  const first = api.putPluginBlob('plugin', input),
    second = api.putPluginBlob('plugin', input)
  assert.throws(() => api.putPluginBlob('plugin', input), /附件正在保存/)
  assert.equal(s.activityCount, 2)
  gate.resolve()
  await Promise.all([first, second])
  assert.equal(s.activityCount, 0)
  await assert.rejects(
    api.putPluginBlob('plugin', { dataUrl: 'data:text/plain;base64,YQ==' }),
    /仅支持/,
  )
  assert.equal(s.activityCount, 0)
  const third = await api.putPluginBlob('plugin', input)
  assert.ok(third.id)
  assert.equal(s.activityCount, 0)
})
test('附件写入的晚完成在 owner 关闭后回滚，下一代可重新保存', async () => {
  const s = scope(),
    gate = deferred()
  let reached = false
  state.writeGate = async () => {
    reached = true
    await gate.promise
  }
  const saving = api.putPluginBlob('plugin', input)
  const rejected = assert.rejects(saving, /abort|closing|stale/i)
  await until(() => reached)
  s.markClosing()
  gate.resolve()
  await rejected
  assert.deepEqual(await readdir(dir('plugin')), [])
  assert.equal(s.activityCount, 0)
  await s.dispose()
  scope('plugin', 2)
  state.writeGate = null
  const next = await api.putPluginBlob('plugin', input)
  assert.ok((await api.getPluginBlob('plugin', next.id)).bytes > 0)
})
test('附件 ID 不能跨插件读取或删除，拒绝路径遍历', async () => {
  scope()
  scope('other', 2)
  const blob = await api.putPluginBlob('plugin', input)
  assert.equal(await api.getPluginBlob('other', blob.id), null)
  await api.removePluginBlob('other', blob.id)
  assert.ok(await api.getPluginBlob('plugin', blob.id))
  await assert.rejects(api.getPluginBlob('plugin', '../../outside'), /附件标识/)
  await api.removePluginBlob('plugin', blob.id)
  assert.equal(await api.getPluginBlob('plugin', blob.id), null)
})
test('关闭 owner 后原生对话框晚返回不会写文件，焦点与活动立即释放', async () => {
  const s = scope(),
    destination = join(state.root, 'must-not-exist.txt')
  const saving = api.savePluginFile('plugin', {
    defaultName: 'draft.txt',
    content: 'never written',
  })
  const rejected = assert.rejects(saving, /插件已关闭/)
  assert.equal(state.leases, 1)
  assert.equal(s.activityCount, 1)
  s.markClosing()
  await rejected
  assert.equal(state.leases, 0)
  assert.equal(s.activityCount, 0)
  state.dialogs[0].resolve({ canceled: false, filePath: destination })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(state.writes.length, 0)
  await assert.rejects(readFile(destination), { code: 'ENOENT' })
})
test('取消保存返回 null；同插件只允许一个对话框，settle 后可再次保存', async () => {
  const s = scope()
  const first = api.savePluginFile('plugin', { content: 'draft' })
  await assert.rejects(
    api.savePluginFile('plugin', { content: 'duplicate' }),
    /已有保存对话框/,
  )
  state.dialogs[0].resolve({ canceled: true })
  assert.equal(await first, null)
  assert.equal(state.writes.length, 0)
  assert.equal(s.activityCount, 0)
  assert.equal(state.leases, 0)
  const destination = join(state.root, 'export.txt'),
    next = api.savePluginFile('plugin', {
      defaultName: '../../export.txt',
      content: 'saved',
    })
  assert.equal(state.dialogs[1].args[0].defaultPath, 'export.txt')
  state.dialogs[1].resolve({ canceled: false, filePath: destination })
  assert.deepEqual(await next, { ok: true, path: destination })
  assert.equal(await readFile(destination, 'utf8'), 'saved')
  assert.equal(s.activityCount, 0)
  assert.equal(state.leases, 0)
})
test('保存临时文件期间关闭会清理残留，不覆盖用户现有目标', async () => {
  const s = scope(),
    gate = deferred(),
    destination = join(state.root, 'target.txt')
  let reached = false
  await writeFile(destination, 'original contents', 'utf8')
  state.writeGate = async () => {
    reached = true
    await gate.promise
  }
  const saving = api.savePluginFile('plugin', { content: 'must roll back' })
  const rejected = assert.rejects(saving, /abort|closing|stale/i)
  state.dialogs[0].resolve({ canceled: false, filePath: destination })
  await until(() => reached)
  s.markClosing()
  gate.resolve()
  await rejected
  assert.deepEqual(await readdir(state.root), ['target.txt'])
  assert.equal(await readFile(destination, 'utf8'), 'original contents')
  assert.equal(s.activityCount, 0)
  assert.equal(state.leases, 0)
})
