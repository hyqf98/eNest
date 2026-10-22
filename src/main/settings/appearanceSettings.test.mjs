import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'

const mocks = {
  electron: 'export const nativeTheme={shouldUseDarkColors:false}',
  '@main/paths/pathsService': 'export const getDefaultSettingsPath=()=>"/not-created/appearance-settings-test.json";export const setAppPathsRoot=()=>{}',
  '@main/window/createShellWindow': 'export const events=[];export const sendShellEvent=event=>events.push(event)',
  '@main/db/sqliteService': `import {DatabaseSync} from 'node:sqlite';const db=new DatabaseSync(':memory:');
    db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY,value TEXT NOT NULL)');
    export const seed=data=>db.prepare('INSERT OR REPLACE INTO settings VALUES (?,?)').run('app',JSON.stringify(data));
    export const saved=()=>JSON.parse(db.prepare('SELECT value FROM settings WHERE key=?').get('app').value);
    let fail=false;export const failWrites=value=>{fail=value};
    const guarded={exec:sql=>db.exec(sql),prepare:sql=>{if(fail && sql.startsWith('INSERT'))throw Error('fixture disk failure');return db.prepare(sql)}};
    export const kvStore={getDatabase:()=>guarded,initDatabase:async()=>{},getBackend:()=> 'sqlite'};`
}
const bundle = await build({
  stdin: { contents: `export {SettingsStore} from '@main/settings/SettingsStore';
    export {resolveAppearance,patchThemeProfile} from '@shared/theme/appearance';
    export {DEFAULT_THEME_PACKAGE} from '@shared/theme/defaultTheme/package';
    export {seed,saved,failWrites} from '@main/db/sqliteService';
    export {events} from '@main/window/createShellWindow';`, resolveDir: process.cwd() },
  tsconfig: 'tsconfig.node.json', bundle: true, write: false, platform: 'node', format: 'esm',
  plugins: [{ name: 'isolated-appearance-settings', setup(builder) {
    builder.onResolve({ filter: /.*/ }, ({ path }) => path in mocks ? { path, namespace: 'mock' } : undefined)
    builder.onLoad({ filter: /.*/, namespace: 'mock' }, ({ path }) => ({ contents: mocks[path] }))
  } }]
})
const { SettingsStore, resolveAppearance, patchThemeProfile, DEFAULT_THEME_PACKAGE, seed, saved, failWrites, events } = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'))

function legacySettings() {
  return {
    theme: { mode: 'light', overrides: { light: { '--accent': '#295b4b' }, dark: { '--accent': '#b9c9bd' } }, backgroundEffect: 'orbit' },
    general: { fontFamily: 'Georgia, serif', fontSizeScale: 1.1, animationLevel: 'medium' }
  }
}

test('a clean installation starts with the paired default appearance rather than a synthesized legacy selection', async () => {
  for (const initial of [null, {}]) {
    seed(initial)
    const store = new SettingsStore()
    await store.load()
    const appearance = store.getAppearanceSettings()
    assert.equal(appearance.version, 2)
    assert.deepEqual(appearance.active, { source: 'enest.builtin', id: 'default' })
    assert.equal(appearance.mode, 'light')
    assert.equal(store.getAll().appearance.active.id, 'default')
    assert.equal(Object.hasOwn(store.getAll().general, 'themeSetupComplete'), false)
    assert.deepEqual(store.getAll().general.splashBackground, { type: 'brand', opacity: 0.55 })
  }
})

