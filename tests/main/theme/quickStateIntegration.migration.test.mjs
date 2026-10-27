import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

const normalize = value => JSON.parse(JSON.stringify(value))

function compile(file, dependencies = {}) {
  const source = readFileSync(new URL(file, new URL("../../../src/main/theme/", import.meta.url)), 'utf8')
  const { outputText } = ts.transpileModule(source, {
    fileName: file,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  })
  const module = { exports: {} }
  const require = name => {
    if (!Object.hasOwn(dependencies, name)) throw new Error(`Unexpected fixture dependency: ${name}`)
    return dependencies[name]
  }
  const execute = vm.runInNewContext(`(function(require, module, exports) {\n${outputText}\n})`, {}, { filename: file })
  execute(require, module, module.exports)
  return module.exports
}

function handlers() {
  const callbacks = new Map(), events = new Map(), calls = []
  const builtin = { source: 'enest.builtin', packId: 'default' }
  const remote = { source: 'fixture.theme', packId: 'first' }
  const alternate = { source: 'fixture.theme', packId: 'second' }
  const owners = new Map([['active-first', remote], ['active-second', alternate]])
  const snapshots = new Map()
  const namespace = owner => `${owner.source}/${owner.packId}`
  const legacy = { opaqueBackup: ['not interpreted by the host'] }
  const state = {
    quickWindow: { webContents: { id: 41 } },
    quickPlugin: 'fixture.plugin',
    contentsDestroyed: false,
    valid: true,
    appError: null,
    appGate: null,
    pluginResult: { ok: true },
    scanResult: { apps: [], complete: true, errors: [] },
    identityError: false,
    writeError: null,
    writeResult: { revision: 8, value: { committed: true } },
  }
  const contents = {
    isDestroyed: () => state.contentsDestroyed,
    focus: () => calls.push(['contents-focus']),
    sendInputEvent: event => calls.push(['input', event]),
  }
  const dependencies = {
    electron: { ipcMain: {} },
    '@main/ipc/ipcSecurity': {
      handleShellIpc: (channel, handler) => callbacks.set(channel, handler),
      onShellIpc: (channel, handler) => events.set(channel, handler),
    },
    '@shared/types/ipc': { IpcChannels: new Proxy({}, { get: (_target, key) => key }) },
    '@main/window/createQuickWindow': {
      getQuickWindow: () => state.quickWindow,
      hideQuickWindow: () => calls.push(['hide']),
      setQuickContentHeight: height => calls.push(['height', height]),
      toggleQuickWindow: () => calls.push(['toggle']),
    },
    '@main/plugin/quickInputService': { getQuickInputState: () => null, handleQuickInput: () => true },
    '@main/launcher/pluginLauncher': {
      launchPlugin: async request => {
        calls.push(['plugin-launch', request])
        return state.pluginResult
      },
    },
    '@main/hotkey/quickHotkey': {
      saveQuickHotkeys: () => true, getQuickHotkeyConfig: () => ({}), probeHotkey: () => ({}),
    },
    '@main/launcher/appScanner': {
      scanApplications: async force => {
        calls.push(['scan', force])
        return state.scanResult
      },
    },
    '@main/launcher/commandIndex': {
      searchQuickCommands: async () => [],
      validateQuickOpenTarget: async request => {
        calls.push(['validate', request])
        return state.valid
      },
      quickOpenedIdentity: request => {
        calls.push(['identity', request])
        if (state.identityError) throw new Error('private store unavailable')
        return 'opaque-native-state-key'
      },
    },
    '@main/launcher/appLauncher': {
      launchLocalApp: async path => {
        calls.push(['app-launch', path])
        if (state.appGate) await state.appGate()
        if (state.appError) throw new Error(state.appError)
      },
    },
    '@main/plugin/PluginHost': {
      pluginHost: {
        dismissQuickPlugin: id => calls.push(['dismiss', id]),
        pinToShell: id => calls.push(['pin', id]),
        getQuickPlugin: () => state.quickPlugin,
        getWebContents: () => contents,
      },
    },
    '@main/settings/SettingsStore': {
      settingsStore: { getQuickLauncherSettings: () => { calls.push(['legacy']); return legacy } },
    },
    '@main/window/createShellWindow': {
      getMainWindow: () => ({
        isDestroyed: () => false, isMinimized: () => false,
        show: () => calls.push(['main-show']), focus: () => calls.push(['main-focus']),
      }),
      sendShellEvent: event => calls.push(['shell-event', event]),
    },
    '@main/logs/logService': {
      logError: (...args) => calls.push(['error', ...args]), logInfo: () => {},
    },
    '@main/theme/quickThemeProtocol': {
      consumeQuickThemeGesture: () => false,
      getQuickThemeConfig: () => null,
      getQuickThemeStateOwner: key => { calls.push(['resolve-owner', key]); return owners.get(key) ?? null },
    },
    '@main/theme/quickStateService': {
      quickProviderStates: {
        read: owner => {
          calls.push(['read', owner])
          return structuredClone(snapshots.get(namespace(owner)) ?? { revision: 0, value: null })
        },
        write: (owner, expectedRevision, value) => {
          calls.push(['write', owner, expectedRevision, value])
          if (state.writeError) throw state.writeError
          return state.writeResult
        },
        encodeIdentities: identities => {
          calls.push(['encode', identities])
          return identities.map((_value, index) => `opaque-key-${index}`)
        },
      },
    },
  }
  compile('../ipc/quickHandlers.ts', dependencies).registerQuickHandlers()
  return {
    state, calls, owners, snapshots, builtin, remote, alternate, legacy, namespace,
    invoke: (channel, request, sender = 41) => callbacks.get(channel)({ sender: { id: sender } }, request),
    read: (providerKey = null, sender = 41) => callbacks.get('QuickProviderState')(
      { sender: { id: sender } }, { providerKey, operation: 'read' }),
    open: request => callbacks.get('QuickOpen')({ sender: { id: 41 } }, request),
  }
}

