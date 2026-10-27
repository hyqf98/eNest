import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, writeFile, rm, symlink, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { build } from 'esbuild'

const state = { scope: null, manifest: null, root: null, granted: false, devUrl: undefined }
globalThis.__backendPathFixture = state
const adapters = {
  electron: `export const app={getVersion:()=> '0.1.0'};`,
  '@main/plugin/PluginRegistry': `const s=globalThis.__backendPathFixture;export const pluginRegistry={getManifest:()=>s.manifest,getRootPath:()=>s.root,get:()=>({devUrl:s.devUrl})};`,
  '@main/plugin/PluginRuntimeScope': `export const getRuntimeScope=()=>globalThis.__backendPathFixture.scope;`,
  '@main/plugin/PermissionService': `export const permissionService={isGranted:()=>globalThis.__backendPathFixture.granted};`,
  '@main/logs/logService': `export const logInfo=()=>{};export const logWarn=()=>{};`,
  './pluginInstallTasks': `export const extractPluginArchive=()=>{};export const writePluginBuildRevision=()=>{};`
}
const bundle = await build({
  stdin: { contents: `export * from '@main/plugin/pluginBackend'; export * from '@main/plugin/pluginBackendPath'; export * from '@main/plugin/pluginPaths'; export {installFromDirectory} from '@main/plugin/PluginInstaller';`, resolveDir: process.cwd() },
  tsconfig: 'tsconfig.node.json', bundle: true, write: false, platform: 'node', format: 'esm',
  plugins: [{ name: 'backend-path-fixture', setup(b) {
    b.onResolve({ filter: /.*/ }, x => x.path in adapters ? { path: x.path, namespace: 'fixture' } : undefined)
    b.onLoad({ filter: /.*/, namespace: 'fixture' }, x => ({ contents: adapters[x.path], loader: 'js' }))
  } }]
})
const api = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'))
const manifest = () => ({ id: 'com.test.backend', name: 'Backend', description: 'Backend fixture', version: '0.1.0', main: 'index.html', icon: 'assets/market/icon.svg', market: { readme: 'assets/market/README.md', screenshots: ['assets/market/screenshots/main.webp'] } })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'enest-backend-path-'))
  await mkdir(join(root, 'assets/market/screenshots'), { recursive: true })
  await mkdir(join(root, 'backend'), { recursive: true })
  for (const [name, value] of [['index.html', '<html/>'], ['assets/market/icon.svg', '<svg/>'], ['assets/market/README.md', 'fixture'], ['assets/market/screenshots/main.webp', 'fixture'], ['backend/index.cjs', 'module.exports={}']]) await writeFile(join(root, name), value)
  return root
}

test('backend entry rejects encoded traversal, absolute paths and every symlink component', async () => {
  const root = await fixture(), outside = await mkdtemp(join(tmpdir(), 'enest-backend-outside-'))
  try {
    assert.equal(api.resolveBackendFile(root, 'backend/index.cjs'), await realpath(join(root, 'backend/index.cjs')))
    for (const entry of ['../index.cjs', '/tmp/index.cjs', 'backend/../index.cjs', 'backend/%2e%2e/index.cjs', 'backend/a\\index.cjs', 'backend//index.cjs', 'backend/.hidden/index.cjs', 'backend/index.ts', 'backend/index.cjs?x=1', 'backend/index.cjs\0']) assert.throws(() => api.resolveBackendFile(root, entry), undefined, entry)
    await writeFile(join(outside, 'outside.cjs'), '')
    await symlink(join(outside, 'outside.cjs'), join(root, 'backend/link.cjs'))
    await symlink(outside, join(root, 'backend/linkdir'))
    for (const entry of ['backend/link.cjs', 'backend/linkdir/outside.cjs']) assert.throws(() => api.resolveBackendFile(root, entry), /symbolic links/)
  } finally { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }) }
})

