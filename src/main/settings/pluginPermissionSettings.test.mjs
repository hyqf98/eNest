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
    'storage.local': 'deny', 'ui.setTitle': 'deny', 'fs.read': 'deny', 'net.fetch': 'allow', unknown: 'allow'
  } } } })
  for (const permission of BUILTIN_PLUGIN_CAPABILITIES) assert.equal(store.getPermissionGrant('own', permission), 'allow')
  assert.equal(store.getPermissionGrant('own', 'fs.read'), 'deny')
  assert.equal(store.getPermissionGrant('own', 'net.fetch'), 'allow')
  assert.equal(store.getPermissionGrant('own', 'clipboard.read'), 'ask')
  assert.equal(store.getPermissionGrant('other', 'net.fetch'), 'ask')
  assert.deepEqual(store.getPermissionGrants('own'), { 'net.fetch': 'allow', 'fs.read': 'deny' })
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
  await store.setPermissionGrant('own', 'fs.read', 'allow')
  const event = state.events.find(event => event.type === 'permission-grants-changed')
  assert.equal(event.pluginId, 'own')
  assert.equal(event.grants['fs.read'], 'allow')
  assert.equal(event.grants['storage.local'], undefined)
  event.grants['fs.read'] = 'deny'
  assert.equal(store.getPermissionGrant('own', 'fs.read'), 'allow')
  store.flushNow()
})

test('unknown capabilities stay gated and consent filtering ignores inherited or invalid values', () => {
  assert.equal(requiresUserConsent('new.system.permission'), true)
  assert.equal(requiresUserConsent('clipboard.history'), true)
  assert.equal(requiresUserConsent('ui.toast'), false)
  const bag = Object.assign(Object.create({ 'fs.read': 'allow' }), {
    'fs.write': 'deny', 'clipboard.read': 'invalid', 'ui.toast': 'deny', unknown: 'allow'
  })
  assert.deepEqual(filterPermissionGrants(bag), { 'fs.write': 'deny' })
})
