import assert from 'node:assert/strict'
import test from 'node:test'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'
import ts from 'typescript'

function load(path, imports = {}, globals = {}) {
  const module = { exports: {} }
  const source = ts.transpileModule(readFileSync(new URL(path, new URL('../../../', import.meta.url)), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  vm.runInNewContext(source, { module, exports: module.exports, require: key => {
    if (!(key in imports)) throw new Error(key)
    return imports[key]
  }, ...globals })
  return module.exports
}
function fixture(initial = {}) {
  let settings = structuredClone(initial), id = 0
  let writeFailure = false
  const writes = [], events = [], timers = new Map()
  const plugins = ['a', 'b'].map(id => ({ id, name: `Plugin ${id}`, installed: true, enabled: true }))
  const { createShortcutMock } = load('tests/fixtures/browser-preview/shortcutMock.ts', {
    '@shared/accelerator': load('src/shared/accelerator.ts'),
    '@shared/platform': { IS_MAC: true, IS_WINDOWS: false }
  }, { crypto: { randomUUID: () => `id-${++id}` }, setTimeout: callback => { const id = timers.size + 1; timers.set(id, callback); return id }, clearTimeout: id => timers.delete(id) })
  const api = createShortcutMock({ read: () => structuredClone(settings), write: value => { if (writeFailure) throw Error('write failed'); settings = structuredClone(value); writes.push(value) },
    plugins: () => plugins, publish: snapshot => events.push(snapshot) })
  return { api, plugins, writes, events, settings: () => settings, timers, failWrites: value => { writeFailure = value } }
}
const input = (accelerator, extra = {}) => ({ pluginId: 'a', accelerator, mode: 'quick', enabled: true, ...extra })

test('legacy hotkey migration is persisted exactly once and preserves mode and aliases', () => {
  const f = fixture({ pluginLaunch: { a: { hotkey: 'Ctrl+Shift+K', mode: 'shell', aliases: ['search'] }, b: { hotkey: '' } } })
  const one = f.api.snapshot(), two = f.api.snapshot()
  assert.equal(one.bindings.length, 1)
  assert.equal(one.bindings[0].accelerator, 'Control+Shift+K')
  assert.equal(one.bindings[0].mode, 'shell')
  assert.equal(two.bindings[0].id, one.bindings[0].id)
  assert.equal(f.writes.length, 1)
  assert.deepEqual(JSON.parse(JSON.stringify(f.settings().pluginLaunch)), { a: { mode: 'shell', aliases: ['search'] }, b: {} })
})

test('same plugin supports multiple bindings, detects equivalent keys and preserves failed edits', () => {
  const f = fixture()
  const first = f.api.save(input('Ctrl+Shift+K')), second = f.api.save(input('Alt+J', { mode: 'shell' }))
  assert.equal(first.ok, true); assert.equal(second.ok, true)
  assert.equal(f.api.snapshot().bindings.length, 2)
  const failed = f.api.save(input('Control+Shift+K', { id: second.binding.id }))
  assert.equal(failed.ok, false)
  assert.equal(failed.probe.ownerBindingId, first.binding.id)
  assert.equal(f.api.snapshot().bindings.find(binding => binding.id === second.binding.id).accelerator, 'Alt+J')
  assert.equal(f.api.save({ ...first.binding, mode: 'shell' }).ok, true)
})

test('disabled bindings release keys and reenable conflicts preserve the disabled configuration', () => {
  const f = fixture(), first = f.api.save(input('Alt+K'))
  f.api.save({ ...first.binding, enabled: false })
  assert.equal(f.api.save(input('Alt+K', { pluginId: 'b' })).ok, true)
  assert.equal(f.api.save(first.binding).ok, false)
  assert.equal(f.api.snapshot().bindings[0].enabled, false)
  assert.equal(f.api.snapshot().states[0].status, 'disabled')
})

test('plugin-disabled and missing entries have correct states and uninstall cleans their bindings', () => {
  const f = fixture(), saved = f.api.save(input('Alt+K'))
  f.plugins[0].enabled = false
  assert.equal(f.api.snapshot().states[0].status, 'plugin-disabled')
  assert.equal(f.api.probe('Alt+K').status, 'free')
  f.plugins[0].installed = false
  assert.equal(f.api.snapshot().states[0].status, 'plugin-missing')
  f.api.removePlugin('a')
  assert.equal(f.api.snapshot().bindings.length, 0)
  assert.ok(saved.ok)
})

test('Quick and plugin bindings conflict without takeover and Quick enable is independent', () => {
  const f = fixture()
  assert.equal(f.api.save(input('Alt+Space')).probe.status, 'quick')
  assert.equal(f.api.setQuick({ enabled: false }).ok, true)
  const saved = f.api.save(input('Alt+Space'))
  assert.equal(saved.ok, true)
  assert.equal(f.api.setQuick({ enabled: true }).ok, false)
  assert.equal(f.api.quickConfig().enabled, false)
  assert.equal(f.api.snapshot().bindings[0].enabled, true)
})

test('browser preview never claims real OS registration; capture suspends until its final token ends', () => {
  const f = fixture(); f.api.save(input('Alt+K'))
  assert.equal(f.api.quickConfig().registered.length, 0)
  assert.equal(f.api.snapshot().states[0].status, 'conflict')
  assert.match(f.api.snapshot().states[0].error, /浏览器预览/)
  const first = f.api.beginCapture(), second = f.api.beginCapture()
  assert.equal(f.api.snapshot().states[0].status, 'suspended')
  assert.equal(f.api.save(input('Alt+J')).ok, false)
  assert.equal(f.api.setQuick({ enabled: false }).ok, false)
  f.api.endCapture(first.token)
  assert.equal(f.api.snapshot().states[0].status, 'suspended')
  f.api.endCapture(second.token)
  assert.equal(f.api.snapshot().states[0].status, 'conflict')
  assert.equal(f.timers.size, 0)
})


test('manual input cannot register bare keys or Shift-only shortcuts', () => {
  const f = fixture()
  for (const accelerator of ['A', 'F4', 'Shift+K']) {
    assert.equal(f.api.save(input(accelerator)).ok, false)
    assert.equal(f.api.probe(accelerator).status, 'invalid')
    assert.equal(f.api.setQuick({ activeHotkey: accelerator, hotkeys: [accelerator] }).ok, false)
  }
  assert.equal(f.api.snapshot().bindings.length, 0)
})

test('confirmed browser replacements preserve disabled bindings and atomically switch Quick ownership', () => {
  const f = fixture()
  const original = f.api.save(input('Alt+K'))
  const replacement = f.api.save(input('Alt+K', { pluginId: 'b', overrideToken: f.api.probe('Alt+K').overrideToken }))
  assert.equal(replacement.ok, true)
  assert.equal(f.settings().pluginShortcuts.find(binding => binding.id === original.binding.id).enabled, false)
  assert.equal('overrideToken' in replacement.binding, false)
  const quick = f.api.setQuick({ activeHotkey: 'Alt+K', hotkeys: ['Alt+K'], overrideToken: f.api.probe('Alt+K', undefined, true).overrideToken })
  assert.equal(quick.ok, true)
  assert.equal(f.settings().pluginShortcuts.find(binding => binding.id === replacement.binding.id).enabled, false)
  const back = f.api.save(input('Alt+K', { overrideToken: f.api.probe('Alt+K').overrideToken }))
  assert.equal(back.ok, true)
  assert.equal(f.settings().quick.enabled, false)
  assert.equal(f.settings().pluginShortcuts.filter(binding => binding.enabled).length, 1)
})

test('browser stale confirmations and write failures preserve both settings sections', () => {
  const f = fixture()
  const first = f.api.save(input('Alt+K'))
  const token = f.api.probe('Alt+K').overrideToken
  f.api.save({ ...first.binding, mode: 'shell' })
  const stale = f.api.save(input('Alt+K', { pluginId: 'b', overrideToken: token }))
  assert.equal(stale.ok, false)
  assert.match(stale.error, /变化或确认已过期/)
  const before = structuredClone(f.settings())
  f.failWrites(true)
  const plugin = f.api.save(input('Alt+K', { pluginId: 'b', overrideToken: stale.probe.overrideToken }))
  assert.equal(plugin.ok, false)
  const quick = f.api.setQuick({ activeHotkey: 'Alt+K', hotkeys: ['Alt+K'], overrideToken: f.api.probe('Alt+K', undefined, true).overrideToken })
  assert.equal(quick.ok, false)
  assert.deepEqual(f.settings(), before)
  assert.ok(quick.probe.overrideToken)
  f.failWrites(false)
  assert.equal(f.api.setQuick({ activeHotkey: 'Alt+K', hotkeys: ['Alt+K'], overrideToken: quick.probe.overrideToken }).ok, true)
})

test('browser Quick validates malformed patches even with a valid conflict token', () => {
  const f = fixture()
  f.api.save(input('Alt+K'))
  const token = f.api.probe('Alt+K', undefined, true).overrideToken
  const before = structuredClone(f.settings())
  for (const patch of [{ enabled: 'true' }, { activeHotkey: {} }, { hotkeys: 'Alt+K' }, { overrideToken: {} }]) {
    assert.equal(f.api.setQuick({ activeHotkey: 'Alt+K', hotkeys: ['Alt+K'], overrideToken: token, ...patch }).ok, false)
    assert.deepEqual(f.settings(), before)
  }
  assert.equal(f.api.setQuick({ activeHotkey: 'Alt+K', hotkeys: ['Alt+K'], overrideToken: token }).ok, true)
})
