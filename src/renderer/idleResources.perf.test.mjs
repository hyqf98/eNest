import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const require = createRequire(import.meta.url)
const sourceCache = new Map()

function load(path, imports = {}, globals = {}) {
  if (!sourceCache.has(path)) sourceCache.set(path, ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText)
  const module = { exports: {} }
  vm.runInNewContext(sourceCache.get(path), { module, exports: module.exports, console,
    require(name) {
      if (name in imports) return imports[name]
      if (name === 'react' || name === 'react/jsx-runtime') return require(name)
      if (name.endsWith('.css')) return {}
      throw Error(`Unexpected import ${name} in ${path}`)
    }, ...globals }, { filename: path })
  return module.exports
}

function eventTarget() {
  const listeners = new Map()
  return {
    addEventListener(type, callback) {
      if (!listeners.has(type)) listeners.set(type, new Set())
      listeners.get(type).add(callback)
    },
    removeEventListener(type, callback) { listeners.get(type)?.delete(callback) },
    dispatch(type, event = {}) { for (const callback of listeners.get(type) ?? []) callback(event) },
    get listenerCount() { return [...listeners.values()].reduce((sum, set) => sum + set.size, 0) },
  }
}

// Deterministic hooks/effect runner; no browser, native app or historical suite is started.
function hooks() {
  const slots = []
  let cursor = 0, dirty = false
  let effects = [], layouts = []
  const same = (a, b) => a && b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]))
  const effect = (setup, deps, queue) => {
    const index = cursor++
    if (slots[index] && same(slots[index].deps, deps)) return
    const previous = slots[index]
    slots[index] = { deps, cleanup: previous?.cleanup }
    queue.push(() => { previous?.cleanup?.(); slots[index].cleanup = setup() })
  }
  const react = {
    useState(initial) {
      const index = cursor++
      slots[index] ??= { value: typeof initial === 'function' ? initial() : initial }
      return [slots[index].value, update => {
        const next = typeof update === 'function' ? update(slots[index].value) : update
        if (!Object.is(next, slots[index].value)) { slots[index].value = next; dirty = true }
      }]
    },
    useRef(initial) { const index = cursor++; slots[index] ??= { current: initial }; return slots[index] },
    useCallback(callback, deps) {
      const index = cursor++
      if (!slots[index] || !same(slots[index].deps, deps)) slots[index] = { deps, callback }
      return slots[index].callback
    },
    useEffect(setup, deps) { effect(setup, deps, effects) },
    useLayoutEffect(setup, deps) { effect(setup, deps, layouts) },
  }
  return {
    react,
    render(component, attach = () => {}) {
      let result, turns = 0
      do {
        assert.ok(turns++ < 30, 'hook fixture must settle')
        cursor = 0; dirty = false; effects = []; layouts = []
        result = component()
        attach(result)
        for (const run of [...layouts, ...effects]) run()
      } while (dirty)
      return result
    },
    dispose() { for (const slot of slots) slot.cleanup?.() },
  }
}

