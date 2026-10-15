import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import ts from 'typescript'

const source = ts.transpileModule(readFileSync(new URL('./useFpsGuard.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText

function eventTarget() {
  const listeners = new Map()
  return {
    listeners,
    addEventListener(type, callback) {
      if (!listeners.has(type)) listeners.set(type, new Set())
      listeners.get(type).add(callback)
    },
    removeEventListener(type, callback) { listeners.get(type)?.delete(callback) },
    dispatch(type) { for (const callback of listeners.get(type) ?? []) callback() },
    get count() { return [...listeners.values()].reduce((sum, entries) => sum + entries.size, 0) },
  }
}

function fixture({ level = 'high', reduced = false, focused = true, hidden = false, enabled = true } = {}) {
  const pending = new Map()
  const writes = []
  const notices = []
  const document = { ...eventTarget(), hidden, hasFocus: () => focused }
  const window = eventTarget()
  let nextId = 0
  let cleanup
  let dependencies
  const animationStore = selector => selector({ level })
  animationStore.getState = () => ({ setLevel: async value => { writes.push(value) } })
  const imports = {
    react: { useEffect: (setup, deps) => { cleanup = setup(); dependencies = deps } },
    '@renderer/hooks/useAnimationLevel': { useAnimationLevelStore: animationStore, useReducedMotion: () => reduced },
    '@renderer/services/notifyService': { notify: { info: (...args) => notices.push(args) } },
  }
  const module = { exports: {} }
  new Function('require', 'module', 'exports', 'document', 'window', 'requestAnimationFrame', 'cancelAnimationFrame', source)(
    name => {
      if (!(name in imports)) throw new Error(`unexpected import ${name}`)
      return imports[name]
    }, module, module.exports, document, window,
    callback => { const id = ++nextId; pending.set(id, callback); return id },
    id => pending.delete(id),
  )
  const mount = () => module.exports.useFpsGuard(enabled)
  mount()
  return {
    pending, writes, notices, document, window,
    get dependencies() { return dependencies },
    tick(time) {
      const current = [...pending.entries()]
      pending.clear()
      for (const [, callback] of current) callback(time)
    },
    focus(value) { focused = value; window.dispatch(value ? 'focus' : 'blur') },
    hide(value) { document.hidden = value; document.dispatch('visibilitychange') },
    reduce(value) { cleanup?.(); reduced = value; mount() },
    dispose() { cleanup?.() },
    listenerCount() { return [...document.listeners.values(), ...window.listeners.values()].reduce((sum, entries) => sum + entries.size, 0) },
  }
}

test('FPS sampling starts only for visible, focused, high animation without reduced motion', () => {
  for (const options of [
    { level: 'low' }, { level: 'medium' }, { reduced: true }, { focused: false }, { hidden: true }, { enabled: false },
  ]) {
    const f = fixture(options)
    assert.equal(f.pending.size, 0, JSON.stringify(options))
    f.dispose()
    assert.equal(f.listenerCount(), 0)
  }
  const active = fixture()
  assert.equal(active.pending.size, 1)
  active.dispose()
  assert.equal(active.pending.size, 0)
  assert.equal(active.listenerCount(), 0)
})

test('blur and visibility stop RAF immediately and restoration never creates parallel samplers', () => {
  const f = fixture()
  f.tick(0)
  f.focus(false)
  assert.equal(f.pending.size, 0)
  f.hide(true)
  f.focus(true)
  assert.equal(f.pending.size, 0, 'focus cannot resume a hidden window')
  f.hide(false)
  assert.equal(f.pending.size, 1)
  f.focus(true)
  f.hide(false)
  assert.equal(f.pending.size, 1)
  f.focus(false)
  f.hide(false)
  assert.equal(f.pending.size, 0, 'visibility cannot resume an unfocused window')
  f.focus(true)
  assert.equal(f.pending.size, 1)
  f.dispose()
  f.focus(true)
  f.hide(false)
  assert.equal(f.pending.size, 0)
  assert.equal(f.listenerCount(), 0)
})

test('idle time is excluded from the FPS window and actual slow frames degrade once', () => {
  const f = fixture()
  for (let time = 0; time < 4000; time += 50) f.tick(time)
  assert.deepEqual(f.writes, [])
  f.focus(false)
  f.focus(true)
  // An hour away must not turn four old low-FPS buckets into an immediate downgrade.
  f.tick(3_600_000)
  for (let time = 3_600_050; time < 3_604_900; time += 50) f.tick(time)
  assert.deepEqual(f.writes, [])
  for (let time = 3_604_900; time <= 3_606_000; time += 50) f.tick(time)
  assert.deepEqual(f.writes, ['medium'])
  assert.equal(f.notices.length, 1)
  assert.equal(f.pending.size, 0)
  f.hide(true)
  f.hide(false)
  f.focus(false)
  f.focus(true)
  assert.equal(f.pending.size, 0, 'an already degraded session cannot be restarted by browser events')
  f.dispose()
  assert.equal(f.listenerCount(), 0)
})

test('live reduced-motion changes cancel and release the sampler, then permit fresh sampling', () => {
  const f = fixture()
  f.tick(1000)
  f.reduce(true)
  assert.equal(f.pending.size, 0)
  assert.equal(f.listenerCount(), 0)
  assert.deepEqual(f.dependencies, ['high', true, true])
  f.reduce(false)
  assert.equal(f.pending.size, 1)
  assert.equal(f.listenerCount(), 3)
  assert.deepEqual(f.writes, [])
  f.dispose()
})
