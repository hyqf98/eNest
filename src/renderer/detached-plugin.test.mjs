import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'
import { _electron as electron } from 'playwright-core'

const moduleRequire = createRequire(import.meta.url)
function loadShared(path, mocks = {}) {
  const js = ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  const module = { exports: {} }
  new Function('require', 'module', 'exports', js)(id => mocks[id] ?? moduleRequire(id), module, module.exports)
  return module.exports
}
const backgroundEffects = loadShared('../shared/backgroundEffects.ts', { '@shared/pluginContract': loadShared('../shared/pluginContract.ts') })
const backgroundAtmosphere = loadShared('./components/backgroundAtmosphere.ts', { './backgroundColorStyle': loadShared('./components/backgroundColorStyle.ts') })

const state = (value = 'saved', generation = 1) => ({
  pluginId: 'fixture', generation, title: 'Fixture', status: 'ready', mode: 'quick',
  input: { pluginId: 'fixture', generation, value, placeholder: 'Search' }
})

async function fixture(initialState = state()) {
  class Element {
    listeners = new Map()
    attributes = new Map()
    dataset = {}
    style = { setProperty(name, value) { this[name] = value }, removeProperty(name) { delete this[name] }, getPropertyValue(name) { return this[name] ?? '' } }
    value = ''
    disabled = false
    children = []
    classList = {
      add: name => { this.className = `${this.className || ''} ${name}` },
      toggle: (name, force) => { const names = new Set(this.className?.split(' ').filter(Boolean)); if (force) names.add(name); else names.delete(name); this.className = [...names].join(' ') },
    }
    get src() { return this.attributes.get('src') || '' }
    set src(value) { this.attributes.set('src', value) }
    get poster() { return this.attributes.get('poster') || '' }
    set poster(value) { this.attributes.set('poster', value) }
    appendChild(child) { this.children.push(child); child.parentElement = this; return child }
    querySelector(selector) { const className = selector.match(/^:scope > \.([\w-]+)$/)?.[1]; return className ? this.children.find(child => child.className?.split(' ').includes(className)) ?? null : null }
    prepend(child) { this.children.unshift(child); child.parentElement = this }
    remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this); this.parentElement = null }
    play() { this.playCalls = (this.playCalls || 0) + 1; return Promise.resolve() }
    pause() { this.pauseCalls = (this.pauseCalls || 0) + 1 }
    load() { this.loadCalls = (this.loadCalls || 0) + 1 }
    addEventListener(name, fn) { const items = this.listeners.get(name) ?? []; items.push(fn); this.listeners.set(name, items) }
    removeEventListener(name, fn) { this.listeners.set(name, (this.listeners.get(name) ?? []).filter(item => item !== fn)) }
    dispatch(name, fields = {}) { for (const fn of this.listeners.get(name) ?? []) fn({ target: this, preventDefault() {}, ...fields }) }
    getAttribute(name) { return this.attributes.get(name) }
    setAttribute(name, value) { this.attributes.set(name, value) }
    removeAttribute(name) { this.attributes.delete(name) }
    focus() { this.focusCount = (this.focusCount ?? 0) + 1 }
    select() { this.selectCount = (this.selectCount ?? 0) + 1 }
  }
  const elements = new Map(), pendingReads = [], commands = [], backgroundStarts = []
  const document = new Element(), window = new Element()
  document.documentElement = new Element()
  document.body = new Element()
  document.hidden = false
  document.hasFocus = () => true
  document.createElement = tag => { const node = new Element(); node.tagName = tag; node.ownerDocument = document; return node }
  const reducedMotion = new Element()
  reducedMotion.matches = false
  window.matchMedia = () => reducedMotion
  document.getElementById = id => {
    if (!elements.has(id)) elements.set(id, new Element())
    return elements.get(id)
  }
  let receive
  window.enestWindows = {
    getState: () => new Promise(resolve => pendingReads.push(resolve)),
    command: command => { commands.push(command); return Promise.resolve({ ok: true }) },
    onEvent: callback => { receive = callback; return () => {} }
  }
  const source = readFileSync(new URL('./detached-plugin.ts', import.meta.url), 'utf8').replaceAll('import.meta.hot', 'undefined')
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const module = { exports: {} }
  vm.runInNewContext(compiled, {
    module, exports: module.exports, window, document, URLSearchParams, location: { search: '?mode=quick' }, setTimeout: () => 1, clearTimeout() {},
    require: id => {
      if (id.endsWith('.css')) return {}
      if (id === '@shared/platform') return { IS_MAC: false }
      if (id === '@renderer/gsap/marketMotion') return { applyLevelToDefaults() {} }
      if (id === '@shared/backgroundEffects') return backgroundEffects
      if (id === '@renderer/components/backgroundAtmosphere') return backgroundAtmosphere
      if (id === '@renderer/background/backgroundEffect') return { startBackgroundEffect: (canvas, options) => {
        const record = { canvas, options, disposed: false }; backgroundStarts.push(record)
        return () => { record.disposed = true }
      } }
      if (id === '@renderer/services/pluginWindowDrag') return { bindPluginDragSource: () => () => {} }
      throw new Error(id)
    }
  })
  pendingReads.shift()(initialState)
  await new Promise(setImmediate)
  return {
    input: elements.get('plugin-input'), elements, commands, document, window, reducedMotion, backgroundStarts,
    emit: event => receive(event),
    refresh: () => receive({ type: 'shell', event: { type: 'settings-changed', generalKeys: ['fontFamily'] } }),
    resolve: async result => { assert.ok(pendingReads.length); pendingReads.shift()(result); await new Promise(setImmediate) }
  }
}

