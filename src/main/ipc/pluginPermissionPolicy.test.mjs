import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import ts from 'typescript'

const require = createRequire(import.meta.url)
const root = new URL('../../../', import.meta.url)

function fixture() {
  const pluginId = 'com.test.permissions', handlers = new Map(), calls = [], grants = new Map(), saved = new Map()
  const control = { allow: true, confirm: true, confirmations: [], wait: null, closed: 0, requested: [], sections: [], settings: {} }
  const shell = { id: 2 }, sender = { id: 1, mainFrame: { url: `enest://plugin/${pluginId}/index.html` } }
  const event = { sender, senderFrame: sender.mainFrame }, shellEvent = { sender: shell }
  const manifest = { id: pluginId, name: 'Permissions fixture', version: '1.0.0', main: 'index.html', permissions: [] }
  const mocks = {
    electron: {
      ipcMain: { handle: (name, fn) => handlers.set(name, fn), on() {} },
      dialog: { showMessageBox: async (_win, options) => {
        control.confirmations.push(options)
        return { response: control.confirm ? 1 : 0 }
      } }
    },
    '@main/ipc/ipcSecurity': { handleShellIpc: (name, fn) => handlers.set(name, fn) },
    '@main/logs/logService': { logInfo() {}, logWarn() {} },
    '@main/plugin/PluginRegistry': { pluginRegistry: { get: () => ({ manifest }), getManifest: () => manifest } },
    '@main/plugin/PluginHost': { pluginHost: {
      getPluginIdByWebContentsId: id => id === sender.id ? pluginId : undefined,
      getManifestForWebContents: id => id === sender.id ? manifest : null,
      getContainerWindow: () => ({ isDestroyed: () => false }),
      acquireWindowInteraction: () => () => {},
      setTitle: (id, title) => { calls.push({ method: 'title', id, title }); return true },
      closePlugin: async () => { control.closed++ }
    } },
    '@main/settings/SettingsStore': { settingsStore: {
      getPermissionGrant: (_id, permission) => grants.get(permission) || 'ask',
      setPermissionGrant: async (_id, permission, value) => { grants.set(permission, value) },
      getPermissionGrants: () => Object.fromEntries(grants),
      getPluginSettings: () => control.settings,
      setPluginSetting: async (_id, key, value) => { control.settings[key] = value }
    } },
    '@main/plugin/PermissionService': {
      normalizeGrant: value => ['allow', 'deny'].includes(value) ? value : 'ask',
      permissionService: {
        request: async (id, permission) => { control.requested.push({ id, permission }); if (control.wait) await control.wait; return control.allow },
        cancelFor() {}, resolveRequest: () => false
      }
    },
    '@main/plugin/localFiles': {
      readLocalFile: (id, args) => { calls.push({ method: 'readLocalFile', id, args }); return 'selected file' },
      pickLocalFiles: (id, args) => { calls.push({ method: 'pickLocalFiles', id, args }); return [{ handleId: 'selected' }] },
      pickLocalSaveFile: (id, args) => { calls.push({ method: 'pickLocalSaveFile', id, args }); return { handleId: 'save-selected' } }
    },
    '@main/plugin/quickInputService': { bindQuickInputHost: host => { control.quickInputHost = host } },
    '@main/plugin/pluginFiles': {
      savePluginFile: (id, args) => { calls.push({ method: 'savePluginFile', id, args }); return { ok: true, path: '/selected/export.txt' } }
    },
    '@main/timer/focusTimerService': Object.fromEntries(
      ['startFocusTimer', 'getFocusTimer', 'pauseFocusTimer', 'resumeFocusTimer', 'skipFocusTimer', 'stopFocusTimer', 'updateFocusTimerRecord'].map(method =>
        [method, (id, ...args) => { calls.push({ method, id, args }); return { state: { status: 'fixture' }, records: [] } }]
      )
    ),
    '@main/config/agentConfigService': {
      agentApps: () => { calls.push({ method: 'agentApps' }); return [{ id: 'codex' }] },
      agentRead: (id, args) => { calls.push({ method: 'agentRead', id, args }); return 'agent configuration' },
      ...Object.fromEntries(['agentWrite', 'agentWriteAssets', 'agentRestore', 'agentDeleteAssets'].map(method =>
        [method, (id, args) => { calls.push({ method, id, args }); return { ok: true } }]
      ))
    },
    '@main/plugin/pluginBackendRpc': { callPluginBackend: (id, method, args) => { calls.push({ method: 'backend', id, backendMethod: method, args }); return { done: true } } },
    '@main/database/dbSessionManager': {
      dbDialectsList: id => { calls.push({ method: 'dbDialectsList', id }); return [{ id: 'sqlite' }] },
      dbWorkbenchRpc: (id, args) => { calls.push({ method: 'dbWorkbenchRpc', id, args }); return { action: args.action } }
    },
    '@main/db/pluginStorage': {
      initPluginStorage() {},
      setPluginStorageValue: (id, key, value) => saved.set(id + ':' + key, value),
      getPluginStorageValue: (id, key) => saved.get(id + ':' + key)
    },
    '@main/theme/themePacks': { themePackRegistry: { registerPlugin: async (pack, source) => { const saved = { ...pack, source }; calls.push({ method: 'theme', pack: saved }); return saved } } },
    '@main/settings/PluginSettingsBridge': { pluginSettingsBridge: {
      register: (id, section) => control.sections.push({ ...section, pluginId: id }),
      listAll: () => control.sections,
      get: (_id, key) => control.settings[key],
      set: (_id, key, value) => { control.settings[key] = value }
    } },
    '@main/window/createShellWindow': { getShellWebContents: () => shell, sendShellEvent() {} },
    '@main/window/createQuickWindow': { acquireQuickInteraction: () => () => {} },
    '@main/clipboard/clipboardHistory': {
      revalidateClipboardPolling() {},
      onClipboardHistoryChange: callback => { control.clipboardHistoryChange = callback }
    }
  }
  const real = new Map([
    ['@shared/types/plugin', 'src/shared/types/plugin.ts'],
    ['@shared/types/ipc', 'src/shared/types/ipc.ts'],
    ['@shared/constants', 'src/shared/constants.ts'],
    ['@shared/pluginPermissionPolicy', 'src/shared/pluginPermissionPolicy.ts'],
    ['@shared/pluginSettingsKeys', 'src/shared/pluginSettingsKeys.ts'],
    ['@main/plugin/PluginRuntimeScope', 'src/main/plugin/PluginRuntimeScope.ts'],
    ['@main/plugin/pluginSessionPolicy', 'src/main/plugin/pluginSessionPolicy.ts'],
    ['@main/plugin/PluginPermissions', 'src/main/plugin/PluginPermissions.ts'],
    ['@main/ipc/pluginToolsHandlers', 'src/main/ipc/pluginToolsHandlers.ts'],
    ['@main/database/workbench', 'src/main/database/workbench.ts']
  ])
  const cache = new Map()
  function load(path) {
    if (cache.has(path)) return cache.get(path)
    const source = ts.transpileModule(readFileSync(new URL(path, root), 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
    }).outputText
    const module = { exports: {} }
    cache.set(path, module.exports)
    new Function('require', 'module', 'exports', source)(name => {
      if (name in mocks) return mocks[name]
      if (real.has(name)) return load(real.get(name))
      if (name.startsWith('@main/')) return {}
      return require(name)
    }, module, module.exports)
    return module.exports
  }
  const scopes = load(real.get('@main/plugin/PluginRuntimeScope'))
  const scope = scopes.createRuntimeScope({ pluginId, generation: 1, wcId: sender.id })
  const permissions = load(real.get('@main/plugin/PluginPermissions'))
  const channels = load(real.get('@shared/types/ipc')).IpcChannels
  load('src/main/ipc/pluginHandlers.ts').registerPluginHandlers()
  return {
    pluginId, manifest, grants, calls, control, scope, event, shellEvent, permissions,
    builtin: load(real.get('@shared/pluginPermissionPolicy')).BUILTIN_PLUGIN_CAPABILITIES,
    call: (method, args = [], ev = event, requestedId) => handlers.get(channels.PluginCall)(ev, { method, args, pluginId: requestedId }),
    setGrant: (permission, grant) => handlers.get(channels.PermissionGrantsSet)(shellEvent, { pluginId, permission, grant })
  }
}

