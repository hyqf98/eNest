import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'

const mocks = {
  electron: 'export const nativeTheme={shouldUseDarkColors:false}',
  '@main/paths/pathsService': 'export const getDefaultSettingsPath=()=>"/not-created/shortcut-test.json";export const setAppPathsRoot=()=>{}',
  '@main/window/createShellWindow': 'export const sendShellEvent=()=>{}',
  '@main/db/sqliteService': `import {DatabaseSync} from 'node:sqlite';const db=new DatabaseSync(':memory:');
    db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY,value TEXT NOT NULL)');
    export const seed=data=>db.prepare('INSERT OR REPLACE INTO settings VALUES (?,?)').run('app',JSON.stringify(data));
    export const saved=()=>JSON.parse(db.prepare('SELECT value FROM settings WHERE key=?').get('app').value);
    let fail=false;export const failWrites=value=>{fail=value};
    const guarded={exec:sql=>db.exec(sql),prepare:sql=>{if(fail && sql.startsWith('INSERT'))throw Error('fixture disk failure');return db.prepare(sql)}};
    export const kvStore={getDatabase:()=>guarded,initDatabase:async()=>{},getBackend:()=> 'sqlite'};`
}
const result = await build({
  stdin: { contents: `export {SettingsStore} from '@main/settings/SettingsStore';
    export {migratePluginShortcuts} from '@main/settings/pluginShortcutMigration';
    export {seed,saved,failWrites} from '@main/db/sqliteService';`, resolveDir: process.cwd() },
  tsconfig: 'tsconfig.node.json', bundle: true, write: false, platform: 'node', format: 'esm',
  plugins: [{ name: 'isolated-shortcut-settings', setup(builder) {
    builder.onResolve({ filter: /.*/ }, ({ path }) => path in mocks ? { path, namespace: 'mock' } : undefined)
    builder.onLoad({ filter: /.*/, namespace: 'mock' }, ({ path }) => ({ contents: mocks[path] }))
  } }]
})
const { SettingsStore, migratePluginShortcuts, seed, saved, failWrites } = await import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64'))

test('legacy keys migrate once, preserving modes, aliases and missing plugins', async () => {
  seed({ pluginLaunch: {
    one: { hotkey: ' Control+1 ', mode: 'shell', aliases: ['work'] },
    missing: { hotkey: 'Alt+2' }, empty: { hotkey: '', aliases: ['keep'] }
  } })
  const store = new SettingsStore()
  await store.load()
  assert.deepEqual(store.getPluginShortcuts(), [
    { id: 'legacy:one', pluginId: 'one', accelerator: 'Control+1', mode: 'shell', enabled: true },
    { id: 'legacy:missing', pluginId: 'missing', accelerator: 'Alt+2', mode: 'quick', enabled: true }
  ])
  assert.deepEqual(store.getPluginLaunchConfig('one'), { mode: 'shell', aliases: ['work'] })
  assert.deepEqual(store.getPluginLaunchConfig('empty'), { aliases: ['keep'] })
  assert.equal(Object.hasOwn(saved().pluginLaunch.one, 'hotkey'), false)
  const next = new SettingsStore()
  await next.load()
  assert.deepEqual(next.getPluginShortcuts(), store.getPluginShortcuts())
})

test('generic settings cannot overwrite bindings or recreate legacy hotkeys', async () => {
  seed({})
  const store = new SettingsStore()
  await store.load()
  const bindings = [{ id: 'x', pluginId: 'one', accelerator: 'Alt+1', mode: 'quick', enabled: false }]
  store.setPluginShortcuts(bindings)
  bindings[0].enabled = true
  await store.setAll({ pluginShortcuts: [], pluginLaunch: { one: { hotkey: 'Alt+9', aliases: ['new'] } }, general: { locale: 'en-US' } })
  assert.equal(store.getPluginShortcuts().length, 1)
  assert.equal(store.getPluginShortcuts()[0].enabled, false)
  assert.deepEqual(store.getPluginLaunchConfig('one'), { aliases: ['new'] })
  await store.setPluginLaunch('one', { mode: 'shell', hotkey: 'Alt+8' })
  assert.deepEqual(store.getPluginLaunchConfig('one'), { mode: 'shell' })
  const copy = store.getPluginShortcuts(); copy.length = 0
  assert.equal(store.getPluginShortcuts().length, 1)
  store.flushNow()
  const restored = new SettingsStore(); await restored.load()
  assert.deepEqual(restored.getPluginShortcuts(), store.getPluginShortcuts())
})

