import assert from 'node:assert/strict'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { build } from 'esbuild'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const model = await build({
  entryPoints: [join(root, 'src/shared/theme/appearance.ts')],
  tsconfig: join(root, 'tsconfig.node.json'),
  absWorkingDir: root,
  bundle: true,
  write: false,
  platform: 'node',
  format: 'esm',
})
const builtins = await build({
  entryPoints: [join(root, 'src/shared/theme/builtinThemes.ts')],
  tsconfig: join(root, 'tsconfig.node.json'),
  absWorkingDir: root,
  bundle: true,
  write: false,
  platform: 'node',
  format: 'esm',
})

const modelUrl = `data:text/javascript;base64,${Buffer.from(model.outputFiles[0].text).toString('base64')}`
const builtinUrl = `data:text/javascript;base64,${Buffer.from(builtins.outputFiles[0].text).toString('base64')}`
const { migrateAppearanceSettings, resolveAppearance, patchThemeProfile, themeProfileKey, appearanceStyleProperties } = await import(modelUrl)
const { BUILTIN_THEME_PACKS, DEFAULT_THEME_IDENTITY, DEFAULT_THEME_PACKAGE, DEFAULT_BODY_FONT, DEFAULT_MONO_FONT } = await import(builtinUrl)

const legacy = {
  theme: { mode: 'system', overrides: {} },
  general: {},
}

function assertFrozenTree(value) {
  if (!value || typeof value !== 'object') return
  assert.ok(Object.isFrozen(value))
  for (const child of Object.values(value)) assertFrozenTree(child)
}

test('one immutable installed default package contributes both appearance and the original Home', () => {
  assert.deepEqual(BUILTIN_THEME_PACKS.map(pack => pack.id), ['default'])
  assert.equal(BUILTIN_THEME_PACKS.length, 1)
  assert.equal(DEFAULT_THEME_IDENTITY.source, 'enest.builtin')
  assert.equal(DEFAULT_THEME_IDENTITY.id, 'default')
  assert.equal(DEFAULT_THEME_PACKAGE.id, 'enest.builtin')
  assert.equal(DEFAULT_THEME_PACKAGE.name, 'eNest 默认主题')
  assert.equal(DEFAULT_THEME_PACKAGE.version, '3.0.0')
  assert.equal(DEFAULT_THEME_PACKAGE.contributes.themePacks, BUILTIN_THEME_PACKS)
  assert.deepEqual(Object.keys(DEFAULT_THEME_PACKAGE.contributes), ['themePacks', 'homePages'])
  assert.deepEqual(DEFAULT_THEME_PACKAGE.contributes.homePages, [{ source: 'enest.builtin', id: 'home', version: 1, entry: 'home.html', variants: ['default'] }])
  assertFrozenTree(DEFAULT_THEME_PACKAGE)
  assertFrozenTree(DEFAULT_THEME_IDENTITY)
  for (const pack of BUILTIN_THEME_PACKS) {
    assert.equal(pack.source, 'enest.builtin')
    assert.equal(pack.mode, 'system')
    assert.equal(pack.home.source, 'enest.builtin')
    assert.equal(pack.home.id, 'home')
    assert.equal(pack.home.variant, pack.id)
    assert.equal(pack.settings.version, 4)
  }
})

