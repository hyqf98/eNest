import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'

const directory = await realpath(await mkdtemp(join(tmpdir(), 'enest-user-path-')))
const fixtureHome = join(directory, 'home')
const state = { opened: [], error: '', sourcePaths: [], records: [] }
globalThis.__userPathFixture = state
const adapters = {
  'node:os': `export const homedir=()=>${JSON.stringify(fixtureHome)};`,
  electron: `export const nativeTheme={shouldUseDarkColors:false};export const shell={openPath:async path=>{const s=globalThis.__userPathFixture;s.opened.push(path);return s.error}};export const dialog={showOpenDialog:async()=>({canceled:true,filePaths:[]})};`,
  '@main/window/createShellWindow': 'export const sendShellEvent=()=>{};',
  '@main/db/sqliteService': `import {DatabaseSync} from 'node:sqlite';const db=new DatabaseSync(':memory:');export const kvStore={getDatabase:()=>db,initDatabase:async()=>{},getBackend:()=> 'sqlite'};`,
  '@main/logs/logService': 'export const logInfo=()=>{};export const logWarn=()=>{};',
  '@main/plugin/PluginRegistry': 'export const pluginRegistry={addDevPlugin:summary=>summary};',
  '@main/plugin/PluginHost': 'export const pluginHost={isOpen:()=>false};',
  './devPluginsStore': `export const readDevPluginRecords=async()=>[];export const dropDevPluginRecord=async()=>{};export const upsertDevPluginRecord=async(id,path)=>globalThis.__userPathFixture.records.push({id,path});`,
  './devPluginEntry': `export const resolveDevPluginEntry=async sourcePath=>{globalThis.__userPathFixture.sourcePaths.push(sourcePath);return {rootPath:sourcePath,manifest:{id:'test.path',name:'Path test',version:'1.0.0'}}};`
}
const output = await build({
  stdin: { contents: "export * from '@main/paths/pathsService';export * from '@main/paths/openLocalPath';export {loadDevPlugin} from '@main/dev/DevConsole';export {SettingsStore} from '@main/settings/SettingsStore';", resolveDir: process.cwd() },
  tsconfig: 'tsconfig.node.json', bundle: true, write: false, format: 'esm', platform: 'node',
  plugins: [{ name: 'local-path-boundaries', setup(builder) {
    builder.onResolve({ filter: /.*/ }, ({ path }) => path in adapters ? { path, namespace: 'fixture' } : undefined)
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({ contents: adapters[path], loader: 'js' }))
  } }]
})
const api = await import('data:text/javascript;base64,' + Buffer.from(output.outputFiles[0].text).toString('base64'))
test.after(async () => { delete globalThis.__userPathFixture; await rm(directory, { recursive: true, force: true }) })

test('developer loading passes and persists expanded home and explicit cwd paths', async () => {
  const homePlugin = await api.loadDevPlugin('~/Plugins/demo')
  assert.equal(homePlugin.sourcePath, join(fixtureHome, 'Plugins/demo'))
  assert.equal(state.sourcePaths.at(-1), homePlugin.sourcePath)
  assert.equal(state.records.at(-1).path, homePlugin.sourcePath)
  const relativePlugin = await api.loadDevPlugin('./plugins/demo')
  assert.equal(relativePlugin.sourcePath, resolve('plugins/demo'))
  const before = state.sourcePaths.length
  await assert.rejects(api.loadDevPlugin('user@server:/plugins/demo'), /本地路径/)
  assert.equal(state.sourcePaths.length, before)
})

test('data paths retain the old relative cwd base and existing literal-tilde directories', async () => {
  const previous = process.cwd()
  try {
    process.chdir(directory)
    api.setAppPathsRoot('./legacy-data')
    assert.equal(api.getAppPathsRoot(), join(directory, 'legacy-data'))
    assert.equal(api.getAppPaths('./override').root, join(directory, 'override'))
    await mkdir(join(directory, '~', 'existing-data'), { recursive: true })
    api.setAppPathsRoot('~/existing-data')
    assert.equal(api.getAppPathsRoot(), join(directory, '~', 'existing-data'))
    assert.equal(api.getAppPaths('~/existing-data').root, join(directory, '~', 'existing-data'))
    api.setAppPathsRoot('~/new-data')
    assert.equal(api.getAppPathsRoot(), join(fixtureHome, 'new-data'))
  } finally { process.chdir(previous); api.setAppPathsRoot(null) }
})

test('new data root edits persist absolute paths, while malformed input leaves settings unchanged', async () => {
  const previous = process.cwd()
  const store = new api.SettingsStore()
  try {
    process.chdir(directory)
    await store.load()
    const settings = await store.setAll({ general: { dataRoot: './new-data' } })
    assert.equal(settings.general.dataRoot, join(directory, 'new-data'))
    assert.equal(api.getAppPathsRoot(), join(directory, 'new-data'))
    const anchor = JSON.parse(await readFile(api.getDefaultSettingsPath(), 'utf8'))
    assert.equal(anchor.general.dataRoot, join(directory, 'new-data'))
    const before = store.getAll()
    await assert.rejects(store.setAll({ general: { locale: 'en-US', dataRoot: 'ssh://server/data' } }), /本地路径/)
    assert.deepEqual(store.getAll(), before)
    assert.equal(api.getAppPathsRoot(), join(directory, 'new-data'))
    // A new edit is intentionally home-relative even when a literal legacy ~/ directory exists.
    await store.setAll({ general: { dataRoot: '~/existing-data' } })
    assert.equal(store.getAll().general.dataRoot, join(fixtureHome, 'existing-data'))
    assert.equal(api.getAppPathsRoot(), join(fixtureHome, 'existing-data'))
  } finally { store.flushNow(); process.chdir(previous); api.setAppPathsRoot(null) }
})

test('native path opening uses Electron shell and reports OS failures without accepting remote targets', async () => {
  await api.openLocalPath('~/Downloads')
  assert.equal(state.opened.at(-1), join(fixtureHome, 'Downloads'))
  await api.openLocalPath('.')
  assert.equal(state.opened.at(-1), process.cwd())
  const count = state.opened.length
  await assert.rejects(api.openLocalPath('ssh://server/data'), /本地路径/)
  assert.equal(state.opened.length, count)
  state.error = 'directory unavailable'
  await assert.rejects(api.openLocalPath('/missing'), /directory unavailable/)
  state.error = ''
})