test('persisted migration applies all original appearance choices once and a reset stays authoritative', async () => {
  const initial = legacySettings()
  initial.theme.background = { type: 'video', value: '/private/original.webm', fit: 'contain', opacity: 0.64 }
  initial.general = {
    ...initial.general, fontFamilyEn: '"Inter", sans-serif', tabStyle: 'orb', animationLevel: 'high',
    splashBackground: { type: 'image', value: '/private/startup.png', opacity: 0.31 },
  }
  seed(initial)
  const store = new SettingsStore()
  await store.load()
  const settings = store.getAppearanceSettings()
  const effective = resolveAppearance({ settings, systemDark: false })
  assert.equal(effective.theme.id, 'default')
  assert.equal(effective.home.variant, 'default')
  assert.equal(effective.tokens['--accent'], '#295b4b')
  assert.equal(effective.tokens['--link'], '#295b4b')
  assert.equal(effective.fonts.body, '"Inter", sans-serif, Georgia, serif')
  assert.equal(effective.fonts.scale, 1.1)
  assert.equal(effective.layout.tabStyle, 'orb')
  assert.equal(effective.animation.requested, 'high')
  assert.equal(effective.background.effect, 'orbit')
  assert.deepEqual(effective.background.media, { type: 'video', value: 'enest://appearance/legacy/background', fit: 'contain', opacity: 0.64 })
  assert.deepEqual(effective.splash, { type: 'image', media: { type: 'image', value: 'enest://appearance/legacy/splash', fit: 'cover', opacity: 0.31 }, opacity: 0.31 })
  const key = 'v2:enest.builtin:default'
  assert.equal(JSON.stringify(settings.profiles[key]).includes('/private/'), false)
  assert.equal(settings.legacyBackup.theme.background.value, initial.theme.background.value)
  assert.equal(settings.legacyBackup.general.splashBackground.value, initial.general.splashBackground.value)
  store.commitAppearanceSettings(settings)
  const reloaded = new SettingsStore()
  await reloaded.load()
  assert.deepEqual(resolveAppearance({ settings: reloaded.getAppearanceSettings() }), effective)
  const originalBackup = structuredClone(settings.legacyBackup)
  const pack = DEFAULT_THEME_PACKAGE.contributes.themePacks[0]
  settings.profiles[key] = patchThemeProfile(pack, settings.profiles[key], { theme: settings.active, reset: true })
  reloaded.commitAppearanceSettings(settings)
  const resetStore = new SettingsStore()
  await resetStore.load()
  const reset = resetStore.getAppearanceSettings()
  const defaults = resolveAppearance({ settings: reset })
  assert.deepEqual(Object.keys(reset.profiles[key].values), [])
  assert.equal(defaults.fonts.scale, 1)
  assert.equal(defaults.layout.tabStyle, 'classic')
  assert.equal(defaults.background.effect, 'tunnel')
  assert.equal(defaults.background.media, null)
  assert.equal(defaults.splash.type, 'brand')
  assert.equal(defaults.tokens['--accent'], '#bd542b')
  assert.deepEqual(reset.legacyBackup, originalBackup)
})

test('V2 mode is authoritative across legacy reads and reloads after one-time migration', async () => {
  seed(legacySettings())
  const store = new SettingsStore()
  await store.load()
  const migrated = store.getAppearanceSettings()
  assert.equal(migrated.mode, 'light')
  assert.equal(migrated.active.id, 'default')
  store.commitAppearanceSettings({ ...migrated, mode: 'dark' })
  for (let i = 0; i < 3; i++) {
    assert.equal(store.getAppearanceSettings().mode, 'dark')
    assert.equal(store.getTheme().mode, 'light', 'the legacy mode must not overwrite the V2 choice')
  }
  await store.setTheme({ backgroundEffect: 'fold' })
  assert.equal(store.getAppearanceSettings().mode, 'dark', 'unrelated compatibility edits must not restore the legacy mode')
  const reloaded = new SettingsStore()
  await reloaded.load()
  assert.equal(reloaded.getAppearanceSettings().mode, 'dark')
  assert.deepEqual(reloaded.getAppearanceSettings().legacyBackup, migrated.legacyBackup)
})

