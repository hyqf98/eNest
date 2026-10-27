import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { transform } from 'esbuild'

const css = readFileSync(new URL('../../../src/renderer/styles/appearance.css', import.meta.url), 'utf8')
const workspaceCss = readFileSync(new URL('../../../src/renderer/themes/default/defaultWorkspace.css', import.meta.url), 'utf8')
const entry = readFileSync(new URL('../../../src/renderer/homeClient.ts', import.meta.url), 'utf8')
const view = readFileSync(new URL('../../../src/renderer/themes/default/DefaultWorkspace.tsx', import.meta.url), 'utf8')

test('default plugin restores original typography, nested controls and shared page styles', () => {
  assert.match(css, /--radius-md:calc\(var\(--appearance-control-radius\) \+ 4px\)/)
  assert.match(css, /\.btn \{ border-radius:max\(0px,calc\(var\(--appearance-control-radius\) - 2px\)\)/)
  assert.doesNotMatch(css, /data-appearance-theme=['"][a-z]/, 'shared controls must not branch on theme IDs')
  for (const sheet of ['tokens.css', 'base.css', 'app.css', 'detail.css', 'market.css']) assert.ok(entry.includes(sheet))
  assert.doesNotMatch(entry, /styles\/home.css/)
  assert.match(view, /FeaturedCarousel/)
  assert.match(view, /MarketCategoryView/)
  assert.match(view, /usePluginDetailMotion/)
  assert.match(view, /playHeroIn/)
  assert.match(view, /animateCards/)
  assert.doesNotMatch(view, /WorkspaceSettingsClient/)
  assert.doesNotMatch(view, /shellApi|useShellStore/)
})

test('restored materials compile, preserve host geometry and have no retired warm layout', async () => {
  for (const source of [css, workspaceCss]) {
    const result = await transform(source, { loader: 'css' })
    assert.deepEqual(result.warnings, [])
    assert.doesNotMatch(source, /data-appearance-(?:theme|layout)=['"](?:warm|ink|sketch|painted|tech)['"]/)
  }
  assert.match(workspaceCss, /height: 100%/)
  assert.match(workspaceCss, /max-width: var\(--appearance-content-width, 1520px\)/)
  assert.doesNotMatch(workspaceCss, /500px \+/)
  assert.match(workspaceCss, /\[hidden\]/)
  assert.match(css, /prefers-reduced-motion:reduce/)
  assert.doesNotMatch(css, /\.s-card \{ box-shadow:0 8px 32px/)
})
