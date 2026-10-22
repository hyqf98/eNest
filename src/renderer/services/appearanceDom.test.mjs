import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import ts from 'typescript'

const source = ts.transpileModule(readFileSync(new URL('./appearanceDom.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText

function fixture() {
  const properties = new Map(), classes = new Set(), motionLevels = [], backgrounds = []
  const root = {
    dataset: {},
    style: { setProperty: (key, value) => properties.set(key, value), removeProperty: key => properties.delete(key) },
    classList: { toggle: (name, enabled) => enabled ? classes.add(name) : classes.delete(name) }
  }
  const document = { documentElement: root, fonts: { add() {}, delete() {} } }
  const imports = {
    '@shared/theme/appearance': { appearanceStyleProperties: appearance => ({ '--accent': '#123456', ...appearance.tokens }), DEFAULT_NOTIFICATION_STYLE: { layout: 'card', accent: 'stripe', shadow: 'soft' } },
    '@renderer/gsap/marketMotion': { applyLevelToDefaults: level => motionLevels.push(level) },
    '@renderer/components/backgroundAtmosphere': { syncBackgroundAtmosphereTheme: (_root, media) => backgrounds.push(media) }
  }
  const module = { exports: {} }
  new Function('require', 'module', 'exports', 'document', source)(id => {
    assert.ok(Object.hasOwn(imports, id), `Unexpected import: ${id}`)
    return imports[id]
  }, module, module.exports, document)
  return { root, properties, classes, motionLevels, backgrounds, apply: module.exports.applyAppearanceToDom }
}

function appearance(theme) {
  return {
    theme,
    mode: 'light',
    fonts: { scale: 1 },
    layout: { variant: 'comfortable' },
    background: { texture: 'none', effect: 'none', media: null },
    animation: { effective: 'medium' },
    resources: { fonts: [] }
  }
}

test('appearance DOM identity preserves the exact case of the owning source', () => {
  const { root, apply } = fixture()
  const theme = { source: 'com.github.eNest.Theme', id: 'paper', legacy: false }
  apply(appearance(theme))
  assert.equal(root.dataset.appearanceSource, theme.source)
  assert.equal(root.dataset.appearanceTheme, theme.id)
  assert.equal(root.dataset.appearanceLegacy, String(theme.legacy))
})

test('legacy compatibility flags do not leak through matching theme ids or later activations', () => {
  const { root, apply } = fixture()
  for (const theme of [
    { source: 'enest.builtin', id: 'legacy-custom', legacy: true },
    { source: 'com.test', id: 'legacy-custom', legacy: false },
    { source: 'enest.builtin', id: 'warm', legacy: false }
  ]) {
    apply(appearance(theme))
    assert.equal(root.dataset.appearanceSource, theme.source)
    assert.equal(root.dataset.appearanceTheme, theme.id)
    assert.equal(root.dataset.appearanceLegacy, String(theme.legacy))
  }
})

test('Quick DOM keeps its surface and geometry while applying updated snapshot fonts, animation and background', () => {
  const api = fixture()
  api.root.dataset.surface = 'quick'
  api.properties.set('--quick-radius', '20px')
  api.properties.set('--quick-bar-h', '64px')
  const current = appearance({ source: 'com.example.theme', id: 'paper', legacy: false })
  const media = { type: 'color', value: '#abcdef', opacity: 0.6 }
  api.apply({
    ...current, mode: 'dark', fonts: { body: 'Custom Font, sans-serif', scale: 1.2 },
    tokens: { '--appearance-control-radius': '6px', '--old-theme-token': '1px' },
    animation: { requested: 'high', effective: 'low' },
    background: { texture: 'grain', effect: 'flow', media }
  })
  assert.equal(api.root.dataset.surface, 'quick')
  assert.equal(api.root.dataset.theme, 'dark')
  assert.equal(api.root.dataset.anim, 'low')
  assert.equal(api.properties.get('--font-size-base'), '16.8px')
  assert.equal(api.properties.get('--appearance-control-radius'), '6px')
  assert.equal(api.properties.get('--quick-radius'), '20px')
  assert.equal(api.properties.get('--quick-bar-h'), '64px')
  assert.ok(api.classes.has('has-bg-media'))
  assert.ok(api.classes.has('has-bg-effect'))
  assert.equal(api.properties.get('--bg-media-opacity'), '0.6')
  assert.equal(api.backgrounds.at(-1), media)
  assert.equal(api.motionLevels.at(-1), 'low')

  api.apply({ ...current, animation: { effective: 'high' } })
  assert.equal(api.root.dataset.anim, 'high')
  assert.equal(api.properties.get('--font-size-base'), '14px')
  assert.equal(api.properties.has('--old-theme-token'), false, 'changing themes releases removed token overrides')
  assert.equal(api.classes.has('has-bg-media'), false)
  assert.equal(api.classes.has('has-bg-effect'), false)
  assert.equal(api.backgrounds.at(-1), null)
  assert.equal(api.motionLevels.at(-1), 'high')
  assert.equal(api.properties.get('--quick-radius'), '20px')
})

test('Quick inner styles consume shared appearance tokens without restyling native geometry', () => {
  const css = readFileSync(new URL('../components/quick.css', import.meta.url), 'utf8')
  const marker = '/* Snapshot-backed inner materials;'
  const start = css.indexOf(marker)
  assert.notEqual(start, -1)
  const end = css.indexOf('/* End Quick appearance tokens. */', start)
  assert.ok(end > start)
  const section = css.slice(start, end)
  for (const token of ['control-radius', 'card-radius', 'panel-radius', 'border-width']) {
    assert.ok(section.includes(`var(--appearance-${token})`), token)
  }
  assert.match(section, /\.quick-item-title\s*\{[^}]*font-size:\s*[\d.]+rem/)
  assert.match(section, /\.quick-plugin-loading\s*\{[^}]*font-size:\s*[\d.]+rem/)
  assert.doesNotMatch(section, /--quick-(?:radius|bar-h|border-w|home-h|grid-columns|content-max-h)\s*:/)
  assert.doesNotMatch(section, /titlebar|app-region/)
})

test('notification style attributes update live and fall back for older snapshots', () => {
  const { root, apply } = fixture()
  const current = appearance({ source: 'com.example.theme', id: 'paper', legacy: false })
  for (const layout of ['card', 'compact', 'banner']) {
    for (const accent of ['stripe', 'icon', 'none']) {
      for (const shadow of ['none', 'soft', 'raised']) {
        apply({ ...current, notifications: { layout, accent, shadow, radius: 10, borderWidth: 1, density: 1 } })
        assert.equal(root.dataset.notificationLayout, layout)
        assert.equal(root.dataset.notificationAccent, accent)
        assert.equal(root.dataset.notificationShadow, shadow)
      }
    }
  }
  apply(current)
  assert.equal(root.dataset.notificationLayout, 'card')
  assert.equal(root.dataset.notificationAccent, 'stripe')
  assert.equal(root.dataset.notificationShadow, 'soft')
})
