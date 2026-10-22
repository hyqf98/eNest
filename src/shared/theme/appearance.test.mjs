import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { build } from 'esbuild'
import Ajv2020 from 'ajv/dist/2020.js'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const bundle = await build({
  stdin: {
    contents: `export * from '@shared/theme/appearance'; export { DEFAULT_THEME_PACKAGE, DEFAULT_BODY_FONT } from '@shared/theme/defaultTheme/package'; export * from '@shared/theme/defaultTheme/backgroundPalettes'`,
    resolveDir: root,
    loader: 'ts',
  },
  tsconfig: join(root, 'tsconfig.node.json'),
  absWorkingDir: root,
  bundle: true,
  write: false,
  platform: 'node',
  format: 'esm',
})
const url = `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`

const {
  APPEARANCE_SCHEMA_VERSION,
  DEFAULT_THEME_IDENTITY,
  DEFAULT_THEME_PACKAGE,
  DEFAULT_BODY_FONT,
  DEFAULT_BACKGROUND_PALETTES,
  DEFAULT_NOTIFICATION_STYLE,
  appearanceStyleProperties,
  completeLegacyPackBackground,
  backgroundPalette,
  backgroundPaletteForCss,
  isSafeAppearanceBackgroundColor,
  THEME_HOME_LEGACY,
  THEME_PROFILE_LEGACY,
  migrateAppearanceSettings,
  patchThemeProfile,
  reconcileThemeProfile,
  resolveAppearance,
  themeProfileKey,
  validateThemePackV2,
} = await import(url)

const source = 'com.example.theme'
const legacy = {
  theme: {
    mode: 'system',
    overrides: {
      light: { '--accent': '#123456' },
      dark: { '--accent': '#abcdef' },
    },
    packId: 'old-pack',
    background: { type: 'color', value: '#123456', opacity: 0.8, fit: 'cover' },
    backgroundSource: 'user',
    backgroundEffect: 'orbit',
  },
  general: {
    fontFamily: '"PingFang SC", sans-serif',
    fontFamilyEn: '"Inter", sans-serif',
    fontSizeScale: 1.15,
    animationLevel: 'high',
    splashBackground: { type: 'brand', opacity: 0.55 },
  },
}

const validPackInput = {
  id: 'night',
  name: 'Night',
  schemaVersion: 2,
  mode: 'system',
  tokens: { '--accent': '#318469' },
  variants: {
    light: {
      tokens: { '--accent': '#318469' },
      fonts: { body: '"Avenir Next", sans-serif', heading: 'Georgia, serif', mono: '', scale: 1 },
      components: { controlRadius: 8, cardRadius: 12, panelRadius: 16, borderWidth: 1 },
      background: { media: null, effect: 'aurora', texture: 'silk', intensity: 0.7, speed: 1.25, direction: 45 },
      layout: { variant: 'compact', density: 0.95, gap: 12, sidebarWidth: 260, contentWidth: 900, columns: 2 },
      animation: 'medium',
    },
    dark: {
      tokens: { '--accent': '#77bfa4' },
      fonts: { body: '"Avenir Next", sans-serif', heading: 'Georgia, serif', mono: '', scale: 1 },
      components: { controlRadius: 8, cardRadius: 12, panelRadius: 16, borderWidth: 1 },
      background: { media: null, effect: 'tunnel', texture: 'silk', intensity: 0.9, speed: 0.75, direction: 180 },
      layout: { variant: 'comfortable', density: 1.05, gap: 20, sidebarWidth: 300, contentWidth: 1100, columns: 3 },
      animation: 'high',
    },
  },
  settings: {
    version: 2,
    groups: [{
      id: 'main',
      title: 'Main',
      fields: [
        { key: 'accent', label: 'Accent', type: 'color', default: '#318469', binding: { target: 'token', key: '--accent' } },
        { key: 'density', label: 'Density', type: 'slider', default: 1, min: 0.8, max: 1.2, step: 0.01, binding: { target: 'layout', key: 'density' } },
        { key: 'speed', label: 'Speed', type: 'slider', default: 1, min: 0.25, max: 2, step: 0.05, binding: { target: 'background', key: 'speed' } },
        { key: 'radius', label: 'Radius', type: 'slider', default: 8, min: 0, max: 24, step: 1, binding: { target: 'component', key: 'controlRadius' } },
        { key: 'body', label: 'Body', type: 'font', default: '"Avenir Next", sans-serif', binding: { target: 'font', key: 'body' } },
        { key: 'effect', label: 'Effect', type: 'select', default: 'aurora', options: [{ label: 'Aurora', value: 'aurora' }, { label: 'Tunnel', value: 'tunnel' }], binding: { target: 'background', key: 'texture' } },
        { key: 'motion', label: 'Motion', type: 'select', default: 'medium', options: [{ label: 'Low', value: 'low' }, { label: 'Medium', value: 'medium' }, { label: 'High', value: 'high' }], binding: { target: 'animation', key: 'level' } },
        { key: 'effectEnabled', label: 'Effect enabled', type: 'switch', default: true, binding: { target: 'background', key: 'effect' } },
      ],
    }],
  },
  home: { source, id: 'night-home', variant: 'compact' },
  version: 7,
}

const makePack = () => validateThemePackV2(validPackInput, source)

function withSetting(pack, key, patch) {
  const change = typeof patch === 'function' ? patch : () => patch
  return {
    ...pack,
    settings: {
      ...pack.settings,
      groups: pack.settings.groups.map(group => ({
        ...group,
        fields: group.fields.map(field => field.key === key ? change(field) : field),
      })),
    },
  }
}

test('validateThemePackV2 normalizes safely, binds source, and blocks unsafe input', () => {
  const pack = makePack()
  assert.equal(pack.source, source)
  assert.equal(pack.schemaVersion, 2)
  assert.deepEqual(pack.home, { source, id: 'night-home', variant: 'compact' })
  const attacks = [
    { ...validPackInput, schemaVersion: 3 },
    { ...validPackInput, id: '__proto__' },
    { ...validPackInput, id: '../escape' },
    { ...validPackInput, name: '<script>alert(1)</script>' },
    { ...validPackInput, tokens: { 'background': 'red' } },
    { ...validPackInput, tokens: { '--x': 'url(https://example.test/x)' } },
    { ...validPackInput, tokens: { '--shadow': '0 8px 16px rgba(0,0,0,.16)' } },
    { ...validPackInput, variants: { ...validPackInput.variants, light: { ...validPackInput.variants.light, tokens: { '--accent': 'javascript:alert(1)' } } } },
    withSetting(validPackInput, 'accent', { binding: { target: 'layout', key: 'density' } }),
    withSetting(validPackInput, 'effect', { default: 'aurora', binding: { target: 'font', key: 'body' } }),
    withSetting(validPackInput, 'density', { default: '1' }),
    withSetting(validPackInput, 'effect', field => ({ ...field, binding: { target: 'animation', key: 'level' } })),
    { ...validPackInput, settings: { ...validPackInput.settings, groups: validPackInput.settings.groups.map(group => ({ ...group, extra: true })) } },
    { ...validPackInput, home: { source: 'com.other.plugin', id: 'home', variant: 'legacy' } },
    { ...validPackInput, backgroundEffects: [{ id: 'bad', name: 'Bad', renderer: 'shader', shader: 'main(){}' }] },
    { ...validPackInput, background: { type: 'image', value: 'https://example.test/x.png', opacity: 1, fit: 'cover' } },
    { ...validPackInput, background: { type: 'image', value: `enest://plugin/com.other.plugin/assets/x.png`, opacity: 1, fit: 'cover' } },
    { ...validPackInput, variants: { ...validPackInput.variants, dark: { ...validPackInput.variants.dark, background: { ...validPackInput.variants.dark.background, media: { type: 'image', value: '/etc/passwd', opacity: 1, fit: 'cover' } } } } },
  ]
  for (const [index, attack] of attacks.entries()) {
    let rejected = false
    try { validateThemePackV2(attack, source) } catch { rejected = true }
    assert.equal(rejected, true, `attack ${index}: ${JSON.stringify(attack).slice(0, 600)}`)
  }
  assert.throws(() => validateThemePackV2(validPackInput, 'enest.builtin'), /reserved theme source/)
  const packInput = makePack()
  packInput.name = 'mutated'
  assert.equal(makePack().name, 'Night')
})

test('official mixed-case sources retain their identity through validation, migration and profile patches', () => {
  const official = 'com.github.eNest.theme'
  const lower = official.toLowerCase()
  const input = { ...validPackInput, source: 'com.forged.source', home: { ...validPackInput.home, source: official } }
  const pack = validateThemePackV2(input, official)
  assert.equal(pack.source, official)
  assert.equal(pack.home.source, official)
  const identity = { source: official, id: pack.id }
  const settings = migrateAppearanceSettings({ version: 2, active: identity, profiles: {} }, legacy)
  assert.deepEqual(settings.active, identity)
  const key = themeProfileKey(identity)
  assert.equal(key, 'v2:com.github.eNest.theme:night')
  assert.notEqual(key, themeProfileKey({ source: lower, id: pack.id }))
  const profile = patchThemeProfile(pack, settings.profiles[key], { theme: identity, values: { density: 1.1 } })
  assert.deepEqual(profile.identity, identity)
  assert.equal(profile.values.density, 1.1)
  const resolved = resolveAppearance({ settings: { ...settings, profiles: { ...settings.profiles, [key]: profile } }, pack, systemDark: false, reducedMotion: false })
  assert.equal(resolved.theme.source, official)
  assert.equal(resolved.home.source, official)
  assert.equal(resolved.layout.density, 1.1)
  assert.throws(() => validateThemePackV2({ ...input, home: { ...input.home, source: lower } }, official), /owning source/)
  assert.throws(() => patchThemeProfile(pack, profile, { theme: { source: lower, id: pack.id }, values: {} }), /identity/)
  for (const source of ['Com.github.eNest.theme', 'com.github.eNest/theme', 'com..theme', 'com.github.theme_unsafe']) {
    assert.throws(() => validateThemePackV2(input, source), /source/)
  }
})

