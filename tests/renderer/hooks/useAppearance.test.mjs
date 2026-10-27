import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import ts from 'typescript'

const source = ts.transpileModule(readFileSync(new URL('../../../src/renderer/hooks/useAppearance.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText

function deferred() {
  let resolve, reject
  const promise = new Promise((accept, refuse) => { resolve = accept; reject = refuse })
  return { promise, resolve, reject }
}

function fixture() {
  const reads = [], applied = []
  const identity = { source: 'enest.builtin', id: 'default' }
  const snapshot = revision => ({ appearance: { revision, theme: identity }, profile: { identity }, packs: [], customFonts: [] })
  const imports = {
    zustand: { create: init => {
      let state
      const getState = () => state
      const setState = patch => { state = { ...state, ...patch } }
      state = init(setState, getState)
      return { getState, setState }
    } },
    '@renderer/services/shellApi': { shellApi: { getAppearance: () => { const read = deferred(); reads.push(read); return read.promise } } },
    '@renderer/services/notifyService': { notify: { error() {} } },
    '@renderer/services/appearanceDom': { applyAppearanceToDom: value => applied.push(value) },
    '@shared/theme/appearance': {
      migrateAppearanceSettings: () => ({ active: identity, profiles: { default: snapshot(0).profile } }),
      resolveAppearance: () => snapshot(0).appearance,
      themeProfileKey: () => 'default',
    },
    '@shared/theme/builtinThemes': { BUILTIN_THEME_PACKS: [identity] },
  }
  const module = { exports: {} }
  new Function('require', 'module', 'exports', source)(id => {
    assert.ok(imports[id], id)
    return imports[id]
  }, module, module.exports)
  return { store: module.exports.useAppearanceStore, reads, applied, snapshot }
}

test('initial appearance subscribers share one hydration request and reuse the confirmed snapshot', async () => {
  const f = fixture()
  const first = f.store.getState().hydrate()
  assert.equal(f.store.getState().hydrate(), first)
  assert.equal(f.reads.length, 1)
  assert.equal(f.store.getState().hydrated, false)
  f.reads[0].resolve(f.snapshot(1))
  await first
  await f.store.getState().hydrate()
  assert.equal(f.reads.length, 1)
  assert.equal(f.applied.length, 1)
})

test('failed hydration clears the flight and remains explicitly retryable', async () => {
  const f = fixture()
  const first = f.store.getState().hydrate()
  f.reads[0].reject(new Error('read failed'))
  await assert.rejects(first, /read failed/)
  assert.equal(f.store.getState().hydrated, false)
  const retry = f.store.getState().hydrate()
  assert.equal(f.reads.length, 2)
  f.reads[1].resolve(f.snapshot(2))
  await retry
  assert.equal(f.store.getState().appearance.revision, 2)
})

test('explicit event refresh is not swallowed by startup deduplication or stale responses', async () => {
  const f = fixture()
  const initial = f.store.getState().hydrate()
  const refreshed = f.store.getState().refresh()
  assert.equal(f.reads.length, 2)
  f.reads[1].resolve(f.snapshot(4))
  await refreshed
  f.reads[0].resolve(f.snapshot(1))
  await initial
  assert.equal(f.store.getState().appearance.revision, 4)
  assert.deepEqual(f.applied.map(value => value.revision), [4])
  const next = f.store.getState().refresh()
  assert.equal(f.reads.length, 3)
  f.reads[2].resolve(f.snapshot(5))
  await next
  assert.equal(f.store.getState().appearance.revision, 5)
})
