import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../../', import.meta.url))
function png(size, marker = 1) {
  const data = Buffer.alloc(32, marker)
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(data)
  data.writeUInt32BE(size, 16); data.writeUInt32BE(size, 20)
  return data
}
function icns(images) {
  const chunks = images.map(image => {
    const header = Buffer.alloc(8); header.write('ic07'); header.writeUInt32BE(image.length + 8, 4)
    return Buffer.concat([header, image])
  })
  const header = Buffer.alloc(8); header.write('icns'); header.writeUInt32BE(8 + chunks.reduce((sum, chunk) => sum + chunk.length, 0), 4)
  return Buffer.concat([header, ...chunks])
}
async function fixture(t, platform, dataHome) {
  const adapters = {
    'fixture': `export const state={files:[],buffers:[],processes:[],shortcuts:{},now:Date.now(),fail:false};
      export const image=value=>({isEmpty:()=>!value,getSize:()=>({width:128,height:128}),resize:()=>image(value),toDataURL:()=>value});`,
    electron: `import {state,image} from 'fixture';export const app={getFileIcon:async path=>{state.files.push(path);if(state.fail)throw Error('temporary');return image('native:'+path)}};export const nativeImage={createFromBuffer:buffer=>{state.buffers.push(buffer);return image('data:image/png;base64,'+buffer.toString('base64'))},createFromPath:path=>image('file:'+path)};export const shell={readShortcutLink:path=>state.shortcuts[path],openPath:async()=>''};`,
    './appScanner': 'export const getCachedApps=()=>null;',
    '@main/logs/logService': 'export const logError=()=>{};export const logInfo=()=>{};export const logWarn=()=>{};',
    'node:child_process': `import {state} from 'fixture';export const spawn=()=>{throw Error('unexpected launch')};export const execFile=(file,args,options,cb)=>{state.processes.push(file);cb(null,'{}')};`
  }
  const bundled = await build({
    stdin: { contents: `export * from '@main/launcher/appLauncher';export {state} from 'fixture';export const nonce=${Math.random()}`, resolveDir: root },
    bundle: true, write: false, platform: 'node', format: 'esm', tsconfig: join(root, 'tsconfig.node.json'),
    define: { 'process.platform': JSON.stringify(platform), ...(dataHome ? { 'process.env.XDG_DATA_HOME': JSON.stringify(dataHome), 'process.env.XDG_DATA_DIRS': JSON.stringify(join(dataHome, 'missing')) } : {}) },
    plugins: [{ name: 'fixtures', setup(builder) {
      builder.onResolve({ filter: /.*/ }, ({ path }) => path in adapters ? { path, namespace: 'fixture' } : undefined)
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({ contents: adapters[path] }))
    } }]
  })
  return import('data:text/javascript;base64,' + Buffer.from(bundled.outputFiles[0].text).toString('base64'))
}
async function directory(t) {
  const dir = await mkdtemp(join(tmpdir(), 'enest-icon-unit-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

test('macOS reads native colour PNG from the declared ICNS, coalesces requests and reuses cached results', async t => {
  const dir = await directory(t), app = join(dir, 'Colour.app'), resources = join(app, 'Contents/Resources')
  await mkdir(resources, { recursive: true })
  await writeFile(join(app, 'Contents/Info.plist'), '<plist><dict><key>CFBundleIconFile</key><string>Colour &amp; Original</string></dict></plist>')
  await writeFile(join(resources, 'Colour & Original.icns'), icns([png(32, 2), png(256, 3), png(128, 4)]))
  const api = await fixture(t, 'darwin')
  const icons = await Promise.all(Array.from({ length: 8 }, () => api.getAppIconDataUrl(app)))
  assert.ok(icons.every(icon => icon === 'data:image/png;base64,' + png(128, 4).toString('base64')))
  assert.equal(api.state.buffers.length, 1)
  assert.deepEqual(api.state.processes, [])
  assert.deepEqual(api.state.files, [])
  assert.equal(await api.getAppIconDataUrl(app), icons[0])
  assert.equal(api.state.buffers.length, 1)
})

test('ICNS selection rejects truncated lengths and handles unknown chunks without unsafe reads', async t => {
  const api = await fixture(t, 'darwin')
  assert.equal(api.extractIcnsPng(Buffer.from('icns')), undefined)
  const bad = icns([png(128)]); bad.writeUInt32BE(bad.length + 1, 4)
  assert.equal(api.extractIcnsPng(bad), undefined)
  const loop = icns([png(128)]); loop.writeUInt32BE(0, 12)
  assert.equal(api.extractIcnsPng(loop), undefined)
  assert.deepEqual(api.extractIcnsPng(icns([png(64, 1), png(32, 2)])), png(64, 1))
})

test('Windows resolves a shortcut target and preserves explicit native icon resources', async t => {
  const api = await fixture(t, 'win32')
  api.state.shortcuts['App.lnk'] = { target: 'Colour.exe' }
  assert.equal(await api.getAppIconDataUrl('App.lnk'), 'native:Colour.exe')
  api.state.shortcuts['Custom.lnk'] = { target: 'Tool.exe', icon: 'Colour.ico' }
  assert.equal(await api.getAppIconDataUrl('Custom.lnk'), 'file:Colour.ico')
  api.state.shortcuts['Resource.lnk'] = { target: 'Tool.exe', icon: 'Icons.dll', iconIndex: 5 }
  assert.equal(await api.getAppIconDataUrl('Resource.lnk'), 'native:Resource.lnk')
  assert.deepEqual(api.state.files, ['Colour.exe', 'Resource.lnk'])
})

test('Linux finds sized hicolor application icons and uses iconName as part of the cache key', async t => {
  const dir = await directory(t), icons = join(dir, 'icons/hicolor/128x128/apps')
  await mkdir(icons, { recursive: true })
  await writeFile(join(icons, 'colour.png'), png(128))
  await writeFile(join(icons, 'other.png'), png(128, 2))
  const api = await fixture(t, 'linux', dir)
  assert.equal(await api.getAppIconDataUrl('tool %U', 'colour'), 'file:' + join(icons, 'colour.png'))
  assert.equal(await api.getAppIconDataUrl('tool %U', 'other'), 'file:' + join(icons, 'other.png'))
  assert.deepEqual(api.state.files, [], 'Exec command lines never go to getFileIcon')
})

test('successful cache is bounded and temporary extraction failure retries after its short TTL', async t => {
  const api = await fixture(t, 'win32')
  await api.getAppIconDataUrl('first.exe')
  for (let i = 0; i < 256; i++) await api.getAppIconDataUrl('app' + i + '.exe')
  await api.getAppIconDataUrl('first.exe')
  assert.equal(api.state.files.filter(path => path === 'first.exe').length, 2)
  api.state.fail = true
  assert.equal(await api.getAppIconDataUrl('retry.exe'), undefined)
  api.state.fail = false
  assert.equal(await api.getAppIconDataUrl('retry.exe'), undefined)
  const originalNow = Date.now
  Date.now = () => originalNow() + 16_000
  try { assert.equal(await api.getAppIconDataUrl('retry.exe'), 'native:retry.exe') }
  finally { Date.now = originalNow }
})