function frame(script, kind = 'quick') {
  const events = new Map(), timers = new Map(), sent = []
  const key = 'a'.repeat(64), generation = 'fixture_generation_0123456789'
  const parent = { postMessage() {} }
  const window = {
    parent,
    addEventListener: (name, handler) => events.set(name, handler),
    removeEventListener: (name, handler) => { if (events.get(name) === handler) events.delete(name) },
  }
  const port = {
    postMessage: message => sent.push(normalize(message)),
    start() {},
    close() { this.closed = true },
  }
  let nextTimer = 0
  const context = vm.createContext({
    window, location: { pathname: `/${key}/assets/provider.html`, hash: `#generation=${generation}` },
    URLSearchParams, TextEncoder, structuredClone, __port: port,
    setTimeout: callback => { const id = ++nextTimer; timers.set(id, callback); return id },
    clearTimeout: id => timers.delete(id),
  })
  vm.runInContext(script, context)
  events.get('message')({ source: parent, data: { type: `enest-${kind}:port`, key, generation }, ports: [port] })
  const run = expression => vm.runInContext(expression, context)
  return {
    run, sent, timers, port,
    respond(result, overrides = {}) {
      const request = sent.findLast(message => message.type === 'action')
      context.__response = JSON.stringify({ type: 'action-result', id: request.id, generation, result, ...overrides })
      // Browser MessagePort delivery creates values in the receiving realm.
      run('__port.onmessage({ data: JSON.parse(__response) })')
    },
    close: () => events.get('pagehide')(),
  }
}

const bridges = compile('./quickThemeBridge.ts')

test('Quick private state accepts only the exact live Quick sender and a valid request envelope', () => {
  const f = handlers()
  assert.throws(() => f.read(null, 42), /Quick state controller rejected/)
  f.state.quickWindow = null
  assert.throws(() => f.read(), /Quick state controller rejected/)
  f.state.quickWindow = { webContents: { id: 41 } }
  for (const request of [null, [], {}, { providerKey: 9, operation: 'read' },
    { providerKey: 'x'.repeat(129), operation: 'read' }]) {
    assert.throws(() => f.invoke('QuickProviderState', request), /Invalid Quick state request/)
  }
  assert.equal(f.calls.some(([name]) => name === 'read'), false)
})

