import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'

const directory = await mkdtemp(join(tmpdir(), 'enest-permission-settings-'))
const state = { events: [] }
globalThis.__permissionSettingsFixture = state
const adapters = {
  electron: 'export const nativeTheme={shouldUseDarkColors:false};',
  '@main/paths/pathsService': `export const getDefaultSettingsPath=()=>${JSON.stringify(join(directory, 'settings.json'))};export const setAppPathsRoot=()=>{};`,
  '@main/window/createShellWindow': 'export const sendShellEvent=event=>globalThis.__permissionSettingsFixture.events.push(event);',
  '@main/db/sqliteService': `import {DatabaseSync} from 'node:sqlite';const db=new DatabaseSync(':memory:');export const kvStore={getDatabase:()=>db,initDatabase:async()=>{},getBackend:()=> 'sqlite'};`
}
const bundle = await build({
  stdin: { contents: "export {SettingsStore} from '@main/settings/SettingsStore';export * from '@shared/pluginPermissionPolicy';", resolveDir: process.cwd() },
  tsconfig: 'tsconfig.node.json', bundle: true, write: false, platform: 'node', format: 'esm',
  plugins: [{ name: 'isolated-permissions', setup(builder) {
    builder.onResolve({ filter: /.*/ }, ({ path }) => path in adapters ? { path, namespace: 'fixture' } : undefined)
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({ contents: adapters[path] }))
  } }]
})
const { SettingsStore, BUILTIN_PLUGIN_CAPABILITIES, filterPermissionGrants, requiresUserConsent } = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'))
test.after(async () => { delete globalThis.__permissionSettingsFixture; await rm(directory, { recursive: true, force: true }) })

test('legacy built-in denials do not block private capabilities; sensitive grants survive reload', async () => {
  const store = new SettingsStore()
  await store.load()
  await store.setAll({ plugins: { own: { note: 'preserved', permissionGrants: {
    'storage.local': 'deny', 'ui.setTitle': 'deny', 'config.agent.read': 'deny', 'net.fetch': 'allow', unknown: 'allow'
  } } } })
  for (const permission of BUILTIN_PLUGIN_CAPABILITIES) assert.equal(store.getPermissionGrant('own', permission), 'allow')
  assert.equal(store.getPermissionGrant('own', 'config.agent.read'), 'deny')
  assert.equal(store.getPermissionGrant('own', 'net.fetch'), 'allow')
  assert.equal(store.getPermissionGrant('own', 'clipboard.read'), 'ask')
  assert.equal(store.getPermissionGrant('other', 'net.fetch'), 'ask')
  assert.deepEqual(store.getPermissionGrants('own'), { 'net.fetch': 'allow', 'config.agent.read': 'deny' })
  await store.setPermissionGrant('own', 'clipboard.read', 'deny')
  assert.equal(store.getPluginSettings('own').note, 'preserved')
  store.flushNow()
  const restored = new SettingsStore()
  await restored.load()
  assert.equal(restored.getPermissionGrant('own', 'clipboard.read'), 'deny')
  assert.equal(restored.getPermissionGrant('own', 'storage.local'), 'allow')
})

test('only sensitive consent updates are emitted; a built-in denial cannot mutate grants', async () => {
  const store = new SettingsStore()
  await store.load()
  state.events.length = 0
  const before = store.getPermissionGrants('own')
  await assert.rejects(store.setPermissionGrant('own', 'theme', 'deny'), /built-in/)
  assert.deepEqual(store.getPermissionGrants('own'), before)
  assert.deepEqual(state.events, [])
  await store.setPermissionGrant('own', 'config.agent.read', 'allow')
  const event = state.events.find(event => event.type === 'permission-grants-changed')
  assert.equal(event.pluginId, 'own')
  assert.equal(event.grants['config.agent.read'], 'allow')
  assert.equal(event.grants['storage.local'], undefined)
  event.grants['config.agent.read'] = 'deny'
  assert.equal(store.getPermissionGrant('own', 'config.agent.read'), 'allow')
  store.flushNow()
})