test('a plugin with no permissions can use built-in storage/title/theme despite old denials', async () => {
  const f = fixture()
  try {
    for (const permission of f.builtin) {
      f.grants.set(permission, 'deny')
      assert.equal(f.permissions.hasPermission(f.manifest, permission), true)
    }
    assert.deepEqual(await f.call('storage.set', ['draft', 'local data']), { ok: true, data: true })
    assert.deepEqual(await f.call('storage.get', ['draft']), { ok: true, data: 'local data' })
    assert.equal((await f.call('ui.setTitle', ['Draft'])).ok, true)
    const result = await f.call('theme.register', [{ id: 'fixture', source: 'forged-source', tokens: { '--accent': '#eee' } }])
    assert.equal(result.data.source, f.pluginId)
    assert.deepEqual(f.control.requested, [])
  } finally { await f.scope.dispose() }
})

test('user-selected file and export routes need no declarations or repeated consent and keep the verified owner', async () => {
  const f = fixture()
  try {
    f.grants.set('fs.read', 'deny')
    f.grants.set('fs.write', 'deny')
    const routes = [
      ['localFiles.read', { handleId: 'selected', encoding: 'text' }, 'readLocalFile', 'selected file'],
      ['localFiles.pick', { access: 'read' }, 'pickLocalFiles', [{ handleId: 'selected' }]],
      ['localFiles.pick', { access: 'write' }, 'pickLocalFiles', [{ handleId: 'selected' }]],
      ['localFiles.pickSave', { defaultName: 'draft.txt' }, 'pickLocalSaveFile', { handleId: 'save-selected' }],
      ['shell.saveFile', { filename: 'export.txt', content: 'export' }, 'savePluginFile', { ok: true, path: '/selected/export.txt' }],
      ['shell.saveTextFile', { defaultName: 'notes.txt', content: 'notes' }, 'savePluginFile', { ok: true, path: '/selected/export.txt' }]
    ]
    for (const [method, args, service, data] of routes) {
      assert.deepEqual(await f.call(method, [args]), { ok: true, data }, method)
      assert.deepEqual(f.calls.at(-1), { method: service, id: f.pluginId, args }, method)
    }
    assert.deepEqual(f.manifest.permissions, [])
    assert.deepEqual(f.control.requested, [])
    const count = f.calls.length
    assert.equal((await f.call('localFiles.read', [{ handleId: 'selected' }], f.event, 'com.other.plugin')).error, 'plugin id mismatch')
    assert.equal((await f.call('shell.saveFile', [routes[4][1]], { ...f.event, senderFrame: { url: f.event.sender.mainFrame.url } })).error, 'unauthorized sender')
    f.scope.markClosing()
    assert.match((await f.call('localFiles.pickSave', [{}])).error, /closing or stale/)
    assert.equal(f.calls.length, count, 'identity and runtime checks run before file services')
  } finally { await f.scope.dispose() }
})