test('provider state resolves builtin and remote namespaces without accepting caller-supplied owners', () => {
  const f = handlers()
  for (const [owner, label] of [[f.builtin, 'builtin'], [f.remote, 'first'], [f.alternate, 'second']]) {
    f.snapshots.set(f.namespace(owner), { revision: 3, value: { label } })
  }
  assert.deepEqual(normalize(f.read()), { revision: 3, value: { label: 'builtin' } })
  assert.deepEqual(normalize(f.read('active-first')), { revision: 3, value: { label: 'first' } })
  assert.deepEqual(normalize(f.invoke('QuickProviderState', {
    providerKey: 'active-second', operation: 'read', owner: f.builtin,
  })), { revision: 3, value: { label: 'second' } })
  assert.deepEqual(normalize(f.calls.filter(([name]) => name === 'read').map(([, owner]) => owner)),
    [f.builtin, f.remote, f.alternate])
})

test('legacy settings are exposed only to the builtin provider at revision zero', () => {
  const f = handlers()
  assert.deepEqual(normalize(f.read()), { revision: 0, value: null, legacy: f.legacy })
  assert.deepEqual(normalize(f.read('active-first')), { revision: 0, value: null })
  f.snapshots.set(f.namespace(f.builtin), { revision: 1, value: { imported: true } })
  assert.deepEqual(normalize(f.read()), { revision: 1, value: { imported: true } })
  assert.equal(f.calls.filter(([name]) => name === 'legacy').length, 1)
})

test('retired provider keys and unknown state operations cannot read or mutate another namespace', () => {
  const f = handlers()
  f.owners.delete('active-first')
  assert.throws(() => f.read('active-first'), /Quick state provider retired/)
  assert.throws(() => f.read('unknown-provider'), /Quick state provider retired/)
  assert.throws(() => f.invoke('QuickProviderState', { providerKey: null, operation: 'erase' }), /Invalid Quick state operation/)
  assert.equal(f.calls.some(([name]) => name === 'read' || name === 'write'), false)
})

test('legacy identity encoding is builtin-only and rejects invalid or oversized inputs before storage', () => {
  const f = handlers()
  const encode = (identities, providerKey = null) => f.invoke('QuickProviderState', { providerKey, operation: 'keys', identities })
  assert.throws(() => encode(['plugin:fixture'], 'active-first'), /Quick identity encoding rejected/)
  for (const identities of [null, 'plugin:fixture', Array(257).fill('id'), [''], [7], ['x'.repeat(4097)]]) {
    assert.throws(() => encode(identities), /Quick identity encoding rejected/)
  }
  assert.equal(f.calls.some(([name]) => name === 'encode'), false)
  const identities = Array(256).fill('x'.repeat(4096))
  const result = encode(identities)
  assert.equal(result.keys.length, 256)
  assert.equal(f.calls.find(([name]) => name === 'encode')[1], identities)
})

test('state writes pass CAS revision and opaque values to the resolved owner and propagate conflicts', () => {
  const f = handlers()
  const value = { providerSchema: 3, items: [{ key: 'opaque-key' }] }
  const write = providerKey => f.invoke('QuickProviderState', {
    providerKey, operation: 'write', expectedRevision: 7, value,
  })
  assert.equal(write('active-first'), f.state.writeResult)
  const call = f.calls.find(([name]) => name === 'write')
  assert.equal(call[1], f.remote)
  assert.equal(call[2], 7)
  assert.equal(call[3], value)
  assert.equal(write(null), f.state.writeResult)
  assert.deepEqual(normalize(f.calls.filter(([name]) => name === 'write').at(-1)[1]), f.builtin)
  const conflict = new Error('Quick provider state revision conflict')
  f.state.writeError = conflict
  assert.throws(() => write('active-first'), error => error === conflict)
})

test('an app open returns a native success fact only after the real launcher promise completes', async () => {
  const f = handlers()
  let entered, release
  const started = new Promise(resolve => { entered = resolve })
  const gate = new Promise(resolve => { release = resolve })
  f.state.appGate = async () => { entered(); await gate }
  const pending = f.open({ kind: 'app', path: '/fixture/application' })
  await started
  assert.equal(f.calls.some(([name]) => name === 'identity'), false)
  release()
  const result = await pending
  assert.equal(result.ok, true)
  assert.equal(result.opened.stateKey, 'opaque-native-state-key')
  assert.ok(Number.isSafeInteger(result.opened.at) && result.opened.at > 0)
  assert.deepEqual(f.calls.filter(([name]) => ['app-launch', 'hide', 'identity'].includes(name)).map(([name]) => name),
    ['app-launch', 'hide', 'identity'])
})

