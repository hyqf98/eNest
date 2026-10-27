import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { build } from 'esbuild'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { readCss } from '../../fixtures/read-css.mjs'

const require = createRequire(import.meta.url)
const output = await build({
  entryPoints: ['src/renderer/layout/TitleBar.tsx'], tsconfig: 'tsconfig.web.json',
  bundle: true, write: false, format: 'cjs', platform: 'node', packages: 'external', jsx: 'automatic',
  plugins: [{ name: 'titlebar-fixture', setup(builder) {
    builder.onResolve({ filter: /^react$/ }, ({ namespace }) => namespace === 'server-hooks' ? { path: 'react', external: true } : { path: 'react', namespace: 'server-hooks' })
    builder.onLoad({ filter: /.*/, namespace: 'server-hooks' }, () => ({ contents: 'const React=require("react");module.exports={...React,useLayoutEffect:React.useEffect}' }))
    const mocks = {
      '@renderer/stores/shellStore': 'export const useShellStore=selector=>selector({tabStyle:"classic"})',
      '@renderer/services/shellApi': 'export const shellApi={}',
      '@renderer/themes/default/chrome/TabStrip': 'export const TabStrip=()=>null',
    }
    builder.onResolve({ filter: /^@renderer\// }, ({ path }) => Object.hasOwn(mocks, path) ? { path, namespace: 'fixture' } : undefined)
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({ contents: mocks[path] }))
  } }],
})
const module = { exports: {} }
new Function('require', 'module', 'exports', output.outputFiles[0].text)(require, module, module.exports)
const { TitleBar } = module.exports
const css = readCss(new URL('../../../src/renderer/styles/app.css', import.meta.url))
const layout = readFileSync(new URL('../../../src/renderer/layout/ShellLayout.tsx', import.meta.url), 'utf8')

// Static guards complement the real pointer/native-window acceptance checks.
test('only the titlebar receives collapsed styles, never the application root', () => {
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter(([, selector]) => selector.includes('titlebar-autohide'))
  assert.ok(rules.length > 0)
  for (const [, selector] of rules) {
    assert.match(selector, /header\.titlebar\.titlebar-autohide:not\(\.is-revealed\)/)
    assert.doesNotMatch(selector, /\.app[\s.]/)
  }
  assert.doesNotMatch(layout, /\? ' titlebar-autohide'/)
  assert.match(layout, /data-titlebar-state=/)
  assert.match(css, /grid-template-rows: var\(--shell-titlebar-height, var\(--titlebar-h\)\) minmax\(0, 1fr\)/)
})

test('settings retains the content row below the titlebar without extra underlap padding', () => {
  assert.match(layout, /data-shell-view=\{view\}/)
  assert.match(css, /\.app-chrome > \.stage \{ grid-area: 2 \/ 1; \}/)
  const settingsStage = css.match(/\.app\[data-shell-view='settings'\] \.app-chrome > \.stage \{([^}]+)\}/)?.[1] ?? ''
  assert.match(settingsStage, /z-index: 0/)
  assert.doesNotMatch(settingsStage, /grid-area|grid-row/)
  const settings = readCss(new URL('../../../src/renderer/themes/default/settings/settings.css', import.meta.url))
  assert.match(settings, /padding-top: 32px/)
  assert.match(settings, /padding: 24px 16px 80px/)
  assert.doesNotMatch(settings, /--settings-titlebar-clearance|--shell-titlebar-height/)
})

test('opacity belongs to the shared background layer including atmosphere paint overrides', () => {
  const base = css.match(/\n\.titlebar \{([^}]+)\}/)?.[1] ?? ''
  const paint = css.match(/\n\.titlebar::before \{([^}]+)\}/)?.[1] ?? ''
  assert.match(base, /background: transparent/)
  assert.doesNotMatch(base, /opacity:/)
  assert.match(paint, /opacity: var\(--appearance-tab-opacity, 1\)/)
  assert.match(paint, /background: var\(--titlebar-paint\)/)
  assert.match(css, /\.has-bg-atmosphere \.titlebar \{ --titlebar-paint: var\(--atmosphere-chrome\)/)
  assert.doesNotMatch(css, /\.tab-strip\s*\{[^}]*opacity:/)
})

test('the fixed reveal region stays mounted across animation without intercepting expanded controls', () => {
  const hidden = renderToStaticMarkup(createElement(TitleBar, { autoHide: true, revealed: false }))
  assert.match(hidden, /^<div class="titlebar-region">/)
  assert.match(hidden, /<header[^>]+class="titlebar titlebar-autohide"/)
  assert.match(hidden, /class="titlebar-hotzone"[^>]+role="button"[^>]+tabindex="0"/)
  const expanded = renderToStaticMarkup(createElement(TitleBar, { autoHide: true, revealed: true }))
  assert.match(expanded, /class="titlebar-hotzone"[^>]+tabindex="-1"/)
  assert.doesNotMatch(renderToStaticMarkup(createElement(TitleBar, { autoHide: false })), /class="titlebar-hotzone"/)
  assert.match(css, /height: var\(--titlebar-reveal-height, 8px\)/)
  assert.match(css, /\.titlebar-region > \.titlebar\.is-revealed \+ \.titlebar-hotzone \{ pointer-events: none; \}/)
})