test('explicit legacy mode writes update V2 authority without changing theme identity, profiles, or backup', async () => {
  seed(legacySettings())
  const store = new SettingsStore()
  await store.load()
  const migrated = store.getAppearanceSettings()
  const active = { source: 'com.example.theme', id: 'night' }
  store.commitAppearanceSettings({ ...migrated, mode: 'dark', active })
  const before = store.getAppearanceSettings()
  events.length = 0
  await store.setTheme({ mode: 'system' })
  const after = store.getAppearanceSettings()
  assert.equal(after.mode, 'system')
  assert.equal(after.legacy.theme.mode, 'system')
  assert.deepEqual(after.active, active)
  assert.deepEqual(JSON.parse(JSON.stringify(after.profiles)), JSON.parse(JSON.stringify(before.profiles)))
  assert.deepEqual(after.legacyBackup, migrated.legacyBackup)
  assert.equal(saved().appearance.mode, 'system')
  assert.equal(saved().theme.mode, 'system')
  assert.deepEqual(events, [{ type: 'theme-changed', mode: 'system' }])
  await store.setTheme({ backgroundEffect: 'fold' })
  assert.equal(store.getAppearanceSettings().mode, 'system')
  assert.deepEqual(store.getAppearanceSettings().legacyBackup, migrated.legacyBackup)
})

test('explicit compatibility colors update only the legacy profile and preserve the original backup', async () => {
  seed(legacySettings())
  const store = new SettingsStore()
  await store.load()
  const before = store.getAppearanceSettings()
  const ink = { identity: { source: 'enest.builtin', id: 'ink' }, schemaVersion: 2, colors: { dark: { '--accent': '#8899aa' } }, values: { density: 1.1 }, quarantined: {} }
  store.commitAppearanceSettings({ ...before, profiles: { ...before.profiles, 'v2:enest.builtin:ink': ink } })
  await store.setTheme({ overrides: { dark: { '--accent': '#aabbcc' } } })
  const after = store.getAppearanceSettings()
  assert.deepEqual(after.profiles['v2:enest.builtin:legacy-custom'].colors.dark, { '--accent': '#aabbcc' })
  assert.deepEqual(after.profiles['v2:enest.builtin:legacy-custom'].colors.light, before.profiles['v2:enest.builtin:legacy-custom'].colors.light)
  assert.equal(after.profiles['v2:enest.builtin:ink'].values.density, 1.1)
  assert.deepEqual(after.profiles['v2:enest.builtin:ink'].colors, ink.colors)
  assert.deepEqual(after.legacyBackup, before.legacyBackup)
})

test('failed compatibility writes preserve both persisted and in-memory authorities without publishing', async t => {
  t.mock.method(console, 'error', () => {})
  seed(legacySettings())
  const store = new SettingsStore()
  await store.load()
  const appearance = store.getAppearanceSettings()
  store.commitAppearanceSettings({ ...appearance, mode: 'dark' })
  const before = store.getAll()
  const persisted = saved()
  events.length = 0
  failWrites(true)
  try {
    await assert.rejects(() => store.setTheme({ mode: 'system', backgroundEffect: 'fold' }), /写入失败/)
    assert.deepEqual(store.getAll(), before)
    assert.deepEqual(saved(), persisted)
    assert.equal(store.getAppearanceSettings().mode, 'dark')
    assert.deepEqual(events, [])
  } finally { failWrites(false) }
})