test('migration is repeatable, preserves the immutable backup, and blocks prototype keys', () => {
  const first = migrateAppearanceSettings(undefined, legacy)
  assert.equal(first.version, 2)
  assert.deepEqual(first.active, DEFAULT_THEME_IDENTITY)
  assert.equal(first.mode, 'system')
  assert.deepEqual(first.legacyBackup, legacy)
  assert.equal(themeProfileKey(THEME_PROFILE_LEGACY), 'v2:enest.builtin:legacy-custom')
  const key = '__proto__'
  const poisoned = {
    version: 2,
    revision: 9,
    mode: 'dark',
    active: THEME_PROFILE_LEGACY,
    legacy,
    profiles: {},
  }
  Object.defineProperty(poisoned.profiles, key, {
    value: { identity: THEME_PROFILE_LEGACY, values: { x: 1 } },
    enumerable: true,
    writable: true,
    configurable: true,
  })
  const clean = migrateAppearanceSettings(poisoned, legacy)
  assert.equal(Object.hasOwn(clean.profiles, key), false)
  const changedLegacy = structuredClone(legacy)
  changedLegacy.general.animationLevel = 'low'
  const second = migrateAppearanceSettings(clean, changedLegacy)
  assert.deepEqual(second.legacyBackup, legacy)
  assert.equal(second.mode, 'dark')
  assert.equal(second.revision, 9)
  second.legacy.general.fontFamily = 'Georgia, serif'
  assert.deepEqual(migrateAppearanceSettings(second, changedLegacy).legacyBackup, legacy)
})

test('legacy settings become effective default-theme values while their immutable backup survives', () => {
  const settings = migrateAppearanceSettings(undefined, legacy)
  const light = resolveAppearance({ settings, systemDark: false })
  const dark = resolveAppearance({ settings, systemDark: true })
  assert.equal(light.theme.legacy, false)
  assert.equal(light.theme.id, 'default')
  assert.equal(light.mode, 'light')
  assert.equal(dark.mode, 'dark')
  assert.equal(light.tokens['--accent'], '#123456')
  assert.equal(dark.tokens['--accent'], '#abcdef')
  assert.equal(light.tokens['--link'], '#123456')
  assert.equal(dark.tokens['--link'], '#abcdef')
  // 英文栈尾的通用族同样覆盖中文字形，必须让位于中文槽位，否则「中文字体」选择永远不生效。
  assert.equal(light.fonts.body, '"Inter", "PingFang SC", sans-serif')
  assert.equal(light.fonts.cjk, legacy.general.fontFamily)
  assert.equal(light.fonts.latin, legacy.general.fontFamilyEn)
  assert.equal(light.fonts.scale, 1.15)
  assert.deepEqual(light.background.media, legacy.theme.background)
  assert.equal(light.background.effect, 'orbit')
  assert.deepEqual(settings.legacyBackup, legacy)
  assert.deepEqual(settings.legacy.theme.background, legacy.theme.background)
  assert.equal(settings.profiles[themeProfileKey(THEME_PROFILE_LEGACY)].colors.light['--accent'], '#123456')
  assert.deepEqual(light.animation, { requested: 'high', effective: 'high', continuous: true })
  assert.deepEqual(light.home, THEME_HOME_LEGACY)
  assert.equal(light.home.variant, 'default')
  assert.deepEqual(light.splash, { type: 'brand', media: null, opacity: 0.55 })
  const reduced = resolveAppearance({ settings, systemDark: true, reducedMotion: true })
  assert.equal(reduced.animation.effective, 'low')
  assert.equal(reduced.animation.continuous, false)
  assert.equal(reduced.background.speed, 0.25)
})

test('legacy background and independent Splash remain effective through opaque host handles', () => {
  for (const type of ['image', 'video']) {
    const previous = structuredClone(legacy)
    previous.theme.background = { type, value: `/Users/private/壁纸.${type === 'image' ? 'png' : 'webm'}`, opacity: 0.63, fit: 'contain' }
    previous.general.splashBackground = { type: 'image', value: '/Users/private/startup.png', opacity: 0.27 }
    previous.general.tabStyle = 'orb'
    const original = structuredClone(previous)
    const settings = migrateAppearanceSettings(undefined, previous)
    const profile = settings.profiles[themeProfileKey(DEFAULT_THEME_IDENTITY)]
    const appearance = resolveAppearance({ settings })
    assert.deepEqual(appearance.background.media, { ...previous.theme.background, value: 'enest://appearance/legacy/background' })
    assert.equal(appearance.background.kind, type)
    assert.equal(appearance.background.opacity, 0.63)
    assert.equal(appearance.background.fit, 'contain')
    assert.deepEqual(appearance.splash, { type: 'image', media: { type: 'image', value: 'enest://appearance/legacy/splash', opacity: 0.27, fit: 'cover' }, opacity: 0.27 })
    assert.equal(appearance.layout.tabStyle, 'orb')
    for (const value of [profile, appearance]) {
      assert.equal(JSON.stringify(value).includes('/Users/private/'), false, 'public profiles/snapshots must not expose source paths')
    }
    assert.deepEqual(settings.legacyBackup, original)
    assert.deepEqual(previous, original)
    assert.deepEqual(JSON.parse(JSON.stringify(migrateAppearanceSettings(settings, previous))), JSON.parse(JSON.stringify(settings)))
  }
})

test('all eight original atmosphere presets migrate by safe identity and reject arbitrary CSS', () => {
  assert.deepEqual(DEFAULT_BACKGROUND_PALETTES.map(item => item.id), ['theme', 'dawn', 'mint', 'linen', 'peach', 'ocean', 'forest', 'ink'])
  assert.ok(Object.isFrozen(DEFAULT_BACKGROUND_PALETTES))
  for (const palette of DEFAULT_BACKGROUND_PALETTES) {
    assert.ok(Object.isFrozen(palette))
    assert.equal(backgroundPalette(palette.id), palette)
    assert.equal(backgroundPaletteForCss(palette.css), palette)
    assert.equal(isSafeAppearanceBackgroundColor(palette.css), true)
    const previous = structuredClone(legacy)
    previous.theme.background = { type: 'color', value: palette.css, opacity: 0.42, fit: 'cover' }
    const settings = migrateAppearanceSettings(undefined, previous)
    const profile = settings.profiles[themeProfileKey(DEFAULT_THEME_IDENTITY)]
    assert.equal(profile.values.backgroundType, 'gradient')
    assert.equal(profile.values.backgroundPalette, palette.id)
    assert.deepEqual(resolveAppearance({ settings }).background.media, previous.theme.background)
    assert.equal(JSON.stringify(profile).includes(palette.css), false, 'preset CSS is derived, not accepted profile code')
  }
  for (const value of ['linear-gradient(red, blue)', 'url(file:///private/secret)', 'var(--arbitrary)', '#fff; background: red', `${DEFAULT_BACKGROUND_PALETTES[0].css}, url(https://example.test/x)`]) {
    assert.equal(isSafeAppearanceBackgroundColor(value), false, value)
    const input = structuredClone(validPackInput)
    input.variants.light.background.media = { type: 'color', value, opacity: 1, fit: 'cover' }
    assert.throws(() => validateThemePackV2(input, source), /safe color|atmosphere preset/)
  }
  assert.equal(isSafeAppearanceBackgroundColor('rgba(0, 12, 24, 0.5)'), true)
  assert.equal(backgroundPalette('__proto__'), undefined)
})

test('default font slots retain the other authored script fallback when only one is changed', () => {
  const pack = DEFAULT_THEME_PACKAGE.contributes.themePacks[0]
  const settings = migrateAppearanceSettings(undefined, { theme: { mode: 'light', overrides: {} }, general: {} })
  const key = themeProfileKey(DEFAULT_THEME_IDENTITY)
  settings.profiles[key] = patchThemeProfile(pack, settings.profiles[key], {
    theme: DEFAULT_THEME_IDENTITY, values: { fontFamilyEn: 'Georgia, serif', fontFamily: '' },
  })
  let appearance = resolveAppearance({ settings, pack })
  assert.match(appearance.fonts.body, /^Georgia, "PingFang SC"/)
  assert.doesNotMatch(pack.settings.groups.flatMap(group => group.fields).find(field => field.key === 'fontFamilyEn').options.find(option => option.label === 'Georgia 衬线').value, /Songti/)
  settings.profiles[key] = patchThemeProfile(pack, settings.profiles[key], {
    theme: DEFAULT_THEME_IDENTITY, values: { fontFamilyEn: '', fontFamily: '"LXGW WenKai", serif', fontScale: 1.2 },
  })
  appearance = resolveAppearance({ settings, pack })
  assert.match(appearance.fonts.body, /^"Inter", "SF Pro Display", "LXGW WenKai"/)
  assert.equal(appearanceStyleProperties(appearance)['--appearance-font-scale'], '1.2')
  assert.equal(appearanceStyleProperties(appearance)['--font-size-base'], '16.8px')
})

