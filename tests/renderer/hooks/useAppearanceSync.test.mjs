import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import ts from 'typescript'

const source = ts.transpileModule(readFileSync(new URL('../../../src/renderer/hooks/useAppearanceSync.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText

function fixture() {
  const order = [], callbacks = new Set()
  const state = {
    appearance: { revision: 1, theme: { source: 'enest.builtin', id: 'ink' } },
    profile: { identity: { source: 'enest.builtin', id: 'ink' }, values: { gap: 12 } },
    packs: ['packs'], customFonts: ['fonts'],
    applySnapshot(snapshot) { if (snapshot.appearance.revision >= state.appearance.revision) Object.assign(state, snapshot) },
    refresh: async () => { order.push('appearance-read') },
    hydrate: async () => { order.push('appearance-read') }
  }
  let cleanup
  const imports = {
    react: { useEffect: effect => { cleanup = effect() } },
    '@renderer/services/shellApi': { shellApi: { onEvent: listener => { order.push('subscribe'); callbacks.add(listener); return () => callbacks.delete(listener) } } },
    '@renderer/hooks/useAppearance': { useAppearanceStore: { getState: () => state } },
  }
  const module = { exports: {} }
  new Function('require', 'module', 'exports', source)(id => imports[id], module, module.exports)
  module.exports.useAppearanceSync()
  return { state, order, callbacks, cleanup: () => cleanup(), emit: payload => [...callbacks].forEach(listener => listener(payload)) }
}

test('each renderer subscribes before its initial appearance read and releases the subscription', () => {
  const api = fixture()
  assert.deepEqual(api.order.slice(0, 2), ['subscribe', 'appearance-read'])
  assert.equal(api.callbacks.size, 1)
  api.cleanup()
  assert.equal(api.callbacks.size, 0)
})

test('external activation never associates the new appearance with the previous theme profile', () => {
  const api = fixture()
  api.emit({ type: 'appearance-changed', appearance: { revision: 3, theme: { source: 'com.github.eNest.theme', id: 'paper' } } })
  assert.deepEqual(api.state.profile.identity, { source: 'com.github.eNest.theme', id: 'paper' })
  assert.deepEqual(api.state.profile.values, {})
  assert.equal(api.order.filter(value => value === 'appearance-read').length, 2, 'fetch a complete profile after applying the rendering snapshot')
  api.emit({ type: 'appearance-changed', appearance: { revision: 2, theme: { source: 'enest.builtin', id: 'ink' } } })
  assert.equal(api.state.appearance.theme.id, 'paper')
  assert.equal(api.state.profile.identity.id, 'paper')
  api.cleanup()
})

test('Quick applies effective animation, font, materials and background from the authoritative event', () => {
  const api = fixture()
  const appearance = {
    revision: 8, theme: { source: 'com.example.theme', id: 'paper' },
    fonts: { body: 'Custom Font, sans-serif', scale: 1.2 },
    components: { controlRadius: 5, cardRadius: 9, panelRadius: 14, borderWidth: 2 },
    background: { texture: 'grain', effect: 'none', media: { type: 'image', value: 'enest://appearance/media/' + 'a'.repeat(64), opacity: 0.7 } },
    animation: { requested: 'high', effective: 'low', continuous: false }
  }
  api.emit({ type: 'appearance-changed', revision: 8, appearance })
  assert.equal(api.state.appearance, appearance, 'Quick must not recompute appearance from legacy general settings')
  assert.equal(api.state.appearance.animation.effective, 'low')
  assert.equal(api.state.appearance.fonts.scale, 1.2)
  assert.equal(api.state.appearance.components.controlRadius, 5)
  assert.equal(api.state.appearance.background.media, appearance.background.media)
  api.cleanup()
})

test('theme registration and font resources refresh only the authoritative snapshot', () => {
  const api = fixture()
  api.emit({ type: 'theme-packs-changed' })
  assert.equal(api.order.filter(value => value === 'appearance-read').length, 2)
  api.emit({ type: 'settings-changed', generalKeys: ['customFonts'] })
  assert.equal(api.order.filter(value => value === 'appearance-read').length, 3)
  assert.ok(!api.order.some(value => value.includes('legacy')))
  api.cleanup()
})
