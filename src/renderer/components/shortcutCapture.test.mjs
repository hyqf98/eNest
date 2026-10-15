import assert from 'node:assert/strict'
import test from 'node:test'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'
import ts from 'typescript'

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const settle = () => new Promise(resolve => setImmediate(resolve))
function fixture(overrides = {}) {
  const module = { exports: {} }, timers = new Map(), listeners = new Map(), calls = [], values = [], phases = [], errors = []
  let timerId = 0
  const target = {
    addEventListener: (name, handler) => { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(handler) },
    removeEventListener: (name, handler) => listeners.get(name)?.delete(handler),
    dispatch(name, patch = {}) {
      const event = { code: 'KeyK', key: 'k', ctrlKey: true, altKey: false, shiftKey: false, metaKey: false,
        preventDefault() {}, stopPropagation() {}, ...patch }
      for (const handler of [...(listeners.get(name) ?? [])]) handler(event)
    }
  }
  const source = ts.transpileModule(readFileSync(new URL('./shortcutCapture.ts', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  vm.runInNewContext(source, { module, exports: module.exports,
    setTimeout: (callback, delay) => { const id = ++timerId; timers.set(id, { callback, delay }); return id },
    clearTimeout: id => timers.delete(id) })
  const options = { target, platform: 'darwin', begin: async () => { calls.push('begin'); return { token: 'token' } },
    end: async token => { calls.push(['end', token]) }, onPhase: value => phases.push(value),
    onValue: value => values.push(value), onError: error => errors.push(error), ...overrides }
  return { Capture: module.exports.ShortcutCapture, capture: new module.exports.ShortcutCapture(options), options,
    model: module.exports, target, listeners, timers, calls, values, phases, errors }
}

test('valid key release restores host shortcuts before handing the value to a save handler', async () => {
  const release = deferred()
  const f = fixture({ end: () => release.promise })
  await f.capture.start()
  f.target.dispatch('keydown')
  f.target.dispatch('keydown', { repeat: true })
  assert.equal(f.values.length, 0)
  assert.equal(f.phases.at(-1), 'recording', 'holding an existing shortcut must not restore global key-repeat')
  f.target.dispatch('keyup', { code: 'ControlLeft' })
  assert.equal(f.phases.at(-1), 'recording')
  f.target.dispatch('keyup')
  assert.equal(f.phases.at(-1), 'restoring')
  assert.equal(f.values.length, 0)
  release.resolve()
  await settle()
  assert.deepEqual(f.values, ['Control+K'])
  assert.equal(f.timers.size, 0)
})

test('Escape, blur and 30 second timeout all restore the host without changing the draft', async () => {
  for (const trigger of ['escape', 'blur', 'timeout']) {
    const f = fixture(); await f.capture.start()
    if (trigger === 'escape') f.target.dispatch('keydown', { key: 'Escape' })
    else if (trigger === 'blur') f.target.dispatch('blur')
    else { const timer = [...f.timers.values()][0]; assert.equal(timer.delay, 30_000); timer.callback() }
    await settle()
    assert.deepEqual(f.calls, ['begin', ['end', 'token']], trigger)
    assert.deepEqual(f.values, [])
    assert.equal([...f.listeners.values()].reduce((sum, set) => sum + set.size, 0), 0)
  }
})

test('unmount or blur before begin resolves still releases the late token exactly once', async () => {
  for (const action of ['dispose', 'blur']) {
    const pending = deferred(), f = fixture({ begin: () => pending.promise })
    const starting = f.capture.start()
    if (action === 'dispose') f.capture.dispose(); else f.target.dispatch('blur')
    pending.resolve({ token: 'late-token' })
    await starting
    assert.deepEqual(f.calls, [['end', 'late-token']])
    assert.deepEqual(f.values, [])
    assert.equal([...f.listeners.values()].reduce((sum, set) => sum + set.size, 0), 0)
  }
})

test('only one recorder listens even if the user switches between Quick and plugin recording', async () => {
  const f = fixture(); await f.capture.start()
  const second = new f.Capture({ ...f.options, begin: async () => ({ token: 'second' }) })
  await second.start()
  assert.ok(f.calls.some(call => Array.isArray(call) && call[1] === 'token'))
  assert.equal(f.listeners.get('keydown').size, 1)
  f.target.dispatch('keydown'); f.target.dispatch('keyup'); await settle()
  assert.deepEqual(f.values, ['Control+K'])
  assert.deepEqual(f.calls.at(-1), ['end', 'second'])
})

test('a late restore completion cannot update an unmounted editor', async () => {
  const pending = deferred(), f = fixture({ end: () => pending.promise })
  await f.capture.start(); f.target.dispatch('keydown'); f.target.dispatch('keyup'); f.capture.dispose()
  pending.resolve(); await settle()
  assert.deepEqual(f.values, [])
})

test('capture failures remain visible and never deliver an apparently saved key', async () => {
  const failed = new Error('restore failed'), f = fixture({ end: async () => { throw failed } })
  await f.capture.start(); f.target.dispatch('keydown'); f.target.dispatch('keyup'); await settle()
  assert.equal(f.errors[0], failed)
  assert.deepEqual(f.values, [])
})

test('recording ignores modifier-only, repeat, bare and shift-only keystrokes across platforms', () => {
  const { model } = fixture()
  const base = { code: 'KeyA', key: 'a', ctrlKey: false, altKey: false, shiftKey: false, metaKey: false }
  for (const patch of [{}, { shiftKey: true }, { ctrlKey: true, code: 'ControlLeft' }, { ctrlKey: true, repeat: true }]) {
    assert.equal(model.eventToAccelerator({ ...base, ...patch }, 'darwin'), null)
  }
  assert.equal(model.eventToAccelerator({ ...base, metaKey: true }, 'darwin'), 'Command+A')
  assert.equal(model.eventToAccelerator({ ...base, metaKey: true }, 'win32'), 'Super+A')
})

test('modifier and complete chord previews update on keydown before committing on release', async () => {
  const previews = [], f = fixture({ onPreview: value => previews.push(value) })
  await f.capture.start()
  f.target.dispatch('keydown', { code: 'ControlLeft', key: 'Control' })
  assert.equal(previews.at(-1), 'Control')
  f.target.dispatch('keydown', { code: 'ShiftLeft', key: 'Shift', shiftKey: true })
  assert.equal(previews.at(-1), 'Control+Shift')
  f.target.dispatch('keydown', { shiftKey: true })
  assert.equal(previews.at(-1), 'Control+Shift+K')
  assert.deepEqual(f.values, [], 'preview is never a saved value')
  f.target.dispatch('keyup', { shiftKey: true })
  await settle()
  assert.deepEqual(f.values, ['Control+Shift+K'])
  assert.equal(previews.at(-1), '')
})

test('blur while a key release is restoring cannot bypass the pending restore', async () => {
  const release = deferred(), f = fixture({ end: () => release.promise })
  await f.capture.start()
  f.target.dispatch('keydown'); f.target.dispatch('keyup')
  await f.capture.stop()
  assert.equal(f.phases.at(-1), 'restoring')
  assert.deepEqual(f.values, [])
  release.resolve(); await settle()
  assert.equal(f.phases.at(-1), 'idle')
  assert.deepEqual(f.values, ['Control+K'])
})

test('bare Tab releases capture for keyboard navigation without saving a shortcut', async () => {
  const f = fixture(); await f.capture.start()
  f.target.dispatch('keydown', { code: 'Tab', key: 'Tab', ctrlKey: false })
  await settle()
  assert.deepEqual(f.values, [])
  assert.equal(f.phases.at(-1), 'idle')
})

test('fast typing during capture startup previews immediately and commits only after the late lease is restored', async () => {
  const begin = deferred(), end = deferred(), previews = []
  const f = fixture({ begin: () => begin.promise, end: () => end.promise, onPreview: value => previews.push(value) })
  const starting = f.capture.start()
  f.target.dispatch('keydown', { code: 'ControlLeft', key: 'Control' })
  assert.equal(previews.at(-1), 'Control')
  f.target.dispatch('keydown'); f.target.dispatch('keyup')
  assert.equal(previews.at(-1), 'Control+K')
  assert.deepEqual(f.values, [])
  begin.resolve({ token: 'slow' }); await settle()
  assert.equal(f.phases.at(-1), 'restoring')
  assert.deepEqual(f.values, [])
  end.resolve(); await starting
  assert.deepEqual(f.values, ['Control+K'])
  assert.equal(f.phases.at(-1), 'idle')
})