test('migration accepts frozen old data and retains either or both original font slots', () => {
  for (const [latin, cjk, expected] of [
    ['', '', DEFAULT_BODY_FONT],
    ['Georgia, serif', '', 'Georgia, "PingFang SC", "Microsoft YaHei", system-ui, sans-serif'],
    ['', '"PingFang SC", sans-serif', '"Inter", "SF Pro Display", "PingFang SC", sans-serif'],
    ['Georgia, serif', '"PingFang SC", sans-serif', 'Georgia, "PingFang SC", sans-serif'],
  ]) {
    const previous = structuredClone(legacy)
    previous.general.fontFamily = cjk
    previous.general.fontFamilyEn = latin
    previous.theme.mode = 'unrecognized'
    const freeze = value => {
      if (!value || typeof value !== 'object') return value
      for (const child of Object.values(value)) freeze(child)
      return Object.freeze(value)
    }
    freeze(previous)
    const appearance = resolveAppearance({ settings: migrateAppearanceSettings(undefined, previous) })
    assert.equal(appearance.fonts.body, expected)
    assert.equal(appearance.fonts.heading, expected)
    assert.equal(appearance.requestedMode, 'light')
    assert.equal(previous.theme.mode, 'unrecognized', 'normalization must not mutate the old store object')
  }
})

test('existing default edits and intentional reset never re-import archived appearance settings', () => {
  const pack = DEFAULT_THEME_PACKAGE.contributes.themePacks[0]
  const settings = migrateAppearanceSettings(undefined, legacy)
  const key = themeProfileKey(DEFAULT_THEME_IDENTITY)
  settings.profiles[key] = patchThemeProfile(pack, settings.profiles[key], {
    theme: DEFAULT_THEME_IDENTITY,
    values: { fontFamily: 'Georgia, serif', fontFamilyEn: '', fontScale: 1.05, backgroundEffect: 'none', backgroundType: 'none', splashType: 'none', tabStyle: 'orb', contentWidth: 1020 },
    colors: { light: { '--accent': '#152637', '--link': '#734625' } },
  })
  const changedLegacy = structuredClone(legacy)
  changedLegacy.general.fontFamily = '"Courier New", monospace'
  const retained = migrateAppearanceSettings(settings, changedLegacy)
  const appearance = resolveAppearance({ settings: retained })
  assert.equal(appearance.fonts.body, 'Georgia, serif')
  assert.equal(appearance.fonts.scale, 1.05)
  assert.equal(appearance.background.effect, 'none')
  assert.equal(appearance.background.media, null)
  assert.equal(appearance.splash.type, 'none')
  assert.equal(appearance.layout.tabStyle, 'orb')
  assert.equal(appearance.layout.contentWidth, 1020, 'an existing explicit content width must not be migrated to the new default')
  assert.equal(appearance.tokens['--accent'], '#152637')
  assert.equal(appearance.tokens['--link'], '#734625')
  retained.profiles[key] = patchThemeProfile(pack, retained.profiles[key], { theme: DEFAULT_THEME_IDENTITY, reset: true })
  const reset = migrateAppearanceSettings(retained, changedLegacy)
  const defaults = resolveAppearance({ settings: reset })
  assert.deepEqual(Object.keys(reset.profiles[key].values), [])
  assert.equal(defaults.fonts.body, DEFAULT_BODY_FONT)
  assert.equal(defaults.fonts.scale, 1)
  assert.equal(defaults.tokens['--accent'], '#bd542b')
  assert.equal(defaults.tokens['--link'], '#bd542b')
  assert.equal(defaults.layout.tabStyle, 'classic')
  assert.equal(defaults.layout.contentWidth, 1520)
  assert.equal(defaults.background.effect, 'tunnel')
  assert.equal(defaults.background.media, null)
  assert.deepEqual(defaults.splash, { type: 'brand', media: null, opacity: 0.55 })
  assert.deepEqual(reset.legacyBackup, settings.legacyBackup)
})

test('legacy background effect identities and retired disabled-background choice are preserved', () => {
  const previous = structuredClone(legacy)
  previous.theme.backgroundEffect = 'plugin:com.github.eNest.theme:custom:film'
  const settings = migrateAppearanceSettings(undefined, previous)
  assert.equal(resolveAppearance({ settings }).background.effect, previous.theme.backgroundEffect)
  const warm = { source: 'enest.builtin', id: 'warm' }
  const key = themeProfileKey(warm)
  const profile = { identity: warm, schemaVersion: 2, values: { background: false, bodyFont: 'Georgia, serif', radius: 7 }, colors: {}, quarantined: {} }
  const migrated = migrateAppearanceSettings({ version: 2, active: warm, profiles: { [key]: profile } }, previous)
  const appearance = resolveAppearance({ settings: migrated })
  assert.equal(appearance.background.effect, 'none')
  assert.equal(appearance.fonts.cjk, 'Georgia, serif')
  assert.equal(appearance.components.controlRadius, 7)
  assert.deepEqual(JSON.parse(JSON.stringify(migrated.profiles[key])), profile)
})

test('background/Splash destinations enforce closed enums, ranges and image-only startup media', () => {
  const pack = DEFAULT_THEME_PACKAGE.contributes.themePacks[0]
  const profile = migrateAppearanceSettings(undefined, legacy).profiles[themeProfileKey(DEFAULT_THEME_IDENTITY)]
  for (const [key, value] of [
    ['backgroundType', 'iframe'], ['backgroundPalette', 'url(file:///private)'], ['backgroundColor', 'var(--secret)'],
    ['backgroundOpacity', 1.01], ['backgroundFit', 'fill'], ['backgroundEffect', 'javascript:alert(1)'],
    ['splashType', 'video'], ['splashOpacity', -0.01],
    ['splashMedia', { type: 'video', value: `enest://appearance/media/${'b'.repeat(64)}.mp4`, opacity: 0.8, fit: 'cover' }],
  ]) assert.throws(() => patchThemeProfile(pack, profile, { theme: DEFAULT_THEME_IDENTITY, values: { [key]: value } }), /invalid theme setting/, key)

  for (const [key, value] of [['kind', 'iframe'], ['palette', 'custom-css'], ['fit', 'fill'], ['opacity', 2], ['color', 'url(file:///private)']]) {
    const input = structuredClone(validPackInput)
    input.variants.light.background[key] = value
    assert.throws(() => validateThemePackV2(input, source), /background/)
  }
  for (const splash of [
    { type: 'video', media: null, opacity: 0.5 }, { type: 'image', media: null, opacity: Infinity },
    { type: 'image', media: { type: 'video', value: `enest://plugin/${source}/assets/film.mp4`, opacity: 1, fit: 'cover' }, opacity: 0.5 },
    { type: 'brand', media: null, opacity: 0.5, css: 'body{display:none}' },
  ]) {
    const input = structuredClone(validPackInput)
    input.variants.light.splash = splash
    assert.throws(() => validateThemePackV2(input, source), /splash/)
  }
})

test('font presets and new semantic options remain data-only and cannot broaden their binding', () => {
  const preset = withSetting(validPackInput, 'body', field => ({ ...field, options: [{ label: 'System', value: 'Georgia, serif' }] }))
  assert.deepEqual(validateThemePackV2(preset, source).settings.groups[0].fields.find(field => field.key === 'body').options, [{ label: 'System', value: 'Georgia, serif' }])
  for (const value of ['Arial; color:red', 'url(file:///private/font.ttf)', 'var(--font)', 123]) {
    const input = withSetting(preset, 'body', field => ({ ...field, options: [{ label: 'Unsafe', value }] }))
    assert.throws(() => validateThemePackV2(input, source), /font stack/)
  }
  for (const [binding, safe, bad] of [
    [{ target: 'background', key: 'kind' }, 'none', 'iframe'],
    [{ target: 'background', key: 'palette' }, 'theme', 'custom-css'],
    [{ target: 'background', key: 'fit' }, 'cover', 'fill'],
    [{ target: 'background', key: 'texture' }, 'none', 'url(file:///private)'],
    [{ target: 'splash', key: 'type' }, 'brand', 'video'],
    [{ target: 'animation', key: 'level' }, 'medium', 'ultra'],
  ]) {
    const input = withSetting(validPackInput, 'effect', field => ({ ...field, binding, default: safe, options: [{ label: 'Safe', value: safe }, { label: 'Bad', value: bad }] }))
    input.settings.groups[0].fields = input.settings.groups[0].fields.filter(field => field.key === 'effect' || field.binding.target !== binding.target || field.binding.key !== binding.key)
    assert.throws(() => validateThemePackV2(input, source), /semantic choice/)
  }
  const unsafe = withSetting(validPackInput, 'effect', field => ({ ...field, binding: { target: 'splash', key: 'css' } }))
  assert.throws(() => validateThemePackV2(unsafe, source), /binding/)
})

test('host legacy media handles are not available to third-party declarations or profile patches', () => {
  for (const value of ['enest://appearance/legacy/background', 'enest://appearance/legacy/splash']) {
    const media = { type: 'image', value, opacity: 0.5, fit: 'cover' }
    const input = structuredClone(validPackInput)
    input.variants.light.background.media = media
    assert.throws(() => validateThemePackV2(input, source), /source/)
    input.variants.light.background.media = null
    input.settings.groups[0].fields.push({ key: 'media', label: 'Media', type: 'media', default: null, binding: { target: 'background', key: 'media' } })
    const pack = validateThemePackV2(input, source)
    const identity = { source, id: pack.id }
    const profile = { identity, schemaVersion: 2, values: {}, colors: {}, quarantined: {} }
    assert.throws(() => patchThemeProfile(pack, profile, { theme: identity, values: { media } }), /invalid theme setting/)
    const quarantined = reconcileThemeProfile(pack, { ...profile, values: { media } })
    assert.equal(quarantined.values.media, undefined)
    assert.deepEqual(quarantined.quarantined['values.media'].value, media)
    const builtin = DEFAULT_THEME_PACKAGE.contributes.themePacks[0]
    const builtinProfile = migrateAppearanceSettings(undefined, legacy).profiles[themeProfileKey(DEFAULT_THEME_IDENTITY)]
    assert.deepEqual(patchThemeProfile(builtin, builtinProfile, { theme: DEFAULT_THEME_IDENTITY, values: { media } }).values.media, media)
  }
})