test('a stale appearance refresh cannot replace text typed after its read started', async () => {
  const f = await fixture()
  f.refresh()
  f.input.value = 'new local text'; f.input.dispatch('input')
  assert.equal(f.commands.at(-1).message.value, 'new local text')
  await f.resolve({ ...state('old snapshot'), title: 'Updated title' })
  assert.equal(f.input.value, 'new local text')
  assert.equal(f.elements.get('plugin-title').textContent, 'Updated title', 'metadata still refreshes independently of the newer input')
})

test('same-generation metadata snapshots preserve typed input while still updating pin and title', async () => {
  const f = await fixture()
  f.input.value = 'new typed text'; f.input.dispatch('input')
  f.emit({ type: 'state', state: { ...state('old pin snapshot'), title: 'Pinned title', alwaysOnTop: true } })
  assert.equal(f.input.value, 'new typed text')
  assert.equal(f.elements.get('plugin-title').textContent, 'Pinned title')
  assert.equal(f.elements.get('pin-window').getAttribute('aria-pressed'), 'true')
  f.input.value += '!'; f.input.dispatch('input')
  assert.equal(f.commands.at(-1).message.value, 'new typed text!', 'the next keystroke must not send a value truncated by stale metadata')
  f.emit({ type: 'shell', event: { type: 'quick-input', state: { ...state('configured value').input, placeholder: 'Configured search' } } })
  f.emit({ type: 'state', state: state('old history snapshot') })
  assert.equal(f.input.value, 'configured value')
  assert.equal(f.input.placeholder, 'Configured search')
  f.emit({ type: 'shell', event: { type: 'quick-input', state: null } })
  f.emit({ type: 'state', state: state('old nonempty input') })
  assert.equal(f.input.value, '')
  assert.equal(f.input.disabled, true, 'metadata must not resurrect an explicitly cleared input configuration')
  f.emit({ type: 'state', state: state('new instance input', 2) })
  assert.equal(f.input.value, 'new instance input')
  assert.equal(f.input.disabled, false)
})

test('a newer input configuration arriving while loading survives an older ready read', async () => {
  const f = await fixture({ ...state('loading value'), status: 'loading' })
  f.refresh()
  f.emit({ type: 'shell', event: { type: 'quick-input', state: { ...state('configured during load').input, placeholder: 'Ready search' } } })
  await f.resolve(state('earlier ready snapshot'))
  assert.equal(f.input.disabled, false)
  assert.equal(f.input.value, 'configured during load')
  assert.equal(f.input.placeholder, 'Ready search')
})

test('new input configuration and explicit clear both supersede an in-flight state read', async () => {
  const f = await fixture()
  f.refresh()
  f.emit({ type: 'shell', event: { type: 'quick-input', state: { ...state('new configuration').input, placeholder: 'Updated search' } } })
  await f.resolve(state('old configuration'))
  assert.equal(f.input.value, 'new configuration')
  assert.equal(f.input.placeholder, 'Updated search')
  f.refresh()
  f.emit({ type: 'shell', event: { type: 'quick-input', state: null } })
  await f.resolve(state('must not reappear'))
  assert.equal(f.input.value, '')
  assert.equal(f.input.disabled, true)
})

