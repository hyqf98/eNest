import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import ts from 'typescript'

const color = value => ({ type: 'color', value, opacity: 0.8, fit: 'cover' })
const pack = value => ({ id: 'com.test.theme', source: 'com.test.owner', name: 'Theme', mode: 'light', tokens: {}, background: color(value) })
const javascript = ts.transpileModule(readFileSync(new URL('./useTheme.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText
function fixture(initial = {}) {
  let persisted = { mode: 'light', overrides: {}, packs: [pack('#123456')], ...structuredClone(initial) }
  const writes = []
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
    '@renderer/services/shellApi': { shellApi: api },
    '@renderer/hooks/useToast': { toastStore: { getState: () => ({ push() {} }) } }
  }
  const module = { exports: {} }
  const root = { dataset: {}, style: { setProperty() {}, removeProperty() {} }, classList: { toggle() {} } }
  new Function('require', 'module', 'exports', 'window', 'document', javascript)(name => stubs[name], module, module.exports, {}, { documentElement: root })
  return { store: module.exports.useThemeStore, writes, data: () => persisted, setData: patch => { persisted = { ...persisted, ...structuredClone(patch) } } }
}

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
