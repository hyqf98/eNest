import assert from 'node:assert/strict'
import test from 'node:test'
import { transform } from 'esbuild'
import { readCss } from '../../fixtures/read-css.mjs'

const settings = readCss(new URL('../../../src/renderer/themes/default/settings/settings.css', import.meta.url))
const app = readCss(new URL('../../../src/renderer/styles/app.css', import.meta.url))
const rule = (source, selector) => source.split(`${selector} {`)[1]?.split('}')[0] ?? ''

test('settings cards keep text and popups outside their independent glass material layer', () => {
  const card = rule(settings, '.page-settings :is(.s-card, .account-card)')
  assert.match(card, /background: transparent/)
  assert.match(card, /backdrop-filter: none/)
  assert.match(card, /isolation: isolate/)
  const paint = rule(settings, '.page-settings :is(.s-card, .account-card)::before')
  for (const value of ['position: absolute', 'z-index: -1', 'border-radius: inherit', 'pointer-events: none']) assert.ok(paint.includes(value), value)
  assert.match(settings, /backdrop-filter: blur\(var\(--settings-glass-blur\)\) saturate\(var\(--settings-glass-saturation\)\)/)
  assert.match(settings, /-webkit-backdrop-filter: blur\(var\(--settings-glass-blur\)\)/)
  assert.match(settings, /--settings-glass-blur: 20px/)
  assert.match(settings, /--settings-glass-fill: color-mix\(in srgb, var\(--surface\) 54%, transparent\)/)
  assert.doesNotMatch(app, /\.page-settings\s*\{[^}]*backdrop-filter:/)
  assert.match(app, /\.s-card:not\(\.page-settings \.s-card\)/)
})

test('glass adapts to dark mode, lower animation levels and reduced transparency without changing selected controls', () => {
  assert.match(settings, /:root\[data-theme='dark'\] \.page-settings/)
  assert.match(rule(settings, ":root[data-anim='low'] .page-settings"), /--settings-glass-blur: 4px/)
  assert.match(settings, /prefers-reduced-transparency: reduce/)
  assert.match(settings, /prefers-contrast: more/)
  assert.match(settings, /--settings-glass-fill: var\(--surface\)/)
  assert.match(settings, /\.page-settings \.s-card:hover \{ transform: none; \}/)
  const paints = [...settings.matchAll(/([^{}]+)\{[^{}]*--settings-glass-fill:/g)]
  for (const [, selector] of paints) assert.doesNotMatch(selector, /\.active|\.chip/)
})

test('settings glass styles compile without CSS diagnostics', async () => {
  const result = await transform(settings, { loader: 'css' })
  assert.deepEqual(result.warnings, [])
})