test('a new renderer generation takes precedence over pending reads and old input events', async () => {
  const f = await fixture()
  f.refresh()
  f.emit({ type: 'state', state: state('new instance', 2) })
  f.emit({ type: 'shell', event: { type: 'quick-input', state: state('old instance', 1).input } })
  await f.resolve(state('old read', 1))
  assert.equal(f.input.value, 'new instance')
  f.input.value = 'new instance text'; f.input.dispatch('input')
  assert.equal(f.commands.at(-1).message.generation, 2)
})

test('refreshes preserve an active IME composition and send only its final value', async () => {
  const f = await fixture()
  f.refresh()
  f.input.dispatch('compositionstart')
  f.input.value = '拼音候选'; f.input.dispatch('input')
  await f.resolve(state('old read'))
  assert.equal(f.input.value, '拼音候选')
  assert.equal(f.commands.length, 0)
  f.input.value = '拼音完成'; f.input.dispatch('compositionend')
  assert.equal(f.commands.length, 1)
  assert.equal(f.commands[0].message.value, '拼音完成')
})

test('dock controls are icon-only buttons with exact tooltips and accessible names', () => {
  const html = readFileSync(new URL('./detached-plugin.html', import.meta.url), 'utf8')
  for (const [id, label] of [['dock-shell', '收回主窗口'], ['dock-quick', '收回小窗口']]) {
    const button = html.match(new RegExp(`<button id="${id}"([^>]*)>([\\s\\S]*?)<\\/button>`))
    assert.ok(button, id)
    assert.match(button[1], new RegExp(`title="${label}"`))
    assert.match(button[1], new RegExp(`aria-label="${label}"`))
    assert.match(button[2], /<svg[^>]*aria-hidden="true"[^>]*focusable="false"/)
    assert.equal(button[2].replace(/<[^>]*>/g, '').trim(), '', 'icons must not retain the old visible text labels')
  }
})

test('lazy Quick restores only a placeholder and waits for an explicit open click', async () => {
  const lazy = { ...state('stale input'), status: 'lazy', generation: 0 }
  const f = await fixture(lazy)
  assert.equal(f.document.documentElement.dataset.status, 'lazy')
  assert.equal(f.elements.get('plugin-placeholder').hidden, false)
  assert.equal(f.elements.get('quick-bar').hidden, true)
  assert.equal(f.input.disabled, true)
  assert.equal(f.elements.get('focus-plugin').disabled, true)
  f.window.dispatch('focus'); f.document.dispatch('focus')
  f.emit({ type: 'shell', event: { type: 'quick-focus-search' } })
  f.document.dispatch('keydown', { key: 'k', ctrlKey: true })
  f.elements.get('focus-plugin').dispatch('click')
  f.elements.get('retry').dispatch('click')
  f.input.value = 'must not reach a sleeping runtime'; f.input.dispatch('input')
  f.refresh(); await f.resolve(lazy)
  assert.equal(f.input.focusCount ?? 0, 0)
  assert.equal(f.commands.length, 0, 'state reads, focus and disabled input must never activate a lazy plugin')
  f.elements.get('activate').dispatch('click')
  assert.deepEqual(f.commands.map(command => command.action), ['activate'])
})

test('lazy, loading, ready and failure states expose only their available controls', async () => {
  const f = await fixture({ ...state(), status: 'lazy' })
  for (const nextStatus of ['loading', 'error', 'hibernated']) {
    f.emit({ type: 'state', state: { ...state(), status: nextStatus } })
    assert.equal(f.elements.get('plugin-placeholder').hidden, true, nextStatus)
    assert.equal(f.elements.get('quick-bar').hidden, false, nextStatus)
    assert.equal(f.input.disabled, true, nextStatus)
    assert.equal(f.elements.get('focus-plugin').disabled, true, nextStatus)
    assert.equal(f.elements.get('retry').hidden, nextStatus === 'loading', nextStatus)
    f.elements.get('activate').dispatch('click')
    f.input.dispatch('input')
  }
  assert.equal(f.commands.length, 0)
  f.elements.get('retry').dispatch('click')
  assert.equal(f.commands.at(-1).action, 'retry')
  f.emit({ type: 'state', state: state('ready input') })
  assert.equal(f.elements.get('plugin-placeholder').hidden, true)
  assert.equal(f.input.disabled, false)
  assert.equal(f.elements.get('focus-plugin').disabled, false)
  assert.equal(f.elements.get('retry').hidden, true)
  f.input.value = 'user input'; f.input.dispatch('input')
  assert.equal(f.commands.at(-1).message.value, 'user input')
  f.emit({ type: 'state', state: { ...state(), mode: 'shell', status: 'lazy' } })
  assert.equal(f.elements.get('plugin-placeholder').hidden, false)
  assert.equal(f.elements.get('quick-bar').hidden, true)
})