function pendingLegacyPackSettings(backgroundSource = 'pack') {
  const previous = structuredClone(legacy)
  previous.theme.backgroundSource = backgroundSource
  previous.theme.packId = 'old-pack'
  delete previous.theme.background
  return migrateAppearanceSettings(undefined, previous)
}

test('pack-sourced legacy backgrounds complete once after the source-bound registry becomes available', () => {
  const owner = 'com.example.original'
  for (const media of [
    { type: 'color', value: '#456789', opacity: 0.62, fit: 'contain' },
    { type: 'image', value: `enest://plugin/${owner}/assets/background.png`, opacity: 0.73, fit: 'contain' },
    { type: 'video', value: `enest://plugin/${owner}/assets/film.webm`, opacity: 0.81, fit: 'cover' },
    { type: 'none', value: '', opacity: 0.44, fit: 'cover' },
    undefined,
  ]) {
    const settings = pendingLegacyPackSettings()
    const before = JSON.stringify(settings)
    const key = themeProfileKey(DEFAULT_THEME_IDENTITY)
    const pack = { id: 'old-pack', source: owner, name: 'Original', tokens: {}, ...(media ? { background: media } : {}) }
    assert.equal(completeLegacyPackBackground(settings, []), settings, 'an unavailable source does not block the default or consume the pending choice')
    assert.equal(completeLegacyPackBackground(settings, [{ ...pack, id: 'different' }]), settings)
    const completed = completeLegacyPackBackground(settings, [pack])
    assert.notEqual(completed, settings)
    assert.equal(completed.revision, settings.revision + 1)
    assert.equal(Object.values(completed.profiles[key].quarantined).some(item => item.reason === 'legacy-pack-background-pending'), false)
    const resolved = resolveAppearance({ settings: completed })
    assert.equal(resolved.background.kind, media?.type ?? 'none')
    assert.deepEqual(resolved.background.media, media?.type === 'none' || !media ? null : media)
    assert.equal(resolved.background.opacity, media?.opacity ?? 0.85)
    assert.equal(resolved.background.fit, media?.fit ?? 'cover')
    assert.equal(resolved.background.effect, 'orbit')
    assert.equal(resolved.fonts.scale, 1.15)
    assert.equal(resolved.tokens['--accent'], '#123456')
    assert.deepEqual(completed.legacyBackup, settings.legacyBackup)
    assert.equal(JSON.stringify(settings), before)
    assert.equal(completeLegacyPackBackground(completed, [pack]), completed)
    assert.equal(completeLegacyPackBackground(completed, [{ ...pack, background: { type: 'color', value: '#987654', opacity: 1, fit: 'cover' } }]), completed, 'later pack updates do not re-import a completed choice')
    const reloaded = migrateAppearanceSettings(JSON.parse(JSON.stringify(completed)), completed.legacy)
    assert.equal(completeLegacyPackBackground(reloaded, [pack]), reloaded)
    assert.deepEqual(resolveAppearance({ settings: reloaded }).background, resolved.background)
  }
  const unmarkedLegacy = structuredClone(legacy)
  delete unmarkedLegacy.theme.backgroundSource
  delete unmarkedLegacy.theme.background
  const unmarked = migrateAppearanceSettings(undefined, unmarkedLegacy)
  assert.notEqual(completeLegacyPackBackground(unmarked, [{ id: 'old-pack', source: owner, name: 'Original', tokens: {}, background: { type: 'color', value: '#456789', opacity: 0.7, fit: 'cover' } }]), unmarked, 'unmarked legacy data retains the original pack fallback')
  const user = pendingLegacyPackSettings('user')
  assert.equal(completeLegacyPackBackground(user, [{ id: 'old-pack', source: owner, name: 'Original', tokens: {} }]), user, 'an explicit empty user background is not a pack fallback')
})

test('only a selected pack own safe asset or color may complete a pending migration', () => {
  const owner = 'com.example.original'
  for (const media of [
    { type: 'image', value: 'enest://plugin/com.other.theme/assets/background.png', opacity: 1, fit: 'cover' },
    { type: 'image', value: '/private/secret.png', opacity: 1, fit: 'cover' },
    { type: 'image', value: 'https://example.test/background.png', opacity: 1, fit: 'cover' },
    { type: 'image', value: `enest://plugin/${owner}/assets/../private.png`, opacity: 1, fit: 'cover' },
    { type: 'image', value: `enest://plugin/${owner}/assets/%2e%2e/private.png`, opacity: 1, fit: 'cover' },
    { type: 'video', value: `enest://plugin/${owner}/assets/background.png`, opacity: 1, fit: 'cover' },
    { type: 'color', value: 'linear-gradient(red, blue)', opacity: 1, fit: 'cover' },
    { type: 'color', value: '#456789', opacity: 2, fit: 'cover' },
    { type: 'image', value: 'enest://appearance/legacy/background', opacity: 1, fit: 'cover' },
    { type: 'image', value: `enest://appearance/media/${'c'.repeat(64)}.png`, opacity: 1, fit: 'cover' },
  ]) {
    const settings = pendingLegacyPackSettings()
    const pack = { id: 'old-pack', source: owner, name: 'Original', tokens: {}, background: media }
    assert.equal(completeLegacyPackBackground(settings, [pack]), settings, JSON.stringify(media))
    assert.equal(resolveAppearance({ settings }).background.media, null)
  }
  for (const source of ['enest.builtin', 'bad source', 'com.invalid/source']) {
    const settings = pendingLegacyPackSettings()
    assert.equal(completeLegacyPackBackground(settings, [{ id: 'old-pack', source, name: 'Invalid', tokens: {}, background: { type: 'color', value: '#456789', opacity: 1, fit: 'cover' } }]), settings)
  }
  const extension = structuredClone(validPackInput)
  extension.variants.light.background.media = { type: 'image', value: `enest://plugin/${owner}/assets/background.png`, opacity: 1, fit: 'cover' }
  assert.throws(() => validateThemePackV2(extension, source), /source/)
})

test('pending pack choices never overwrite an existing default, reset or explicit background mutation', () => {
  const pack = DEFAULT_THEME_PACKAGE.contributes.themePacks[0]
  const legacyPack = { id: 'old-pack', source: 'com.example.original', name: 'Original', tokens: {}, background: { type: 'color', value: '#456789', opacity: 0.6, fit: 'contain' } }
  const key = themeProfileKey(DEFAULT_THEME_IDENTITY)
  const pending = pendingLegacyPackSettings()
  for (const patch of [
    { values: { backgroundType: 'none' } }, { values: { backgroundEffect: 'none' } },
    { values: { backgroundOpacity: 0.3 } }, { values: { media: null } }, { reset: true },
  ]) {
    const profile = patchThemeProfile(pack, pending.profiles[key], { theme: DEFAULT_THEME_IDENTITY, ...patch })
    const changed = { ...pending, profiles: { ...pending.profiles, [key]: profile } }
    assert.equal(completeLegacyPackBackground(changed, [legacyPack]), changed)
    const migratedAgain = migrateAppearanceSettings(changed, changed.legacy)
    assert.equal(completeLegacyPackBackground(migratedAgain, [legacyPack]), migratedAgain)
    assert.equal(resolveAppearance({ settings: migratedAgain }).background.media, null)
  }
  const layoutOnly = patchThemeProfile(pack, pending.profiles[key], { theme: DEFAULT_THEME_IDENTITY, values: { density: 1.1 } })
  const kept = completeLegacyPackBackground({ ...pending, profiles: { ...pending.profiles, [key]: layoutOnly } }, [legacyPack])
  assert.deepEqual(resolveAppearance({ settings: kept }).background.media, legacyPack.background)
  assert.equal(resolveAppearance({ settings: kept }).layout.density, 1.1)
  const existingDefault = { identity: DEFAULT_THEME_IDENTITY, schemaVersion: 2, values: {}, colors: {}, quarantined: {} }
  const existing = migrateAppearanceSettings({ version: 2, active: DEFAULT_THEME_IDENTITY, profiles: { [key]: existingDefault } }, pending.legacy)
  assert.equal(completeLegacyPackBackground(existing, [legacyPack]), existing)
  assert.deepEqual(Object.keys(existing.profiles[key].values), [])
})

test('V2 resolver follows defaults, patches, isolated profiles, and constraints', () => {
  const pack = makePack()
  const settings = migrateAppearanceSettings({
    version: 2,
    revision: 4,
    mode: 'dark',
    active: { source, id: 'night' },
    legacy,
    profiles: {
      [themeProfileKey({ source, id: 'night' })]: {
        identity: { source, id: 'night' },
        schemaVersion: 2,
        values: { density: 1.2, speed: 2, radius: 0, effect: 'tunnel', motion: 'low', effectEnabled: false },
        colors: { dark: { '--accent': '#111111', '--text': '#eeeeee' } },
      },
    },
  }, legacy)
  const resolved = resolveAppearance({ settings, pack, systemDark: true })
  assert.equal(resolved.theme.name, 'Night')
  assert.equal(resolved.theme.version, 7)
  assert.equal(resolved.layout.density, 1.2)
  assert.equal(resolved.background.speed, 2)
  assert.equal(resolved.background.effect, 'none')
  assert.equal(resolved.components.controlRadius, 0)
  assert.equal(resolved.animation.effective, 'low')
  assert.equal(resolved.tokens['--accent'], '#111111')
  assert.deepEqual(resolved.home, pack.home)
  const noPack = resolveAppearance({ settings, pack: null, systemDark: true })
  assert.equal(noPack.theme.legacy, false)
  assert.equal(noPack.theme.id, DEFAULT_THEME_IDENTITY.id)
  assert.ok(noPack.diagnostics.some(item => item.code === 'appearance.theme-unavailable'))
  assert.deepEqual(noPack.home, THEME_HOME_LEGACY)
  const constrained = resolveAppearance({ settings, pack, systemDark: true, performanceLimited: true })
  assert.equal(constrained.background.speed, 0.25)
  assert.equal(constrained.animation.effective, 'low')
})

