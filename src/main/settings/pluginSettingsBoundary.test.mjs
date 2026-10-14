import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const adapters = {
  electron: 'export const nativeTheme={shouldUseDarkColors:false};',
  '@main/paths/pathsService': 'export const getDefaultSettingsPath=()=>"/not-created/enest-boundary-settings.json";export const setAppPathsRoot=()=>{};',
  '@main/window/createShellWindow': 'export const sendShellEvent=()=>{};',
  '@main/window/orbRailViews': 'export const refreshOrbRailContribEntries=()=>{};',
  '@main/logs/logService': 'export const logInfo=()=>{};export const logWarn=()=>{};',
  '@main/db/sqliteService': `import {DatabaseSync} from 'node:sqlite';const db=new DatabaseSync(':memory:');
    export const kvStore={getDatabase:()=>db,initDatabase:async()=>{},getBackend:()=> 'sqlite'};
    export const runInTransaction=(_db,fn)=>{db.exec('BEGIN');try{fn();db.exec('COMMIT')}catch(error){db.exec('ROLLBACK');throw error}};`
}
const output = await build({
  stdin: { contents: `export {settingsStore as store} from '@main/settings/SettingsStore';
    export {PluginSettingsBridge} from '@main/settings/PluginSettingsBridge';
    export {contributionRegistry as registry} from '@main/contrib/ContributionRegistry';`, resolveDir: root },
  tsconfig: root + 'tsconfig.node.json', bundle: true, write: false, platform: 'node', format: 'esm',
  plugins: [{ name: 'isolated-settings-boundary', setup(builder) {
    builder.onResolve({ filter: /.*/ }, ({ path }) => path in adapters ? { path, namespace: 'mock' } : undefined)
    builder.onLoad({ filter: /.*/, namespace: 'mock' }, ({ path }) => ({ contents: adapters[path] }))
  } }]
})
const { store, PluginSettingsBridge, registry } = await import('data:text/javascript;base64,' + Buffer.from(output.outputFiles[0].text).toString('base64'))
await store.load()
const reserved = ['permissionGrants', '__proto__', 'prototype', 'constructor']

test('registering a business setting cannot grant sensitive permissions or mutate prototypes', async () => {
  const id = 'com.test.settings-boundary'
  const bridge = new PluginSettingsBridge()
  await store.setPermissionGrant(id, 'fs.read', 'deny')
  bridge.register(id, { id: 'business', title: 'Business', items: [
    ...reserved.map(key => ({ key, type: 'text', label: key, default: { 'fs.read': 'allow' } })),
    { key: 'density', type: 'text', label: 'Density', default: 'compact' }
  ] })
  assert.deepEqual(bridge.listAll().find(section => section.pluginId === id).items.map(item => item.key), ['density'])
  for (const key of reserved) {
    assert.equal(bridge.get(id, key), undefined)
    assert.throws(() => bridge.set(id, key, { 'fs.read': 'allow' }), /reserved plugin settings key/)
    await assert.rejects(store.setPluginSetting(id, key, { 'fs.read': 'allow' }), /reserved plugin settings key/)
  }
  assert.equal(store.getPermissionGrant(id, 'fs.read'), 'deny')
  assert.equal(store.getPermissionGrant(id, 'sys.control'), 'ask')
  await store.setPluginSetting(id, 'density', 'comfortable')
  assert.deepEqual(store.getPluginSettings(id), { density: 'comfortable' })
  assert.deepEqual(store.getPermissionGrants(id), { 'fs.read': 'deny' })
  store.flushNow()
})

test('legacy manifest sections and persisted bags cannot expose host fields or another plugin settings', async () => {
  const id = 'com.test.settings-legacy'
  registry.registerManifestContributes(id, { settings: [{ id: 'old', title: 'Old', items: [
    ...reserved.map(key => ({ key, type: 'text', label: key, default: 'hidden' })),
    { key: 'prefs', type: 'text', label: 'Preferences', default: 'default' }
  ] }] })
  await store.setAll({ plugins: {
    [id]: JSON.parse('{"permissionGrants":{"fs.read":"deny"},"__proto__":{"polluted":true},"constructor":"hidden","prototype":"hidden","prefs":{"value":7}}'),
    'com.test.settings-other': { prefs: 'other plugin value' }
  } })
  const bridge = new PluginSettingsBridge()
  assert.deepEqual(bridge.listAll().find(section => section.pluginId === id).items.map(item => item.key), ['prefs'])
  for (const key of reserved) assert.equal(bridge.get(id, key), undefined)
  const values = store.getPluginSettings(id)
  assert.deepEqual(values, { prefs: { value: 7 } })
  values.prefs.value = 9
  assert.equal(store.getPluginSettings(id).prefs.value, 7)
  assert.equal(store.getPluginSettings('com.test.settings-other').prefs, 'other plugin value')
  assert.equal({}.polluted, undefined)
  store.flushNow()
})

test('theme provenance clears only explicitly pack-derived snapshots and preserves user and unmarked legacy backgrounds', async () => {
  const legacy = { type: 'image', value: '/Users/example/legacy.png', opacity: 0.8, fit: 'cover' }
  await store.setAll({ theme: { mode: 'light', overrides: {}, packId: 'test-theme', background: legacy } })
  await store.setTheme({ mode: 'dark' })
  assert.deepEqual(store.getTheme().background, legacy)
  assert.equal(store.getTheme().backgroundSource, undefined)
  await store.setTheme({ backgroundSource: 'pack', background: legacy })
  assert.equal(store.getTheme().backgroundSource, 'pack')
  assert.equal(store.getTheme().background, undefined)
  const user = { ...legacy, value: '/Users/example/user-selected.png' }
  await store.setTheme({ backgroundSource: 'user', background: user })
  await store.setTheme({ mode: 'light' })
  assert.deepEqual(store.getTheme().background, user)
  assert.equal(store.getTheme().backgroundSource, 'user')
  await assert.rejects(store.setTheme({ backgroundSource: 'invalid', background: legacy }), /invalid background source/)
  assert.deepEqual(store.getTheme().background, user)
  store.flushNow()
})