test('legacy grants for user-selected file handles and plugin timers are filtered and cannot disable them', async () => {
  const store = new SettingsStore()
  await store.load()
  const defaults = ['fs.read', 'fs.write', 'timer.background']
  const legacyGrants = Object.fromEntries(defaults.map(permission => [permission, 'deny']))
  legacyGrants['config.agent.write'] = 'deny'
  await store.setAll({ plugins: { 'default-available': { permissionGrants: legacyGrants } } })
  assert.deepEqual(filterPermissionGrants(legacyGrants), { 'config.agent.write': 'deny' })
  assert.deepEqual(store.getPermissionGrants('default-available'), { 'config.agent.write': 'deny' })
  for (const permission of defaults) {
    assert.equal(requiresUserConsent(permission), false, permission)
    assert.equal(store.getPermissionGrant('default-available', permission), 'allow', permission)
    await assert.rejects(store.setPermissionGrant('default-available', permission, 'deny'), /built-in/)
  }
  store.flushNow()
  const restored = new SettingsStore()
  await restored.load()
  assert.deepEqual(restored.getPermissionGrants('default-available'), { 'config.agent.write': 'deny' })
  for (const permission of defaults) assert.equal(restored.getPermissionGrant('default-available', permission), 'allow', permission)
})

test('unknown capabilities stay gated and consent filtering ignores inherited or invalid values', () => {
  assert.equal(requiresUserConsent('new.system.permission'), true)
  assert.equal(requiresUserConsent('clipboard.history'), true)
  assert.equal(requiresUserConsent('ui.toast'), false)
  const bag = Object.assign(Object.create({ 'config.agent.read': 'allow' }), {
    'config.agent.write': 'deny', 'clipboard.read': 'invalid', 'ui.toast': 'deny', unknown: 'allow'
  })
  assert.deepEqual(filterPermissionGrants(bag), { 'config.agent.write': 'deny' })
})

test('uninstalled plugin settings and grants stay removed after reload without touching another plugin', async () => {
  const store = new SettingsStore()
  await store.load()
  const removed = 'com.test.uninstalled', retained = 'com.test.retained'
  const otherSettings = { density: 'compact', permissionGrants: { 'config.agent.read': 'deny', 'net.fetch': 'allow' } }
  await store.setAll({ plugins: {
    [removed]: { density: 'comfortable', permissionGrants: { 'clipboard.history': 'allow', 'config.agent.write': 'deny' } },
    [retained]: otherSettings
  } })
  state.events.length = 0
  await store.removePluginSettings(removed)
  assert.deepEqual(store.getPluginSettings(removed), {})
  assert.deepEqual(store.getPermissionGrants(removed), {})
  assert.equal(store.getPermissionGrant(removed, 'clipboard.history'), 'ask')
  assert.equal(store.getPermissionGrant(removed, 'config.agent.write'), 'ask')
  assert.equal(Object.hasOwn(store.getAll().plugins, removed), false)
  assert.deepEqual(store.getAll().plugins[retained], otherSettings)
  assert.deepEqual(state.events, [{ type: 'permission-grants-changed', pluginId: removed, grants: {} }])
  await store.removePluginSettings(removed)
  assert.equal(state.events.length, 1, 'removing absent settings is idempotent')
  store.flushNow()

  const reinstalled = new SettingsStore()
  await reinstalled.load()
  assert.equal(Object.hasOwn(reinstalled.getAll().plugins, removed), false)
  assert.equal(reinstalled.getPermissionGrant(removed, 'clipboard.history'), 'ask')
  assert.equal(reinstalled.getPermissionGrant(removed, 'config.agent.write'), 'ask')
  assert.deepEqual(reinstalled.getAll().plugins[retained], otherSettings)
})
