import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const adapters = {
  electron: 'export const nativeTheme={shouldUseDarkColors:false};',
  '@main/paths/pathsService': 'export const getDefaultSettingsPath=()=>"/not-created/enest-settings.json";export const setAppPathsRoot=()=>{};',
  '@main/window/createShellWindow': 'export const sendShellEvent=()=>{};',
  '@main/db/sqliteService': `import {DatabaseSync} from 'node:sqlite';const db=new DatabaseSync(':memory:');export const kvStore={getDatabase:()=>db,initDatabase:async()=>{},getBackend:()=> 'sqlite'};`
}
const bundled = await build({
  stdin: { contents: "export {SettingsStore} from '@main/settings/SettingsStore'", resolveDir: root },
  tsconfig: root + 'tsconfig.node.json', bundle: true, write: false, platform: 'node', format: 'esm',
  plugins: [{ name: 'isolated-settings', setup(b) {
    b.onResolve({ filter: /.*/ }, ({ path }) => path in adapters ? { path, namespace: 'mock' } : undefined)
    b.onLoad({ filter: /.*/, namespace: 'mock' }, ({ path }) => ({ contents: adapters[path] }))
  } }]
})
const { SettingsStore } = await import('data:text/javascript;base64,' + Buffer.from(bundled.outputFiles[0].text).toString('base64'))

test('Quick use updates preserve settings, bound preferences and survive reload without copying plugin bags', async () => {
  const store = new SettingsStore()
  await store.load()
  await store.setAll({ general: { quickLauncher: { enabled: false, hotkeys: ['Alt+Space'] } }, pluginLaunch: { one: { aliases: ['example'] } }, plugins: { one: { saved: 'keep' } } })
  const revision = store.getPluginLaunchRevision()
  store.recordQuickUse('plugin:one:', ' ＱＱ ', 20)
  store.recordQuickUse('plugin:two:', 'qq', 20)
  store.recordQuickUse('plugin:two:', 'qq', 20)
  // The new narrow read/write paths must not use the full settings snapshot.
  store.getAll = () => { throw new Error('unexpected full settings copy') }
  assert.equal(store.getQuickLauncherSettings().recent[0].count, 2)
  assert.deepEqual(store.getQuickLauncherSettings().queryPreferences, [{ query: 'qq', id: 'plugin:two:' }])
  const returned = store.getQuickLauncherSettings()
  returned.recent.length = 0
  assert.equal(store.getQuickLauncherSettings().recent.length, 2)
  for (let i = 0; i < 120; i++) store.recordQuickUse(`plugin:${i}:`, `word${i}`, 20)
  assert.equal(store.getQuickLauncherSettings().recent.length, 20)
  assert.equal(store.getQuickLauncherSettings().queryPreferences.length, 100)
  store.recordQuickUse('plugin:content:', 'long content'.repeat(50), 20)
  assert.equal(store.getQuickLauncherSettings().queryPreferences[0].query, 'word119')
  assert.equal(store.getPluginLaunchRevision(), revision)
  store.flushNow()
  const restored = new SettingsStore()
  await restored.load()
  const quick = restored.getQuickLauncherSettings()
  assert.equal(quick.enabled, false)
  assert.deepEqual(quick.hotkeys, ['Alt+Space'])
  assert.equal(quick.recent[0].id, 'plugin:content:')
  assert.equal(quick.queryPreferences.length, 100)
  assert.deepEqual(restored.getPluginSettings('one'), { saved: 'keep' })
})