test('partial migration retains existing new bindings and never duplicates legacy IDs', () => {
  const current = [{ id: 'legacy:one', pluginId: 'one', accelerator: 'Alt+9', mode: 'shell', enabled: false }]
  const migrated = migratePluginShortcuts({ one: { hotkey: 'Alt+1', aliases: ['keep'] } }, current)
  assert.deepEqual(migrated.pluginShortcuts, current)
  assert.deepEqual(migrated.pluginLaunch, { one: { aliases: ['keep'] } })
  assert.equal(migratePluginShortcuts(migrated.pluginLaunch, migrated.pluginShortcuts).migrated, false)
})

test('real store rejects durable-write failure without replacing the saved or in-memory binding', async t => {
  t.mock.method(console, 'error', () => {})
  const original = [{ id: 'x', pluginId: 'one', accelerator: 'Alt+1', mode: 'quick', enabled: true }]
  seed({ pluginShortcuts: original })
  const store = new SettingsStore(); await store.load()
  failWrites(true)
  try {
    assert.throws(() => store.setPluginShortcuts([{ ...original[0], accelerator: 'Alt+2' }]), /写入失败/)
    assert.deepEqual(store.getPluginShortcuts(), original)
    assert.deepEqual(saved().pluginShortcuts, original)
  } finally { failWrites(false) }
  store.setPluginShortcuts([{ ...original[0], accelerator: 'Alt+2' }])
  const restored = new SettingsStore(); await restored.load()
  assert.equal(restored.getPluginShortcuts()[0].accelerator, 'Alt+2')
})

test('Quick native selection commits durably, preserves search history, and rejects disk failures', async t => {
  t.mock.method(console, 'error', () => {})
  const original = { enabled: true, hotkeys: ['Alt+1'], activeHotkey: 'Alt+1',
    recent: [{ id: 'plugin:one:', count: 2, lastUsed: 123 }], queryPreferences: [{ query: 'one', id: 'plugin:one:' }] }
  seed({ general: { quickLauncher: original } })
  const store = new SettingsStore(); await store.load()
  const next = { enabled: false, hotkeys: ['Alt+2'], activeHotkey: 'Alt+2' }
  failWrites(true)
  try {
    assert.throws(() => store.setQuickHotkeys(next), /写入失败/)
    assert.deepEqual(store.getQuickLauncherSettings(), original)
    assert.deepEqual(saved().general.quickLauncher, original)
  } finally { failWrites(false) }
  store.setQuickHotkeys(next)
  const restored = new SettingsStore(); await restored.load()
  assert.deepEqual(restored.getQuickLauncherSettings(), { ...original, ...next })
})

test('confirmed replacement commits plugin and Quick sections in one durable write or leaves both unchanged', async t => {
  t.mock.method(console, 'error', () => {})
  const bindings = [{ id: 'x', pluginId: 'one', accelerator: 'Alt+1', mode: 'quick', enabled: true }]
  const quick = { enabled: false, hotkeys: ['Alt+1'], activeHotkey: 'Alt+1', recent: [{ id: 'keep', count: 2 }] }
  seed({ pluginShortcuts: bindings, general: { quickLauncher: quick } })
  const store = new SettingsStore(); await store.load()
  const next = [{ ...bindings[0], enabled: false }]
  const enabled = { enabled: true, hotkeys: ['Alt+1'], activeHotkey: 'Alt+1' }
  failWrites(true)
  try {
    assert.throws(() => store.setShortcutConfiguration(next, enabled), /写入失败/)
    assert.deepEqual(store.getPluginShortcuts(), bindings)
    assert.deepEqual(store.getQuickLauncherSettings(), quick)
    assert.deepEqual(saved().pluginShortcuts, bindings)
    assert.deepEqual(saved().general.quickLauncher, quick)
  } finally { failWrites(false) }
  store.setShortcutConfiguration(next, enabled)
  const restored = new SettingsStore(); await restored.load()
  assert.deepEqual(restored.getPluginShortcuts(), next)
  assert.deepEqual(restored.getQuickLauncherSettings(), { ...quick, ...enabled })
})
