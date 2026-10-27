import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import ts from 'typescript'

const source = ts.transpileModule(readFileSync(new URL('../../../../src/renderer/themes/default/DefaultThemeSplash.tsx', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText
const lifecycleSource = ts.transpileModule(readFileSync(new URL('../../../../src/renderer/themes/default/useSplashLifecycle.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText

function fixture(t, { reduced = false, atmosphere = false, playable = false, effects = [] } = {}) {
  const hooks = []
  const pending = []
  const playback = []
  const window = new EventTarget()
  const dom = { querySelector: () => null, querySelectorAll: () => [] }
  const appearance = { animation: { effective: 'medium' }, background: { effect: 'none' }, splash: { type: 'none' } }
  let cursor = 0
  let completed = 0
  const sameDeps = (a, b) => a?.length === b.length && b.every((value, index) => Object.is(value, a[index]))
  function useEffect(effect, deps) {
    const index = cursor++
    const previous = hooks[index]
    if (!sameDeps(previous?.deps, deps)) {
      const state = hooks[index] = { deps }
      pending.push(() => { previous?.cleanup?.(); state.cleanup = effect() })
    }
  }
  const imports = {
    react: {
      useEffect, useLayoutEffect: useEffect,
      useRef(value) { const index = cursor++; return hooks[index] ??= { current: value } },
      useCallback(callback, deps) {
        const index = cursor++
        if (!sameDeps(hooks[index]?.deps, deps)) hooks[index] = { callback, deps }
        return hooks[index].callback
      },
    },
    'react/jsx-runtime': { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) },
    '@renderer/themes/default/motion/splashMotion': { playSplash(_handles, onDone, _level, _style, ready) {
      const state = { onDone, ready, updates: [], disposed: false }
      playback.push(state)
      return Object.assign(() => { state.disposed = true }, { setReady(value) { state.ready = value; state.updates.push(value) } })
    } },
    '@renderer/hooks/useReducedMotion': { useReducedMotion: () => reduced },
    '@shared/backgroundEffects': { BUILTIN_BACKGROUND_EFFECTS: effects },
    '@renderer/components/backgroundAtmosphere': { backgroundAtmosphereStyle: () => atmosphere ? { background: '#eee' } : null },
    '@renderer/themes/default/DefaultThemeBackground': { DefaultThemeBackground: () => null },
    '@renderer/services/themeResources': { resolveMediaSrc: value => ({ playable, src: value }) },
    '@renderer/components/ui/Button': { Button: 'button' },
  }
  const lifecycleModule = { exports: {} }
  new Function('require', 'module', 'exports', 'window', lifecycleSource)(id => imports[id], lifecycleModule, lifecycleModule.exports, window)
  imports['@renderer/themes/default/useSplashLifecycle'] = lifecycleModule.exports
  const module = { exports: {} }
  new Function('require', 'module', 'exports', 'window', source)(id => imports[id], module, module.exports, window)
  const unmount = () => {
    for (const hook of hooks) { hook.cleanup?.(); delete hook.cleanup }
  }
  t.after(unmount)
  return {
    playback, window, appearance,
    get completed() { return completed },
    render(props = {}) {
      cursor = 0
      const tree = module.exports.DefaultThemeSplash({ appearance, onDone: () => completed++, ...props })
      tree.props.ref.current = dom
      while (pending.length) pending.shift()()
      return tree
    },
    unmount,
  }
}

test('a selected startup image overrides static atmosphere after background motion is disabled', t => {
  const f = fixture(t, { atmosphere: true, playable: true })
  f.appearance.splash = { type: 'image', media: { type: 'image', value: 'enest://appearance/media/startup.png' }, opacity: 0.6 }
  const tree = f.render()
  const photo = tree.props.children.find(node => node?.type === 'img')
  assert.equal(photo.props.src, 'enest://appearance/media/startup.png')
  assert.match(tree.props.className, /splash--photo/)
  assert.doesNotMatch(tree.props.className, /splash--effect/)
})

test('shared background motion still takes precedence over an independent startup image', t => {
  const f = fixture(t, { atmosphere: true, playable: true, effects: [{ id: 'tunnel', renderer: 'preset', preset: 'tunnel' }] })
  f.appearance.background.effect = 'tunnel'
  f.appearance.splash = { type: 'image', media: { type: 'image', value: 'enest://appearance/media/startup.png' } }
  const tree = f.render()
  assert.equal(tree.props.children.some(node => node?.type === 'img'), false)
  assert.match(tree.props.className, /splash--effect/)
})

test('readiness updates release the existing splash rather than re-running its layout effect', t => {
  const f = fixture(t)
  f.render({ ready: false })
  assert.equal(f.playback.length, 1)
  assert.equal(f.playback[0].ready, false)
  f.render({ ready: true })
  assert.equal(f.playback.length, 1)
  assert.equal(f.playback[0].ready, true)
  assert.equal(f.playback[0].disposed, false)
  f.playback[0].onDone()
  f.playback[0].onDone()
  assert.equal(f.completed, 1)
  f.unmount()
  assert.equal(f.playback[0].disposed, true)
})

test('configuration hydration starts a single splash with the latest readiness value', t => {
  const f = fixture(t)
  f.render({ hydrated: false, ready: false })
  assert.equal(f.playback.length, 0)
  f.render({ hydrated: false, ready: true })
  assert.equal(f.playback.length, 0)
  f.render({ hydrated: true, ready: true })
  assert.equal(f.playback.length, 1)
  assert.equal(f.playback[0].ready, true)
})

test('reduced motion waits for both configuration and workspace readiness without an animation', t => {
  const f = fixture(t, { reduced: true })
  f.render({ hydrated: false, ready: true })
  assert.equal(f.completed, 0)
  f.render({ hydrated: true, ready: false })
  assert.equal(f.completed, 0)
  f.render({ ready: true })
  assert.equal(f.completed, 1)
  f.render({ ready: false })
  f.render({ ready: true })
  assert.equal(f.completed, 1)
  assert.equal(f.playback.length, 0)
})

test('preview keeps its ready default and reduced-motion Escape dismissal', t => {
  const normal = fixture(t)
  normal.render({ preview: true })
  assert.equal(normal.playback[0].ready, true)
  const reduced = fixture(t, { reduced: true })
  reduced.render({ preview: true })
  assert.equal(reduced.completed, 0)
  const event = new Event('keydown')
  Object.defineProperty(event, 'key', { value: 'Escape' })
  reduced.window.dispatchEvent(event)
  assert.equal(reduced.completed, 1)
  reduced.unmount()
  reduced.window.dispatchEvent(event)
  assert.equal(reduced.completed, 1)
})
