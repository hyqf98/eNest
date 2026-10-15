import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import ts from 'typescript'

const javascript = ts.transpileModule(readFileSync(new URL('./useFont.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText

function deferred() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

function fixture() {
  let state
  const writes = [], deletions = new Map(), styles = new Map()
  const create = initialize => {
    const get = () => state
    const set = update => { state = { ...state, ...(typeof update === 'function' ? update(state) : update) } }
    state = initialize(set, get)
    return { getState: get, setState: set }
  }
  const api = {
    deleteCustomFont: file => {
      const pending = deferred()
      deletions.set(file, pending)
      return pending.promise
    },
    readCustomFont: async () => ({ ok: false }),
    setSettings: async patch => { writes.push(structuredClone(patch.general)) }
  }
  const stubs = {
    zustand: { create },
    '@renderer/services/shellApi': { shellApi: api, isMockShell: false },
    '@renderer/hooks/useToast': { toastStore: { getState: () => ({ push() {} }) } },
    '@renderer/i18n': { t: key => key }
  }
  const module = { exports: {} }
  new Function('require', 'module', 'exports', 'document', javascript)(name => {
    if (!(name in stubs)) throw new Error(name)
    return stubs[name]
  }, module, module.exports, {
    documentElement: { style: { setProperty: (key, value) => styles.set(key, value), removeProperty: key => styles.delete(key) } }
  })
  const store = module.exports.useFontStore
  store.setState({
    hydrated: true,
    customFonts: ['a', 'b', 'c'].map(id => ({ id, name: id, family: `Font-${id}`, fileName: `${id}.woff` })),
    customFontId: 'a', fontFamily: '"Font-a", sans-serif', fontFamilyEn: 'Latin'
  })
  const finishDelete = id => deletions.get(`${id}.woff`).resolve({ ok: true })
  return { store, api, writes, styles, finishDelete, exports: module.exports }
}

test('a font selected while another deletion is pending keeps its selection, DOM and persisted family', async () => {
  const f = fixture()
  const deleting = f.store.getState().removeCustomFont('a')
  await f.store.getState().applyCustom('b')
  const selectedFamily = f.store.getState().fontFamily
  f.finishDelete('a')
  await deleting
  assert.equal(f.store.getState().customFontId, 'b')
  assert.equal(f.store.getState().fontFamily, selectedFamily)
  assert.equal(f.styles.get('--font'), `Latin, ${selectedFamily}`)
  assert.equal(Object.assign({}, ...f.writes).fontFamily, selectedFamily)
  assert.deepEqual(f.writes.at(-1).customFonts.map(font => font.id), ['b', 'c'])
})

for (const order of [['a', 'b'], ['b', 'a']]) {
  test(`concurrent deletions completed ${order.join(' then ')} never restore removed entries`, async () => {
    const f = fixture()
    await f.store.getState().applyCustom('c')
    const pending = Object.fromEntries(['a', 'b'].map(id => [id, f.store.getState().removeCustomFont(id)]))
    for (const id of order) { f.finishDelete(id); await pending[id] }
    assert.deepEqual(f.store.getState().customFonts.map(font => font.id), ['c'])
    assert.deepEqual(f.writes.at(-1).customFonts.map(font => font.id), ['c'])
    assert.equal(f.store.getState().customFontId, 'c')
  })
}

test('deleting an inactive font preserves a preset chosen during the delete', async () => {
  const f = fixture()
  const deleting = f.store.getState().removeCustomFont('b')
  const preset = f.exports.FONT_PRESETS_CJK[0]
  await f.store.getState().setCjkPreset(preset.id)
  f.finishDelete('b')
  await deleting
  assert.equal(f.store.getState().cjkPresetId, preset.id)
  assert.equal(f.store.getState().fontFamily, preset.css)
  assert.equal(Object.assign({}, ...f.writes).fontFamily, preset.css)
})

test('deleting the active font resets only its slot and uses the current English font', async () => {
  const f = fixture()
  const deleting = f.store.getState().removeCustomFont('a')
  f.store.setState({ fontFamilyEn: 'Latest Latin' })
  f.finishDelete('a')
  await deleting
  assert.equal(f.store.getState().customFontId, null)
  assert.equal(f.store.getState().fontFamilyEn, 'Latest Latin')
  assert.equal(f.styles.get('--font'), 'Latest Latin')
  assert.equal(f.writes.at(-1).fontFamily, '')
})

test('late font reads cannot select a font whose deletion already completed', async () => {
  const f = fixture()
  const reading = deferred()
  f.api.readCustomFont = () => reading.promise
  const applying = f.store.getState().applyCustom('b')
  const deleting = f.store.getState().removeCustomFont('b')
  f.finishDelete('b')
  await deleting
  reading.resolve({ ok: false })
  await applying
  assert.equal(f.store.getState().customFontId, 'a')
  assert.deepEqual(f.store.getState().customFonts.map(font => font.id), ['a', 'c'])
  assert.equal(f.writes.some(patch => patch.fontFamily?.includes('Font-b')), false)
})

test('a settings refresh started during deletion cannot restore its stale list afterward', async () => {
  const f = fixture()
  const reading = deferred()
  const oldFonts = structuredClone(f.store.getState().customFonts)
  f.api.getSettings = () => reading.promise
  const deleting = f.store.getState().removeCustomFont('b')
  const refreshing = f.store.getState().refresh()
  f.finishDelete('b')
  await deleting
  reading.resolve({ general: { customFonts: oldFonts } })
  await refreshing
  assert.deepEqual(f.store.getState().customFonts.map(font => font.id), ['a', 'c'])
  assert.equal(f.store.getState().hydrating, false)
})