test('plugin-owned focus timer routes need no timer grant and receive only the verified plugin identity', async () => {
  const f = fixture()
  try {
    f.grants.set('timer.background', 'deny')
    f.grants.set('notify', 'deny')
    assert.equal(typeof f.control.quickInputHost.current, 'function', 'real tool handlers bind their host')
    assert.equal(typeof f.control.clipboardHistoryChange, 'function')
    assert.equal((await f.call('focusTimer.start', [{ task: 'Draft', focusMin: 25 }])).ok, true)
    assert.deepEqual(f.calls.at(-1), {
      method: 'startFocusTimer', id: f.pluginId, args: [{ task: 'Draft', focusMin: 25, notify: false }]
    }, 'an undeclared notification capability is disabled without prompting')
    for (const [method, service] of [
      ['focusTimer.get', 'getFocusTimer'], ['focusTimer.pause', 'pauseFocusTimer'],
      ['focusTimer.resume', 'resumeFocusTimer'], ['focusTimer.skip', 'skipFocusTimer'],
      ['focusTimer.stop', 'stopFocusTimer']
    ]) {
      assert.equal((await f.call(method)).ok, true, method)
      assert.deepEqual(f.calls.at(-1), { method: service, id: f.pluginId, args: [] })
    }
    const patch = { task: 'Revised task', counted: false }
    assert.equal((await f.call('focusTimer.updateRecord', ['record-1', patch])).ok, true)
    assert.deepEqual(f.calls.at(-1), { method: 'updateFocusTimerRecord', id: f.pluginId, args: ['record-1', patch] })
    assert.deepEqual(f.manifest.permissions, [])
    assert.deepEqual(f.control.requested, [])
  } finally { await f.scope.dispose() }
})

