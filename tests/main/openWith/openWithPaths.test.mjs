import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'

const direct = '\\\\server\\share\\one.md'
const fromUrl = '\\\\server\\share\\two.md'
const rejected = ['\\\\?\\C:\\file.md', '\\\\.\\pipe\\file.md', 'C:file.md', '\\rooted.md', '/rooted.md', '\\\\server']
const cwd = 'C:\\eNest'
const executable = 'C:\\eNest\\eNest.exe'
const adapters = {
  fixture: `export const state={launches:[],probes:[],files:${JSON.stringify([direct, fromUrl, ...rejected, 'C:\\rooted.md', 'C:\\eNest\\file.md'])}};`,
  'node:fs': `import {state} from 'fixture';export const existsSync=path=>{state.probes.push(path);return state.files.includes(path)};export const statSync=()=>({isFile:()=>true});`,
  'node:path': `import {win32} from '#native-path';export {posix,win32} from '#native-path';export const extname=win32.extname;`,
  'node:url': `import {fileURLToPath as native} from '#native-url';export const fileURLToPath=url=>native(url,{windows:true});`,
  electron: `export const app={getAppPath:()=>${JSON.stringify('C:\\eNest\\resources\\app.asar')}};`,
  '@main/launcher/pluginLauncher': `import {state} from 'fixture';export const launchPlugin=async request=>{state.launches.push(request);return {ok:true}};`,
  '@main/logs/logService': 'export const logInfo=()=>{};export const logWarn=()=>{};',
  '@main/plugin/localFiles': 'export const grantLocalFile=async(_owner,path)=>({id:path,displayPath:path});',
  '@main/window/createShellWindow': 'export const getShellWebContents=()=>null;export const sendShellEvent=()=>{};',
  '@main/window/modalSurface': 'export const openNativeModal=async()=>false;',
  './associationService': `export const associationService={resolveTarget:()=>({pluginId:'test.paths',ambiguous:false,providers:[]})};`
}
const output = await build({
  stdin: { contents: "export {handleOpenWithArgv,setOpenWithReadyProbe} from '@main/openWith/openWithRouter';export {state} from 'fixture';", resolveDir: process.cwd() },
  tsconfig: 'tsconfig.node.json', bundle: true, write: false, platform: 'node', format: 'esm',
  define: { process: 'pathFixtureProcess' },
  banner: { js: `const pathFixtureProcess={platform:'win32',cwd:()=>${JSON.stringify(cwd)},execPath:${JSON.stringify(executable)}};` },
  plugins: [{ name: 'open-with-paths', setup(builder) {
    builder.onResolve({ filter: /.*/ }, ({ path }) => path === '#native-url' ? { path: 'node:url', external: true }
      : path === '#native-path' ? { path: 'node:path', external: true }
      : path in adapters ? { path, namespace: 'fixture' } : undefined)
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({ contents: adapters[path] }))
  } }]
})
const api = await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`)

test('Windows external opens preserve UNC paths and file URL shares', async () => {
  api.setOpenWithReadyProbe(() => true)
  api.handleOpenWithArgv([executable, direct, 'file://server/share/two.md', ...rejected])
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(api.state.launches.length, 1)
  assert.deepEqual(api.state.launches[0].enter.payload.paths, [direct, fromUrl])
  assert.deepEqual(api.state.launches[0].enter.payload.handles.map(handle => handle.displayPath), [direct, fromUrl])
  assert.deepEqual(api.state.probes, [direct, fromUrl], 'non-absolute/device arguments are rejected before probing files')
})