test('pin state follows native snapshots and neither pin nor dock buttons activate the plugin', async () => {
  const lazy = { ...state(), status: 'lazy', alwaysOnTop: false }
  const f = await fixture(lazy), pin = f.elements.get('pin-window')
  assert.equal(pin.getAttribute('aria-pressed'), 'false')
  assert.equal(pin.getAttribute('title'), '置顶窗口')
  assert.equal(pin.getAttribute('aria-label'), '置顶窗口')
  pin.dispatch('click')
  assert.equal(f.commands.at(-1).action, 'toggle-always-on-top')
  assert.equal(pin.getAttribute('aria-pressed'), 'false', 'native acknowledgement owns the visible pinned state')
  f.emit({ type: 'state', state: { ...lazy, alwaysOnTop: true } })
  assert.equal(pin.getAttribute('aria-pressed'), 'true')
  assert.equal(pin.getAttribute('title'), '取消置顶')
  assert.equal(pin.getAttribute('aria-label'), '取消置顶')
  pin.dispatch('click')
  f.emit({ type: 'state', state: lazy })
  assert.equal(pin.getAttribute('aria-pressed'), 'false')
  assert.equal(pin.getAttribute('title'), '置顶窗口')
  f.elements.get('dock-shell').dispatch('click')
  assert.equal(f.commands.at(-1).target, 'shell')
  f.elements.get('dock-quick').dispatch('click')
  assert.equal(f.commands.at(-1).target, 'quick')
  assert.deepEqual(f.commands.map(command => command.action), ['toggle-always-on-top', 'toggle-always-on-top', 'dock', 'dock'])
})

const appearance = (backgroundEffect, animationLevel = 'medium') => ({ theme: 'dark', tokens: { '--bg': '#102030' }, animationLevel, backgroundEffect })
const withAppearance = (effect, level = 'medium') => ({ ...state(), appearance: appearance(effect, level) })

test('detached chrome reuses the selected preset and releases its canvas on switch, off and disposal', async () => {
  const effect = backgroundEffects.resolveBackgroundEffect('tunnel')
  const f = await fixture(withAppearance(effect))
  assert.equal(f.backgroundStarts.length, 1)
  assert.equal(f.backgroundStarts[0].options.preset, 'tunnel')
  assert.equal(f.backgroundStarts[0].options.level, 'medium')
  const firstCanvas = f.backgroundStarts[0].canvas
  f.emit({ type: 'state', state: { ...withAppearance({ ...effect }), title: 'Metadata only', alwaysOnTop: true } })
  assert.equal(f.backgroundStarts.length, 1, 'metadata refreshes must not restart the GPU scene')
  f.emit({ type: 'state', state: withAppearance(backgroundEffects.resolveBackgroundEffect('aurora'), 'low') })
  assert.equal(f.backgroundStarts[0].disposed, true)
  assert.notEqual(f.backgroundStarts[1].canvas, firstCanvas, 'disposed GPU contexts require a fresh canvas')
  assert.equal(f.backgroundStarts[1].options.level, 'low')
  assert.equal(f.document.body.children.length, 1)
  f.reducedMotion.matches = true; f.reducedMotion.dispatch('change')
  assert.equal(f.backgroundStarts[1].disposed, true)
  assert.equal(f.backgroundStarts[2].options.reducedMotion, true)
  f.emit({ type: 'state', state: withAppearance(null) })
  assert.equal(f.backgroundStarts[2].disposed, true)
  assert.equal(f.document.body.children.length, 0)
  assert.equal(f.document.documentElement.dataset.backgroundEffect, 'none')
  f.emit({ type: 'state', state: withAppearance(effect) })
  f.window.dispatch('pagehide')
  assert.equal(f.backgroundStarts.at(-1).disposed, true)
  assert.equal(f.document.body.children.length, 0)
  const total = f.backgroundStarts.length
  f.reducedMotion.dispatch('change')
  f.emit({ type: 'state', state: withAppearance(effect) })
  assert.equal(f.backgroundStarts.length, total)
})