test('application availability needs no grant; database metadata requires backend consent but no connection grant', async () => {
  const f = fixture()
  try {
    f.grants.set('config.agent.read', 'deny')
    f.grants.set('db.connect', 'deny')
    assert.deepEqual(await f.call('agent.apps'), { ok: true, data: [{ id: 'codex' }] })
    assert.deepEqual(await f.call('db.dialects.list'), { ok: false, error: 'permission denied: backend.node' })
    f.manifest.permissions.push('backend.node')
    assert.deepEqual(await f.call('db.dialects.list'), { ok: true, data: [{ id: 'sqlite' }] })
    assert.deepEqual(await f.call('db.workbench', [{ action: 'drivers.list' }]), { ok: true, data: { action: 'drivers.list' } })
    assert.deepEqual(f.calls, [
      { method: 'agentApps' },
      { method: 'dbDialectsList', id: f.pluginId },
      { method: 'dbWorkbenchRpc', id: f.pluginId, args: { action: 'drivers.list' } }
    ])
    assert.deepEqual(f.manifest.permissions, ['backend.node'])
    assert.deepEqual(f.control.requested, [{ id: f.pluginId, permission: 'backend.node' }, { id: f.pluginId, permission: 'backend.node' }])
  } finally { await f.scope.dispose() }
})

test('database workbench connection and execution retain their distinct sensitive permissions', async () => {
  const f = fixture()
  try {
    f.manifest.permissions.push('backend.node')
    for (const [action, permission] of [['test', 'db.connect'], ['execute', 'db.query']]) {
      const input = { action, profileId: 'fixture-profile' }
      const count = f.calls.length
      f.grants.set(permission, 'allow')
      assert.deepEqual(await f.call('db.workbench', [input]), { ok: false, error: `permission denied: ${permission}` })
      assert.equal(f.calls.length, count, 'stale grants do not replace the manifest declaration')
      f.grants.delete(permission)
      f.manifest.permissions.push(permission)
      f.control.allow = false
      assert.deepEqual(await f.call('db.workbench', [input]), { ok: false, error: `permission denied: ${permission}` })
      assert.equal(f.calls.length, count)
      assert.deepEqual(f.control.requested.at(-1), { id: f.pluginId, permission })
      f.control.allow = true
      assert.deepEqual(await f.call('db.workbench', [input]), { ok: true, data: { action } })
      assert.deepEqual(f.calls.at(-1), { method: 'dbWorkbenchRpc', id: f.pluginId, args: input })
    }
    assert.equal(f.calls.length, 2)
    assert.match((await f.call('db.workbench', [{ action: 'future-action' }])).error, /Unknown database workbench action/)
    assert.equal(f.calls.length, 2)
  } finally { await f.scope.dispose() }
})

