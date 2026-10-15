import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
const root = fileURLToPath(new URL('../../../', import.meta.url))
const adapters = {
  'test-state': `export const state={keys:new Map(),blocked:new Set(),registerCalls:[],unregisterCalls:[],bindings:[],plugins:new Map(),quick:{enabled:true,hotkeys:['Alt+Space','Control+Space'],activeHotkey:'Alt+Space'},events:[],launches:[],settingsReads:0,writeFailure:false,listeners:new Set()};`,
  electron: `import {state} from 'test-state'; export const globalShortcut={
    register:(acc,callback)=>{state.registerCalls.push(acc);if(state.blocked.has(acc)||state.keys.has(acc))return false;state.keys.set(acc,callback);return true},
    unregister:acc=>{state.unregisterCalls.push(acc);state.keys.delete(acc)},isRegistered:acc=>state.keys.has(acc),unregisterAll:()=>state.keys.clear()};`,
  '@main/logs/logService': 'export const logInfo=()=>{};export const logWarn=()=>{};export const logError=()=>{};',
  '@main/settings/SettingsStore': `import {state} from 'test-state';export const defaultQuickHotkeys=()=>['Alt+Space','Control+Space'];export const settingsStore={
    getQuickLauncherSettings:()=>structuredClone(state.quick),
    setQuickHotkeys:config=>{if(state.writeFailure)throw Error('write failed');state.quick={...state.quick,...structuredClone(config)}},
    getPluginShortcuts:()=>{state.settingsReads++;return structuredClone(state.bindings)},
    setPluginShortcuts:bindings=>{if(state.writeFailure)throw Error('write failed');state.bindings=structuredClone(bindings)},
    setShortcutConfiguration:(bindings,quick)=>{if(state.writeFailure)throw Error('write failed');state.bindings=structuredClone(bindings);if(quick)state.quick={...state.quick,...structuredClone(quick)}},
    getPluginLaunchSettings:()=>({}),getPluginLaunchConfig:()=>undefined,getPluginLaunchRevision:()=>0,setPluginLaunch:async()=>{}
  };`,
  '@main/plugin/PluginRegistry': `import {state} from 'test-state';export const pluginRegistry={get:id=>state.plugins.get(id),onInstalledChanged:listener=>{state.listeners.add(listener);return ()=>state.listeners.delete(listener)}};`,
  '@main/launcher/pluginLauncher': `import {state} from 'test-state';export async function launchPlugin(request){state.launches.push(request);return {ok:true}};`,
  '@main/window/createShellWindow': `import {state} from 'test-state';export const sendShellEvent=event=>state.events.push(event);`,
  '@main/window/createQuickWindow': `import {state} from 'test-state';export const toggleQuickWindow=()=>state.launches.push({quick:true});`
}
const output = await build({
  stdin: { contents: "export * from '@main/hotkey/hotkeyRegistry';export * from '@main/hotkey/pluginShortcuts';export * from '@main/hotkey/pluginRuntimeHotkeys';export * from '@main/hotkey/quickHotkey';export {state} from 'test-state'", resolveDir: root },
  tsconfig: root + 'tsconfig.node.json', bundle: true, write: false, platform: 'node', format: 'esm',
  plugins: [{ name: 'shortcut-fixtures', setup(b) {
    b.onResolve({ filter: /.*/ }, ({ path }) => path in adapters ? { path, namespace: 'mock' } : undefined)
    b.onLoad({ filter: /.*/, namespace: 'mock' }, ({ path }) => ({ contents: adapters[path] }))
  } }]
})
const api = await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`)
const { state } = api
const input = (accelerator, mode = 'quick', extra = {}) => ({ pluginId: 'one', accelerator, mode, enabled: true, ...extra })
const flush = async () => { await Promise.resolve(); await Promise.resolve() }
test.beforeEach(async () => {
  api.disposePluginShortcuts()
  api.disposeQuickHotkeys()
  await flush()
  Object.assign(state, { keys: new Map(), blocked: new Set(), registerCalls: [], unregisterCalls: [], bindings: [],
    plugins: new Map([['one', { name: 'One', installed: true, enabled: true }], ['two', { name: 'Two', installed: true, enabled: true }]]),
    quick: { enabled: true, hotkeys: ['Alt+Space', 'Control+Space'], activeHotkey: 'Alt+Space' },
    events: [], launches: [], settingsReads: 0, writeFailure: false, listeners: new Set() })
  api.initPluginShortcuts()
  await flush()
})
test.after(async () => { api.disposePluginShortcuts(); api.disposeQuickHotkeys(); await flush() })

test('one plugin has multiple independent modes; hotkey launches use cached bindings', async () => {
  const quick = await api.savePluginShortcut(input('Control+1'))
  const shell = await api.savePluginShortcut(input('Control+2', 'shell'))
  assert.equal(quick.ok, true)
  assert.equal(shell.ok, true)
  assert.notEqual(quick.binding.id, shell.binding.id)
  await flush()
  const reads = state.settingsReads
  state.keys.get('Control+1')()
  state.keys.get('Control+2')()
  await flush()
  assert.deepEqual(state.launches.map(item => item.mode), ['quick', 'shell'])
  assert.equal(state.settingsReads, reads, 'launching must not copy the binding list')
  assert.equal(state.launches.every(item => item.source === 'shortcut'), true)
})

test('mode edits and stable reconciliation never re-register native keys', async () => {
  const saved = await api.savePluginShortcut(input('Control+1'))
  state.registerCalls.length = state.unregisterCalls.length = 0
  assert.equal((await api.savePluginShortcut({ ...saved.binding, mode: 'shell' })).ok, true)
  api.reconcilePluginShortcuts()
  assert.deepEqual(state.registerCalls, [])
  assert.deepEqual(state.unregisterCalls, [])
  state.keys.get('Control+1')()
  await flush()
  assert.equal(state.launches[0].mode, 'shell')
})

test('equivalent accelerators conflict by binding identity without changing the original owner', async () => {
  const first = await api.savePluginShortcut(input('Ctrl+Shift+J'))
  const conflict = await api.savePluginShortcut(input('shift+control+j', 'shell'))
  assert.equal(conflict.ok, false)
  assert.equal(conflict.probe.ownerBindingId, first.binding.id)
  assert.equal(state.bindings.length, 1)
  assert.equal(api.probePluginShortcut('CTRL+shift+j', first.binding.id).status, 'free')
})

test('failed native replacement and failed settings commit retain the previous binding and key', async () => {
  const saved = await api.savePluginShortcut(input('Control+1'))
  state.blocked.add('Control+2')
  const nativeFailure = await api.savePluginShortcut({ ...saved.binding, accelerator: 'Control+2' })
  assert.equal(nativeFailure.ok, false)
  assert.equal(state.keys.has('Control+1'), true)
  assert.deepEqual(state.bindings, [saved.binding])
  state.blocked.clear()
  state.writeFailure = true
  const persistenceFailure = await api.savePluginShortcut({ ...saved.binding, accelerator: 'Control+3' })
  assert.equal(persistenceFailure.ok, false)
  assert.equal(state.keys.has('Control+1'), true)
  assert.equal(state.keys.has('Control+3'), false)
  assert.deepEqual(state.bindings, [saved.binding])
})

test('registration race after a successful probe reports failure and preserves old configuration', async () => {
  const saved = await api.savePluginShortcut(input('Control+1'))
  // Inject a competing app after the probe unregisters its temporary registration.
  const calls = state.unregisterCalls
  state.unregisterCalls = { push(acc) { calls.push(acc); if (acc === 'Control+2') state.blocked.add(acc) } }
  const result = await api.savePluginShortcut({ ...saved.binding, accelerator: 'Control+2' })
  assert.equal(result.ok, false)
  assert.deepEqual(state.bindings, [saved.binding])
  assert.equal(state.keys.has('Control+1'), true)
})

test('failed persistence with a lost rollback key removes the unsaved key and reports the actual inactive state', async () => {
  const saved = await api.savePluginShortcut(input('Control+1'))
  const untouched = await api.savePluginShortcut(input('Control+3'))
  state.blocked.add('Control+1')
  state.writeFailure = true
  const result = await api.savePluginShortcut({ ...saved.binding, accelerator: 'Control+2', mode: 'shell' })
  assert.equal(result.ok, false)
  assert.deepEqual(state.bindings, [saved.binding, untouched.binding])
  assert.equal(state.keys.has('Control+2'), false, 'an unsaved replacement must not remain globally active')
  assert.equal(api.getHotkeyOwner('Control+2'), undefined)
  assert.equal(api.getHotkeyOwner('Control+1'), undefined)
  const failed = result.snapshot.states.find(item => item.id === saved.binding.id)
  assert.equal(failed.status, 'conflict')
  assert.match(failed.error, /Control\+1.*恢复失败/)
  assert.equal(result.snapshot.states.find(item => item.id === untouched.binding.id).status, 'registered')
  assert.equal(state.keys.has('Control+3'), true)
  assert.deepEqual(state.launches, [])
})

test('failed bulk-delete persistence restores available bindings even when another old key is lost', async () => {
  const first = await api.savePluginShortcut(input('Control+1'))
  const second = await api.savePluginShortcut(input('Control+2', 'shell'))
  state.blocked.add('Control+1')
  state.writeFailure = true
  const result = await api.removePluginShortcuts('one')
  assert.equal(result.ok, false)
  assert.deepEqual(state.bindings, [first.binding, second.binding])
  assert.equal(state.keys.has('Control+1'), false)
  assert.equal(state.keys.has('Control+2'), true)
  assert.match(result.snapshot.states.find(item => item.id === first.binding.id).error, /Control\+1.*恢复失败/)
  assert.equal(result.snapshot.states.find(item => item.id === second.binding.id).status, 'registered')
  state.keys.get('Control+2')()
  await flush()
  assert.equal(state.launches[0].mode, 'shell')
})

test('runtime unregister cannot delete Quick or another plugin shortcut', async () => {
  api.initQuickHotkeys()
  const shortcut = await api.savePluginShortcut(input('Control+2'))
  assert.equal(api.registerRuntimeHotkey('two', 'Control+3', () => {}).ok, true)
  api.unregisterRuntimeHotkey('two', 'Alt+Space')
  api.unregisterRuntimeHotkey('two', 'Ctrl+2')
  assert.equal(state.keys.has('Alt+Space'), true)
  assert.equal(state.keys.has(shortcut.binding.accelerator), true)
  state.registerCalls.length = 0
  assert.equal(api.registerRuntimeHotkey('two', 'Ctrl+3', () => {}).ok, true)
  assert.deepEqual(state.registerCalls, [], 'repeat registration updates the callback without native churn')
})

test('capture pauses every owner, preserves conflict attribution, and restores only for the correct token owner', async () => {
  api.initQuickHotkeys()
  const saved = await api.savePluginShortcut(input('Control+1'))
  api.registerRuntimeHotkey('two', 'Control+2', () => {})
  const token = api.beginShortcutCapture(10)
  assert.equal(state.keys.size, 0)
  assert.equal(api.getPluginShortcuts().states[0].status, 'suspended')
  assert.equal(api.probePluginShortcut('Alt+Space').status, 'quick')
  assert.equal(api.probePluginShortcut('Control+2').status, 'runtime')
  assert.equal((await api.savePluginShortcut({ ...saved.binding, mode: 'shell' })).ok, false)
  assert.equal(api.applyQuickHotkeys({ activeHotkey: 'Control+Space' }).ok, false)
  api.endShortcutCapture(token, 11)
  assert.equal(state.keys.size, 0)
  api.endShortcutCapturesForOwner(10)
  assert.equal(state.keys.size, 3)
  assert.equal(api.getPluginShortcuts().states[0].status, 'registered')
})

test('capture restore failure is reported and does not prevent unrelated binding changes', async () => {
  api.initQuickHotkeys()
  await api.savePluginShortcut(input('Control+1'))
  const token = api.beginShortcutCapture(10)
  state.blocked.add('Control+1')
  state.blocked.add('Alt+Space')
  api.endShortcutCapture(token, 10)
  assert.equal(api.getPluginShortcuts().states[0].status, 'conflict')
  assert.deepEqual(api.getQuickHotkeyConfig().registered, [])
  assert.match(api.getQuickHotkeyConfig().error, /注册失败/)
  assert.equal((await api.savePluginShortcut(input('Control+3'))).ok, true)
  assert.equal(state.keys.has('Control+3'), true)
})

test('capture expires after 30 seconds and renewed tokens cannot release the new lease', async t => {
  await api.savePluginShortcut(input('Control+1'))
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const oldToken = api.beginShortcutCapture(10)
  const token = api.beginShortcutCapture(10)
  api.endShortcutCapture(oldToken, 10)
  assert.equal(state.keys.size, 0)
  t.mock.timers.tick(29_999)
  assert.equal(state.keys.size, 0)
  t.mock.timers.tick(1)
  assert.equal(state.keys.size, 1)
  api.endShortcutCapture(token, 10)
  assert.equal(state.keys.size, 1)
})

test('concurrent conflicting saves serialize and deleting during capture cannot resurrect the key', async () => {
  const results = await Promise.all([api.savePluginShortcut(input('Control+1')), api.savePluginShortcut(input('Ctrl+1', 'shell'))])
  assert.deepEqual(results.map(result => result.ok), [true, false])
  const token = api.beginShortcutCapture(10)
  assert.equal((await api.removePluginShortcut(results[0].binding.id)).ok, true)
  api.endShortcutCapture(token, 10)
  assert.equal(state.keys.size, 0)
  assert.equal(state.bindings.length, 0)
})

test('disable releases only its key, manual launch remains available, and missing plugin can recover', async () => {
  const saved = await api.savePluginShortcut(input('Control+1'))
  const other = await api.savePluginShortcut(input('Control+2', 'shell'))
  assert.equal((await api.savePluginShortcut({ ...saved.binding, enabled: false })).ok, true)
  assert.equal(state.keys.has('Control+1'), false)
  assert.equal(state.keys.has('Control+2'), true)
  assert.equal((await api.launchPluginShortcut(saved.binding.id)).ok, true)
  state.plugins.get('one').enabled = false
  for (const listener of state.listeners) listener()
  assert.equal(state.keys.has('Control+2'), false)
  assert.equal((await api.launchPluginShortcut(other.binding.id)).ok, false)
  state.plugins.delete('one')
  api.reconcilePluginShortcuts()
  assert.equal(api.getPluginShortcuts().states.find(item => item.id === other.binding.id).status, 'plugin-missing')
  state.plugins.set('one', { installed: true, enabled: true, name: 'One' })
  api.reconcilePluginShortcuts()
  assert.equal(state.keys.has('Control+2'), true)
  assert.equal(state.keys.has('Control+1'), false)
  assert.equal((await api.removePluginShortcuts('one')).ok, true)
  assert.deepEqual(state.bindings, [])
  assert.equal(state.keys.size, 0)
})

test('explicit Quick conflict leaves its original selection and all plugin keys intact', async () => {
  api.initQuickHotkeys()
  await api.savePluginShortcut(input('Control+1'))
  const previous = structuredClone(state.quick)
  const changed = api.saveQuickHotkeys({ hotkeys: ['Control+1', 'Control+Space'], activeHotkey: 'Control+1' })
  assert.equal(changed.ok, false)
  assert.equal(changed.activeHotkey, 'Alt+Space')
  assert.match(changed.error, /One（one）.*快捷键绑定/)
  assert.deepEqual(state.quick, previous)
  assert.equal(state.keys.has('Alt+Space'), true)
  assert.equal(state.keys.has('Control+1'), true)
  assert.equal(state.keys.has('Control+Space'), false)
  assert.equal(api.probeHotkey('Ctrl+1').free, false)
  assert.match(api.probeHotkey('Ctrl+1').hint, /One（one）/)
  api.registerRuntimeHotkey('two', 'Control+2', () => {})
  const runtimeConflict = api.saveQuickHotkeys({ hotkeys: ['Control+2'], activeHotkey: 'Control+2' })
  assert.match(runtimeConflict.error, /Two（two）.*运行时快捷键/)
  assert.equal(api.probeHotkey('Control+2').free, false)
  assert.match(api.probeHotkey('Control+2').hint, /Two（two）.*运行时快捷键/)
})

test('Quick durable save updates only shortcut preferences and can disable without claiming plugin keys', async () => {
  state.quick.recent = [{ id: 'plugin:one:', ts: 12, count: 2 }]
  state.quick.queryPreferences = [{ query: 'test', id: 'plugin:one:' }]
  api.initQuickHotkeys()
  await api.savePluginShortcut(input('Control+1'))
  const result = api.saveQuickHotkeys({ activeHotkey: 'Control+Space' })
  assert.equal(result.ok, true)
  assert.equal(state.quick.activeHotkey, 'Control+Space')
  assert.deepEqual(state.quick.recent, [{ id: 'plugin:one:', ts: 12, count: 2 }])
  assert.deepEqual(state.quick.queryPreferences, [{ query: 'test', id: 'plugin:one:' }])
  assert.equal(state.keys.has('Alt+Space'), false)
  assert.equal(state.keys.has('Control+Space'), true)
  const disabled = api.saveQuickHotkeys({ enabled: false })
  assert.equal(disabled.ok, true)
  assert.equal(state.quick.enabled, false)
  assert.deepEqual([...state.keys.keys()], ['Control+1'])
  assert.equal(api.getQuickHotkeyConfig().error, undefined)
})

test('Quick native conflict keeps old preferences and retains the error across configuration refresh', () => {
  api.initQuickHotkeys()
  const previous = structuredClone(state.quick)
  state.blocked.add('Control+Space')
  const result = api.saveQuickHotkeys({ activeHotkey: 'Control+Space' })
  assert.equal(result.ok, false)
  assert.deepEqual(state.quick, previous)
  assert.deepEqual(result.registered, ['Alt+Space'])
  assert.equal(state.keys.has('Alt+Space'), true)
  assert.equal(state.keys.has('Control+Space'), false)
  assert.match(api.getQuickHotkeyConfig().error, /系统或其他应用/)
})

test('Quick write failure restores the exact old callback and selection and publishes no saved event', () => {
  api.initQuickHotkeys()
  const original = api.getOwnedHotkey({ kind: 'quick', id: 'launcher' })
  const preferences = structuredClone(state.quick)
  state.events.length = 0
  state.writeFailure = true
  const result = api.saveQuickHotkeys({ activeHotkey: 'Control+Space' })
  assert.equal(result.ok, false)
  assert.match(result.error, /write failed/)
  assert.deepEqual(state.quick, preferences)
  assert.deepEqual(result.registered, ['Alt+Space'])
  assert.equal(state.keys.has('Control+Space'), false)
  assert.equal(api.getOwnedHotkey(original.owner).onFire, original.onFire)
  assert.equal(state.events.some(event => event.type === 'quick-config-changed'), false)
  state.keys.get('Alt+Space')()
  assert.deepEqual(state.launches, [{ quick: true }])
  assert.equal(api.getQuickHotkeyConfig().lastUsedHotkey, 'Alt+Space')
})

test('Quick rollback loses the old key without leaving an unsaved replacement globally active', async () => {
  api.initQuickHotkeys()
  await api.savePluginShortcut(input('Control+1'))
  state.blocked.add('Alt+Space')
  state.writeFailure = true
  const preferences = structuredClone(state.quick)
  const result = api.saveQuickHotkeys({ activeHotkey: 'Control+Space' })
  assert.equal(result.ok, false)
  assert.match(result.error, /Alt\+Space.*恢复失败/)
  assert.deepEqual(result.registered, [])
  assert.equal(result.activeHotkey, 'Alt+Space')
  assert.deepEqual(state.quick, preferences)
  assert.equal(state.keys.has('Control+Space'), false)
  assert.equal(api.getHotkeyOwner('Control+Space'), undefined)
  assert.deepEqual(api.getQuickHotkeyConfig().registered, [])
  assert.match(api.getQuickHotkeyConfig().error, /Alt\+Space.*恢复失败/)
  assert.equal(state.keys.has('Control+1'), true)
  state.writeFailure = false
  assert.equal(api.saveQuickHotkeys({ activeHotkey: 'Control+Space' }).ok, true)
  assert.equal(state.quick.activeHotkey, 'Control+Space')
  assert.equal(api.getQuickHotkeyConfig().error, undefined)
})

test('Quick disabling write failure restores its old registration and enabled preference', () => {
  api.initQuickHotkeys()
  state.writeFailure = true
  const result = api.saveQuickHotkeys({ enabled: false })
  assert.equal(result.ok, false)
  assert.equal(result.enabled, true)
  assert.equal(state.quick.enabled, true)
  assert.deepEqual(result.registered, ['Alt+Space'])
  assert.equal(state.keys.has('Alt+Space'), true)
})

test('Quick enabling write failure leaves a previously disabled launcher unregistered', () => {
  state.quick.enabled = false
  api.initQuickHotkeys()
  state.writeFailure = true
  const result = api.saveQuickHotkeys({ enabled: true })
  assert.equal(result.ok, false)
  assert.equal(result.enabled, false)
  assert.equal(state.quick.enabled, false)
  assert.deepEqual(result.registered, [])
  assert.equal(state.keys.size, 0)
  assert.equal(api.getOwnedHotkey({ kind: 'quick', id: 'launcher' }), undefined)
})

test('typed user shortcuts cannot capture plain typing while runtime keys retain their existing API', async () => {
  api.initQuickHotkeys()
  for (const accelerator of ['A', 'Shift+A', 'F1', 'Shift+F1']) {
    assert.equal((await api.savePluginShortcut(input(accelerator))).ok, false)
    assert.equal(api.probePluginShortcut(accelerator).status, 'invalid')
    assert.equal(api.applyQuickHotkeys({ hotkeys: [accelerator], activeHotkey: accelerator }).ok, false)
    assert.equal(api.probeHotkey(accelerator).free, false)
  }
  assert.equal(state.keys.has('Alt+Space'), true)
  assert.equal(state.bindings.length, 0)
  assert.equal(api.registerRuntimeHotkey('two', 'F1', () => {}).ok, true)
  state.bindings.push({ id: 'legacy-plain', ...input('A') })
  api.reconcilePluginShortcuts()
  assert.equal(api.getPluginShortcuts().states[0].status, 'conflict')
  assert.equal(state.keys.has('A'), false)
})

test('Quick-only capture restore still publishes state when there are no plugin bindings', async () => {
  api.initQuickHotkeys()
  await flush()
  state.events.length = 0
  const token = api.beginShortcutCapture(10)
  await flush()
  assert.equal(state.events.filter(event => event.type === 'plugin-shortcuts-changed').length, 1)
  state.blocked.add('Alt+Space')
  api.endShortcutCapture(token, 10)
  await flush()
  assert.equal(state.events.filter(event => event.type === 'plugin-shortcuts-changed').length, 2)
  assert.deepEqual(api.getQuickHotkeyConfig().registered, [])
})

test('many saved shortcuts register without loading any plugin or affecting unrelated native keys', async () => {
  for (let i = 0; i < 50; i++) {
    const pluginId = `plugin-${i}`
    state.plugins.set(pluginId, { installed: true, enabled: true })
    state.bindings.push({ id: `binding-${i}`, pluginId, accelerator: `${i < 25 ? 'Control' : 'Alt'}+${i % 25 < 24 ? `F${i % 25 + 1}` : 'Space'}`, mode: 'quick', enabled: true })
  }
  api.reconcilePluginShortcuts()
  assert.equal(state.keys.size, 50)
  assert.deepEqual(state.launches, [])
  state.registerCalls.length = state.unregisterCalls.length = 0
  await api.savePluginShortcut({ ...state.bindings[0], mode: 'shell' })
  assert.deepEqual(state.registerCalls, [])
  assert.deepEqual(state.unregisterCalls, [])
})

test('confirmed plugin replacement disables the original binding and transfers the existing native callback', async () => {
  const original = await api.savePluginShortcut(input('Control+1'))
  const probe = api.probePluginShortcut('Ctrl+1')
  assert.ok(probe.overrideToken)
  state.registerCalls.length = state.unregisterCalls.length = 0
  const replacement = await api.savePluginShortcut(input('Control+1', 'shell', { pluginId: 'two', overrideToken: probe.overrideToken }))
  assert.equal(replacement.ok, true)
  assert.equal(state.bindings.find(item => item.id === original.binding.id).enabled, false)
  assert.equal(api.getHotkeyOwner('Control+1').id, replacement.binding.id)
  assert.deepEqual(state.registerCalls, [])
  assert.deepEqual(state.unregisterCalls, [])
  assert.equal('overrideToken' in state.bindings[1], false)
  state.keys.get('Control+1')(); await flush()
  assert.equal(state.launches[0].pluginId, 'two')
  assert.equal(state.launches[0].mode, 'shell')
})

test('confirmed plugin to Quick and Quick to plugin replacements persist both owners together', async () => {
  api.initQuickHotkeys()
  const first = await api.savePluginShortcut(input('Alt+Space', 'quick', { overrideToken: api.probePluginShortcut('Alt+Space').overrideToken }))
  assert.equal(first.ok, true)
  assert.equal(state.quick.enabled, false)
  assert.equal(api.getHotkeyOwner('Alt+Space').id, first.binding.id)
  assert.ok(state.events.some(event => event.type === 'quick-config-changed' && !event.enabled))
  const probe = api.probeHotkey('Alt+Space')
  assert.equal(probe.free, false)
  assert.equal(probe.conflict.ownerBindingId, first.binding.id)
  const second = api.saveQuickHotkeys({ enabled: true, activeHotkey: 'Alt+Space', overrideToken: probe.conflict.overrideToken })
  assert.equal(second.ok, true)
  assert.equal(state.quick.enabled, true)
  assert.equal(state.bindings[0].enabled, false)
  assert.equal(api.getHotkeyOwner('Alt+Space').kind, 'quick')
  state.keys.get('Alt+Space')()
  assert.deepEqual(state.launches, [{ quick: true }])
})

test('changed conflict owners, expired confirmations and reused tokens cannot replace a different binding', async t => {
  const first = await api.savePluginShortcut(input('Control+1'))
  const probe = api.probePluginShortcut('Control+1')
  await api.savePluginShortcut({ ...first.binding, mode: 'shell' })
  const stale = await api.savePluginShortcut(input('Control+1', 'quick', { pluginId: 'two', overrideToken: probe.overrideToken }))
  assert.equal(stale.ok, false)
  assert.match(stale.error, /变化或确认已过期/)
  assert.equal(state.bindings.length, 1)
  const fresh = stale.probe.overrideToken
  const now = Date.now()
  const mocked = t.mock.method(Date, 'now', () => now + 300_001)
  const expired = await api.savePluginShortcut(input('Control+1', 'quick', { overrideToken: fresh }))
  assert.equal(expired.ok, false)
  mocked.mock.restore()
  const token = api.probePluginShortcut('Control+1').overrideToken
  const results = await Promise.all([
    api.savePluginShortcut(input('Control+1', 'shell', { pluginId: 'two', overrideToken: token })),
    api.savePluginShortcut(input('Control+1', 'quick', { overrideToken: token }))
  ])
  assert.deepEqual(results.map(item => item.ok), [true, false])
  assert.equal(state.bindings.filter(binding => binding.enabled).length, 1)
})

test('runtime and system conflicts never return replacement tokens or accept unrelated confirmations', async () => {
  await api.savePluginShortcut(input('Control+1'))
  const token = api.probePluginShortcut('Control+1').overrideToken
  api.registerRuntimeHotkey('two', 'Control+2', () => {})
  state.blocked.add('Control+3')
  for (const key of ['Control+2', 'Control+3']) {
    const probe = api.probePluginShortcut(key)
    assert.equal(probe.overrideToken, undefined)
    assert.equal((await api.savePluginShortcut(input(key, 'quick', { overrideToken: token }))).ok, false)
  }
  assert.equal(api.getHotkeyOwner('Control+2').kind, 'runtime')
  assert.equal(state.bindings.length, 1)
})

test('replacement persistence failures restore all original owners, callbacks and both preference sections', async () => {
  api.initQuickHotkeys()
  const first = await api.savePluginShortcut(input('Control+1'))
  const before = { bindings: structuredClone(state.bindings), quick: structuredClone(state.quick) }
  const originalPlugin = api.getOwnedHotkey({ kind: 'shortcut', id: first.binding.id })
  const originalQuick = api.getOwnedHotkey({ kind: 'quick', id: 'launcher' })
  state.writeFailure = true
  const plugin = await api.savePluginShortcut(input('Control+1', 'shell', { pluginId: 'two', overrideToken: api.probePluginShortcut('Control+1').overrideToken }))
  assert.equal(plugin.ok, false)
  const quickTaken = await api.savePluginShortcut(input('Alt+Space', 'shell', { overrideToken: api.probePluginShortcut('Alt+Space').overrideToken }))
  assert.equal(quickTaken.ok, false)
  const pluginTaken = api.saveQuickHotkeys({ hotkeys: ['Control+1'], activeHotkey: 'Control+1', overrideToken: api.probeHotkey('Control+1').conflict.overrideToken })
  assert.equal(pluginTaken.ok, false)
  assert.deepEqual(state.bindings, before.bindings)
  assert.deepEqual(state.quick, before.quick)
  assert.equal(api.getOwnedHotkey(originalPlugin.owner).onFire, originalPlugin.onFire)
  assert.equal(api.getOwnedHotkey(originalQuick.owner).onFire, originalQuick.onFire)
  assert.equal(state.keys.size, 2)
})

test('native replacement failure after a lost capture restore preserves the old owner configuration', async () => {
  const first = await api.savePluginShortcut(input('Control+1'))
  const capture = api.beginShortcutCapture(12)
  state.blocked.add('Control+1')
  api.endShortcutCapture(capture, 12)
  const result = await api.savePluginShortcut(input('Control+1', 'shell', { pluginId: 'two', overrideToken: api.probePluginShortcut('Control+1').overrideToken }))
  assert.equal(result.ok, false)
  assert.deepEqual(state.bindings, [first.binding])
  assert.equal(api.getHotkeyOwner('Control+1').id, first.binding.id)
})

test('Wayland probe is silent and successful submission stays pending until the real shortcut fires', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')
  const previousSession = process.env.XDG_SESSION_TYPE
  Object.defineProperty(process, 'platform', { value: 'linux' })
  process.env.XDG_SESSION_TYPE = 'wayland'
  try {
    const probe = api.probeHotkey('Control+1')
    assert.equal(probe.free, true)
    assert.match(probe.hint, /尚未检查系统占用/)
    assert.deepEqual(state.registerCalls, [])
    const quick = api.saveQuickHotkeys({ hotkeys: ['Control+1'], activeHotkey: 'Control+1' })
    assert.equal(quick.systemConfirmationRequired, true)
    assert.deepEqual(quick.registered, [])
    const plugin = await api.savePluginShortcut(input('Control+2'))
    assert.equal(plugin.snapshot.states[0].status, 'pending-system')
    state.keys.get('Control+1')(); state.keys.get('Control+2')(); await flush()
    assert.equal(api.getQuickHotkeyConfig().systemConfirmationRequired, false)
    assert.deepEqual(api.getQuickHotkeyConfig().registered, ['Control+1'])
    assert.equal(api.getPluginShortcuts().states[0].status, 'registered')
  } finally {
    Object.defineProperty(process, 'platform', descriptor)
    if (previousSession === undefined) delete process.env.XDG_SESSION_TYPE; else process.env.XDG_SESSION_TYPE = previousSession
  }
})

test('invalid Quick patches cannot bypass validation through a valid replacement confirmation', async () => {
  api.initQuickHotkeys()
  const saved = await api.savePluginShortcut(input('Control+1'))
  const token = api.probeHotkey('Control+1').conflict.overrideToken
  const previous = structuredClone(state.quick)
  for (const patch of [null, [], { enabled: 'true' }, { enabled: 1 }, { activeHotkey: {} }, { hotkeys: 'Control+1' }, { overrideToken: {} }]) {
    const request = patch && !Array.isArray(patch) ? { hotkeys: ['Control+1'], activeHotkey: 'Control+1', overrideToken: token, ...patch } : patch
    assert.equal(api.saveQuickHotkeys(request).ok, false)
    assert.equal(api.applyQuickHotkeys(request).ok, false)
    assert.deepEqual(state.quick, previous)
    assert.deepEqual(state.bindings, [saved.binding])
  }
  assert.equal(api.saveQuickHotkeys({ hotkeys: ['Control+1'], activeHotkey: 'Control+1', overrideToken: token }).ok, true)
})

test('failed Quick replacement returns a fresh confirmation that can be retried immediately', async () => {
  api.initQuickHotkeys()
  const saved = await api.savePluginShortcut(input('Control+1'))
  const originalToken = api.probeHotkey('Control+1').conflict.overrideToken
  state.writeFailure = true
  const failed = api.saveQuickHotkeys({ hotkeys: ['Control+1'], activeHotkey: 'Control+1', overrideToken: originalToken })
  assert.equal(failed.ok, false)
  assert.equal(failed.probe.ownerBindingId, saved.binding.id)
  assert.ok(failed.probe.overrideToken)
  assert.notEqual(failed.probe.overrideToken, originalToken)
  state.writeFailure = false
  assert.equal(api.saveQuickHotkeys({ hotkeys: ['Control+1'], activeHotkey: 'Control+1', overrideToken: failed.probe.overrideToken }).ok, true)
})