test('retired host selections converge to default while every archived profile and backup survive', async () => {
  for (const id of ['warm', 'ink', 'sketch', 'painted', 'tech', 'legacy-custom']) {
    const initial = legacySettings()
    initial.general.tabStyle = 'orb'
    const identity = { source: 'enest.builtin', id }
    const key = `v2:enest.builtin:${id}`
    const profile = { identity, schemaVersion: 2, colors: { dark: { '--accent': '#123456' } }, values: { density: 1.1, archived: 'keep' }, quarantined: {} }
    initial.appearance = { version: 2, active: identity, mode: 'dark', profiles: { [key]: profile } }
    seed(initial)
    const store = new SettingsStore()
    await store.load()
    const migrated = store.getAppearanceSettings()
    assert.deepEqual(migrated.active, { source: 'enest.builtin', id: 'default' })
    assert.equal(store.getAll().appearance.active.id, 'default')
    assert.deepEqual(JSON.parse(JSON.stringify(migrated.profiles[key])), profile)
    assert.equal(migrated.profiles['v2:enest.builtin:default'].values.tabStyle, 'orb')
    const effective = resolveAppearance({ settings: migrated })
    assert.equal(effective.layout.density, 1.1)
    assert.equal(effective.layout.tabStyle, 'orb')
    assert.equal(effective.tokens['--accent'], '#123456')
    assert.equal(effective.fonts.body, 'Georgia, serif')
    assert.equal(effective.fonts.scale, 1.1)
    assert.equal(effective.background.effect, 'orbit')
    assert.deepEqual(migrated.legacyBackup.theme, initial.theme)
    assert.equal(migrated.mode, 'dark')
    store.commitAppearanceSettings(migrated)
    const reloaded = new SettingsStore()
    await reloaded.load()
    assert.deepEqual(reloaded.getAppearanceSettings().legacyBackup, migrated.legacyBackup)
    assert.equal(reloaded.getAppearanceSettings().profiles[key].values.archived, 'keep')
  }
  const initial = legacySettings()
  initial.appearance = { version: 2, active: { source: 'com.extension.theme', id: 'ink' }, profiles: {} }
  seed(initial)
  const store = new SettingsStore()
  await store.load()
  assert.deepEqual(store.getAppearanceSettings().active, initial.appearance.active)
})

test('retired setup markers of any stored value are removed on load without changing appearance profiles', async () => {
  seed(legacySettings())
  const reference = new SettingsStore()
  await reference.load()
  const appearance = reference.getAppearanceSettings()
  const archived = {
    identity: { source: 'com.example.theme', id: 'paper' }, schemaVersion: 2,
    colors: { dark: { '--accent': '#123456' } }, values: { gap: 23, archived: 'keep' },
    quarantined: { old: { value: 'keep', reason: 'removed', schemaVersion: 1 } },
  }
  reference.commitAppearanceSettings({ ...appearance, mode: 'dark', profiles: { ...appearance.profiles, 'v2:com.example.theme:paper': archived } })
  const baseline = reference.getAll()
  const expected = JSON.parse(JSON.stringify(reference.getAppearanceSettings()))
  for (const raw of [undefined, true, false, 'true', 'false', 1, 0, null, {}, []]) {
    const initial = structuredClone(baseline)
    initial.general.themeSetupComplete = raw
    seed(initial)
    const store = new SettingsStore()
    await store.load()
    assert.equal(Object.hasOwn(store.getAll().general, 'themeSetupComplete'), false)
    assert.deepEqual(JSON.parse(JSON.stringify(store.getAppearanceSettings())), expected, 'marker cleanup preserves identity, mode, profiles and migration backup')
    store.flushNow()
    assert.equal(Object.hasOwn(saved().general, 'themeSetupComplete'), false, 'the next persistence removes the retired key')
    assert.deepEqual(saved().appearance.profiles, expected.profiles)
    const reloaded = new SettingsStore()
    await reloaded.load()
    assert.equal(Object.hasOwn(reloaded.getAll().general, 'themeSetupComplete'), false)
    assert.deepEqual(JSON.parse(JSON.stringify(reloaded.getAppearanceSettings())), expected)
  }
})

