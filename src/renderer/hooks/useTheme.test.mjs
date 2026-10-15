import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import ts from 'typescript'

const color = value => ({ type: 'color', value, opacity: 0.8, fit: 'cover' })
const pack = value => ({ id: 'com.test.theme', source: 'com.test.owner', name: 'Theme', mode: 'light', tokens: {}, background: color(value) })
const javascript = ts.transpileModule(readFileSync(new URL('./useTheme.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText
function loadShared(path, imports = {}) {
  const source = ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  const module = { exports: {} }
  new Function('require', 'module', 'exports', source)(name => imports[name], module, module.exports)
  return module.exports
}
const backgroundEffects = loadShared('../../shared/backgroundEffects.ts', {
  '@shared/pluginContract': loadShared('../../shared/pluginContract.ts'),
})
function fixture(initial = {}) {
  let persisted = { mode: 'light', overrides: {}, packs: [pack('#123456')], ...structuredClone(initial) }
  const writes = []
  const notifications = []
  const classes = new Set()
  const create = initialize => {
    let state
    const get = () => state
    const set = update => { state = { ...state, ...(typeof update === 'function' ? update(state) : update) } }
    state = initialize(set, get)
    return { getState: get, setState: set }
  }
  const api = {
    getTheme: async () => structuredClone(persisted),
    setTheme: async (mode, overrides, extra) => {
      writes.push(structuredClone({ mode, overrides, ...extra }))
      persisted = { ...persisted, mode, overrides: { ...persisted.overrides, [mode]: overrides }, ...structuredClone(extra) }
    }
  }
  const stubs = {
    zustand: { create },
    '@shared/theme/presets': { THEME_TOKEN_PRESETS: { light: {}, dark: {} }, resolveThemePalette: (_mode, overrides, tokens) => ({ ...tokens, ...overrides }) },
    '@shared/backgroundEffects': backgroundEffects,
    '@renderer/services/shellApi': { shellApi: api },
    '@renderer/services/notifyService': { notify: { error: message => notifications.push(message) } },
    '@renderer/hooks/useToast': { toastStore: { getState: () => ({ push() {} }) } }
  }
  const module = { exports: {} }
  const root = { dataset: {}, style: { setProperty() {}, removeProperty() {} }, classList: { toggle: (name, active) => active ? classes.add(name) : classes.delete(name) } }
  new Function('require', 'module', 'exports', 'window', 'document', javascript)(name => stubs[name], module, module.exports, {}, { documentElement: root })
  return { store: module.exports.useThemeStore, api, writes, notifications, classes, data: () => persisted, setData: patch => { persisted = { ...persisted, ...structuredClone(patch) } } }
}

function deferred() {
  let resolve, reject
  const promise = new Promise((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

const settle = () => new Promise(resolve => setImmediate(resolve))

test('background preview stays immediate, ignores old broadcasts and persists only the final value', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = fixture({ background: color('#123456') })
  await f.store.getState().hydrate()
  for (let index = 0; index < 100; index++) {
    f.store.getState().previewBackground({ ...color('#654321'), opacity: index / 100 })
    t.mock.timers.tick(8)
  }
  assert.equal(f.store.getState().background.opacity, 0.99)
  assert.equal(f.writes.length, 0)
  await f.store.getState().refresh()
  assert.equal(f.store.getState().background.opacity, 0.99, 'an old theme broadcast must not reset the gesture')
  await f.store.getState().flushBackgroundPreview()
  assert.equal(f.writes.length, 1)
  assert.equal(f.data().background.opacity, 0.99)
  t.mock.timers.tick(1000)
  await settle()
  assert.equal(f.writes.length, 1, 'ending the gesture cancels the idle write')
})

test('idle previews save, and a later theme action consumes the preview without a stale write', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = fixture()
  await f.store.getState().hydrate()
  f.store.getState().previewBackground(color('#abcdef'))
  t.mock.timers.tick(240)
  await settle()
  assert.equal(f.data().background.value, '#abcdef')
  f.store.getState().previewBackground(color('#654321'))
  await f.store.getState().setMode('dark')
  t.mock.timers.tick(1000)
  await settle()
  assert.equal(f.writes.length, 2)
  assert.equal(f.data().mode, 'dark')
  assert.equal(f.data().background.value, '#654321')
  f.store.getState().previewBackground(color('#777777'))
  await f.store.getState().setBackground(null)
  t.mock.timers.tick(1000)
  await settle()
  assert.equal(f.writes.length, 3)
  assert.equal(f.data().background, undefined)
})

test('a slow previous write and refresh cannot overwrite a newer background preview', async () => {
  const f = fixture()
  await f.store.getState().hydrate()
  const gate = deferred(), write = f.api.setTheme
  let calls = 0
  f.api.setTheme = async (...args) => {
    if (++calls === 1) await gate.promise
    await write(...args)
  }
  const older = f.store.getState().setBackground(color('#111111'))
  const refresh = f.store.getState().refresh()
  f.store.getState().previewBackground(color('#888888'))
  gate.resolve()
  await Promise.all([older, refresh])
  assert.equal(f.store.getState().background.value, '#888888')
  await f.store.getState().flushBackgroundPreview()
  assert.equal(f.data().background.value, '#888888')
})

test('preview save errors remain visible and do not poison the next gesture', async () => {
  const f = fixture()
  await f.store.getState().hydrate()
  const write = f.api.setTheme
  f.api.setTheme = async () => { throw new Error('disk unavailable') }
  f.store.getState().previewBackground(color('#123456'))
  await f.store.getState().flushBackgroundPreview()
  assert.equal(f.notifications.length, 1)
  assert.equal(f.store.getState().background.value, '#123456')
  f.api.setTheme = write
  f.store.getState().previewBackground(color('#abcdef'))
  await f.store.getState().flushBackgroundPreview()
  assert.equal(f.data().background.value, '#abcdef')
})

test('pack backgrounds follow the current registry and are removed on disable/uninstall without persisting snapshots', async () => {
  const f = fixture({ packId: 'com.test.theme', backgroundSource: 'pack', background: color('url(https://old.invalid)') })
  await f.store.getState().refresh()
  assert.deepEqual(f.store.getState().background, color('#123456'))
  f.setData({ packs: [pack('#654321')] })
  await f.store.getState().refreshPacks()
  assert.deepEqual(f.store.getState().background, color('#654321'))
  await f.store.getState().setMode('dark')
  f.store.getState().setToken('--accent', '#abc')
  await f.store.getState().resetMode()
  assert.equal(f.writes.length, 3)
  for (const write of f.writes) { assert.equal(write.backgroundSource, 'pack'); assert.equal(write.background, undefined) }
  f.setData({ packs: [] })
  await f.store.getState().refreshPacks()
  assert.equal(f.store.getState().background, null)
  await f.store.getState().refresh()
  assert.equal(f.store.getState().background, null)
})

test('explicit user backgrounds and explicit none survive pack updates, removal and refresh', async () => {
  const f = fixture({ packId: 'com.test.theme', backgroundSource: 'pack' })
  await f.store.getState().refresh()
  const user = { type: 'image', value: '/Users/example/hand-picked.png', opacity: 0.9, fit: 'contain' }
  await f.store.getState().setBackground(user)
  assert.equal(f.writes.at(-1).backgroundSource, 'user')
  f.setData({ packs: [pack('#654321')] })
  await f.store.getState().refreshPacks()
  assert.deepEqual(f.store.getState().background, user)
  f.setData({ packs: [] })
  await f.store.getState().refreshPacks()
  await f.store.getState().refresh()
  assert.deepEqual(f.store.getState().background, user)
  f.setData({ packs: [pack('#654321')] })
  await f.store.getState().setBackground(null)
  await f.store.getState().refresh()
  assert.equal(f.store.getState().background, null)
  assert.equal(f.store.getState().backgroundSource, 'user')
})

test('unmarked legacy snapshots are preserved until an explicit theme/background choice establishes provenance', async () => {
  const legacy = { type: 'image', value: 'https://user-or-old-theme.invalid/image.png', opacity: 0.9, fit: 'cover' }
  const f = fixture({ packId: 'com.test.theme', background: legacy })
  await f.store.getState().refresh()
  assert.deepEqual(f.store.getState().background, legacy)
  assert.equal(f.store.getState().backgroundSource, undefined)
  f.setData({ packs: [pack('#abcabc')] })
  await f.store.getState().refreshPacks()
  await f.store.getState().setMode('dark')
  assert.deepEqual(f.writes.at(-1).background, legacy)
  assert.equal(f.writes.at(-1).backgroundSource, undefined)
  await f.store.getState().applyPack('com.test.theme')
  assert.deepEqual(f.store.getState().background, color('#abcabc'))
  assert.equal(f.writes.at(-1).backgroundSource, 'pack')
  assert.equal(f.writes.at(-1).background, undefined)
  await f.store.getState().applyPack(null)
  assert.equal(f.store.getState().background, null)
})

test('effect hydration defaults to tunnel, preserves explicit off and refreshes across windows without writes', async () => {
  const f = fixture()
  await f.store.getState().hydrate()
  assert.equal(f.store.getState().backgroundEffect, 'tunnel')
  f.setData({ backgroundEffect: 'none' })
  await f.store.getState().refresh()
  assert.equal(f.store.getState().backgroundEffect, 'none')
  f.setData({ backgroundEffect: 'aurora' })
  await f.store.getState().refresh()
  assert.equal(f.store.getState().backgroundEffect, 'aurora')
  assert.equal(f.writes.length, 0)
})

test('all theme and media mutations preserve the selected effect', async () => {
  const f = fixture({ backgroundEffect: 'orbit' })
  await f.store.getState().hydrate()
  await f.store.getState().setMode('dark')
  f.store.getState().setToken('--accent', '#aabbcc')
  await f.store.getState().resetMode()
  await f.store.getState().applyPack('com.test.theme')
  await f.store.getState().setBackground(color('#334455'))
  await f.store.getState().applyPack(null)
  assert.equal(f.writes.length, 6)
  assert.ok(f.writes.every(write => write.backgroundEffect === 'orbit'))
  assert.equal(f.store.getState().backgroundEffect, 'orbit')
})

test('clearing a custom background keeps the media class while an effect is active', async () => {
  const f = fixture({ backgroundEffect: 'tunnel' })
  await f.store.getState().hydrate()
  await f.store.getState().setBackground(null)
  assert.ok(f.classes.has('has-bg-media'))
  await f.store.getState().setBackgroundEffect('none')
  await f.store.getState().setBackground(null)
  assert.equal(f.classes.has('has-bg-media'), false)
  await f.store.getState().setBackground(color('#123456'))
  assert.ok(f.classes.has('has-bg-media'))
})

test('unavailable plugin effect IDs survive registry updates and later writes', async () => {
  const id = 'plugin:com.test.owner:com.test.theme:glow'
  const f = fixture({ backgroundEffect: id })
  await f.store.getState().hydrate()
  f.setData({ packs: [] })
  await f.store.getState().refreshPacks()
  assert.equal(f.store.getState().backgroundEffect, id)
  await f.store.getState().setMode('dark')
  await f.store.getState().refresh()
  assert.equal(f.store.getState().backgroundEffect, id)
  assert.equal(f.data().backgroundEffect, id)
})

test('rapid effect changes are immediate and serial writes plus refresh cannot restore an older choice', async () => {
  const f = fixture()
  await f.store.getState().hydrate()
  const first = deferred(), second = deferred(), started = []
  const write = f.api.setTheme
  f.api.setTheme = async (...args) => {
    started.push(args[2].backgroundEffect)
    await (started.length === 1 ? first : second).promise
    await write(...args)
  }
  const a = f.store.getState().setBackgroundEffect('fold')
  const b = f.store.getState().setBackgroundEffect('ripple')
  assert.equal(f.store.getState().backgroundEffect, 'ripple')
  const refreshing = f.store.getState().refresh()
  await settle()
  assert.deepEqual(started, ['fold'])
  first.resolve()
  await a
  await settle()
  assert.deepEqual(started, ['fold', 'ripple'])
  assert.equal(f.store.getState().backgroundEffect, 'ripple')
  second.resolve()
  await Promise.all([b, refreshing])
  assert.equal(f.store.getState().backgroundEffect, 'ripple')
  assert.equal(f.data().backgroundEffect, 'ripple')
})

test('an older failed effect save cannot roll back a more recent choice or poison the write queue', async () => {
  const f = fixture()
  await f.store.getState().hydrate()
  const gate = deferred(), write = f.api.setTheme
  let calls = 0
  f.api.setTheme = async (...args) => {
    if (++calls === 1) await gate.promise
    await write(...args)
  }
  const older = f.store.getState().setBackgroundEffect('fold')
  const rejected = assert.rejects(older, /disk unavailable/)
  const newer = f.store.getState().setBackgroundEffect('aurora')
  gate.reject(new Error('disk unavailable'))
  await Promise.all([rejected, newer])
  assert.equal(f.store.getState().backgroundEffect, 'aurora')
  assert.equal(f.data().backgroundEffect, 'aurora')
})

test('the latest failed effect choice rolls back to the last saved choice and can be retried', async () => {
  const f = fixture({ backgroundEffect: 'orbit' })
  await f.store.getState().hydrate()
  const write = f.api.setTheme
  f.api.setTheme = async () => { throw new Error('disk unavailable') }
  await assert.rejects(f.store.getState().setBackgroundEffect('none'), /disk unavailable/)
  assert.equal(f.store.getState().backgroundEffect, 'orbit')
  f.api.setTheme = write
  await f.store.getState().setBackgroundEffect('none')
  assert.equal(f.store.getState().backgroundEffect, 'none')
  assert.equal(f.data().backgroundEffect, 'none')
})

test('an effect save failure cannot undo a later theme edit that persists the same effect', async () => {
  const f = fixture()
  await f.store.getState().hydrate()
  const gate = deferred(), write = f.api.setTheme
  let calls = 0
  f.api.setTheme = async (...args) => {
    if (++calls === 1) await gate.promise
    await write(...args)
  }
  const effect = f.store.getState().setBackgroundEffect('aurora')
  const rejected = assert.rejects(effect, /disk unavailable/)
  const mode = f.store.getState().setMode('dark')
  gate.reject(new Error('disk unavailable'))
  await Promise.all([rejected, mode])
  assert.equal(f.store.getState().backgroundEffect, 'aurora')
  assert.equal(f.data().backgroundEffect, 'aurora')
  assert.equal(f.data().mode, 'dark')
})

test('a refresh already reading older settings cannot override a subsequent effect choice', async () => {
  const f = fixture({ backgroundEffect: 'orbit' })
  await f.store.getState().hydrate()
  const reading = deferred()
  f.api.getTheme = () => reading.promise
  const refreshing = f.store.getState().refresh()
  await settle()
  await f.store.getState().setBackgroundEffect('aurora')
  reading.resolve({ mode: 'light', overrides: {}, backgroundEffect: 'orbit', packs: [] })
  await refreshing
  assert.equal(f.store.getState().backgroundEffect, 'aurora')
})

test('a late appearance refresh cannot restore a plugin removed by a newer registry refresh', async () => {
  const f = fixture({ backgroundEffect: 'plugin:com.test.owner:com.test.theme:glow', packId: 'com.test.theme', backgroundSource: 'pack' })
  await f.store.getState().hydrate()
  const reading = deferred(), getTheme = f.api.getTheme
  f.api.getTheme = () => reading.promise
  const refreshing = f.store.getState().refresh()
  await settle()
  f.api.getTheme = getTheme
  f.setData({ packs: [] })
  await f.store.getState().refreshPacks()
  reading.resolve({ mode: 'light', overrides: {}, packId: 'com.test.theme', backgroundSource: 'pack', packs: [pack('#123456')], backgroundEffect: 'plugin:com.test.owner:com.test.theme:glow' })
  await refreshing
  assert.deepEqual(f.store.getState().packs, [])
  assert.equal(f.store.getState().background, null)
  assert.equal(f.store.getState().backgroundEffect, 'plugin:com.test.owner:com.test.theme:glow')
})