function carouselFixture(initial = {}) {
  const options = { level: 'medium', continuous: true, reduced: false, paused: false, focused: true, ...initial }
  const runner = hooks(), timers = new Map(), raf = new Map(), tweens = []
  const document = { ...eventTarget(), hidden: false, hasFocus: () => options.focused }
  const window = eventTarget()
  let nextId = 0, intersection
  const styles = () => ({ setProperty() {}, removeProperty() {} })
  const nodes = Array.from({ length: 8 }, (_, index) => ({
    offsetLeft: index * 300 + 4, dataset: { productPosition: String(index - 1) }, style: styles(),
  }))
  const viewport = { scrollLeft: 300, clientWidth: 300, style: styles(),
    querySelectorAll: () => nodes,
    querySelector: query => nodes.find(node => query.includes(`"${node.dataset.productPosition}"`)),
    scrollTo({ left }) { this.scrollLeft = left },
  }
  const makeTween = (element, config) => {
    const tween = { isPaused: false, killed: false,
      pause() { this.isPaused = true }, paused() { return this.isPaused }, resume() { this.isPaused = false },
      kill() { this.killed = true },
      finish() { if (config.scrollLeft !== undefined) element.scrollLeft = config.scrollLeft; config.onUpdate?.(); config.onComplete?.() },
    }
    tweens.push(tween)
    return tween
  }
  const { useProductCarousel } = load('./themes/default/workspace/useProductCarousel.ts', {
    react: runner.react,
    gsap: { to: makeTween, fromTo: (element, _from, config) => makeTween(element, config) },
    '@renderer/gsap/marketMotion': { d: value => value, ease: value => value },
    '@renderer/hooks/useAnimationLevel': { useReducedMotion: () => options.reduced, useAnimationLevel: () => ({ level: options.level }) },
  }, { document, window,
    ResizeObserver: class { observe() {} disconnect() {} },
    IntersectionObserver: class { constructor(callback) { intersection = callback } observe() {} disconnect() {} },
    setTimeout: (callback, ms) => { const id = ++nextId; timers.set(id, { callback, ms }); return id },
    clearTimeout: id => timers.delete(id),
    requestAnimationFrame: callback => { const id = ++nextId; raf.set(id, callback); return id },
    cancelAnimationFrame: id => raf.delete(id),
  })
  const items = Array.from({ length: 5 }, (_, index) => ({ id: `plugin-${index}`, name: `Plugin ${index}` }))
  let result
  const render = () => {
    result = runner.render(() => useProductCarousel(items, options.paused, options.continuous), value => {
      value.rootRef.current = {}; value.viewportRef.current = viewport
    })
    return result
  }
  render()
  return { options, timers, tweens, document, window, render, get result() { return result },
    intersect(visible, ratio) { intersection([{ isIntersecting: visible, intersectionRatio: ratio }]); render() },
    dispose() { runner.dispose(); assert.equal(timers.size, 0); assert.equal(raf.size, 0); assert.equal(document.listenerCount + window.listenerCount, 0) },
  }
}

test('steady low, continuous=false and blur stop autoplay without pausing manual navigation', () => {
  for (const option of [{ level: 'low' }, { continuous: false }, { focused: false }, { reduced: true }]) {
    const f = carouselFixture(option)
    assert.equal(f.result.running, false, JSON.stringify(option))
    assert.equal(f.timers.size, 0)
    f.result.select(1)
    f.render()
    assert.equal(f.result.index, 1)
    if (!option.reduced) {
      assert.equal(f.tweens.length, 1)
      assert.equal(f.tweens[0].isPaused, false, 'manual movement remains interruptible, not frozen by power policy')
      f.tweens[0].finish(); f.render()
    } else assert.equal(f.tweens.length, 0)
    f.dispose()
  }
  const f = carouselFixture()
  assert.equal(f.result.running, true)
  assert.equal([...f.timers.values()].filter(timer => timer.ms === 6500).length, 1)
  f.window.dispatch('blur'); f.render()
  assert.equal(f.result.running, false)
  assert.equal(f.timers.size, 0)
  f.window.dispatch('focus'); f.render()
  assert.equal(f.result.running, true)
  f.options.continuous = false; f.render()
  assert.equal(f.timers.size, 0)
  f.dispose()
})

test('media is retained for partial peeks and direct manipulation, released when fully hidden', () => {
  const f = carouselFixture()
  f.intersect(true, 0.1)
  assert.equal(f.result.running, false)
  assert.equal(f.result.mediaVisible, true, 'the autoplay threshold must not blank a still-visible screenshot')
  f.result.onPointerDownCapture({ pointerType: 'touch' }); f.render()
  assert.equal(f.result.mediaInteracting, true)
  f.window.dispatch('pointerup'); f.render()
  assert.equal(f.result.mediaInteracting, false)
  f.intersect(false, 0)
  assert.equal(f.result.mediaVisible, false)
  f.intersect(true, 1)
  f.document.hidden = true; f.document.dispatch('visibilitychange'); f.render()
  assert.equal(f.result.mediaVisible, false)
  assert.equal(f.timers.size, 0)
  f.dispose()
})

