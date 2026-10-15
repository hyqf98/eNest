import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import ts from 'typescript'

const javascript = ts.transpileModule(readFileSync(new URL('./updateDialogStore.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText

function fixture() {
  let state
  const calls = [], warnings = [], errors = []
  const create = initialize => {
    const get = () => state
    const set = update => { state = { ...state, ...(typeof update === 'function' ? update(state) : update) } }
    state = initialize(set, get)
    return { getState: get, setState: set }
  }
  const api = {
    getPluginsDirty: async () => { calls.push('dirty'); return { items: [{ pluginId: 'a', name: 'A', dirty: true }] } },
    saveAllPlugins: async () => { calls.push('save'); return { total: 1, acked: 1, timedOut: 0, dirtyBefore: 1 } },
    installUpdate: async () => { calls.push('install'); return { status: 'downloaded' } }
  }
  const stubs = {
    zustand: { create },
    '@renderer/services/shellApi': { shellApi: api },
    '@renderer/services/notifyService': { notify: { warn: message => warnings.push(message), error: message => errors.push(message) } },
    '@renderer/i18n': { t: (key, values) => `${key}${values ? `:${values.count}` : ''}` }
  }
  const module = { exports: {} }
  new Function('require', 'module', 'exports', javascript)(name => {
    if (!(name in stubs)) throw new Error(name)
    return stubs[name]
  }, module, module.exports)
  return { store: module.exports.useUpdateDialogStore, api, calls, warnings, errors }
}

test('both entry points share one save wait before updater can close any windows', async () => {
  const f = fixture()
  let finishSave
  f.api.saveAllPlugins = () => {
    f.calls.push('save')
    return new Promise(resolve => { finishSave = resolve })
  }
  const settingsAction = f.store.getState().restartAfterSave
  const dialogAction = f.store.getState().restartAfterSave
  const pending = settingsAction()
  await dialogAction()
  assert.equal(f.store.getState().open, true)
  assert.equal(f.store.getState().saving, true)
  assert.deepEqual(f.calls, ['dirty', 'save'])
  f.store.getState().closeDialog()
  assert.equal(f.store.getState().open, true, 'saving remains visible until installation is dispatched')
  finishSave({ total: 1, acked: 1, timedOut: 0, dirtyBefore: 1 })
  await pending
  assert.deepEqual(f.calls, ['dirty', 'save', 'install'])
  assert.deepEqual(f.store.getState().dirtyItems, [{ pluginId: 'a', name: 'A', dirty: true }])
  await settingsAction()
  assert.equal(f.calls.filter(call => call === 'install').length, 1)
})

test('a failed dirty snapshot still saves all plugins before installation', async () => {
  const f = fixture()
  f.api.getPluginsDirty = async () => { throw new Error('snapshot unavailable') }
  await f.store.getState().restartAfterSave()
  assert.deepEqual(f.calls, ['save', 'install'])
})

test('unconfirmed saves warn and continue installation under the existing policy', async () => {
  const f = fixture()
  f.api.saveAllPlugins = async () => {
    f.calls.push('save')
    return { total: 2, acked: 1, timedOut: 1, dirtyBefore: 2 }
  }
  await f.store.getState().restartAfterSave()
  assert.deepEqual(f.calls, ['dirty', 'save', 'install'])
  assert.deepEqual(f.warnings, ['update.dialog.saveTimeout:1'])
})

test('a rejected save warns and continues without leaving an unhandled rejection', async () => {
  const f = fixture()
  f.api.saveAllPlugins = async () => { f.calls.push('save'); throw new Error('IPC failed') }
  await f.store.getState().restartAfterSave()
  assert.deepEqual(f.calls, ['dirty', 'save', 'install'])
  assert.deepEqual(f.warnings, ['update.dialog.saveFailed'])
})

for (const failure of ['rejected', 'error-state']) {
  test(`installation ${failure} restores the ability to retry`, async () => {
    const f = fixture()
    f.api.installUpdate = async () => {
      if (failure === 'rejected') throw new Error('installer unavailable')
      return { status: 'error', error: 'installer unavailable' }
    }
    await f.store.getState().restartAfterSave()
    assert.equal(f.store.getState().saving, false)
    assert.deepEqual(f.errors, ['installer unavailable'])
    f.api.installUpdate = async () => { f.calls.push('install'); return { status: 'downloaded' } }
    await f.store.getState().restartAfterSave()
    assert.deepEqual(f.calls, ['dirty', 'save', 'dirty', 'save', 'install'])
  })
}
