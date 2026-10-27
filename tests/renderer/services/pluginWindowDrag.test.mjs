import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

function fixture({ deferred = false, rejected = false, resolveSource } = {}) {
  class Surface {
    listeners = new Map()
    classes = new Set()
    classList = { add: value => this.classes.add(value), remove: value => this.classes.delete(value) }
    addEventListener(name, fn) { const list = this.listeners.get(name) ?? []; list.push(fn); this.listeners.set(name, list) }
    removeEventListener(name, fn) { this.listeners.set(name, (this.listeners.get(name) ?? []).filter(item => item !== fn)) }
    dispatch(name, fields = {}) {
      const event = { target: this, pointerId: 1, pointerType: 'mouse', button: 0, isPrimary: true, clientX: 0, clientY: 0,
        prevented: false, stopped: false, preventDefault() { this.prevented = true }, stopImmediatePropagation() { this.stopped = true }, ...fields }
      for (const fn of this.listeners.get(name) ?? []) { fn(event); if (event.stopped) break }
      return event
    }
    setPointerCapture(id) { this.capture = id }
    hasPointerCapture(id) { return this.capture === id }
    releasePointerCapture(id) { this.capture = null; document.dispatch('lostpointercapture', { pointerId: id }) }
  }
  const root = new Surface(), document = new Surface(), window = new Surface()
  document.documentElement = new Surface()
  let resolveBegin
  const calls = [], frames = new Map(), dragListeners = new Set()
  const api = {
    armDrag(pluginId) { calls.push(['arm', pluginId]) },
    beginDrag(pluginId) { calls.push(['begin', pluginId]); return deferred ? new Promise(resolve => { resolveBegin = resolve }) : Promise.resolve(rejected ? null : { token: 'session-1' }) },
    updateDrag(token) { calls.push(['update', token]) },
    endDrag(token, cancel) { calls.push(['end', token, cancel]); return Promise.resolve() },
    onDrag(listener) { dragListeners.add(listener); return () => dragListeners.delete(listener) }
  }
  window.enestWindows = api
  const module = { exports: {} }
  const source = readFileSync(new URL('../../../src/renderer/services/pluginWindowDrag.ts', import.meta.url), 'utf8')
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  let nextFrame = 0
  vm.runInNewContext(compiled, { module, exports: module.exports, Element: Surface, window, document,
    requestAnimationFrame: fn => { frames.set(++nextFrame, fn); return nextFrame }, cancelAnimationFrame: id => frames.delete(id),
    require: id => id === 'gsap' ? { default: {} } : id === '@renderer/gsap/marketMotion' ? {} : (() => { throw new Error(id) })()
  })
  const dispose = module.exports.bindPluginDragSource(root, resolveSource ?? (() => ({ element: root, pluginId: 'plugin-a' })))
  return { Surface, root, document, window, calls, frames, dragListeners, dispose,
    move: x => document.dispatch('pointermove', { target: root, clientX: x }),
    feedback: event => { for (const listener of dragListeners) listener(event) },
    releaseBegin: () => resolveBegin({ token: 'session-1' }),
    flush: () => { const pending = [...frames.values()]; frames.clear(); pending.forEach(fn => fn()) } }
}

test('clicks below the threshold protect Quick and release the lease without starting a native session', async () => {
  const f = fixture()
  f.root.dispatch('pointerdown'); f.move(7)
  assert.deepEqual(f.calls, [['arm', 'plugin-a']])
  f.document.dispatch('pointerup')
  assert.deepEqual(f.calls, [['arm', 'plugin-a'], ['arm', null]])
  assert.equal(f.root.dispatch('click').prevented, false)
  assert.equal(f.root.capture, null)
  f.root.dispatch('pointerdown'); f.document.dispatch('pointerup')
  assert.equal(f.root.dispatch('click').prevented, false)
  assert.deepEqual(f.calls.slice(2), [['arm', 'plugin-a'], ['arm', null]], 'consecutive clicks must balance their own lease')
  f.dispose()
})