test('sensitive APIs still require declaration and consent before host services run', async () => {
  const f = fixture()
  try {
    assert.deepEqual(await f.call('agent.read', [{ app: 'codex' }]), { ok: false, error: 'permission denied: config.agent.read' })
    assert.deepEqual(await f.call('net.fetch', [{ url: 'https://example.invalid' }]), { ok: false, error: 'permission denied: net.fetch' })
    assert.deepEqual(await f.call('contribute.registerQuickProvider', [{ id: 'global-search' }]), { ok: false, error: 'permission denied: contribute' })
    assert.deepEqual(f.control.requested, [])
    assert.equal(f.permissions.hasPermission(f.manifest, 'future.system.capability'), false)
    f.grants.set('config.agent.read', 'allow')
    assert.equal((await f.call('agent.read', [{ app: 'codex' }])).ok, false, 'a stale saved grant cannot authorize a removed declaration')
    f.grants.delete('config.agent.read')
    f.manifest.permissions.push('config.agent.read')
    f.control.allow = false
    assert.equal((await f.call('agent.read', [{ app: 'codex' }])).ok, false)
    assert.equal(f.calls.length, 0)
    f.control.allow = true
    assert.deepEqual(await f.call('agent.read', [{ app: 'codex' }]), { ok: true, data: 'agent configuration' })
    assert.deepEqual(f.calls.at(-1), { method: 'agentRead', id: f.pluginId, args: 'codex' })
    f.grants.set('config.agent.read', 'deny')
    const count = f.control.requested.length
    assert.equal((await f.call('agent.read', [{ app: 'codex' }])).ok, false)
    assert.equal(f.control.requested.length, count)
    assert.equal(f.calls.length, 1)
  } finally { await f.scope.dispose() }
})

test('built-in capability grant writes are rejected without closing or modifying the plugin', async () => {
  const f = fixture()
  try {
    for (const permission of f.builtin) assert.equal((await f.setGrant(permission, 'deny')).ok, false)
    assert.equal(f.grants.size, 0)
    assert.equal(f.scope.isClosing, false)
    assert.equal(f.control.closed, 0)
    assert.deepEqual(await f.setGrant('config.agent.read', 'deny'), { ok: true })
    assert.equal(f.grants.get('config.agent.read'), 'deny')
    assert.equal(f.scope.isClosing, true)
    assert.equal(f.control.closed, 1)
  } finally { await f.scope.dispose() }
})

test('basic capabilities retain sender/runtime ownership and late sensitive consent is discarded', async () => {
  const f = fixture()
  try {
    assert.equal((await f.call('storage.get', ['draft'], { ...f.event, senderFrame: { url: f.event.sender.mainFrame.url } })).error, 'unauthorized sender')
    assert.equal((await f.call('storage.get', ['draft'], f.event, 'com.other.plugin')).error, 'plugin id mismatch')
    f.manifest.permissions.push('config.agent.read')
    let release
    f.control.wait = new Promise(resolve => { release = resolve })
    const reading = f.call('agent.read', [{ app: 'codex' }])
    await Promise.resolve()
    f.scope.markClosing()
    release()
    assert.match((await reading).error, /closing or stale/)
    assert.equal(f.calls.length, 0)
  } finally { await f.scope.dispose() }
})

test('built-in settings cannot read or overwrite the host permission grants', async () => {
  const f = fixture()
  try {
    // Model a legacy registration and persisted host key, before filtering in
    // the store/bridge. The IPC boundary must still reject the reserved key.
    f.control.settings.permissionGrants = { 'config.agent.read': 'deny' }
    const items = ['permissionGrants', '__proto__', 'constructor', 'prototype', '', 'density'].map(key => ({ key, type: 'text', label: key }))
    assert.equal((await f.call('settings.register', [{ id: 'display', title: 'Display', items }])).ok, true)
    assert.deepEqual(f.control.sections[0].items.map(item => item.key), ['density'])
    f.control.sections[0].items.push({ key: 'permissionGrants', type: 'text' })
    for (const key of ['permissionGrants', '__proto__', 'constructor', 'prototype', '']) {
      assert.deepEqual(await f.call('settings.get', [key]), { ok: false, error: 'reserved plugin settings key' })
      assert.deepEqual(await f.call('settings.set', [key, { 'config.agent.read': 'allow' }]), { ok: false, error: 'reserved plugin settings key' })
    }
    assert.deepEqual(f.control.settings.permissionGrants, { 'config.agent.read': 'deny' })
    assert.deepEqual(f.control.requested, [])
  } finally { await f.scope.dispose() }
})