test('reconcile quarantines invalid and removed fields and recovers valid upgrades', () => {
  const pack = makePack()
  const identity = { source, id: 'night' }
  const profile = {
    identity,
    schemaVersion: 2,
    values: { density: 1.2, old: 'x', speed: 99 },
    colors: { light: { '--accent': '#123456', bad: 'red' }, dark: { '--accent': 'javascript:alert(1)' } },
    quarantined: { 'values.old': { value: 'x', reason: 'field-removed', schemaVersion: 1 } },
  }
  const reconciled = reconcileThemeProfile(pack, profile)
  assert.equal(reconciled.values.density, 1.2)
  assert.equal(reconciled.values.speed, undefined)
  assert.equal(reconciled.colors.light?.['--accent'], '#123456')
  assert.equal(reconciled.colors.light?.bad, undefined)
  assert.ok(reconciled.quarantined['values.old'])
  assert.ok(reconciled.quarantined['values.speed'])
  assert.ok(reconciled.quarantined['colors.light.bad'])
  const upgraded = makePack()
  upgraded.settings.groups[0].fields.push({ key: 'old', label: 'Old', type: 'select', default: 'x', options: [{ label: 'X', value: 'x' }], binding: { target: 'background', key: 'effect' } })
  const recovered = reconcileThemeProfile(upgraded, { ...reconciled, quarantined: { ...reconciled.quarantined, 'values.old': { value: 'x', reason: 'field-removed', schemaVersion: 1 } } })
  assert.equal(recovered.quarantined['values.old'], undefined)
  assert.equal(recovered.values.old, 'x')
})

test('patching is atomic and isolated by theme identity', () => {
  const pack = makePack()
  const identity = { source, id: 'night' }
  const profile = { identity, schemaVersion: 2, values: {}, colors: {}, quarantined: {} }
  const patched = patchThemeProfile(pack, profile, {
    theme: identity,
    values: { density: 1.1 },
    colors: { dark: { '--accent': '#222222', '--text': null } },
  })
  assert.equal(patched.values.density, 1.1)
  assert.equal(patched.colors.dark?.['--accent'], '#222222')
  assert.throws(() => patchThemeProfile(pack, profile, { theme: identity, values: { density: 2, speed: 1 } }), /invalid theme setting/)
  const poisonedColor = {}
  Object.defineProperty(poisonedColor, '__proto__', { value: {}, enumerable: true, configurable: true })
  assert.throws(() => patchThemeProfile(pack, profile, { theme: identity, colors: { dark: poisonedColor } }), /invalid theme color|reserved key/)
  assert.throws(() => patchThemeProfile(pack, profile, { theme: { source, id: 'other' }, values: { density: 1 } }), /identity/)
  assert.throws(() => patchThemeProfile(null, profile, { theme: identity, values: { density: 1 } }), /unknown theme setting/)
  assert.equal(patched.values.density, 1.1)
})

test('independent material bindings are bounded and old V2 backgrounds receive defaults', () => {
  const pack = makePack()
  assert.equal(pack.variants.light.background.warmth, 0.5)
  assert.equal(pack.variants.light.background.grain, 0.12)
  assert.equal(pack.variants.light.background.scale, 1)
  assert.equal(pack.variants.light.background.wash, 0.35)
  for (const [key, value] of [['warmth', 2], ['grain', -1], ['scale', 0], ['wash', Infinity]]) {
    const input = structuredClone(validPackInput)
    input.variants.light.background[key] = value
    assert.throws(() => validateThemePackV2(input, source), new RegExp(`background.${key}`))
  }
  const invalidBinding = withSetting(validPackInput, 'speed', field => ({
    ...field, binding: { target: 'background', key: 'grain' }, min: 0, max: 2,
  }))
  assert.throws(() => validateThemePackV2(invalidBinding, source), /semantic binding/)
  const numericHeading = withSetting(validPackInput, 'speed', field => ({
    ...field, binding: { target: 'font', key: 'heading' },
  }))
  assert.throws(() => validateThemePackV2(numericHeading, source), /does not match/)
})

test('unmodified color controls preserve independently authored dark colors', () => {
  const pack = makePack()
  const settings = migrateAppearanceSettings({ version: 2, active: { source, id: pack.id }, mode: 'dark' }, legacy)
  const appearance = resolveAppearance({ settings, pack, systemDark: true })
  assert.equal(appearance.tokens['--accent'], pack.variants.dark.tokens['--accent'])
  const profile = settings.profiles[themeProfileKey(settings.active)]
  profile.values.accent = '#4a7088'
  assert.equal(resolveAppearance({ settings, pack, systemDark: true }).tokens['--accent'], '#4a7088')
})

test('shared style properties include material controls and a 24-40 second motion range', () => {
  const pack = makePack()
  const settings = migrateAppearanceSettings({ version: 2, active: { source, id: pack.id }, mode: 'light' }, legacy)
  const appearance = resolveAppearance({ settings, pack, systemDark: false })
  const properties = appearanceStyleProperties(appearance)
  assert.equal(properties['--appearance-bg-warmth'], '0.5')
  assert.equal(properties['--appearance-bg-grain'], '0.12')
  assert.equal(properties['--appearance-bg-scale'], '1')
  assert.equal(properties['--appearance-bg-wash'], '0.35')
  assert.equal(properties['--appearance-bg-direction'], '45deg')
  for (const [speed, duration] of [[0.25, '40s'], [2, '24s']]) {
    assert.equal(appearanceStyleProperties({ ...appearance, background: { ...appearance.background, speed } })['--appearance-bg-duration'], duration)
  }
})

test('style adapters retain the original shell baseline and explicit business-plugin baseline', () => {
  const previous = resolveAppearance({ settings: migrateAppearanceSettings(undefined, legacy) })
  assert.equal(appearanceStyleProperties(previous)['--font-size-base'], '16.1px')
  assert.equal(appearanceStyleProperties(previous, { baseFontSize: 13 })['--font-size-base'], '14.95px')
  const pack = makePack()
  const settings = migrateAppearanceSettings({ version: 2, active: { source, id: pack.id }, mode: 'light' }, legacy)
  const next = resolveAppearance({ settings, pack })
  const properties = appearanceStyleProperties(next)
  assert.equal(properties['--font-size-base'], '14px')
  assert.equal(appearanceStyleProperties(next, { baseFontSize: 13 })['--font-size-base'], '13px')
  assert.equal(properties['--mono'], next.fonts.mono)
  assert.equal(properties['--font-mono'], next.fonts.mono)
})

test('content width uses a real 640-1920px semantic bound while preserving authored profile values', () => {
  const pack = DEFAULT_THEME_PACKAGE.contributes.themePacks[0]
  const settings = migrateAppearanceSettings(undefined, legacy)
  const key = themeProfileKey(DEFAULT_THEME_IDENTITY)
  settings.profiles[key] = patchThemeProfile(pack, settings.profiles[key], { theme: DEFAULT_THEME_IDENTITY, values: { contentWidth: 1920 } })
  assert.equal(resolveAppearance({ settings }).layout.contentWidth, 1920)
  assert.throws(() => patchThemeProfile(pack, settings.profiles[key], { theme: DEFAULT_THEME_IDENTITY, values: { contentWidth: 1920.01 } }), /invalid theme setting/)
  const input = structuredClone(validPackInput)
  input.variants.light.layout.contentWidth = 1920
  assert.equal(validateThemePackV2(input, source).variants.light.layout.contentWidth, 1920)
  input.variants.light.layout.contentWidth = 1920.01
  assert.throws(() => validateThemePackV2(input, source), /contentWidth/)
})

test('recovery records survive migration without applying failed theme values', () => {
  const recovery = { theme: { source: 'com.example.theme', id: 'missing' }, reason: 'Home ready timeout' }
  const settings = migrateAppearanceSettings({ version: 2, recovery }, legacy)
  assert.deepEqual(settings.recovery, recovery)
  assert.deepEqual(migrateAppearanceSettings(settings, legacy).recovery, recovery)
  assert.deepEqual(settings.active, DEFAULT_THEME_IDENTITY)
  for (const invalid of [
    { theme: { source: 'bad source', id: 'missing' }, reason: 'bad' },
    { ...recovery, reason: 'x'.repeat(241) },
    { ...recovery, reason: '<script>bad</script>' },
    { ...recovery, path: '/local/private' },
  ]) assert.equal(migrateAppearanceSettings({ version: 2, recovery: invalid }, legacy).recovery, undefined)
})