test('detached atmosphere changes update CSS immediately without restarting its GPU scene', async () => {
  const selected = withAppearance(backgroundEffects.resolveBackgroundEffect('tunnel'), 'low')
  const f = await fixture(selected)
  const background = { type: 'color', value: 'linear-gradient(120deg, #193d43, #728360)', opacity: 0.6, fit: 'cover' }
  f.emit({ type: 'state', state: { ...selected, appearance: { ...selected.appearance, background } } })
  const container = f.document.body.children[0]
  const layer = container.querySelector(':scope > .background-atmosphere')
  assert.equal(layer.style.backgroundImage, background.value)
  assert.equal(layer.style.opacity, '0.6')
  const wash = container.querySelector(':scope > .background-atmosphere-wash')
  assert.equal(wash.style.opacity, String(0.6 * 0.32))
  assert.equal(f.document.documentElement.style.getPropertyValue('--atmosphere-strength'), '0.6')
  f.emit({ type: 'state', state: { ...selected, appearance: { ...selected.appearance, background: { ...background, value: '#ab7733', opacity: 0.2 } } } })
  assert.equal(layer.style.backgroundImage, '')
  assert.equal(layer.style.backgroundColor, '#ab7733')
  assert.equal(layer.style.opacity, '0.2')
  assert.equal(f.backgroundStarts.length, 1)
  assert.equal(f.backgroundStarts[0].disposed, false)
  f.emit({ type: 'state', state: { ...selected, appearance: { ...selected.appearance, background: null } } })
  assert.equal(container.querySelector(':scope > .background-atmosphere'), null)
  assert.equal(container.querySelector(':scope > .background-atmosphere-wash'), null)
  assert.equal(f.document.documentElement.style.getPropertyValue('--atmosphere-paint'), '')
  f.window.dispatch('pagehide')
})

test('detached video follows visibility/focus and uses only its poster in low or reduced motion modes', async () => {
  const source = 'com.example.backgrounds'
  const effect = { id: `plugin:${source}:night:film`, name: 'Film', renderer: 'video', source,
    video: `enest://plugin/${source}/assets/film.webm`, poster: `enest://plugin/${source}/assets/film.webp` }
  const f = await fixture(withAppearance(effect))
  const video = f.document.body.children[0].children[0]
  assert.equal(video.tagName, 'video')
  assert.equal(video.src, effect.video)
  assert.equal(video.poster, effect.poster)
  assert.equal(video.playCalls, 1)
  assert.equal(video.muted, true); assert.equal(video.loop, true)
  f.window.dispatch('blur')
  assert.equal(video.pauseCalls, 1)
  const plays = video.playCalls
  f.document.hidden = true; f.window.dispatch('focus')
  assert.equal(video.playCalls, plays, 'focus cannot restart a hidden background')
  f.document.hidden = false; f.document.dispatch('visibilitychange')
  assert.equal(video.playCalls, plays + 1)
  f.emit({ type: 'state', state: withAppearance(effect, 'low') })
  assert.equal(video.src, '')
  assert.equal(video.poster, '')
  assert.equal(video.loadCalls, 1, 'switching unloads the decoder and source')
  const still = f.document.body.children[0].children[0]
  assert.equal(still.src, '')
  assert.equal(still.poster, effect.poster)
  assert.equal(still.playCalls ?? 0, 0)
  f.emit({ type: 'state', state: withAppearance(effect, 'high') })
  f.reducedMotion.matches = true; f.reducedMotion.dispatch('change')
  assert.equal(f.document.body.children[0].children[0].src, '')
  f.window.dispatch('pagehide')
  assert.equal(f.document.body.children.length, 0)
  assert.equal(f.document.listeners.get('visibilitychange')?.length ?? 0, 0)
  assert.equal(f.window.listeners.get('blur')?.length ?? 0, 0)
})