test('AI configuration and asset writes use consent once without an extra operation dialog', async () => {
  const f = fixture()
  try {
    f.manifest.permissions.push('config.agent.write')
    const input = { app: 'codex', assets: [{ path: 'pets/demo/pet.json', contentText: '{}' }], confirmed: true }
    f.control.allow = false
    assert.equal((await f.call('agent.writeAssets', [input])).ok, false)
    assert.equal(f.calls.length, 0, 'a plugin-supplied confirmed flag cannot replace consent')
    f.grants.set('config.agent.write', 'allow')
    assert.equal((await f.call('agent.writeAssets', [input])).ok, true)
    assert.equal((await f.call('agent.write', [{ app: 'codex', changes: { model: 'example' } }])).ok, true)
    assert.deepEqual(f.calls.map(call => call.method), ['agentWriteAssets', 'agentWrite'])
    assert.ok(f.calls.every(call => call.args.confirmed === true))
    assert.equal(f.control.confirmations.length, 0)
    assert.equal(f.control.requested.length, 1, 'saved consent skips further permission requests')
  } finally { await f.scope.dispose() }
})

test('asset deletion and configuration restore still confirm targets after permission is granted', async () => {
  const f = fixture()
  try {
    f.manifest.permissions.push('config.agent.write')
    f.grants.set('config.agent.write', 'allow')
    f.control.confirm = false
    assert.equal((await f.call('agent.deleteAssets', [{ app: 'codex', paths: ['pets/demo'], confirmed: true }])).ok, false)
    assert.equal(f.calls.length, 0)
    assert.match(f.control.confirmations[0].detail, /pets\/demo/)
    f.control.confirm = true
    assert.equal((await f.call('agent.restore', [{ app: 'codex', id: 'backup-1' }])).ok, true)
    assert.match(f.control.confirmations[1].detail, /backup-1/)
    assert.deepEqual(f.calls.map(call => call.method), ['agentRestore'])
    assert.equal(f.control.requested.length, 0)
  } finally { await f.scope.dispose() }
})

test('generic backend IPC rejects undeclared, denied, forged and stale callers before dispatch', async () => {
  const f = fixture()
  try {
    assert.deepEqual(await f.call('backend.call', ['echo', []]), { ok: false, error: 'permission denied: backend.node' })
    f.manifest.permissions.push('backend.node'); f.control.allow = false
    assert.deepEqual(await f.call('backend.call', ['echo', []]), { ok: false, error: 'permission denied: backend.node' })
    f.control.allow = true
    assert.deepEqual(await f.call('backend.call', ['echo', [1]]), { ok: true, data: { done: true } })
    assert.deepEqual(f.calls, [{ method: 'backend', id: f.pluginId, backendMethod: 'echo', args: [1] }])
    assert.equal((await f.call('backend.call', ['echo', []], f.event, 'com.other')).error, 'plugin id mismatch')
    assert.equal((await f.call('backend.call', ['echo', []], { ...f.event, senderFrame: { url: f.event.sender.mainFrame.url } })).error, 'unauthorized sender')
    let resolve; f.control.wait = new Promise(r => { resolve = r })
    const late = f.call('backend.call', ['echo', []]); await Promise.resolve(); f.scope.markClosing(); resolve()
    assert.match((await late).error, /closing or stale/); assert.equal(f.calls.length, 1)
  } finally { await f.scope.dispose() }
})