test('built-in packs resolve through the shared semantic appearance pipeline', () => {
  for (const pack of BUILTIN_THEME_PACKS) {
    for (const mode of ['light', 'dark']) {
      const settings = migrateAppearanceSettings({
        version: 2,
        revision: 1,
        mode,
        active: { source: pack.source, id: pack.id },
        profiles: {},
        legacy,
      }, legacy)
      const appearance = resolveAppearance({ settings, pack, systemDark: mode === 'dark' })
      assert.equal(appearance.theme.id, pack.id)
      assert.equal(appearance.theme.name, pack.name)
      assert.equal(appearance.mode, mode)
      assert.equal(appearance.layout.variant, pack.id)
      assert.equal(appearance.home.variant, pack.id)
      assert.equal(appearance.animation.effective, pack.variants[mode].animation)
      assert.match(appearance.tokens['--accent'], /^#/)
      assert.equal(appearance.diagnostics.length, 0)
    }
  }
})

test('the default preserves original palettes, font stacks, radii and all original appearance controls', () => {
  const required = ['backgroundType', 'backgroundPalette', 'backgroundColor', 'backgroundOpacity', 'backgroundFit', 'backgroundEffect', 'media', 'fontFamily', 'fontFamilyEn', 'monoFont', 'fontScale', 'splashType', 'splashMedia', 'splashOpacity', 'contentWidth', 'density', 'radius', 'cardRadius', 'panelRadius', 'borderWidth', 'motion', 'tabStyle', 'gap', 'columns', 'notificationLayout', 'notificationAccent', 'notificationRadius', 'notificationBorderWidth', 'notificationDensity', 'notificationShadow']
  const original = {
    light: { '--bg': '#f6f6f4', '--surface': '#ffffff', '--surface-2': '#eeefed', '--surface-3': '#e5e7e4', '--border': 'rgba(41,44,46,0.08)', '--border-strong': 'rgba(41,44,46,0.16)', '--text': '#292c2e', '--text-2': '#666c70', '--text-3': '#82888b', '--accent': '#bd542b', '--ok': '#318469', '--danger': '#c54f46', '--link': '#bd542b' },
    dark: { '--bg': '#17191b', '--surface': '#202326', '--surface-2': '#292d31', '--surface-3': '#33383d', '--border': 'rgba(242,243,243,0.09)', '--border-strong': 'rgba(242,243,243,0.16)', '--text': '#f2f3f3', '--text-2': '#adb3b8', '--text-3': '#7e878f', '--accent': '#e98654', '--ok': '#77bfa4', '--danger': '#e79589', '--link': '#e98654' },
  }
  for (const pack of BUILTIN_THEME_PACKS) {
    const fields = pack.settings.groups.flatMap(group => group.fields)
    assert.equal(fields.length, 45)
    for (const key of required) {
      assert.ok(fields.some(field => field.key === key), `${pack.id} missing ${key}`)
    }
    assert.equal(fields.filter(field => field.binding.target === 'token').length, 13)
    for (const mode of ['light', 'dark']) {
      const settings = migrateAppearanceSettings({ version: 2, active: { source: pack.source, id: pack.id }, mode }, legacy)
      const appearance = resolveAppearance({ settings, pack, systemDark: mode === 'dark' })
      for (const [token, value] of Object.entries(original[mode])) assert.equal(appearance.tokens[token], value, `${mode}/${token}`)
      assert.equal(appearance.fonts.body, DEFAULT_BODY_FONT)
      assert.equal(appearance.fonts.heading, DEFAULT_BODY_FONT)
      assert.equal(appearance.fonts.mono, DEFAULT_MONO_FONT)
      assert.equal(appearanceStyleProperties(appearance)['--font-size-base'], '14px')
      assert.deepEqual(appearance.components, { controlRadius: 10, cardRadius: 18, panelRadius: 24, borderWidth: 1 })
      assert.equal(appearance.background.effect, 'tunnel')
      assert.equal(appearance.layout.contentWidth, 1520)
      assert.equal(appearance.background.media, null)
      assert.deepEqual(appearance.splash, { type: 'brand', media: null, opacity: 0.55 })
    }
    assert.notEqual(pack.variants.light.tokens['--bg'], pack.variants.dark.tokens['--bg'])
    assert.notEqual(pack.variants.light.tokens['--accent'], pack.variants.dark.tokens['--accent'])
    assert.deepEqual(fields.find(field => field.key === 'backgroundEffect').options.map(option => option.value), ['none', 'fold', 'aurora', 'orbit', 'ripple', 'tunnel'])
    assert.deepEqual(fields.find(field => field.key === 'backgroundPalette').options.map(option => option.value), ['theme', 'dawn', 'mint', 'linen', 'peach', 'ocean', 'forest', 'ink'])
    assert.deepEqual(fields.find(field => field.key === 'tabStyle').options.map(option => option.value), ['classic', 'orb'])
    // 分组收敛为 5 组：启动画面并入背景，圆角/描边与通知合并，字段总量 45 项（含顶部标签栏的透明度与自动隐藏）
    assert.deepEqual(pack.settings.groups.map(group => group.id), ['colors', 'background', 'typography', 'layout', 'surfaces'])
    const backgroundGroup = pack.settings.groups.find(group => group.id === 'background')
    assert.deepEqual(backgroundGroup.fields.map(field => field.key), ['backgroundType', 'backgroundPalette', 'backgroundColor', 'media', 'backgroundOpacity', 'backgroundFit', 'backgroundEffect', 'splashType', 'splashMedia', 'splashOpacity'])
    const surfacesGroup = pack.settings.groups.find(group => group.id === 'surfaces')
    assert.deepEqual(surfacesGroup.fields.map(field => field.key), ['radius', 'cardRadius', 'panelRadius', 'borderWidth', 'notificationLayout', 'notificationAccent', 'notificationShadow', 'notificationRadius', 'notificationBorderWidth', 'notificationDensity'])
  }
})

function destination(appearance, binding) {
  if (binding.target === 'token') return appearance.tokens[binding.key]
  if (binding.target === 'animation') return appearance.animation.requested
  const section = { component: 'components', font: 'fonts', notification: 'notifications' }[binding.target] ?? binding.target
  return appearance[section][binding.key]
}

test('every declared field changes its semantic rendering destination', () => {
  for (const pack of BUILTIN_THEME_PACKS) {
    const identity = { source: pack.source, id: pack.id }
    for (const mode of ['light', 'dark']) {
      for (const field of pack.settings.groups.flatMap(group => group.fields)) {
        const settings = migrateAppearanceSettings({ version: 2, active: identity, mode }, legacy)
        const key = themeProfileKey(identity)
        const related = field.binding.target === 'background' && ['palette', 'color'].includes(field.binding.key)
          ? { backgroundType: field.binding.key === 'palette' ? 'gradient' : 'color' } : {}
        settings.profiles[key] = patchThemeProfile(pack, settings.profiles[key], { theme: identity, values: related })
        const before = resolveAppearance({ settings, pack, systemDark: mode === 'dark' })
        const beforeValue = destination(before, field.binding)
        const value = field.type === 'slider' ? (beforeValue === field.min ? field.max : field.min)
          : field.type === 'switch' ? !field.default
          : field.type === 'color' || field.type === 'token' ? '#587b91'
          : field.type === 'font' ? '"Courier New", monospace'
          : field.type === 'media' ? { type: 'image', value: `enest://appearance/media/${'a'.repeat(64)}.png`, opacity: 0.5, fit: 'cover' }
          : field.options.find(option => option.value !== beforeValue).value
        const coupledMediaType = field.type !== 'media' ? {} : field.binding.target === 'splash' ? { splashType: 'image' } : { backgroundType: 'image' }
        settings.profiles[key] = patchThemeProfile(pack, settings.profiles[key], { theme: identity, values: { ...coupledMediaType, [field.key]: value } })
        settings.revision++
        const after = resolveAppearance({ settings, pack, systemDark: mode === 'dark' })
        const afterValue = destination(after, field.binding)
        assert.notDeepEqual(afterValue, beforeValue, `${pack.id}/${mode}/${field.key}`)
        const cssBound = field.binding.target === 'token' || field.binding.target === 'font' || field.binding.target === 'component' || (field.binding.target === 'layout' && field.binding.key !== 'tabStyle') || (field.binding.target === 'notification' && field.type === 'slider') || (field.binding.target === 'background' && field.binding.key === 'effect')
        if (cssBound) {
          assert.notDeepEqual(appearanceStyleProperties(after), appearanceStyleProperties(before), `${pack.id}/${mode}/${field.key} CSS properties`)
        }
      }
    }
  }
})
