import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { build } from 'esbuild'

const snapshot = JSON.parse(await readFile('build/open-with.json', 'utf8'))
const stubs = {
  fixture: `export const state={packaged:true,exe:'',calls:[],files:new Map(),executables:new Set(),tools:true};`,
  electron: `import {state} from 'fixture'; export const app={get isPackaged(){return state.packaged},getAppPath:()=>'/pkg',getPath:()=>state.exe,
    setAsDefaultProtocolClient:scheme=>{state.calls.push({scheme});return true}}; export const dialog={},shell={};`,
  'node:fs': `import {state} from 'fixture';export const constants={X_OK:1},existsSync=()=>state.tools;`,
  'node:path': `import {posix,win32} from '#native-path';export {win32};export const {dirname,basename,join,isAbsolute}=posix;`,
  'node:fs/promises': `import {state} from 'fixture';export const readFile=async path=>{if(state.files.has(path))return state.files.get(path);throw Object.assign(Error(),{code:'ENOENT'})};
    export const access=async path=>{if(!state.executables.has(path))throw Error()};export const stat=async path=>({isFile:()=>state.executables.has(path)});`,
  './registrar': `import {state} from 'fixture';export const registrationAvailable=()=>state.packaged;
    export async function run(command,args,_timeout,input){state.calls.push({command,args,input});return state.reply(command,args,input)}`
}
const built = await build({
  stdin: { contents: `export {win32Registrar as windows} from '@main/openWith/win32';export {linuxRegistrar as linux} from '@main/openWith/linux';
    export {darwinRegistrar as mac} from '@main/openWith/darwin';export {state} from 'fixture';`, resolveDir: process.cwd() },
  tsconfig: 'tsconfig.node.json', bundle: true, write: false, platform: 'node', format: 'esm',
  define: { 'import.meta.glob': 'packageGlob', 'process.env.XDG_DATA_HOME': '"/user"', 'process.env.XDG_DATA_DIRS': '"/system"',
    'process.env.PATH': '"/tools"', 'process.env.SystemRoot': '"C:/Windows"', 'process.windowsStore': 'false',
    'process.resourcesPath': '"/resources"', 'process.getSystemVersion': 'systemVersion' },
  banner: { js: `const packageGlob=(path,options)=>path==='/build/open-with.json'?{[path]:${JSON.stringify(snapshot)}[options.import]}:{};const systemVersion=()=>'15.0';` },
  plugins: [{ name: 'isolated-platforms', setup(builder) {
    builder.onResolve({ filter: /.*/ }, ({ path }) => path === '#native-path' ? { path: 'node:path', external: true }
      : Object.hasOwn(stubs, path) ? { path, namespace: 'stub' } : undefined)
    builder.onLoad({ filter: /.*/, namespace: 'stub' }, ({ path }) => ({ contents: stubs[path] }))
  } }]
})
let sequence = 0
const fixture = () => import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}#${++sequence}`)
const unavailable = { canSetDefault: false, needsSystemSettings: false }
const output = (stdout, code = 0) => ({ code, stdout, stderr: '' })

test('Linux uses the exact installed desktop ID, XDG precedence and Desktop Entry MIME types for both kinds', async () => {
  const { linux, state } = await fixture()
  const id = 'org.example.Shell.desktop'
  const entry = '[Desktop Entry]\nType=Application\nExec=/tools/enest %U\nMimeType=application/json;x-scheme-handler/test-open;\n[Desktop Action Other]\nMimeType=text/plain;'
  state.files.set('/pkg/package.json', JSON.stringify({ desktopName: id }))
  state.files.set('/user/applications/unrelated.desktop', entry)
  state.executables.add('/tools/xdg-mime').add('/tools/enest')
  assert.deepEqual(await linux.caps('ext', 'jsonc'), unavailable)
  state.files.set(`/system/applications/${id}`, entry)
  state.files.set(`/user/applications/${id}`, '[Desktop Entry]\nHidden=true')
  assert.deepEqual(await linux.caps('ext', 'jsonc'), unavailable)
  state.files.delete(`/user/applications/${id}`)
  state.files.set(`/user/applications/${id}`, entry.replace('/tools/enest', '/gone/enest'))
  assert.deepEqual(await linux.caps('ext', 'jsonc'), unavailable)
  state.files.delete(`/user/applications/${id}`)
  assert.deepEqual(await linux.caps('ext', 'txt'), unavailable)
  assert.deepEqual(await linux.caps('ext', 'pdf'), unavailable)
  assert.deepEqual(await linux.caps('scheme', 'missing-scheme'), unavailable)
  assert.deepEqual(state.calls, [])
  for (const [kind, value, mime] of [['ext', 'jsonc', 'application/json'], ['scheme', 'test-open', 'x-scheme-handler/test-open']]) {
    let selected = 'other.desktop'
    state.reply = (_, args) => output(args[0] === 'query' ? selected : '')
    assert.equal((await linux.caps(kind, value)).canSetDefault, true)
    assert.equal((await linux.setDefault(kind, value)).ok, false, 'a successful setter is not a confirmed default')
    assert.deepEqual(state.calls.at(-2).args, ['default', id, mime])
    selected = id
    assert.deepEqual(await linux.setDefault(kind, value), { ok: true, status: 'default' })
  }
  state.executables.delete('/tools/xdg-mime')
  assert.deepEqual(await linux.caps('ext', 'jsonc'), unavailable)
  assert.equal(await linux.detect('ext', 'jsonc'), undefined)
})