const uiImports = {
  '@renderer/hooks/useI18n': { useI18n: () => ({ locale: 'en-US', t: key => key }) },
  '@renderer/components/icons': { ChevronLeftIcon: () => null, ChevronRightIcon: () => null, XIcon: () => null, ICON_STROKE_WIDTH: 1.8 },
  '@renderer/components/PluginIcon': { PluginIcon: () => React.createElement('span', { 'data-icon': true }) },
}
const { ProductVisual } = load('./themes/default/workspace/ProductVisual.tsx', uiImports)
const plugin = index => ({ id: `plugin-${index}`, name: `Plugin ${index}`, category: 'Development', screenshots: [`image-${index}-a.png`, `image-${index}-b.png`] })

test('hidden gallery unmounts images/dialogs while a restored gallery keeps its selected screenshot', () => {
  const hidden = renderToStaticMarkup(React.createElement(ProductVisual, { plugin: plugin(0), active: true, mediaVisible: false }))
  assert.match(hidden, /data-media-resident="false"/)
  assert.doesNotMatch(hidden, /<img|<dialog|<button/)
  const restored = renderToStaticMarkup(React.createElement(ProductVisual, { plugin: plugin(0), active: true, screenshot: 'image-0-b.png' }))
  assert.match(restored, /data-media-resident="true"/)
  assert.match(restored, /src="image-0-b.png"[^>]*loading="eager"/)
  assert.match(restored, /Screenshot 2 of 2/)
  assert.match(restored, /<dialog/)
})

