import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import ts from 'typescript'

const require = createRequire(import.meta.url)

function transpile(file) {
  return ts.transpileModule(readFileSync(new URL(file, new URL("../../../src/main/theme/", import.meta.url)), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
}

function load(file, mocks = {}, globals = {}) {
  const module = { exports: {} }
  new Function('require', 'module', 'exports', ...Object.keys(globals), transpile(file))(name => mocks[name] ?? (name.startsWith('@shared/') ? load(`../../shared/${name.slice('@shared/'.length)}.ts`) : require(name)), module, module.exports, ...Object.values(globals))
  return module.exports
}

const sharedContract = load('../../shared/types/plugin.ts')
const sharedAppearance = load('../../shared/types/appearance.ts', {
  './plugin': sharedContract
})
const sharedColors = load('../../shared/theme/colors.ts')
const sharedBackgroundEffects = load('../../shared/backgroundEffects.ts', {
  '@shared/pluginContract': load('../../shared/pluginContract.ts')
})
const builtinThemes = load('../../shared/theme/builtinThemes.ts')
const defaultTheme = builtinThemes.DEFAULT_THEME_IDENTITY
const appearanceModel = load('../../shared/theme/appearance.ts', {
  '@shared/types/appearance': sharedAppearance,
  '@shared/theme/presets': load('../../shared/theme/presets.ts', {
    '@shared/theme/colors': sharedColors
  }),
  '@shared/pluginContract': load('../../shared/pluginContract.ts'),
  '@shared/theme/colors': sharedColors,
  '@shared/backgroundEffects': sharedBackgroundEffects,
  '@shared/theme/builtinThemes': builtinThemes
})

function variant(accent) {
  return {
    tokens: { '--accent': accent },
    fonts: { body: 'A', heading: 'A', mono: 'Mono', scale: 1 },
    components: { controlRadius: 6, cardRadius: 10, panelRadius: 8, borderWidth: 1 },
    background: { media: null, effect: 'none', texture: 'none', intensity: 0, speed: 1, direction: 0 },
    layout: { variant: 'comfortable', density: 1, gap: 12, sidebarWidth: 260, contentWidth: 1200, columns: 2 },
    animation: 'medium'
  }
}

function pack(id, source, accent = '#bd542b') {
  return {
    schemaVersion: 2,
    version: 1,
    id,
    source,
    name: `Theme ${id}`,
    mode: 'system',
    tokens: { '--accent': accent },
    variants: { light: variant(accent), dark: variant(accent) },
    home: { source, id: 'home', variant: 'comfortable' },
    settings: {
      version: 2,
      groups: [{
        id: 'main',
        title: 'Main',
        fields: [
          { key: 'accent', label: 'Accent', type: 'color', default: accent, binding: { target: 'token', key: '--accent' } },
          { key: 'density', label: 'Density', type: 'slider', default: 1, min: 0.8, max: 1.2, step: 0.1, binding: { target: 'layout', key: 'density' } },
          { key: 'motion', label: 'Motion', type: 'select', default: 'medium', options: [{ label: 'Low', value: 'low' }, { label: 'Medium', value: 'medium' }, { label: 'High', value: 'high' }], binding: { target: 'animation', key: 'level' } }
        ]
      }]
    }
  }
}

function legacy() {
  return {
    theme: { mode: 'system', packId: null, overrides: { light: {}, dark: {} } },
    general: { fontFamily: '', fontFamilyEn: '', fontSizeScale: 1, animationLevel: 'medium', splashBackground: { type: 'brand', opacity: 0.55 } }
  }
}

function createFixture({ packs = [], systemDark = false, commitError } = {}) {
  const events = []
  const fixture = { packs: [...packs, ...structuredClone(builtinThemes.BUILTIN_THEME_PACKS)], customFonts: [], systemDark, commitError }
  const calls = { settingsReads: 0, packLists: 0, fontReads: 0, resolves: 0, reconciles: 0, detachedClones: 0, commits: 0 }
  const resetCalls = () => { for (const key of Object.keys(calls)) calls[key] = 0 }
  const nativeThemeListeners = new Map()
  const store = {
    data: { settings: undefined, legacy: legacy() },
    getAppearanceSettings() { calls.settingsReads++; return this.data.settings },
    getPluginAppearance() { calls.fontReads++; return { customFonts: structuredClone(fixture.customFonts) } },
    commitAppearanceSettings(next) {
      if (fixture.commitError) throw fixture.commitError
      calls.commits++
      this.data.settings = next
    }
  }
  const registry = {
    list: () => { calls.packLists++; return structuredClone(fixture.packs) },
    get: id => structuredClone(fixture.packs.find(pack => pack.id === id) ?? null)
  }
  const nativeTheme = {
    shouldUseDarkColors: systemDark,
    on(event, listener) {
      const listeners = nativeThemeListeners.get(event) ?? []
      listeners.push(listener)
      nativeThemeListeners.set(event, listeners)
    }
  }
  fixture.nativeTheme = nativeTheme
  const electron = {
    nativeTheme,
    systemPreferences: { getAnimationSettings: () => ({ prefersReducedMotion: false }) }
  }
  const homePrepared = []
  const homeState = { committed: false, rolledBack: false }
  const homeTransactions = []
  fixture.homePrepared = homePrepared
  const service = load('./appearanceService.ts', {
    electron: electron,
    '@shared/types/plugin': sharedContract,
    '@shared/types/appearance': sharedAppearance,
    '@shared/theme/appearance': {
      ...appearanceModel,
      resolveAppearance(...args) { calls.resolves++; return appearanceModel.resolveAppearance(...args) },
      reconcileThemeProfile(...args) { calls.reconciles++; return appearanceModel.reconcileThemeProfile(...args) }
    },
    '@shared/theme/builtinThemes': builtinThemes,
    '@main/settings/SettingsStore': { settingsStore: store },
    '@main/theme/themePacks': { themePackRegistry: registry },
    './appearanceResources': { publicAppearanceFonts: () => [], publicAppearanceMedia: media => media },
    '@main/logs/logService': { logWarn: () => undefined }
  }, {
    structuredClone(value) { calls.detachedClones++; return structuredClone(value) }
  })
  fixture.settings = appearanceModel.migrateAppearanceSettings(undefined, legacy())
  store.data.settings = fixture.settings
  service.appearanceService.subscribeAppearance(change => events.push(change))
  service.appearanceService.getAppearance()
  fixture.emitNativeThemeUpdate = () => {
    for (const listener of nativeThemeListeners.get('updated') ?? []) listener()
  }
  service.appearanceService.setHomeCoordinator(async candidate => {
    homePrepared.push(candidate)
    const transaction = {
      commit: () => { homeState.committed = true },
      rollback: () => { homeState.rolledBack = true }
    }
    homeTransactions.push(transaction)
    return transaction
  })
  return { service, store, events, registry, fixture, calls, resetCalls, nativeTheme, appearanceService: service.appearanceService, homePrepared, homeState, homeTransactions }
}

test('snapshots reuse one current read and registry list on both cache hits and misses', () => {
  const theme = pack('theme', 'com.test')
  const { appearanceService, store, calls, resetCalls, events } = createFixture({ packs: [theme] })
  const expected = { settingsReads: 1, packLists: 1, fontReads: 1, resolves: 0, reconciles: 1, detachedClones: 1, commits: 0 }
  resetCalls()
  const initial = appearanceService.getAppearanceSnapshot()
  assert.deepEqual(calls, expected, 'the warmed appearance does not require a second read or clone')

  const identity = { source: theme.source, id: theme.id }
  store.data.settings.active = identity
  store.data.settings.profiles[appearanceModel.themeProfileKey(identity)] = {
    identity, schemaVersion: 2, values: { density: 1.2 }, colors: {}, quarantined: {}
  }
  resetCalls()
  const changed = appearanceService.getAppearanceSnapshot()
  assert.deepEqual(calls, { ...expected, resolves: 1 })
  assert.equal(changed.appearance.layout.density, 1.2)
  assert.equal(changed.profile.values.density, 1.2)
  assert.deepEqual(changed.profile.identity, identity)
  assert.ok(changed.appearance.revision > initial.appearance.revision)

  resetCalls()
  const unchanged = appearanceService.getAppearanceSnapshot()
  assert.deepEqual(calls, expected)
  assert.deepEqual(unchanged, changed)
  assert.equal(unchanged.appearance.revision, changed.appearance.revision)
  assert.notEqual(unchanged, changed)
  assert.notEqual(unchanged.appearance, changed.appearance)
  assert.deepEqual(events, [], 'snapshot reads do not publish changes')

  resetCalls()
  const appearance = appearanceService.getAppearance()
  assert.deepEqual(calls, { ...expected, reconciles: 0 })
  assert.deepEqual(appearance, changed.appearance)
  assert.notEqual(appearance, changed.appearance)
})

test('one detached clone deeply freezes responses without freezing or aliasing live configuration', () => {
  const theme = pack('theme', 'com.test')
  const { appearanceService, store, fixture, calls, resetCalls } = createFixture({ packs: [theme] })
  const identity = { source: theme.source, id: theme.id }
  const key = appearanceModel.themeProfileKey(identity)
  store.data.settings.active = identity
  store.data.settings.profiles[key] = {
    identity, schemaVersion: 2, values: { density: 1.1 }, colors: { light: { '--accent': '#123456' } },
    quarantined: { saved: { value: { items: [{ label: 'original' }] }, reason: 'retained', schemaVersion: 2 } }
  }
  fixture.customFonts = [{ id: 'custom', family: 'Example Font', fileName: 'example.woff2' }]
  resetCalls()
  const snapshot = appearanceService.getAppearanceSnapshot()
  assert.equal(calls.detachedClones, 1, 'nested arrays and objects are frozen without cloning each subtree')
  const assertFrozen = value => {
    if (!value || typeof value !== 'object') return
    assert.ok(Object.isFrozen(value))
    for (const child of Object.values(value)) assertFrozen(child)
  }
  assertFrozen(snapshot)
  assert.throws(() => { snapshot.appearance.tokens['--accent'] = '#ffffff' }, TypeError)
  assert.throws(() => { snapshot.packs[0].settings.groups[0].fields[0].label = 'changed' }, TypeError)
  assert.throws(() => { snapshot.profile.quarantined.saved.value.items.push({ label: 'changed' }) }, TypeError)
  assert.throws(() => { snapshot.customFonts[0].family = 'changed' }, TypeError)
  assert.equal(Object.isFrozen(store.data.settings.profiles[key]), false)
  assert.equal(Object.isFrozen(theme.settings.groups[0].fields[0]), false)
  assert.equal(Object.isFrozen(fixture.customFonts[0]), false)

  store.data.settings.profiles[key].values.density = 0.9
  store.data.settings.profiles[key].colors.light['--accent'] = '#654321'
  store.data.settings.profiles[key].quarantined.saved.value.items[0].label = 'latest'
  theme.settings.groups[0].fields[0].label = 'Latest accent'
  fixture.customFonts[0].family = 'Latest Font'
  resetCalls()
  const latest = appearanceService.getAppearanceSnapshot()
  assert.equal(calls.detachedClones, 1)
  assert.equal(latest.appearance.layout.density, 0.9)
  assert.equal(latest.appearance.tokens['--accent'], '#654321')
  assert.equal(latest.profile.quarantined.saved.value.items[0].label, 'latest')
  assert.equal(latest.packs[0].settings.groups[0].fields[0].label, 'Latest accent')
  assert.equal(latest.customFonts[0].family, 'Latest Font')
  assert.ok(latest.appearance.revision > snapshot.appearance.revision)
  assert.equal(snapshot.appearance.layout.density, 1.1)
  assert.equal(snapshot.appearance.tokens['--accent'], '#123456')
  assert.equal(snapshot.profile.quarantined.saved.value.items[0].label, 'original')
  assert.equal(snapshot.packs[0].settings.groups[0].fields[0].label, 'Accent')
  assert.equal(snapshot.customFonts[0].family, 'Example Font')
})

test('profile updates merge latest fields, persist before publish, and do not activate an inactive theme', async () => {
  const first = pack('same-id', 'com.first')
  const second = pack('same-id', 'com.second', '#112233')
  const fixture = createFixture({ packs: [first, second] })
  const { appearanceService, homePrepared, homeState, store } = fixture

  const initial = appearanceService.getAppearanceSnapshot()
  const firstSnapshot = appearanceService.updateThemeProfile({
    theme: { source: first.source, id: first.id },
    values: { density: 1.1 }
  })
  assert.equal(fixture.store.data.settings.profiles['v2:com.first:same-id'].values.density, 1.1)
  assert.deepEqual(firstSnapshot.profile.identity, defaultTheme)
  assert.equal(firstSnapshot.appearance.theme.id, defaultTheme.id)

  const secondSnapshot = appearanceService.updateThemeProfile({
    theme: { source: second.source, id: second.id },
    values: { density: 0.9 }
  })
  assert.deepEqual(secondSnapshot.profile.identity, defaultTheme)
  assert.equal(fixture.store.data.settings.profiles['v2:com.second:same-id'].values.density, 0.9)
  assert.equal(fixture.store.data.settings.profiles['v2:com.first:same-id'].values.density, 1.1)
  assert.ok(fixture.store.data.settings.revision > initial.appearance.revision)

  const activated = await appearanceService.activateTheme({ source: first.source, id: first.id })
  assert.equal(activated.appearance.theme.id, first.id)
  assert.equal(homePrepared.length, 1)
  assert.equal(homePrepared[0].theme.id, first.id)
  assert.equal(homeState.committed, true)
  assert.equal(homeState.rolledBack, false)
})

test('a background profile patch returns the current active profile, not the edited inactive identity', async () => {
  const first = pack('first', 'com.test')
  const second = pack('second', 'com.test')
  const firstIdentity = { source: first.source, id: first.id }
  const fixture = createFixture({ packs: [first, second] })
  fixture.appearanceService.updateThemeProfile({ theme: firstIdentity, values: { density: 1.1 } })
  await fixture.appearanceService.activateTheme(second)
  const snapshot = fixture.appearanceService.updateThemeProfile({ theme: firstIdentity, values: { density: 1.2 } })
  assert.equal(fixture.store.data.settings.profiles['v2:com.test:first'].values.density, 1.2)
  assert.equal(snapshot.appearance.theme.id, 'second')
  assert.equal(snapshot.profile.identity.id, 'second')
  assert.equal(snapshot.profile.identity.source, snapshot.appearance.theme.source)
  assert.equal(snapshot.profile.values.density, undefined)
})

test('active snapshots reconcile upgraded schemas without rewriting the durable profile', () => {
  const theme = pack('theme', 'com.test')
  const fixture = createFixture({ packs: [theme] })
  const identity = { source: theme.source, id: theme.id }
  fixture.store.data.settings.active = identity
  fixture.appearanceService.updateThemeProfile({ theme: identity, values: { density: 1.2 } })
  theme.settings.groups[0].fields.find(field => field.key === 'density').max = 1
  const persisted = JSON.stringify(fixture.store.data.settings)

  const snapshot = fixture.appearanceService.getAppearanceSnapshot()
  assert.equal(snapshot.profile.identity.source, snapshot.appearance.theme.source)
  assert.equal(snapshot.profile.identity.id, snapshot.appearance.theme.id)
  assert.equal(snapshot.profile.values.density, undefined)
  assert.equal(snapshot.appearance.layout.density, 1)
  assert.deepEqual(snapshot.profile.quarantined['values.density'], {
    value: 1.2, reason: 'field-invalid', schemaVersion: 2
  })
  assert.equal(JSON.stringify(fixture.store.data.settings), persisted)
  assert.equal(fixture.store.data.settings.profiles['v2:com.test:theme'].values.density, 1.2)
  assert.deepEqual(fixture.store.data.settings.profiles['v2:com.test:theme'].quarantined, {})
})

test('persistence failure leaves settings, cache, revision, and events unchanged', async () => {
  const error = new Error('disk full')
  const fixture = createFixture({ packs: [pack('theme', 'com.test')], commitError: error })
  const { appearanceService, homePrepared, homeState } = fixture
  const before = appearanceService.getAppearance()
  const beforeSettings = JSON.parse(JSON.stringify(fixture.store.data.settings))
  assert.throws(() => appearanceService.updateThemeProfile({
    theme: { source: 'com.test', id: 'theme' },
    values: { density: 1.2 }
  }), error)
  assert.equal(JSON.stringify(fixture.store.data.settings), JSON.stringify(beforeSettings))
  assert.deepEqual(appearanceService.getAppearance(), before)
  assert.deepEqual(fixture.events, [])

  const previousActive = fixture.store.data.settings.active
  await assert.rejects(
    () => appearanceService.activateTheme({ source: 'com.test', id: 'theme' }),
    error
  )
  assert.equal(homePrepared.length, 1)
  assert.equal(homeState.committed, false)
  assert.equal(homeState.rolledBack, true)
  assert.equal(fixture.store.data.settings.active.source, previousActive.source)
})

test('failed animation writes retain runtime limits until an explicit preference is durably saved', () => {
  const fixture = createFixture({ packs: [pack('theme', 'com.test')] })
  fixture.store.data.settings.active = { source: 'com.test', id: 'theme' }
  fixture.appearanceService.setPerformanceLimited(true)
  const before = fixture.appearanceService.getAppearance()
  const settings = JSON.stringify(fixture.store.data.settings)
  const eventCount = fixture.events.length
  fixture.fixture.commitError = new Error('disk full')
  assert.throws(() => fixture.appearanceService.updateThemeProfile({
    theme: { source: 'com.test', id: 'theme' }, values: { motion: 'high' }
  }), /disk full/)
  assert.equal(JSON.stringify(fixture.store.data.settings), settings)
  assert.deepEqual(fixture.appearanceService.getAppearance(), before)
  assert.equal(fixture.events.length, eventCount)
  assert.equal(before.animation.effective, 'low')

  fixture.fixture.commitError = undefined
  const saved = fixture.appearanceService.updateThemeProfile({
    theme: { source: 'com.test', id: 'theme' }, values: { motion: 'high' }
  })
  assert.equal(saved.profile.values.motion, 'high')
  assert.equal(saved.appearance.animation.requested, 'high')
  assert.equal(saved.appearance.animation.effective, 'high')
})

test('inactive animation patches preserve the active runtime FPS limit across both identity fields', () => {
  const active = pack('theme', 'com.active')
  const otherSource = pack('theme', 'com.other')
  const otherId = pack('other', 'com.active')
  const fixture = createFixture({ packs: [active, otherSource, otherId] })
  fixture.store.data.settings.active = { source: active.source, id: active.id }
  fixture.appearanceService.setPerformanceLimited(true)

  for (const inactive of [otherSource, otherId]) {
    const snapshot = fixture.appearanceService.updateThemeProfile({
      theme: { source: inactive.source, id: inactive.id }, values: { motion: 'high' }
    })
    assert.equal(snapshot.appearance.theme.source, active.source)
    assert.equal(snapshot.appearance.theme.id, active.id)
    assert.equal(snapshot.appearance.animation.effective, 'low')
    assert.equal(snapshot.appearance.animation.continuous, false)
    assert.equal(fixture.store.data.settings.profiles[appearanceModel.themeProfileKey(inactive)].values.motion, 'high')
  }

  const snapshot = fixture.appearanceService.updateThemeProfile({
    theme: { source: active.source, id: active.id }, values: { motion: 'high' }
  })
  assert.equal(snapshot.appearance.animation.effective, 'high')
  assert.equal(snapshot.appearance.animation.continuous, true)
})

test('host snapshots apply migrated original controls through the single default package', () => {
  const fixture = createFixture()
  const previous = legacy()
  previous.theme.overrides = { light: { '--accent': '#234567' }, dark: { '--accent': '#aabbcc' } }
  previous.theme.background = { type: 'image', value: '/private/original.png', fit: 'contain', opacity: 0.71 }
  previous.theme.backgroundEffect = 'ripple'
  previous.general = {
    ...previous.general, fontFamily: '"PingFang SC", sans-serif', fontFamilyEn: 'Georgia, serif',
    fontSizeScale: 1.2, animationLevel: 'high', tabStyle: 'orb',
    splashBackground: { type: 'image', value: '/private/startup.png', opacity: 0.41 },
  }
  fixture.store.data.settings = appearanceModel.migrateAppearanceSettings(undefined, previous)
  const snapshot = fixture.appearanceService.getAppearanceSnapshot()
  assert.equal(snapshot.appearance.theme.id, 'default')
  assert.equal(snapshot.appearance.theme.name, 'eNest 默认主题')
  assert.equal(snapshot.profile.identity.id, 'default')
  assert.equal(snapshot.appearance.home.variant, 'default')
  assert.equal(snapshot.appearance.tokens['--accent'], '#234567')
  assert.equal(snapshot.appearance.tokens['--link'], '#234567')
  // 通用族（serif）必须排在中文槽位之后，否则中文选择会被 serif 抢先命中。
  assert.equal(snapshot.appearance.fonts.body, 'Georgia, "PingFang SC", sans-serif')
  assert.equal(snapshot.appearance.fonts.scale, 1.2)
  assert.equal(snapshot.appearance.layout.tabStyle, 'orb')
  assert.equal(snapshot.appearance.background.effect, 'ripple')
  assert.deepEqual(snapshot.appearance.background.media, { type: 'image', value: 'enest://appearance/legacy/background', fit: 'contain', opacity: 0.71 })
  assert.deepEqual(snapshot.appearance.splash, { type: 'image', media: { type: 'image', value: 'enest://appearance/legacy/splash', fit: 'cover', opacity: 0.41 }, opacity: 0.41 })
  assert.equal(snapshot.appearance.animation.requested, 'high')
  assert.equal(JSON.stringify(snapshot.profile).includes('/private/'), false)
  assert.equal(JSON.stringify(snapshot.appearance).includes('/private/'), false)
  assert.deepEqual(fixture.store.data.settings.legacyBackup, previous)
})

test('a registry-ready legacy pack background migrates durably once and never returns after reset', () => {
  const media = { type: 'video', value: 'enest://plugin/com.original.theme/assets/film.webm', fit: 'contain', opacity: 0.67 }
  const previousPack = { id: 'old-pack', source: 'com.original.theme', name: 'Original', tokens: {}, background: media }
  const fixture = createFixture({ packs: [previousPack] })
  const previous = legacy()
  previous.theme.packId = previousPack.id
  previous.theme.backgroundSource = 'pack'
  fixture.store.data.settings = appearanceModel.migrateAppearanceSettings(undefined, previous)
  const before = fixture.store.data.settings
  const snapshot = fixture.appearanceService.getAppearanceSnapshot()
  assert.equal(fixture.store.data.settings.revision, before.revision + 1)
  assert.deepEqual(snapshot.appearance.background.media, media)
  assert.equal(snapshot.profile.values.backgroundType, 'video')
  assert.deepEqual(snapshot.profile.values.media, media)
  assert.deepEqual(fixture.store.data.settings.legacyBackup, before.legacyBackup)
  const completed = fixture.store.data.settings
  fixture.appearanceService.getAppearanceSnapshot()
  assert.equal(fixture.store.data.settings, completed, 'reads must not acknowledge another migration write')
  const reset = fixture.appearanceService.updateThemeProfile({ theme: defaultTheme, reset: true })
  assert.equal(reset.appearance.background.media, null)
  assert.deepEqual(Object.keys(reset.profile.values), [])
  const resetState = fixture.store.data.settings
  fixture.appearanceService.getAppearanceSnapshot()
  assert.equal(fixture.store.data.settings, resetState)
  assert.equal(fixture.appearanceService.getAppearance().background.media, null)
  assert.deepEqual(fixture.store.data.settings.legacyBackup, before.legacyBackup)

  const key = appearanceModel.themeProfileKey(defaultTheme)
  const existing = appearanceModel.migrateAppearanceSettings({ version: 2, active: defaultTheme, profiles: {
    [key]: { identity: defaultTheme, schemaVersion: 2, values: { density: 0.9 }, colors: {}, quarantined: {} },
  } }, previous)
  fixture.store.data.settings = existing
  assert.equal(fixture.appearanceService.getAppearance().background.media, null)
  assert.equal(fixture.appearanceService.getAppearance().layout.density, 0.9)
  assert.equal(fixture.store.data.settings, existing, 'an already-existing default profile must not receive a pending choice')
})

test('a failed legacy pack migration commit cannot mutate the store or acknowledge imported values', () => {
  const previousPack = { id: 'old-pack', source: 'com.original.theme', name: 'Original', tokens: {}, background: { type: 'color', value: '#456789', fit: 'cover', opacity: 0.76 } }
  const fixture = createFixture({ packs: [previousPack] })
  const previous = legacy()
  previous.theme.packId = previousPack.id
  previous.theme.backgroundSource = 'pack'
  fixture.store.data.settings = appearanceModel.migrateAppearanceSettings(undefined, previous)
  const before = fixture.store.data.settings
  const serialized = JSON.stringify(before)
  const eventCount = fixture.events.length
  fixture.fixture.commitError = new Error('migration disk failure')
  assert.throws(() => fixture.appearanceService.getAppearanceSnapshot(), /migration disk failure/)
  assert.equal(fixture.store.data.settings, before)
  assert.equal(JSON.stringify(fixture.store.data.settings), serialized)
  assert.equal(fixture.events.length, eventCount)
  fixture.fixture.commitError = undefined
  const retried = fixture.appearanceService.getAppearanceSnapshot()
  assert.deepEqual(retried.appearance.background.media, previousPack.background)
  assert.equal(fixture.store.data.settings.revision, before.revision + 1)
})

test('the archived legacy appearance cannot be reactivated or edited and its backup remains immutable', async () => {
  const target = pack('target', 'com.example.theme')
  const legacyPack = {
    id: 'old-pack', source: 'com.old.theme', name: 'Old theme', mode: 'system',
    tokens: { '--accent': '#295b4b' },
    background: { type: 'color', value: '#bac9bf', opacity: 0.8, fit: 'cover' }
  }
  const fixture = createFixture({ packs: [target, legacyPack] })
  const previous = legacy()
  previous.theme.packId = legacyPack.id
  previous.theme.backgroundSource = 'pack'
  previous.general.fontFamily = 'Georgia, serif'
  previous.general.fontSizeScale = 1.1
  fixture.store.data.settings = appearanceModel.migrateAppearanceSettings(undefined, previous)
  fixture.appearanceService.setAppearanceMode('dark')
  const backup = structuredClone(fixture.store.data.settings.legacyBackup)
  const profile = JSON.stringify(fixture.store.data.settings.profiles['v2:enest.builtin:legacy-custom'])

  await fixture.appearanceService.activateTheme(target)
  const before = fixture.appearanceService.getAppearanceSnapshot()
  const eventCount = fixture.events.length
  const preparationCount = fixture.homePrepared.length
  const identity = { source: 'enest.builtin', id: 'legacy-custom' }
  await assert.rejects(() => fixture.appearanceService.activateTheme(identity), /unavailable/)
  assert.throws(() => fixture.appearanceService.updateThemeProfile({ theme: identity, colors: { dark: { '--accent': '#112233' } } }), /unavailable/)
  const snapshot = fixture.appearanceService.getAppearanceSnapshot()
  assert.deepEqual(snapshot, before)
  assert.equal(snapshot.appearance.theme.legacy, false)
  assert.equal(snapshot.appearance.theme.id, target.id)
  assert.equal(snapshot.appearance.theme.source, target.source)
  assert.equal(snapshot.appearance.requestedMode, 'dark')
  assert.equal(snapshot.appearance.mode, 'dark')
  assert.notEqual(snapshot.appearance.tokens['--accent'], legacyPack.tokens['--accent'])
  assert.equal(snapshot.appearance.background.media, null)
  assert.equal(fixture.homePrepared.length, preparationCount, 'rejected legacy activation cannot prepare another Home')
  assert.equal(fixture.events.length, eventCount)
  assert.equal(fixture.appearanceService.isActiveThemeAvailable(), true)
  assert.deepEqual(fixture.store.data.settings.legacyBackup, backup)
  assert.equal(JSON.stringify(fixture.store.data.settings.profiles['v2:enest.builtin:legacy-custom']), profile)
  assert.deepEqual(snapshot.packs.filter(pack => pack.source === 'enest.builtin').map(pack => pack.id), ['default'])
  assert.equal(snapshot.packs.length, 2, 'the V1 compatibility pack remains archived, not a selectable V2 appearance')
  await assert.rejects(() => fixture.appearanceService.activateTheme({ source: 'com.other', id: 'legacy-custom' }), /unavailable/)
})

test('a missing theme snapshot returns the same fallback identity for the rendered appearance and editable profile', () => {
  const fixture = createFixture()
  fixture.appearanceService.updateThemeProfile({ theme: defaultTheme, values: { density: 0.9 } })
  const missing = { source: 'com.example.missing', id: 'unavailable' }
  const key = appearanceModel.themeProfileKey(missing)
  fixture.store.data.settings.active = missing
  fixture.store.data.settings.profiles[key] = {
    identity: missing, schemaVersion: 2, values: { density: 1.2 }, colors: {}, quarantined: {}
  }
  const stored = JSON.stringify(fixture.store.data.settings)
  const snapshot = fixture.appearanceService.getAppearanceSnapshot()
  assert.deepEqual(snapshot.profile.identity, defaultTheme)
  assert.deepEqual(snapshot.profile.identity, { source: snapshot.appearance.theme.source, id: snapshot.appearance.theme.id })
  assert.equal(snapshot.profile.values.density, 0.9)
  assert.equal(snapshot.appearance.layout.density, 0.9)
  assert.ok(snapshot.appearance.diagnostics.some(item => item.code === 'appearance.theme-unavailable'))
  assert.equal(fixture.appearanceService.isActiveThemeAvailable(), false)
  assert.equal(JSON.stringify(fixture.store.data.settings), stored, 'fallback reads preserve the missing theme profile and retry identity')
})

test('forced light and dark caches receive fresh revisions when native mode changes', () => {
  const { service, store, events, nativeTheme } = createFixture({ packs: [pack('theme', 'com.test', '#222222')] })
  const { appearanceService } = service
  store.data.settings.active = { source: 'com.test', id: 'theme' }
  store.data.settings.mode = 'system'
  const light = appearanceService.getAppearance('light')
  assert.equal(light.mode, 'light')

  nativeTheme.shouldUseDarkColors = true
  const dark = appearanceService.invalidate()
  assert.equal(dark.mode, 'dark')
  assert.ok(dark.revision > light.revision)
  assert.ok(appearanceService.getAppearance('light').revision >= dark.revision)
  assert.deepEqual(events.map(change => change.revision), [dark.revision])
})

test('mode changes broadcast immediately without starting a competing Home transaction', async () => {
  const fixture = createFixture({ packs: [pack('theme', 'com.test')] })
  const { appearanceService, store } = fixture
  store.data.settings.active = { source: 'com.test', id: 'theme' }
  const before = appearanceService.getAppearance()
  appearanceService.setAppearanceMode('dark')
  const after = appearanceService.getAppearanceSnapshot()
  assert.equal(after.appearance.mode, 'dark')
  assert.ok(after.appearance.revision > before.revision)
  assert.equal(fixture.events.at(-1).appearance.mode, 'dark')
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.deepEqual(fixture.homePrepared, [])
})

test('rapid activation serializes transactions and a superseded request cannot publish its theme', async () => {
  const firstTheme = pack('first', 'com.example.first')
  const secondTheme = pack('second', 'com.example.second')
  const fixture = createFixture({ packs: [firstTheme, secondTheme] })
  const { appearanceService, homePrepared, homeTransactions } = fixture
  fixture.store.data.settings.active = { ...defaultTheme }
  appearanceService.getAppearance()

  const gate = new Promise(resolve => { fixture.gateResolve = resolve })
  let calls = 0
  appearanceService.setHomeCoordinator(async candidate => {
    calls += 1
    homePrepared.push(candidate)
    const transaction = {
      name: `transaction-${calls}`,
      committed: false,
      commit() { this.committed = true },
      rollback: () => undefined
    }
    if (calls === 1) {
      await gate
      transaction.name = 'stale-commit'
      homeTransactions.push({ name: transaction.name, get committed() { return transaction.committed } })
      return {
        ...transaction,
        commit: () => { transaction.committed = true },
        rollback: () => undefined
      }
    }
    homeTransactions.push({ name: transaction.name, get committed() { return transaction.committed } })
    return transaction
  })

  const first = appearanceService.activateTheme(firstTheme)
  await new Promise(resolve => setTimeout(resolve, 0))
  const second = appearanceService.activateTheme(secondTheme)
  await new Promise(resolve => setTimeout(resolve, 0))
  fixture.gateResolve()
  const [firstResult, secondResult] = await Promise.all([first, second])
  assert.equal(firstResult.appearance.theme.id, 'default')
  assert.equal(secondResult.appearance.theme.id, secondTheme.id)
  assert.equal(secondResult.appearance.theme.source, secondTheme.source)
  assert.equal(homePrepared.map(candidate => candidate.theme.id).join(','), 'first,second')
  assert.deepEqual(fixture.store.data.settings.active, { source: secondTheme.source, id: secondTheme.id })
  assert.deepEqual(homeTransactions.map(item => item.name ?? 'stale-commit'), ['stale-commit', 'transaction-2'])
  assert.equal(homeTransactions.at(-1).committed, true)
  assert.equal(homeTransactions[0].committed, false, 'superseded transaction must never be committed')
  assert.ok(fixture.events.every(event => event.appearance.theme.source !== firstTheme.source))
})

test('activation preserves profile and mode edits made while Home is loading', async () => {
  const target = pack('target', 'com.example.theme')
  const fixture = createFixture({ packs: [target] })
  let release
  const gate = new Promise(resolve => { release = resolve })
  fixture.appearanceService.setHomeCoordinator(async () => {
    await gate
    return { commit() {}, rollback() {} }
  })
  const activation = fixture.appearanceService.activateTheme(target)
  await new Promise(resolve => setTimeout(resolve, 0))
  fixture.appearanceService.setAppearanceMode('dark')
  fixture.appearanceService.updateThemeProfile({ theme: { source: target.source, id: target.id }, values: { density: 1.2 } })
  release()
  const result = await activation
  assert.equal(result.appearance.mode, 'dark')
  assert.equal(result.profile.values.density, 1.2)
})

test('retired workspace owners cannot commit a prepared theme and the candidate is rolled back', async () => {
  const target = pack('candidate', 'com.example.retired')
  const fixture = createFixture({ packs: [target] })
  const before = fixture.store.data.settings
  let active = true
  let release
  let rolledBack = false
  let committed = false
  const gate = new Promise(resolve => { release = resolve })
  fixture.appearanceService.setHomeCoordinator(async () => {
    await gate
    return { commit() { committed = true }, rollback() { rolledBack = true } }
  })
  const pending = fixture.appearanceService.activateTheme(target, undefined, () => active)
  await new Promise(resolve => setTimeout(resolve, 0))
  active = false
  release()
  await assert.rejects(pending, /owner is no longer active/)
  assert.equal(rolledBack, true)
  assert.equal(committed, false)
  assert.equal(fixture.store.data.settings, before)
  assert.equal(fixture.events.length, 0)
})

test('a broken requested home falls back to the paired built-in default theme', async () => {
  const broken = pack('broken', 'com.test')
  const fixture = createFixture({ packs: [broken] })
  fixture.store.data.settings.active = { ...defaultTheme }
  fixture.appearanceService.getAppearance()
  fixture.appearanceService.setPerformanceLimited(true)
  let calls = 0
  fixture.appearanceService.setHomeCoordinator(async candidate => {
    calls += 1
    fixture.homePrepared.push(candidate)
    if (calls === 1) throw new Error('home crashed')
    const transaction = { committed: false, commit() { this.committed = true }, rollback() { undefined } }
    fixture.homeTransactions.push({ name: `transaction-${calls}`, get committed() { return transaction.committed } })
    return transaction
  })

  const snapshot = await fixture.appearanceService.activateTheme({ source: 'com.test', id: 'broken' })
  assert.equal(snapshot.appearance.theme.id, 'default')
  assert.equal(fixture.homePrepared.map(candidate => candidate.theme.id).join(','), 'broken,default')
  assert.equal(fixture.store.data.settings.active.id, 'default')
  assert.equal(fixture.homeTransactions.at(-1).committed, true)
  for (const candidate of fixture.homePrepared) {
    assert.equal(candidate.animation.requested, 'medium')
    assert.equal(candidate.animation.effective, 'low')
    assert.equal(candidate.animation.continuous, false)
  }
  assert.equal(snapshot.appearance.animation.effective, 'low')
})

test('update publishes listener changes, rejects unavailable and invalid patches, and exposes detached snapshots', () => {
  const fixture = createFixture({ packs: [pack('theme', 'com.test')] })
  const { appearanceService } = fixture.service
  fixture.store.data.settings.active = { source: 'com.test', id: 'theme' }
  const snapshot = appearanceService.updateThemeProfile({
    theme: { source: 'com.test', id: 'theme' },
    colors: { light: { '--accent': '#0088ff' } }
  })
  assert.equal(snapshot.profile.colors.light['--accent'], '#0088ff')
  assert.equal(fixture.events.at(-1).appearance.revision, snapshot.appearance.revision)
  assert.ok(Object.isFrozen(snapshot.profile))
  assert.ok(Object.isFrozen(snapshot.profile.values))
  assert.throws(() => appearanceService.updateThemeProfile({
    theme: { source: 'com.other', id: 'theme' }, values: {}
  }), /unavailable/)
  assert.throws(() => appearanceService.updateThemeProfile({
    theme: { source: 'com.test', id: 'theme' }, values: { unknown: true }
  }), /unknown/)
})

test('refresh is a no-op without content changes and listener failures do not block publication', () => {
  let failListener = false
  const fixture = createFixture({ packs: [pack('theme', 'com.test')] })
  const { appearanceService } = fixture.service
  appearanceService.subscribeAppearance(() => { if (failListener) throw new Error('listener failed') })
  const before = appearanceService.getAppearance()
  assert.equal(appearanceService.refreshAppearance().revision, before.revision)
  failListener = true
  appearanceService.updateThemeProfile({
    theme: { source: 'com.test', id: 'theme' }, values: { density: 1.2 }
  })
  assert.equal(fixture.events.at(-1).appearance.revision, before.revision + 1)
})