test('successful plugin and native action opens return facts after completing the actual operation', async () => {
  const f = handlers()
  const result = await f.open({ kind: 'plugin', pluginId: 'fixture.plugin', code: 'main', container: 'shell', type: 'text', payload: 'query' })
  assert.equal(result.ok, true)
  assert.equal(result.tabId, 'fixture.plugin')
  assert.equal(result.opened.stateKey, 'opaque-native-state-key')
  assert.deepEqual(normalize(f.calls.find(([name]) => name === 'plugin-launch')[1]), {
    pluginId: 'fixture.plugin', source: 'quick', enter: { code: 'main', type: 'text', payload: 'query' }, mode: 'shell',
  })
  for (const action of ['open-settings', 'open-market', 'refresh-apps']) {
    f.calls.length = 0
    const opened = await f.open({ kind: 'action', action })
    assert.equal(opened.ok, true)
    assert.equal(opened.opened.stateKey, 'opaque-native-state-key')
    const completed = f.calls.findIndex(([name]) => action === 'refresh-apps' ? name === 'scan' : name === 'shell-event')
    assert.ok(completed >= 0 && completed < f.calls.findIndex(([name]) => name === 'identity'))
  }
})

test('unavailable targets, native launch failures and incomplete scans never produce an opened fact', async () => {
  const cases = [
    { request: { kind: 'app', path: '/fixture/application' }, configure: f => { f.state.valid = false } },
    { request: { kind: 'app', path: '/fixture/application' }, configure: f => { f.state.appError = 'launch failed' } },
    { request: { kind: 'plugin', pluginId: 'fixture.plugin' }, configure: f => { f.state.pluginResult = { ok: false, error: 'not mounted' } } },
    { request: { kind: 'action', action: 'refresh-apps' }, configure: f => { f.state.scanResult = { apps: [], complete: false, errors: ['scan failed'] } } },
  ]
  for (const { request, configure } of cases) {
    const f = handlers()
    configure(f)
    const result = await f.open(request)
    assert.equal(result.ok, false)
    assert.equal(Object.hasOwn(result, 'opened'), false)
    assert.equal(f.calls.some(([name]) => name === 'identity'), false)
    if (!f.state.valid) assert.equal(f.calls.some(([name]) => name === 'app-launch'), false)
  }
})

test('escape, pin and Tab remain lifecycle interactions rather than new open facts', async () => {
  for (const kind of ['plugin-escape', 'plugin-pin', 'plugin-tab']) {
    const f = handlers()
    const result = await f.open({ kind, pluginId: 'fixture.plugin', shift: true })
    assert.equal(result.ok, true)
    assert.equal(Object.hasOwn(result, 'opened'), false)
    assert.equal(f.calls.some(([name]) => name === 'identity'), false)
    if (kind === 'plugin-escape') assert.ok(f.calls.some(([name]) => name === 'dismiss'))
    if (kind === 'plugin-pin') assert.ok(f.calls.some(([name]) => name === 'pin'))
    if (kind === 'plugin-tab') assert.deepEqual(normalize(f.calls.filter(([name]) => name === 'input').map(([, event]) => event)), [
      { type: 'keyDown', keyCode: 'Tab', modifiers: ['shift'] }, { type: 'keyUp', keyCode: 'Tab', modifiers: ['shift'] },
    ])
  }
  const f = handlers()
  f.state.quickPlugin = 'another.plugin'
  assert.equal((await f.open({ kind: 'plugin-tab', pluginId: 'fixture.plugin' })).ok, false)
  assert.equal(f.calls.some(([name]) => name === 'identity' || name === 'input'), false)
})

test('a private identity failure does not retroactively fail a completed native launch', async () => {
  const f = handlers()
  f.state.identityError = true
  const result = await f.open({ kind: 'app', path: '/fixture/application' })
  assert.equal(result.ok, true)
  assert.equal(result.opened, undefined)
  assert.ok(f.calls.some(([name]) => name === 'app-launch'))
  assert.ok(f.calls.some(([name, , message]) => name === 'error' && /identity unavailable/.test(message)))
})