test('backend launch requires declaration, current live scope and explicit runtime grant; dev entry comes only from dist', async () => {
  const root = await fixture(), controller = new AbortController()
  try {
    state.root = root; state.manifest = { ...manifest(), backend: { entry: 'backend/index.cjs' }, permissions: ['backend.node'] }; state.granted = true; state.devUrl = undefined
    state.scope = { isCurrent: () => true, isClosing: false, signal: controller.signal }
    assert.equal(api.resolvePluginBackendPackage('com.test.backend').entry, await realpath(join(root, 'backend/index.cjs')))
    state.granted = false; assert.throws(() => api.resolvePluginBackendPackage('com.test.backend'), /permission denied/); state.granted = true
    state.manifest.permissions = []; assert.throws(() => api.resolvePluginBackendPackage('com.test.backend'), /permission denied/); state.manifest.permissions = ['backend.node']
    state.scope.isCurrent = () => false; assert.throws(() => api.resolvePluginBackendPackage('com.test.backend'), /stale/); state.scope.isCurrent = () => true
    state.scope.isClosing = true; assert.throws(() => api.resolvePluginBackendPackage('com.test.backend'), /closing/); state.scope.isClosing = false
    state.devUrl = 'http://127.0.0.1:5173/'; assert.throws(() => api.resolvePluginBackendPackage('com.test.backend'), /ENOENT/)
    await mkdir(join(root, 'dist/backend'), { recursive: true }); await writeFile(join(root, 'dist/backend/index.cjs'), '')
    assert.equal(api.resolvePluginBackendPackage('com.test.backend').entry, await realpath(join(root, 'dist/backend/index.cjs')))
    controller.abort(); assert.throws(() => api.resolvePluginBackendPackage('com.test.backend'), /closing|stale/)
  } finally { state.scope = null; await rm(root, { recursive: true, force: true }) }
})

test('renderer public-file resolution never exposes backend entry, dependencies or native assets', async () => {
  const root = await fixture()
  try {
    await mkdir(join(root, 'backend/node_modules/driver'), { recursive: true })
    await writeFile(join(root, 'backend/node_modules/driver/native.node'), 'native')
    for (const source of [false, true]) for (const path of ['backend/index.cjs', 'backend/node_modules/driver/native.node', 'backend/../backend/index.cjs', 'assets/../backend/index.cjs', 'assets/%2e%2e/backend/index.cjs']) assert.equal(await api.resolvePluginFile(root, path, source), null, `${source}: ${path}`)
    assert.equal(await api.resolvePluginFile(root, 'index.html'), await realpath(join(root, 'index.html')))
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('published legacy and backend packages retain distinct validated installation layouts', async () => {
  const root = await fixture()
  const writeManifest = async value => writeFile(join(root, 'plugin.json'), JSON.stringify(value))
  try {
    await rm(join(root, 'backend'), { recursive: true })
    await writeManifest(manifest()); assert.equal((await api.installFromDirectory(root)).id, 'com.test.backend')
    await mkdir(join(root, 'backend/node_modules/driver'), { recursive: true }); await writeFile(join(root, 'backend/index.cjs'), 'module.exports={}'); await writeFile(join(root, 'backend/node_modules/driver/native.node'), 'fixture')
    await assert.rejects(api.installFromDirectory(root), /非标准发布内容/)
    const withBackend = { ...manifest(), backend: { entry: 'backend/index.cjs' }, permissions: ['backend.node'] }
    await writeManifest({ ...withBackend, permissions: [] }); await assert.rejects(api.installFromDirectory(root), /invalid plugin.json/)
    await writeManifest(withBackend); assert.equal((await api.installFromDirectory(root)).backend.entry, 'backend/index.cjs')
    await writeFile(join(root, 'backend/source.ts'), ''); await assert.rejects(api.installFromDirectory(root), /源码或私有文件/); await rm(join(root, 'backend/source.ts'))
    await rm(join(root, 'backend/index.cjs')); await assert.rejects(api.installFromDirectory(root), /ENOENT/)
  } finally { await rm(root, { recursive: true, force: true }) }
})