test('carousel keeps circular neighbors and mirrors but not every offscreen gallery', () => {
  const state = { index: 0, indexRef: { current: 0 }, running: false, mediaVisible: true, mediaInteracting: false }
  const { FeaturedCarousel } = load('./themes/default/workspace/FeaturedCarousel.tsx', {
    ...uiImports,
    '@renderer/themes/default/workspace/useProductCarousel': { PRODUCT_DWELL_MS: 6500, useProductCarousel: () => state },
    '@renderer/themes/default/workspace/ProductVisual': { ProductVisual },
    './pluginPresentation': { formatPluginPackageSize: () => null },
  })
  const render = props => renderToStaticMarkup(React.createElement(FeaturedCarousel, { items: Array.from({ length: 5 }, (_, index) => plugin(index)), onOpen() {}, ...props }))
  const initial = render()
  assert.equal((initial.match(/data-media-resident="false"/g) ?? []).length, 2)
  assert.doesNotMatch(initial, /src="image-[23]-/)
  for (const index of [0, 1, 4]) assert.match(initial, new RegExp(`src="image-${index}-`))
  state.mediaInteracting = true
  assert.equal((render().match(/data-media-resident="false"/g) ?? []).length, 0, 'a long direct swipe does not expose blank galleries')
  const hidden = render({ mediaVisible: false })
  assert.doesNotMatch(hidden, /<img|<dialog/)
  assert.equal((hidden.match(/data-media-resident="false"/g) ?? []).length, 8)
})

test('Home background releases its subtree on host hide and document hide, and forwards continuous/low policy', () => {
  const document = { ...eventTarget(), hidden: false }
  const runner = hooks()
  const { DefaultThemeBackground } = load('./themes/default/DefaultThemeBackground.tsx', {
    react: runner.react,
    '@shared/backgroundEffects': { BUILTIN_BACKGROUND_EFFECTS: [{ id: 'tunnel', renderer: 'preset', preset: 'tunnel' }] },
    '@renderer/hooks/useReducedMotion': { useReducedMotion: () => false },
    '@renderer/components/backgroundAtmosphere': { backgroundAtmosphereStyle: () => null },
    './DefaultBackgroundEffect': { DefaultBackgroundEffect: () => null },
  }, { document })
  const appearance = { background: { effect: 'tunnel' }, animation: { effective: 'medium', continuous: false } }
  let paused = false
  const render = () => runner.render(() => DefaultThemeBackground({ appearance, paused }))
  assert.equal(render().props.continuous, false)
  paused = true; assert.equal(render(), null)
  paused = false; document.hidden = true; document.dispatch('visibilitychange'); assert.equal(render(), null)
  document.hidden = false; document.dispatch('visibilitychange'); assert.ok(render())
  appearance.background = { effect: 'custom', media: { type: 'video', value: 'custom.mp4' } }
  appearance.animation = { effective: 'low', continuous: true }
  assert.equal(render().props.children.props.paused, true)
  runner.dispose()
  assert.equal(document.listenerCount, 0)
})

function backgroundFixture(options = {}) {
  const pending = new Map(), calls = [], observers = []
  const document = { ...eventTarget(), hidden: false, hasFocus: () => true, documentElement: { dataset: { theme: 'light' } } }
  const window = { ...eventTarget(), devicePixelRatio: 2 }
  let id = 0
  const gl = new Proxy({}, { get(_target, name) {
    if (name === 'isContextLost') return () => false
    if (name === 'getParameter') return () => 4096
    if (name === 'getShaderParameter' || name === 'getProgramParameter') return () => true
    if (name === 'getExtension') return () => ({ loseContext: () => calls.push('loseContext') })
    if (name === 'getUniformLocation' || name.startsWith('create')) return () => ({})
    if (name === name.toUpperCase()) return name
    return () => calls.push(name)
  } })
  const canvas = { ...eventTarget(), width: 0, height: 0, getContext: () => gl,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1200, height: 700 }),
  }
  class Observer { constructor() { observers.push(this) } observe() {} disconnect() { this.disconnected = true } }
  const { startBackgroundEffect } = load('./background/backgroundEffect.ts', {
    '@shared/theme/colors': { parseThemeColor: () => [246, 246, 244, 1] },
    './shaders': { BACKGROUND_FRAGMENT_SHADER: 'uniform float time,opening;', BACKGROUND_VERTEX_SHADER: '' },
  }, { document, window, ResizeObserver: Observer, MutationObserver: Observer,
    requestAnimationFrame: callback => { pending.set(++id, callback); return id }, cancelAnimationFrame: id => pending.delete(id),
    getComputedStyle: () => ({ getPropertyValue: () => '#f6f6f4' }),
  })
  const stop = startBackgroundEffect(canvas, { preset: 'tunnel', level: 'medium', ...options })
  return { pending, calls, stop, document, window, observers, canvas }
}

test('background still draws its static frame, owns no idle RAF in low/noncontinuous, and releases GPU handles', () => {
  for (const options of [{ level: 'low' }, { continuous: false }, { reducedMotion: true }, {}]) {
    const f = backgroundFixture(options)
    assert.ok(f.calls.includes('drawArrays'), 'static appearance must not become a blank canvas')
    assert.equal(f.pending.size, Object.keys(options).length ? 0 : 1)
    f.stop(); f.stop()
    assert.equal(f.pending.size, 0)
    assert.equal(f.calls.filter(call => call === 'deleteBuffer').length, 1)
    assert.equal(f.calls.filter(call => call === 'deleteProgram').length, 1)
    assert.equal(f.calls.filter(call => call === 'deleteShader').length, 2)
    assert.equal(f.calls.filter(call => call === 'loseContext').length, 1)
    assert.equal(f.document.listenerCount + f.window.listenerCount + f.canvas.listenerCount, 0)
    assert.ok(f.observers.every(observer => observer.disconnected))
  }
})