test('Windows registers selectable handlers without writing UserChoice, an extension default or a protocol command', async () => {
  const { windows, state } = await fixture()
  state.exe = 'C:\\Program Files\\eNest\\eNest.exe'
  let selected = 'C:\\Different\\eNest.exe'
  state.reply = command => command.endsWith('reg.exe') ? output('') : output(JSON.stringify({ selected, resolved: true, candidates: [state.exe] }))
  for (const [kind, value, association] of [['scheme', 'test-open', 'test-open'], ['ext', 'md', '.md']]) {
    assert.deepEqual(await windows.caps(kind, value), { canSetDefault: false, needsSystemSettings: true })
    const result = await windows.setDefault(kind, value)
    assert.equal(result.status, 'candidate')
    assert.match(result.hint, /默认应用/)
    const writes = state.calls.filter(call => call.command?.endsWith('reg.exe'))
    assert.ok(writes.some(({ args }) => args[1].endsWith('Capabilities\\' + (kind === 'ext' ? 'FileAssociations' : 'URLAssociations')) && args.includes(association)))
    assert.ok(writes.every(({ args }) => !args[1].includes('UserChoice') && !args[1].includes('Classes\\test-open') && args[1] !== 'HKCU\\Software\\Classes\\.md'))
    assert.deepEqual(JSON.parse(state.calls.at(-1).input).name, association)
    selected = state.exe.toUpperCase()
    assert.deepEqual(await windows.setDefault(kind, value), { ok: true, status: 'default' })
    selected = 'C:\\Different\\eNest.exe'
  }
  state.reply = command => command.endsWith('reg.exe') ? output('') : output('', 1)
  assert.equal((await windows.setDefault('ext', 'md')).ok, false)
  state.calls.length = 0
  assert.deepEqual(await windows.caps('scheme', 'ms-example'), unavailable)
  assert.equal((await windows.setDefault('scheme', 'ms-example')).ok, false)
  assert.deepEqual(state.calls, [])
})

test('macOS queries only the selected association again after Finder changes and never infers default from submission', async () => {
  const { mac, state } = await fixture()
  state.exe = '/Applications/App.app/Contents/MacOS/App'
  const bundleId = 'org.example.Shell'
  let selected = 'other.app'
  state.reply = command => command.endsWith('plutil') ? output(JSON.stringify({ CFBundleIdentifier: bundleId,
    CFBundleDocumentTypes: [{ CFBundleTypeExtensions: ['md'] }], CFBundleURLTypes: [{ CFBundleURLSchemes: ['test-open'] }] }))
    : output(JSON.stringify({ defaultBundleId: selected, candidateBundleIds: [bundleId] }))
  assert.deepEqual(await mac.caps('ext', 'missing'), unavailable)
  assert.deepEqual(await mac.caps('ext', 'md'), { canSetDefault: false, needsSystemSettings: true })
  assert.match((await mac.setDefault('ext', 'md')).hint, /Finder/)
  assert.equal((await mac.setDefault('scheme', 'test-open')).ok, false)
  assert.equal(await mac.detect('ext', 'md'), 'candidate')
  selected = bundleId
  assert.equal(await mac.detect('ext', 'md'), 'default')
  assert.deepEqual(state.calls.slice(-2).map(({ args }) => JSON.parse(args.at(-1))), [{ kind: 'ext', value: 'md' }, { kind: 'ext', value: 'md' }])
})