test('retired host selections converge without deleting their profiles or extension identities', () => {
  const previous = { ...legacy, general: { ...legacy.general, tabStyle: 'orb' } }
  for (const id of ['warm', 'ink', 'sketch', 'painted', 'tech', 'legacy-custom']) {
    const identity = { source: 'enest.builtin', id }
    const key = themeProfileKey(identity)
    const profile = { identity, schemaVersion: 2, values: { density: 1.12, accent: '#654321', oldSetting: 'preserve' }, colors: { dark: { '--accent': '#345678' } }, quarantined: { 'values.retired': { value: 'retain', reason: 'field-removed', schemaVersion: 1 } } }
    const existing = { version: 2, active: identity, mode: 'dark', profiles: { [key]: profile }, legacy: previous, legacyBackup: legacy }
    const migrated = migrateAppearanceSettings(existing, previous)
    assert.deepEqual(migrated.active, DEFAULT_THEME_IDENTITY)
    assert.deepEqual(JSON.parse(JSON.stringify(migrated.profiles[key])), profile)
    assert.deepEqual(migrated.legacyBackup, legacy)
    assert.equal(migrated.profiles[themeProfileKey(DEFAULT_THEME_IDENTITY)].values.tabStyle, 'orb')
    assert.deepEqual(JSON.parse(JSON.stringify(migrateAppearanceSettings(migrated, previous))), JSON.parse(JSON.stringify(migrated)))
    const rendered = resolveAppearance({ settings: migrated })
    assert.equal(rendered.theme.id, 'default')
    assert.equal(rendered.layout.tabStyle, 'orb')
    assert.equal(rendered.layout.density, 1.12)
    assert.equal(rendered.tokens['--accent'], '#345678', 'explicit per-mode color overrides take precedence over old unscoped controls')
    assert.equal(resolveAppearance({ settings: { ...migrated, mode: 'light' } }).tokens['--accent'], '#654321')
    assert.equal(rendered.home.variant, 'default')
    assert.equal(rendered.diagnostics.length, 0)
    const extension = { source, id }
    assert.deepEqual(migrateAppearanceSettings({ version: 2, active: extension }, previous).active, extension)
  }
  const settings = migrateAppearanceSettings(undefined, previous)
  const key = themeProfileKey(DEFAULT_THEME_IDENTITY)
  settings.profiles[key].values.tabStyle = 'classic'
  assert.equal(migrateAppearanceSettings(settings, previous).profiles[key].values.tabStyle, 'classic')
  delete settings.profiles[key].values.tabStyle
  assert.equal(resolveAppearance({ settings }).layout.tabStyle, 'classic', 'resetting an existing profile must not reapply the archived orb choice')
})

test('declarative tab styles accept only classic or orb through validation, patches and resolution', () => {
  const input = structuredClone(validPackInput)
  const field = { key: 'tabStyle', label: 'Tabs', type: 'select', default: 'classic', options: [{ label: 'Classic', value: 'classic' }, { label: 'Orb', value: 'orb' }], binding: { target: 'layout', key: 'tabStyle' } }
  input.settings.groups[0].fields.push(field)
  const pack = validateThemePackV2(input, source)
  assert.equal(pack.variants.light.layout.tabStyle, 'classic', 'older extension variants receive the safe default')
  const settings = migrateAppearanceSettings({ version: 2, active: { source, id: pack.id } }, legacy)
  const key = themeProfileKey(settings.active)
  const profile = patchThemeProfile(pack, settings.profiles[key], { theme: settings.active, values: { tabStyle: 'orb' } })
  const appearance = resolveAppearance({ settings: { ...settings, profiles: { ...settings.profiles, [key]: profile } }, pack })
  assert.equal(appearance.layout.tabStyle, 'orb')
  for (const value of ['stacked', 'CLASSIC', 1, false, null]) {
    assert.throws(() => patchThemeProfile(pack, profile, { theme: settings.active, values: { tabStyle: value } }), /invalid theme setting/)
    const invalid = structuredClone(input)
    invalid.variants.light.layout.tabStyle = value
    assert.throws(() => validateThemePackV2(invalid, source), /tabStyle/)
  }
  const invalidOption = structuredClone(input)
  invalidOption.settings.groups[0].fields.at(-1).options.push({ label: 'Unsafe', value: 'stacked' })
  assert.throws(() => validateThemePackV2(invalidOption, source), /supported tab style/)
  const invalidBinding = withSetting(input, 'density', original => ({ ...original, binding: { target: 'layout', key: 'tabStyle' } }))
  assert.throws(() => validateThemePackV2(invalidBinding, source), /does not match/)
})

const notificationStyle = { layout: 'compact', accent: 'icon', radius: 8, borderWidth: 2, density: 0.9, shadow: 'raised' }
const notificationFields = [
  { key: 'notificationLayout', label: 'Layout', type: 'select', default: 'card', options: ['card', 'compact', 'banner'].map(value => ({ label: value, value })), binding: { target: 'notification', key: 'layout' } },
  { key: 'notificationAccent', label: 'Accent', type: 'select', default: 'stripe', options: ['stripe', 'icon', 'none'].map(value => ({ label: value, value })), binding: { target: 'notification', key: 'accent' } },
  { key: 'notificationRadius', label: 'Radius', type: 'slider', default: 16, min: 0, max: 24, step: 1, binding: { target: 'notification', key: 'radius' } },
  { key: 'notificationBorderWidth', label: 'Border', type: 'slider', default: 1, min: 0, max: 6, step: 0.1, binding: { target: 'notification', key: 'borderWidth' } },
  { key: 'notificationDensity', label: 'Density', type: 'slider', default: 1, min: 0.8, max: 1.2, step: 0.01, binding: { target: 'notification', key: 'density' } },
  { key: 'notificationShadow', label: 'Shadow', type: 'select', default: 'soft', options: ['none', 'soft', 'raised'].map(value => ({ label: value, value })), binding: { target: 'notification', key: 'shadow' } },
]

test('notifications resolve safe defaults for old packs and independently authored per-mode variants', () => {
  const pack = makePack()
  const settings = migrateAppearanceSettings({ version: 2, active: { source, id: pack.id } }, legacy)
  for (const mode of ['light', 'dark']) {
    assert.deepEqual(resolveAppearance({ settings: { ...settings, mode }, pack }).notifications, DEFAULT_NOTIFICATION_STYLE)
  }
  const input = structuredClone(validPackInput)
  input.variants.light.notifications = notificationStyle
  input.variants.dark.notifications = { ...notificationStyle, layout: 'banner', accent: 'none', shadow: 'none', radius: 0 }
  const styled = validateThemePackV2(input, source)
  for (const mode of ['light', 'dark']) {
    const resolved = resolveAppearance({ settings: { ...settings, mode }, pack: styled })
    assert.deepEqual(resolved.notifications, input.variants[mode].notifications)
    const props = appearanceStyleProperties(resolved)
    assert.equal(props['--appearance-notification-radius'], `${resolved.notifications.radius}px`)
    assert.equal(props['--appearance-notification-border-width'], '2px')
    assert.equal(props['--appearance-notification-density'], '0.9')
  }
})

test('all notification settings patch, persist, reset and quarantine through the shared profile pipeline', () => {
  const input = structuredClone(validPackInput)
  input.settings.groups.push({ id: 'notifications', title: 'Notifications', fields: notificationFields })
  const pack = validateThemePackV2(input, source)
  const settings = migrateAppearanceSettings({ version: 2, active: { source, id: pack.id } }, legacy)
  const key = themeProfileKey(settings.active)
  const values = Object.fromEntries(notificationFields.map(field => [field.key, notificationStyle[field.binding.key]]))
  settings.profiles[key] = patchThemeProfile(pack, settings.profiles[key], { theme: settings.active, values })
  for (const mode of ['light', 'dark']) {
    assert.deepEqual(resolveAppearance({ settings: { ...settings, mode }, pack }).notifications, notificationStyle)
  }
  const restored = migrateAppearanceSettings(JSON.parse(JSON.stringify(settings)), legacy)
  assert.deepEqual(resolveAppearance({ settings: restored, pack }).notifications, notificationStyle)
  const broken = structuredClone(settings.profiles[key])
  broken.values.notificationLayout = 'script'
  broken.values.notificationRadius = 999
  const safe = reconcileThemeProfile(pack, broken)
  assert.equal(safe.values.notificationLayout, undefined)
  assert.equal(safe.values.notificationRadius, undefined)
  assert.equal(safe.quarantined['values.notificationLayout'].value, 'script')
  assert.equal(safe.values.notificationAccent, 'icon')
  settings.profiles[key] = patchThemeProfile(pack, settings.profiles[key], { theme: settings.active, reset: true })
  assert.deepEqual(resolveAppearance({ settings, pack }).notifications, DEFAULT_NOTIFICATION_STYLE)
  for (const field of notificationFields) {
    const invalid = field.type === 'slider' ? field.max + 0.01 : '<style>body{display:none}</style>'
    assert.throws(() => patchThemeProfile(pack, settings.profiles[key], { theme: settings.active, values: { [field.key]: invalid } }), /invalid theme setting/)
  }
})

test('notification appearance rejects unknown structure, executable values and unbounded settings', () => {
  const invalidStyles = [
    null, {}, { ...notificationStyle, layout: 'html' }, { ...notificationStyle, accent: 'css' }, { ...notificationStyle, shadow: '0 0 0 red' },
    ...['html', 'css', 'script', 'source', 'position', 'closeButton', 'duration', 'title'].map(key => ({ ...notificationStyle, [key]: 'override' })),
    ...[-1, 24.01, NaN, Infinity, '8'].map(radius => ({ ...notificationStyle, radius })),
    ...[-0.01, 6.01, '1'].map(borderWidth => ({ ...notificationStyle, borderWidth })),
    ...[0, 0.799, 1.201, Infinity, false].map(density => ({ ...notificationStyle, density })),
  ]
  for (const notifications of invalidStyles) {
    const input = structuredClone(validPackInput)
    input.variants.light.notifications = notifications
    assert.throws(() => validateThemePackV2(input, source), /notifications/)
  }
  for (const [key, value] of [['notificationLayout', 'html'], ['notificationAccent', 'style'], ['notificationShadow', '0 0 0 red'], ['notificationRadius', 25], ['notificationBorderWidth', 7], ['notificationDensity', 2]]) {
    const input = structuredClone(validPackInput)
    input.settings.groups.push({ id: 'notifications', title: 'Notifications', fields: structuredClone(notificationFields) })
    const field = input.settings.groups.at(-1).fields.find(field => field.key === key)
    if (field.type === 'select') field.options.push({ label: 'Unsupported', value })
    else field.max = value
    assert.throws(() => validateThemePackV2(input, source), /notification style|semantic binding/)
  }
  for (const key of ['html', 'css', 'source', 'closeButton', 'position']) {
    const input = structuredClone(validPackInput)
    input.settings.groups[0].fields[1].binding = { target: 'notification', key }
    assert.throws(() => validateThemePackV2(input, source), /binding/)
  }
  const injectedBinding = structuredClone(validPackInput)
  injectedBinding.settings.groups[0].fields[1].binding.css = '.notify-close{display:none}'
  assert.throws(() => validateThemePackV2(injectedBinding, source), /unknown .*binding field/)
})