test('sleeping tab indicator no longer schedules an infinite pulse', () => {
  const css = readFileSync(new URL('./themes/default/chrome/classicTabs.css', import.meta.url), 'utf8')
  assert.doesNotMatch(css, /tab-lazy-pulse/)
  assert.match(css, /\.tab\.lazy\s*\{[^}]*opacity:\s*0\.62/)
})

function deferred() { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const nextTurn = () => new Promise(resolve => setImmediate(resolve))
function samplerFixture(callbacks) {
  const timers = new Map(), document = { hidden: false }
  let id = 0
  const { makeSampler } = load('../../eNest_plugin/plugins/sysguard/src/js/core.js', {}, {
    document, setInterval: callback => { timers.set(++id, callback); return id }, clearInterval: id => timers.delete(id),
  })
  return { sampler: makeSampler(callbacks), timers, document, tick: () => [...timers.values()].forEach(callback => callback()) }
}

test('sysguard disposes a lease that arrives after stop without sampling', async () => {
  const acquire = deferred(), released = []
  let samples = 0
  const f = samplerFixture({ acquire: () => acquire.promise, release: async token => { released.push(token) }, sample: async () => { samples++ } })
  f.sampler.start()
  await f.sampler.stop()
  acquire.resolve('late')
  await nextTurn()
  assert.deepEqual(released, ['late'])
  assert.equal(samples, 0)
  assert.equal(f.timers.size, 0)
  assert.equal(f.sampler.running, false)
})

test('sysguard keeps acquire and sampling single-flight across interval ticks', async () => {
  const acquisition = deferred(), sampling = deferred()
  let acquisitions = 0, samples = 0
  const released = []
  const f = samplerFixture({ acquire: () => { acquisitions++; return acquisition.promise }, release: async token => released.push(token),
    sample: () => { samples++; return sampling.promise } })
  f.sampler.start(); f.tick(); f.tick()
  assert.equal(acquisitions, 1)
  acquisition.resolve('owned'); await nextTurn()
  f.tick(); f.tick()
  assert.equal(samples, 1)
  sampling.resolve(); await nextTurn()
  f.tick(); await nextTurn()
  assert.equal(samples, 2)
  await f.sampler.stop()
  assert.deepEqual(released, ['owned'])
})

test('sysguard restart never adopts the previous generation pending lease', async () => {
  const first = deferred(), releasingOld = deferred(), released = []
  let acquired = 0, samples = 0
  const f = samplerFixture({ acquire: () => ++acquired === 1 ? first.promise : Promise.resolve('new'),
    release: token => { released.push(token); return token === 'old' ? releasingOld.promise : Promise.resolve() },
    sample: async () => { samples++ } })
  f.sampler.start(); await f.sampler.stop(); f.sampler.start()
  first.resolve('old'); await nextTurn()
  assert.equal(acquired, 1)
  assert.equal(samples, 0)
  releasingOld.resolve(); await nextTurn()
  assert.equal(acquired, 2)
  assert.equal(samples, 1)
  await f.sampler.stop()
  assert.deepEqual(released, ['old', 'new'])
  assert.equal(f.timers.size, 0)
})

test('sysguard delayed release cannot clear the token owned by a restarted sampler', async () => {
  const releasingOld = deferred(), released = []
  let acquired = 0
  const f = samplerFixture({ acquire: async () => ++acquired === 1 ? 'old' : 'new', sample: async () => {},
    release: token => { released.push(token); return token === 'old' ? releasingOld.promise : Promise.resolve() } })
  f.sampler.start(); await nextTurn()
  const stopped = f.sampler.stop()
  f.sampler.start(); await nextTurn()
  assert.equal(acquired, 2)
  releasingOld.resolve(); await stopped
  await f.sampler.stop()
  assert.deepEqual(released, ['old', 'new'])
})