test('captured movement batches updates per animation frame and drop suppresses only its click', async () => {
  const f = fixture()
  f.root.dispatch('pointerdown'); f.move(8)
  await Promise.resolve()
  for (let i = 9; i < 109; i++) f.move(i)
  assert.equal(f.frames.size, 1)
  f.flush()
  assert.equal(f.calls.filter(call => call[0] === 'update').length, 2, 'one initial update and one coalesced frame')
  f.document.dispatch('pointerup')
  assert.deepEqual(f.calls.at(-1), ['end', 'session-1', false])
  assert.equal(f.calls.filter(call => call[0] === 'end').length, 1, 'releasePointerCapture must not cancel an already committed session')
  assert.equal(f.root.dispatch('click').prevented, true)
  f.root.dispatch('pointerdown'); f.document.dispatch('pointerup')
  assert.equal(f.root.dispatch('click').prevented, false)
  f.dispose()
})

test('mouse-up before asynchronous begin completes commits exactly once', async () => {
  const f = fixture({ deferred: true })
  f.root.dispatch('pointerdown'); f.move(16)
  f.document.dispatch('pointerup')
  f.releaseBegin(); await Promise.resolve()
  assert.deepEqual(f.calls, [['arm', 'plugin-a'], ['begin', 'plugin-a'], ['arm', null], ['end', 'session-1', false]])
  f.dispose()
})

test('Escape and unmount before asynchronous begin completes cancel rather than detach', async () => {
  for (const reason of ['Escape', 'dispose', 'pointercancel', 'lostpointercapture']) {
    const f = fixture({ deferred: true })
    f.root.dispatch('pointerdown'); f.move(16)
    if (reason === 'Escape') assert.equal(f.document.dispatch('keydown', { key: 'Escape' }).prevented, true)
    else if (reason === 'dispose') f.dispose()
    else f.document.dispatch(reason)
    f.releaseBegin(); await Promise.resolve()
    assert.deepEqual(f.calls, [['arm', 'plugin-a'], ['begin', 'plugin-a'], ['arm', null], ['end', 'session-1', true]], reason)
    assert.equal(f.root.capture, null)
    assert.equal(f.document.documentElement.classes.has('plugin-dragging'), false)
    f.dispose()
    assert.equal([...f.document.listeners.values()].flat().length, 0)
  }
})

test('unmount before the threshold and a rejected begin both release the provisional lease', async () => {
  const pending = fixture()
  pending.root.dispatch('pointerdown'); pending.dispose()
  assert.deepEqual(pending.calls, [['arm', 'plugin-a'], ['arm', null]])
  const rejected = fixture({ rejected: true })
  rejected.root.dispatch('pointerdown'); rejected.move(12)
  await Promise.resolve()
  assert.deepEqual(rejected.calls, [['arm', 'plugin-a'], ['begin', 'plugin-a'], ['arm', null]])
  assert.equal(rejected.root.capture, null)
  rejected.dispose()
})

test('native cancellation releases capture, visual state and pending frames without echoing an end request', async () => {
  const f = fixture()
  f.root.dispatch('pointerdown'); f.move(16)
  await Promise.resolve()
  f.move(20)
  assert.equal(f.frames.size, 1)
  f.feedback({ active: false, pluginId: 'plugin-a', token: 'session-1' })
  assert.equal(f.root.capture, null)
  assert.equal(f.root.classes.has('plugin-drag-source'), false)
  assert.equal(f.document.documentElement.classes.has('plugin-dragging'), false)
  assert.equal(f.frames.size, 0)
  assert.deepEqual(f.calls.at(-1), ['arm', null])
  f.document.dispatch('pointerup'); f.flush()
  assert.equal(f.calls.filter(call => call[0] === 'end').length, 0, 'native already ended this session')
  f.dispose()
  assert.equal(f.dragListeners.size, 0, 'source must unsubscribe from the native event stream')
})

test('inactive feedback arriving before begin resolves cancels only the matching token without updating it', async () => {
  const f = fixture({ deferred: true })
  f.root.dispatch('pointerdown'); f.move(16)
  f.feedback({ active: false, pluginId: 'plugin-a', token: 'session-1' })
  f.releaseBegin(); await Promise.resolve()
  assert.equal(f.root.capture, null)
  assert.equal(f.root.classes.has('plugin-drag-source'), false)
  assert.equal(f.document.documentElement.classes.has('plugin-dragging'), false)
  assert.deepEqual(f.calls, [['arm', 'plugin-a'], ['begin', 'plugin-a'], ['arm', null]])
  f.document.dispatch('pointerup')
  assert.equal(f.calls.filter(call => call[0] === 'end').length, 0)
  f.dispose()
})