test('detached video rejects foreign and remote media before assigning a source URL', async () => {
  const source = 'com.example.backgrounds'
  for (const video of ['https://example.test/film.webm', 'file:///private/film.webm', 'enest://plugin/com.other.plugin/assets/film.webm',
    `enest://plugin/${source}/assets/../film.webm`]) {
    const f = await fixture(withAppearance({ id: 'film', name: 'Film', source, renderer: 'video', video }))
    assert.equal(f.document.body.children[0].children.length, 0)
    assert.match(f.document.body.children[0].className, /background-effect--fallback/)
    f.window.dispatch('pagehide')
    assert.equal(f.document.body.children.length, 0)
  }
})

test('detached video failures release the media source and cannot restart on lifecycle events', async () => {
  const source = 'com.example.backgrounds'
  const effect = { id: 'film', name: 'Film', renderer: 'video', source,
    video: `enest://plugin/${source}/assets/film.webm`, poster: `enest://plugin/${source}/assets/film.webp` }
  const f = await fixture(withAppearance(effect))
  const container = f.document.body.children[0], video = container.children[0]
  video.dispatch('error')
  assert.equal(video.src, '')
  assert.equal(video.loadCalls, 1, 'media errors must unload the decoder and source')
  assert.match(container.className, /background-effect--fallback/)
  const plays = video.playCalls, pauses = video.pauseCalls
  video.dispatch('error'); video.dispatch('loadeddata')
  f.window.dispatch('blur'); f.window.dispatch('focus'); f.document.dispatch('visibilitychange')
  assert.equal(video.loadCalls, 1, 'repeated failure events are idempotent')
  assert.equal(video.playCalls, plays)
  assert.equal(video.pauseCalls, pauses)
  f.window.dispatch('pagehide')
  assert.equal(video.poster, '')
  assert.equal(f.document.listeners.get('visibilitychange')?.length ?? 0, 0)
})

test('detached video keeps recoverable playback failures and unloads unsupported media', async () => {
  const source = 'com.example.backgrounds'
  const effect = { id: 'film', name: 'Film', renderer: 'video', source,
    video: `enest://plugin/${source}/assets/film.webm` }
  const f = await fixture(withAppearance(effect))
  const container = f.document.body.children[0], video = container.children[0]
  for (const name of ['AbortError', 'NotAllowedError']) {
    video.play = () => Promise.reject({ name })
    f.window.dispatch('focus')
    await new Promise(setImmediate)
    assert.equal(video.src, effect.video, `${name} must preserve retryable media`)
    assert.doesNotMatch(container.className, /background-effect--fallback/)
  }
  video.play = () => Promise.reject({ name: 'NotSupportedError' })
  f.window.dispatch('focus')
  await new Promise(setImmediate)
  assert.equal(video.src, '')
  assert.equal(video.loadCalls, 1)
  assert.match(container.className, /background-effect--fallback/)
  f.window.dispatch('pagehide')
})

test('detached video ignores queued callbacks and playback rejection after replacement', async () => {
  const source = 'com.example.backgrounds'
  const effect = { id: 'film', name: 'Film', renderer: 'video', source,
    video: `enest://plugin/${source}/assets/film.webm` }
  const f = await fixture(withAppearance(effect))
  const container = f.document.body.children[0], video = container.children[0]
  const queuedSync = video.listeners.get('loadeddata')[0]
  const queuedError = video.listeners.get('error')[0]
  let rejectPlay
  video.play = () => new Promise((_, reject) => { rejectPlay = reject })
  f.window.dispatch('focus')
  f.emit({ type: 'state', state: withAppearance(backgroundEffects.resolveBackgroundEffect('tunnel')) })
  const pauses = video.pauseCalls
  queuedSync(); queuedError()
  rejectPlay({ name: 'NotSupportedError' })
  await new Promise(setImmediate)
  assert.equal(video.pauseCalls, pauses, 'queued sync cannot touch disposed media')
  assert.equal(video.loadCalls, 1, 'a late rejection cannot release an already disposed source twice')
  assert.doesNotMatch(container.className, /background-effect--fallback/)
  assert.equal(f.document.body.children.length, 1)
  assert.equal(f.backgroundStarts[0].disposed, false)
  f.window.dispatch('pagehide')
})