test('canonical manifest schema matches notification structures and semantic binding bounds', () => {
  const schema = JSON.parse(readFileSync(join(root, 'eNest_plugin/docs/plugin-manifest.schema.json'), 'utf8'))
  const ajv = new Ajv2020({ allErrors: true, strict: false })
  const validateVariant = ajv.compile({ ...schema.$defs.themeVariant, $defs: schema.$defs })
  const validateField = ajv.compile({ ...schema.$defs.themeSettingsField, $defs: schema.$defs })
  assert.equal(validateVariant(validPackInput.variants.light), true, JSON.stringify(validateVariant.errors))
  assert.equal(validateVariant({ ...validPackInput.variants.light, notifications: notificationStyle }), true, JSON.stringify(validateVariant.errors))
  for (const field of notificationFields) assert.equal(validateField(field), true, JSON.stringify(validateField.errors))
  for (const notifications of [{ ...notificationStyle, source: 'forged' }, { ...notificationStyle, layout: 'html' }, { ...notificationStyle, radius: 25 }, { ...notificationStyle, borderWidth: -1 }, { ...notificationStyle, density: 1.21 }, { ...notificationStyle, shadow: 'url(file:///private)' }]) {
    assert.equal(validateVariant({ ...validPackInput.variants.light, notifications }), false, JSON.stringify(notifications))
  }
  assert.equal(validateField({ ...notificationFields[0], binding: { target: 'notification', key: 'html' } }), false)
  assert.equal(validateField({ ...notificationFields[0], options: [...notificationFields[0].options, { label: 'Bad', value: 'html' }] }), false)
  assert.equal(validateField({ ...notificationFields[2], max: 25 }), false)
  assert.equal(validateField({ ...notificationFields[2], default: 25 }), false)
  assert.equal(validateField({ ...notificationFields[0], css: '.notify-close {display:none}' }), false)
})

test('the entire installed default theme validates against the canonical V2 manifest schema', () => {
  const schema = JSON.parse(readFileSync(join(root, 'eNest_plugin/docs/plugin-manifest.schema.json'), 'utf8'))
  const ajv = new Ajv2020({ allErrors: true, strict: false })
  const validateContributes = ajv.compile({ ...schema.properties.contributes, additionalProperties: false, $defs: schema.$defs })
  const validate = ajv.compile({ $ref: '#/$defs/themePackV2', $defs: schema.$defs })
  assert.equal(validateContributes(DEFAULT_THEME_PACKAGE.contributes), true, JSON.stringify(validateContributes.errors))
  assert.deepEqual(Object.keys(DEFAULT_THEME_PACKAGE.contributes), ['themePacks', 'homePages'])
  assert.equal(validateContributes({ ...DEFAULT_THEME_PACKAGE.contributes, themes: [] }), false)
  // Host identity/entrypoint exemptions are registration rules, not changes to the theme contract.
  for (const pack of DEFAULT_THEME_PACKAGE.contributes.themePacks) {
    assert.equal(validate(pack), true, JSON.stringify(validate.errors))
    assert.equal(pack.settings.groups.flatMap(group => group.fields).length, 45)
    for (const change of [
      input => { input.variants.dark.fonts.cjk = 1 },
      input => { input.variants.light.fonts.latin = 'x'.repeat(241) },
      input => { input.variants.light.background.kind = 'iframe' },
      // palette id 是否已声明由运行时 validateThemePackV2 判定（允许 pack.palettes 扩展）；
      // JSON Schema 只约束 id 形状，因此这里用非法形状而非未声明的合法 id。
      input => { input.variants.dark.background.palette = 'arbitrary css' },
      input => { input.variants.light.layout.contentWidth = 1921 },
      input => { input.variants.light.background.opacity = 1.01 },
      input => { input.variants.dark.splash.type = 'video' },
      input => { input.variants.light.splash.opacity = -0.01 },
      input => { input.variants.light.splash.media = { type: 'video', value: 'enest://plugin/com.example.theme/assets/film.webm', fit: 'cover', opacity: 1 } },
      input => { input.settings.groups[0].fields[0].binding = { target: 'font', key: 'css' } },
      input => { delete input.variants.dark },
    ]) {
      const invalid = structuredClone(pack)
      change(invalid)
      assert.equal(validate(invalid), false, JSON.stringify(invalid).slice(0, 240))
    }
    assert.throws(() => validateThemePackV2(pack, DEFAULT_THEME_PACKAGE.id), /reserved theme source/)
  }
})

test('packs may declare extra atmosphere presets without shadowing host ids or smuggling CSS', () => {
  const declared = structuredClone(validPackInput)
  declared.palettes = [
    { id: 'studioGlow', name: 'Studio glow', css: 'radial-gradient(ellipse 80% 60% at 10% 0%, #d9b3a0 0%, transparent 62%), linear-gradient(160deg, #f6eee6, #e4cbb9)', swatch: 'linear-gradient(135deg,#d9b3a0,#f6eee6)' },
  ]
  declared.settings.groups[0].fields.push({
    key: 'palette', label: 'Atmosphere', type: 'select', default: 'studioGlow',
    options: [{ label: 'Studio', value: 'studioGlow' }, { label: 'Theme', value: 'theme' }],
    binding: { target: 'background', key: 'palette' },
  })
  declared.variants.light.background.kind = 'gradient'
  declared.variants.light.background.palette = 'studioGlow'
  const pack = validateThemePackV2(declared, source)
  assert.equal(pack.palettes?.[0]?.id, 'studioGlow')
  assert.equal(pack.variants.light.background.palette, 'studioGlow')
  // 声明后解析器能产出真实 CSS；未声明时同一 id 必须被拒绝。
  const settings = migrateAppearanceSettings(undefined, { theme: {}, general: {} })
  const active = { ...settings, active: { source, id: pack.id }, profiles: { [themeProfileKey({ source, id: pack.id })]: { identity: { source, id: pack.id }, schemaVersion: 2, values: {}, colors: {}, quarantined: {} } } }
  assert.match(resolveAppearance({ settings: active, pack }).background.media?.value ?? '', /radial-gradient/)
  assert.throws(() => validateThemePackV2({ ...structuredClone(declared), palettes: undefined }, source), /not a declared atmosphere preset/)

  for (const [palettes, reason] of [
    [[{ id: 'theme', name: 'Shadow', css: 'linear-gradient(#123,#456)' }], /shadows a host preset/],
    [[{ id: 'dup', name: 'A', css: 'linear-gradient(#123,#456)' }, { id: 'dup', name: 'B', css: 'linear-gradient(#123,#456)' }], /duplicate/],
    [[{ id: 'bad', name: 'B', css: 'url(file:///private/secret)' }], /not a safe paint/],
    [[{ id: 'bad2', name: 'C', css: 'red; background: url(x)' }], /not a safe paint/],
    [[{ id: 'bad3', name: 'D', css: '#123', swatch: 'expression(alert(1))' }], /not a safe paint/],
  ]) {
    const invalid = structuredClone(declared)
    invalid.palettes = palettes
    assert.throws(() => validateThemePackV2(invalid, source), reason)
  }
})

test('presentation hints and option previews are data-only and must fit their field', () => {
  const withHints = structuredClone(validPackInput)
  withHints.settings.groups[0].fields.push({
    key: 'cardStyle', label: 'Card style', type: 'select', default: 'none',
    presentation: 'cards',
    options: [
      { label: 'None', value: 'none', preview: { kind: 'asset', src: 'assets/market/aurora.png' } },
      { label: 'Gradient', value: 'gradient', preview: { kind: 'swatch', stops: ['#123456', '#abcdef'] } },
    ],
    binding: { target: 'background', key: 'kind' },
  })
  const pack = validateThemePackV2(withHints, source)
  const field = pack.settings.groups[0].fields.find(item => item.key === 'cardStyle')
  assert.equal(field?.presentation, 'cards')
  // 素材被改写成宿主协议 URL，主题不能直接塞任意地址。
  assert.deepEqual(field?.options?.[0]?.preview, { kind: 'asset', src: `enest://plugin/${source}/assets/market/aurora.png` })
  assert.deepEqual(field?.options?.[1]?.preview, { kind: 'swatch', stops: ['#123456', '#abcdef'] })

  const cluster = structuredClone(validPackInput)
  cluster.settings.groups[0].fields.find(item => item.key === 'radius').presentation = 'slider-cluster'
  assert.equal(validateThemePackV2(cluster, source).settings.groups[0].fields.find(item => item.key === 'radius')?.presentation, 'slider-cluster')

  for (const [mutate, reason] of [
    [input => { input.settings.groups[0].fields.push({ key: 'badCards', label: 'X', type: 'slider', default: 0.5, min: 0, max: 1, step: 0.1, presentation: 'cards', binding: { target: 'background', key: 'warmth' } }) }, /presentation does not fit/],
    [input => { input.settings.groups[0].fields.push({ key: 'badSeg', label: 'X', type: 'select', default: 'theme', presentation: 'segmented', options: [{ label: 'A', value: 'theme' }, { label: 'B', value: 'dawn' }, { label: 'C', value: 'mint' }, { label: 'D', value: 'linen' }, { label: 'E', value: 'peach' }, { label: 'F', value: 'ocean' }], binding: { target: 'background', key: 'palette' } }) }, /presentation does not fit/],
    [input => { input.settings.groups[0].fields.push({ key: 'badName', label: 'X', type: 'select', default: 'none', presentation: 'grid', options: [{ label: 'A', value: 'none' }], binding: { target: 'background', key: 'kind' } }) }, /not a supported presentation/],
    [input => { input.settings.groups[0].fields.push({ key: 'escape', label: 'X', type: 'select', default: 'none', options: [{ label: 'A', value: 'none', preview: { kind: 'asset', src: '../secrets/a.png' } }], binding: { target: 'background', key: 'kind' } }) }, /escapes its plugin assets/],
    [input => { input.settings.groups[0].fields.push({ key: 'badSwatch', label: 'X', type: 'select', default: 'none', options: [{ label: 'A', value: 'none', preview: { kind: 'swatch', stops: ['url(x)', '#fff'] } }], binding: { target: 'background', key: 'kind' } }) }, /not a safe paint/],
    [input => { input.settings.groups[0].fields.push({ key: 'mixed', label: 'X', type: 'select', default: 'none', options: [{ label: 'A', value: 'none', preview: { kind: 'swatch', stops: ['#123', '#456'], src: 'assets/a.png' } }], binding: { target: 'background', key: 'kind' } }) }, /unknown .*preview field|cannot mix/],
  ]) {
    const invalid = structuredClone(validPackInput)
    mutate(invalid)
    assert.throws(() => validateThemePackV2(invalid, source), reason)
  }
})