test('final feedback after pointer-up never changes the already submitted drop or sends a duplicate end', async () => {
  const f = fixture()
  f.root.dispatch('pointerdown'); f.move(16)
  await Promise.resolve()
  f.document.dispatch('pointerup')
  const committed = [...f.calls]
  f.feedback({ active: false, pluginId: 'plugin-a', token: 'session-1' })
  assert.deepEqual(f.calls, committed)
  assert.deepEqual(f.calls.at(-1), ['end', 'session-1', false])
  f.dispose()
})

test('another plugin or an old session cannot cancel a pending or active source gesture', async () => {
  const f = fixture({ deferred: true })
  f.root.dispatch('pointerdown'); f.move(16)
  f.feedback({ active: false, pluginId: 'plugin-b', token: 'session-1' })
  f.feedback({ active: false, pluginId: 'plugin-a', token: 'old-session' })
  f.feedback({ active: false, pluginId: 'plugin-a' })
  f.releaseBegin(); await Promise.resolve()
  assert.equal(f.root.capture, 1)
  assert.deepEqual(f.calls.at(-1), ['update', 'session-1'])
  f.feedback({ active: false, pluginId: 'plugin-b', token: 'session-1' })
  f.feedback({ active: false, pluginId: 'plugin-a', token: 'old-session' })
  assert.equal(f.root.capture, 1)
  assert.equal(f.root.classes.has('plugin-drag-source'), true)
  f.document.dispatch('pointerup')
  assert.deepEqual(f.calls.at(-1), ['end', 'session-1', false])
  f.dispose()
})

test('inactive feedback during a below-threshold click does not interfere with activation', () => {
  const f = fixture()
  f.root.dispatch('pointerdown'); f.move(7)
  f.feedback({ active: false, pluginId: 'plugin-a', token: 'old-session' })
  assert.equal(f.root.capture, 1)
  f.document.dispatch('pointerup')
  assert.equal(f.root.dispatch('click').prevented, false)
  assert.deepEqual(f.calls, [['arm', 'plugin-a'], ['arm', null]])
  f.dispose()
})

test('Orb captures its activation button so a below-threshold pointer click still activates the tab', () => {
  // Exercise the actual resolver used by the standalone Orb entry without booting its DOM shell.
  const text = readFileSync(new URL('../../../src/renderer/orb-overlay.ts', import.meta.url), 'utf8')
  const source = ts.createSourceFile('orb-overlay.ts', text, ts.ScriptTarget.ES2022, true)
  let resolver
  function visit(node) {
    if (ts.isCallExpression(node) && node.expression.getText(source) === 'bindPluginDragSource') resolver = node.arguments[1].getText(source)
    ts.forEachChild(node, visit)
  }
  visit(source)
  assert.ok(resolver, 'Orb must wire the common drag source')
  const module = { exports: {} }
  vm.runInNewContext(ts.transpileModule(`module.exports = ${resolver}`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, { module })
  const f = fixture({ resolveSource: module.exports })
  const item = new f.Surface(), button = new f.Surface(), icon = new f.Surface(), close = new f.Surface()
  item.dataset = { pluginId: 'orb-plugin' }; button.dataset = { activate: 't-orb-plugin' }
  item.querySelector = selector => selector === '[data-activate]' ? button : null
  item.closest = selector => selector === '[data-plugin-id]' ? item : null
  button.closest = selector => selector === '[data-plugin-id]' ? item : selector === '[data-activate]' ? button : null
  icon.closest = button.closest
  close.closest = selector => selector === '[data-close]' ? close : item
  let activated = null
  f.root.addEventListener('click', event => { activated = event.target.closest('[data-activate]')?.dataset.activate ?? null })
  f.root.dispatch('pointerdown', { target: icon })
  const captured = [item, button].find(element => element.capture === 1)
  assert.equal(captured, button, 'native pointerup/click retargets to the captured element, which must remain actionable')
  f.document.dispatch('pointerup', { target: captured })
  assert.equal(f.root.dispatch('click', { target: captured }).prevented, false)
  assert.equal(activated, 't-orb-plugin')
  assert.deepEqual(f.calls, [['arm', 'orb-plugin'], ['arm', null]])
  f.root.dispatch('pointerdown', { target: close })
  assert.equal(f.calls.length, 2, 'the close button must never arm a tab drag')
  f.dispose()
})