test('native detached chrome renders pin feedback and compact lazy layouts without waking a plugin', {
  skip: process.env.ENEST_DETACHED_UI_SMOKE !== '1', timeout: 30000
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'enest-detached-ui-'))
  let app
  try {
    const script = join(directory, 'main.cjs')
    await writeFile(script, `const {app,BrowserWindow}=require('electron');
app.setPath('userData',${JSON.stringify(join(directory, 'profile'))});app.disableHardwareAcceleration();
app.whenReady().then(()=>{const win=new BrowserWindow({show:false,width:720,height:460});win.loadURL('about:blank')});`)
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
    app = await electron.launch({ executablePath: createRequire(import.meta.url)('electron'), args: [script], env, timeout: 15000 })
    const page = await app.firstWindow()
    const html = readFileSync(new URL('./detached-plugin.html', import.meta.url), 'utf8').replace(/<script[^>]*>[\s\S]*?<\/script>/g, '')
    const css = readFileSync(new URL('./styles/tokens.css', import.meta.url), 'utf8') + '\n'
      + readFileSync(new URL('./detached-plugin.css', import.meta.url), 'utf8').replace(/^@import.*$/gm, '')
    await page.setContent(html); await page.addStyleTag({ content: css })
    const source = readFileSync(new URL('./detached-plugin.ts', import.meta.url), 'utf8').replaceAll('import.meta.hot', 'undefined')
    const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
    await page.addScriptTag({ content: `window.fixtureState={pluginId:'demo',title:'搜索插件',generation:0,status:'lazy',mode:'quick',alwaysOnTop:false};
window.fixtureCommands=[];window.enestWindows={getState:async()=>window.fixtureState,command:async(command)=>{window.fixtureCommands.push(command);return{ok:true}},onEvent:callback=>{window.emitFixture=callback;return()=>{}}};
const module={exports:{}},exports=module.exports;const require=id=>id.endsWith('.css')?{}:id==='@shared/platform'?{IS_MAC:true}:id==='@renderer/gsap/marketMotion'?{applyLevelToDefaults(){}}:{bindPluginDragSource:()=>()=>{}};
${compiled}` })
    await page.locator('#activate').waitFor({ state: 'visible' })
    assert.equal(await page.locator('#quick-bar').isVisible(), false)
    assert.equal(await page.locator('#plugin-input').isEnabled(), false)
    await page.locator('#pin-window').click()
    assert.deepEqual(await page.evaluate(() => window.fixtureCommands.map(command => command.action)), ['toggle-always-on-top'])
    await page.evaluate(() => window.emitFixture({ type: 'state', state: { ...window.fixtureState, alwaysOnTop: true } }))
    for (const platform of ['mac', 'other']) {
      await page.evaluate(platform => { document.documentElement.dataset.platform = platform }, platform)
      await page.waitForFunction(() => getComputedStyle(document.querySelector('#pin-window')).color !== getComputedStyle(document.querySelector('#dock-shell')).color)
      assert.equal(await page.locator('#pin-window').getAttribute('aria-pressed'), 'true')
      assert.equal(await page.locator('#pin-window').getAttribute('title'), '取消置顶')
      if (platform === 'mac') {
        const centers = await page.locator('.detached-controls button').evaluateAll(buttons => buttons.map(button => {
          const rect = button.getBoundingClientRect(); return rect.y + rect.height / 2
        }))
        assert.ok(centers.every(center => center === centers[0]), 'pin and macOS window controls share a visual center')
      }
      if (process.env.ENEST_DETACHED_UI_SCREENSHOT_DIR) await page.screenshot({ path: join(process.env.ENEST_DETACHED_UI_SCREENSHOT_DIR, `enest-detached-ui-${platform}.png`) })
    }
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(360, 240))
    const geometry = await page.evaluate(() => ({ width: innerWidth,
      buttons: [...document.querySelectorAll('header button')].filter(button => !button.hidden).map(button => ({
        id: button.id, x: button.getBoundingClientRect().x, right: button.getBoundingClientRect().right
      }))
    }))
    for (const button of geometry.buttons) assert.ok(button.x >= 0 && button.right <= geometry.width, JSON.stringify(button))
    if (process.env.ENEST_DETACHED_UI_SCREENSHOT_DIR) await page.screenshot({ path: join(process.env.ENEST_DETACHED_UI_SCREENSHOT_DIR, 'enest-detached-ui-compact.png') })
    await page.locator('#activate').click()
    assert.deepEqual(await page.evaluate(() => window.fixtureCommands.map(command => command.action)), ['toggle-always-on-top', 'activate'])
  } finally {
    if (app) await app.close().catch(() => app.process().kill('SIGKILL'))
    await rm(directory, { recursive: true, force: true })
  }
})