test('declared palette ids persist through profile patches and survive reconcile only while declared', () => {
  const declared = structuredClone(validPackInput)
  declared.palettes = [{ id: 'studioGlow', name: 'Studio', css: 'linear-gradient(160deg, #f6eee6, #e4cbb9)' }]
  const field = { key: 'palette', label: 'Atmosphere', type: 'select', default: 'studioGlow', options: [{ label: 'Studio', value: 'studioGlow' }, { label: 'Theme', value: 'theme' }], binding: { target: 'background', key: 'palette' } }
  declared.settings.groups[0].fields.push(field)
  const pack = validateThemePackV2(declared, source)
  const identity = { source, id: pack.id }
  const base = { identity, schemaVersion: 2, values: Object.create(null), colors: {}, quarantined: Object.create(null) }
  const patched = patchThemeProfile(pack, base, { theme: identity, values: { palette: 'studioGlow' } })
  assert.equal(patched.values.palette, 'studioGlow')
  // 未声明的 id 在补丁阶段即被拒绝，不会存下渲染不出来的值。
  assert.throws(() => patchThemeProfile(pack, base, { theme: identity, values: { palette: 'notDeclared' } }), /invalid theme setting/)
  // 主题下掉这个声明后，旧值进入 quarantine 而不是继续生效。
  const withoutDeclaration = { ...pack, palettes: undefined, settings: { ...pack.settings, groups: pack.settings.groups.map(group => ({ ...group, fields: group.fields.map(item => item.key === 'palette' ? { ...item, options: [{ label: 'Theme', value: 'theme' }], default: 'theme' } : item) })) } }
  const reconciled = reconcileThemeProfile(withoutDeclaration, patched)
  assert.equal(reconciled.values.palette, undefined)
  assert.ok(Object.keys(reconciled.quarantined).some(key => key.includes('palette')))
})

test('canonical manifest schema matches the new palette and preview structures', () => {
  const schema = JSON.parse(readFileSync(join(root, 'eNest_plugin/docs/plugin-manifest.schema.json'), 'utf8'))
  const ajv = new Ajv2020({ allErrors: true, strict: false })
  const validatePalettes = ajv.compile({ ...schema.$defs.themePalettes, $defs: schema.$defs })
  const validateField = ajv.compile({ ...schema.$defs.themeSettingsField, $defs: schema.$defs })
  assert.equal(validatePalettes([{ id: 'studioGlow', name: 'S', css: 'linear-gradient(#123,#456)' }]), true)
  assert.equal(validatePalettes([{ id: 'theme', name: 'S', css: '#123' }]), true, 'schema 只做结构性预检，遮蔽内置由运行时判定')
  for (const bad of [
    [{ id: 'a', name: 'S' }],
    [{ id: 'a', name: 'S', css: '#123', extra: 1 }],
    [{ id: '1bad', name: 'S', css: '#123' }],
    [{ id: 'a'.repeat(97), name: 'S', css: '#123' }],
    Array.from({ length: 13 }, (_, index) => ({ id: `p${index}`, name: 'S', css: '#123' })),
  ]) assert.equal(validatePalettes(bad), false, JSON.stringify(bad).slice(0, 120))
  const withPreview = { key: 'atmosphere', label: 'A', type: 'select', default: 'theme', presentation: 'cards', options: [
    { label: 'A', value: 'theme', preview: { kind: 'swatch', stops: ['#123', '#456'] } },
    { label: 'B', value: 'dawn', preview: { kind: 'asset', src: 'assets/previews/x.webp' } },
  ], binding: { target: 'background', key: 'palette' } }
  assert.equal(validateField(withPreview), true, JSON.stringify(validateField.errors))
  for (const bad of [
    { ...withPreview, presentation: 'grid' },
    { ...withPreview, options: [{ label: 'A', value: 'theme', preview: { kind: 'swatch', stops: ['#123'] } }] },
    { ...withPreview, options: [{ label: 'A', value: 'theme', preview: { kind: 'swatch', stops: ['#123', '#456'], src: 'assets/x.png' } }] },
    { ...withPreview, options: [{ label: 'A', value: 'theme', preview: { kind: 'asset', src: 'file:///secret.png' } }] },
  ]) assert.equal(validateField(bad), false, JSON.stringify(bad).slice(0, 160))
})

test('the classic top tab strip exposes opacity and auto-hide through the layout binding', () => {
  const input = structuredClone(validPackInput)
  input.settings.groups[0].fields.push(
    { key: 'tabOpacity', label: 'Top tab opacity', type: 'slider', default: 1, min: 0, max: 1, step: 0.05, binding: { target: 'layout', key: 'tabOpacity' } },
    { key: 'tabAutoHide', label: 'Auto hide', type: 'switch', default: false, binding: { target: 'layout', key: 'tabAutoHide' } },
  )
  const pack = validateThemePackV2(input, source)
  const identity = { source, id: pack.id }
  const base = { identity, schemaVersion: 2, values: Object.create(null), colors: {}, quarantined: Object.create(null) }
  const patched = patchThemeProfile(pack, base, { theme: identity, values: { tabOpacity: 0.6, tabAutoHide: true } })
  const settings = migrateAppearanceSettings(undefined, { theme: {}, general: {} })
  const active = { ...settings, active: identity, profiles: { [themeProfileKey(identity)]: patched } }
  const resolved = resolveAppearance({ settings: active, pack })
  assert.equal(resolved.layout.tabOpacity, 0.6)
  assert.equal(resolved.layout.tabAutoHide, true)
  // 默认主题未设置时回落到 1 / false，旧主题不需要声明这两个字段。
  const plain = resolveAppearance({ settings: { ...settings, active: identity, profiles: {} }, pack })
  assert.equal(plain.layout.tabOpacity, 1)
  assert.equal(plain.layout.tabAutoHide, false)
  const transparent = patchThemeProfile(pack, base, { theme: identity, values: { tabOpacity: 0 } })
  assert.equal(transparent.values.tabOpacity, 0)
  for (const value of [-0.1, 1.1, NaN, Infinity, '0.5']) {
    assert.throws(() => patchThemeProfile(pack, base, { theme: identity, values: { tabOpacity: value } }), /invalid theme setting/)
  }
  for (const value of ['false', 1, null, {}]) {
    const invalid = structuredClone(validPackInput)
    invalid.variants.light.layout.tabAutoHide = value
    assert.throws(() => validateThemePackV2(invalid, source), /tabAutoHide must be boolean/)
  }
  // switch 只能绑到 background.effect 或 layout.tabAutoHide。
  const wrong = structuredClone(validPackInput)
  wrong.settings.groups[0].fields.push({ key: 'bad', label: 'X', type: 'switch', default: true, binding: { target: 'layout', key: 'gap' } })
  assert.throws(() => validateThemePackV2(wrong, source), /binding/)
})

test('tab strip CSS variables follow the resolved layout so the shell can style itself', () => {
  const input = structuredClone(validPackInput)
  input.settings.groups[0].fields.push(
    { key: 'tabOpacity', label: 'Opacity', type: 'slider', default: 0.7, min: 0.2, max: 1, step: 0.05, binding: { target: 'layout', key: 'tabOpacity' } },
    { key: 'tabAutoHide', label: 'Auto hide', type: 'switch', default: true, binding: { target: 'layout', key: 'tabAutoHide' } },
  )
  const pack = validateThemePackV2(input, source)
  const identity = { source, id: pack.id }
  const settings = migrateAppearanceSettings(undefined, { theme: {}, general: {} })
  const active = { ...settings, active: identity, profiles: { [themeProfileKey(identity)]: { identity, schemaVersion: 2, values: Object.create(null), colors: {}, quarantined: Object.create(null) } } }
  const resolved = resolveAppearance({ settings: active, pack })
  const properties = appearanceStyleProperties(resolved)
  assert.equal(properties['--appearance-tab-opacity'], '0.7')
  assert.equal(properties['--appearance-tab-autohide'], '1')
})