test('compatibility settings writes discard retired setup markers and retain ordinary preferences and profiles', async () => {
  seed(legacySettings())
  const store = new SettingsStore()
  await store.load()
  const before = JSON.parse(JSON.stringify(store.getAppearanceSettings()))
  for (const raw of [undefined, true, false, 'true', 'false', 1, 0, null, {}, []]) {
    const result = await store.setAll({ general: { themeSetupComplete: raw, locale: 'en-US' } })
    assert.equal(Object.hasOwn(result.general, 'themeSetupComplete'), false)
    assert.equal(result.general.locale, 'en-US')
    assert.deepEqual(JSON.parse(JSON.stringify(store.getAppearanceSettings())), before)
    store.flushNow()
    assert.equal(Object.hasOwn(saved().general, 'themeSetupComplete'), false)
    assert.equal(saved().general.locale, 'en-US')
    const reloaded = new SettingsStore()
    await reloaded.load()
    assert.equal(Object.hasOwn(reloaded.getAll().general, 'themeSetupComplete'), false)
    assert.deepEqual(JSON.parse(JSON.stringify(reloaded.getAppearanceSettings())), before)
  }
})

test('font removal durably resets exact selections without dropping unrelated profiles or migration backups', async t => {
  t.mock.method(console, 'error', () => {})
  const initial = legacySettings()
  const font = { id: 'custom-id', family: 'My Font', name: 'Original font', fileName: 'custom.woff2' }
  initial.general.customFonts = [font, { id: 'other', family: 'My Font Extended', fileName: 'other.ttf' }]
  initial.general.fontFamily = '"My Font", sans-serif'
  initial.general.fontFamilyEn = 'Georgia, serif'
  seed(initial)
  const store = new SettingsStore()
  await store.load()
  const appearance = store.getAppearanceSettings()
  appearance.profiles['v2:com.example.theme:paper'] = {
    identity: { source: 'com.example.theme', id: 'paper' }, schemaVersion: 2, colors: { dark: { '--accent': '#123456' } },
    values: { customCjk: '"My Font", sans-serif', heading: "'My Font', serif", unrelatedFont: '"My Font Extended", serif', customLabel: '"My Font", serif', gap: 23 },
    quarantined: { old: { value: 'keep', reason: 'removed', schemaVersion: 1 } },
  }
  store.commitAppearanceSettings(appearance)
  const before = store.getAll()
  const persisted = saved()
  events.length = 0
  const fontFields = { 'v2:enest.builtin:default': ['fontFamily', 'fontFamilyEn', 'monoFont'], 'v2:com.example.theme:paper': ['customCjk', 'heading', 'unrelatedFont'] }
  failWrites(true)
  try { assert.throws(() => store.commitAppearanceFontRemoval(font.id, font.family, fontFields), /写入失败/) }
  finally { failWrites(false) }
  assert.deepEqual(store.getAll(), before)
  assert.deepEqual(saved(), persisted)
  assert.deepEqual(events, [])
  assert.throws(() => store.commitAppearanceFontRemoval(font.id, 'Another Font', fontFields), /library changed/)
  store.commitAppearanceFontRemoval(font.id, font.family, fontFields)
  const after = store.getAll()
  assert.deepEqual(after.general.customFonts.map(item => item.id), ['other'])
  assert.equal(after.general.fontFamily, '')
  assert.equal(after.general.fontFamilyEn, 'Georgia, serif')
  const paper = after.appearance.profiles['v2:com.example.theme:paper']
  assert.deepEqual(paper.values, { unrelatedFont: '"My Font Extended", serif', customLabel: '"My Font", serif', gap: 23 })
  assert.deepEqual(paper.colors, appearance.profiles['v2:com.example.theme:paper'].colors)
  assert.deepEqual(paper.quarantined, appearance.profiles['v2:com.example.theme:paper'].quarantined)
  assert.deepEqual(after.appearance.legacyBackup, before.appearance.legacyBackup)
  assert.equal(after.appearance.profiles['v2:enest.builtin:default'].values.fontFamily, undefined)
  const reloaded = new SettingsStore()
  await reloaded.load()
  assert.deepEqual(reloaded.getAppearanceSettings().profiles['v2:com.example.theme:paper'].values, paper.values)
  assert.equal(reloaded.getAll().general.customFonts.length, 1)
})