test('the real Quick bridge reads and CAS-writes private state without exposing legacy or owner metadata', async () => {
  const f = frame(bridges.QUICK_THEME_BRIDGE_SOURCE)
  try {
    assert.equal(f.run('Object.isFrozen(window.enestQuick.state)'), true)
    const read = f.run('window.enestQuick.state.read()')
    assert.deepEqual(f.sent.at(-1).action, { type: 'state-read' })
    f.respond({ ok: true, state: { revision: 4, value: { items: ['opaque-key'] }, legacy: { secret: true }, owner: 'private-owner' } })
    assert.deepEqual(normalize(await read), { revision: 4, value: { items: ['opaque-key'] } })
    const write = f.run('window.enestQuick.state.write({ schema: 2, selected: ["opaque-key"] }, 4)')
    assert.deepEqual(f.sent.at(-1).action, { type: 'state-write', expectedRevision: 4, value: { schema: 2, selected: ['opaque-key'] } })
    f.respond({ ok: true, state: { revision: 5, value: { schema: 2, selected: ['opaque-key'] } } })
    assert.deepEqual(normalize(await write), { revision: 5, value: { schema: 2, selected: ['opaque-key'] } })
    assert.equal(f.timers.size, 0)
  } finally { f.close() }
})

test('the real Quick bridge rejects malformed or oversized state before issuing a write', async () => {
  const f = frame(bridges.QUICK_THEME_BRIDGE_SOURCE)
  try {
    const expressions = [
      'window.enestQuick.state.write({}, -1)',
      'window.enestQuick.state.write({}, Number.MAX_SAFE_INTEGER + 1)',
      'window.enestQuick.state.write({ invalid: undefined }, 0)',
      'window.enestQuick.state.write({ invalid: Infinity }, 0)',
      'window.enestQuick.state.write(new Date(0), 0)',
      'window.enestQuick.state.write([, 1], 0)',
      'window.enestQuick.state.write({ constructor: "forbidden" }, 0)',
      'window.enestQuick.state.write({ text: "x".repeat(128 * 1024) }, 0)',
      'window.enestQuick.state.write(Array(10000).fill(null), 0)',
      '(() => { let value = null; for (let i = 0; i < 22; i++) value = { child: value }; return window.enestQuick.state.write(value, 0) })()',
    ]
    for (const expression of expressions) await assert.rejects(f.run(expression), /Invalid Quick private state/)
    assert.equal(f.sent.some(message => message.type === 'action'), false)
    assert.equal(f.timers.size, 0)
  } finally { f.close() }
})

test('Quick private-state responses reject malformed snapshots and ignore retired generations', async () => {
  const f = frame(bridges.QUICK_THEME_BRIDGE_SOURCE)
  try {
    let settled = false
    const read = f.run('window.enestQuick.state.read()').then(value => { settled = true; return value })
    f.respond({ ok: true, state: { revision: 1, value: { stale: true } } }, { generation: 'retired_generation_0123456789' })
    await Promise.resolve()
    assert.equal(settled, false)
    f.respond({ ok: true, state: { revision: 2, value: { current: true } } })
    assert.deepEqual(normalize(await read), { revision: 2, value: { current: true } })
    const malformed = f.run('window.enestQuick.state.read()')
    f.respond({ ok: true, state: { revision: -1, value: { invalid: true } } })
    await assert.rejects(malformed, /Quick private state unavailable/)
    const conflict = f.run('window.enestQuick.state.write({ changed: true }, 2)')
    f.respond({ ok: false, error: 'Quick state revision conflict' })
    await assert.rejects(conflict, /Quick state revision conflict/)
  } finally { f.close() }
})

test('the real Settings bridge has no private-state API and strips state from action responses', async () => {
  const f = frame(bridges.SETTINGS_THEME_BRIDGE_SOURCE, 'settings')
  try {
    assert.equal(f.run('Object.hasOwn(window.enestSettings, "state")'), false)
    assert.equal(f.run('typeof window.enestSettings.state'), 'undefined')
    const pending = f.run('window.enestSettings.action({ type: "native", section: "general" })')
    f.respond({ ok: true, state: { revision: 7, value: { privateQuickData: 'must not escape' } }, legacy: { secret: true } })
    assert.deepEqual(normalize(await pending), { ok: true })
    assert.equal(f.timers.size, 0)
  } finally { f.close() }
})
