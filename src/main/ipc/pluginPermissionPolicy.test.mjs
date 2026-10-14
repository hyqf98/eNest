import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import ts from 'typescript'

const require = createRequire(import.meta.url)
const root = new URL('../../../', import.meta.url)

function fixture() {
  const pluginId = 'com.test.permissions', handlers = new Map(), calls = [], grants = new Map(), saved = new Map()
  const control = { allow: true, wait: null, closed: 0, requested: [], sections: [], settings: {} }
  const shell = { id: 2 }, sender = { id: 1, mainFrame: { url: `enest://plugin/${pluginId}/index.html` } }
  const event = { sender, senderFrame: sender.mainFrame }, shellEvent = { sender: shell }
  const manifest = { id: pluginId, name: 'Permissions fixture', version: '1.0.0', main: 'index.html', permissions: [] }
  const mocks = {
    electron: { ipcMain: { handle: (name, fn) => handlers.set(name, fn), on() {} } },
    '@main/ipc/ipcSecurity': { handleShellIpc: (name, fn) => handlers.set(name, fn) },
    '@main/ipc/pluginToolsHandlers': { PLUGIN_TOOL_PERMISSIONS: {}, bindPluginTools() {} },
    '@main/logs/logService': { logInfo() {}, logWarn() {} },
    '@main/plugin/PluginRegistry': { pluginRegistry: { get: () => ({ manifest }), getManifest: () => manifest } },
    '@main/plugin/PluginHost': { pluginHost: {
      getPluginIdByWebContentsId: id => id === sender.id ? pluginId : undefined,
      getManifestForWebContents: id => id === sender.id ? manifest : null,
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
    '@main/plugin/localFiles': { readLocalFile: (id, args) => { calls.push({ method: 'file', id, args }); return 'selected file' } },
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
    '@main/clipboard/clipboardHistory': { revalidateClipboardPolling() {} }
  }
  const real = new Map([
    ['@shared/types/plugin', 'src/shared/types/plugin.ts'],
    ['@shared/types/ipc', 'src/shared/types/ipc.ts'],
    ['@shared/constants', 'src/shared/constants.ts'],
    ['@shared/pluginPermissionPolicy', 'src/shared/pluginPermissionPolicy.ts'],
    ['@shared/pluginSettingsKeys', 'src/shared/pluginSettingsKeys.ts'],
    ['@main/plugin/PluginRuntimeScope', 'src/main/plugin/PluginRuntimeScope.ts'],
    ['@main/plugin/pluginSessionPolicy', 'src/main/plugin/pluginSessionPolicy.ts'],
    ['@main/plugin/PluginPermissions', 'src/main/plugin/PluginPermissions.ts']
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

test('sensitive APIs still require declaration and consent before host services run', async () => {
  const f = fixture()
  try {
    assert.deepEqual(await f.call('localFiles.read', [{ handleId: 'selected' }]), { ok: false, error: 'permission denied: fs.read' })
    assert.deepEqual(await f.call('net.fetch', [{ url: 'https://example.invalid' }]), { ok: false, error: 'permission denied: net.fetch' })
    assert.deepEqual(await f.call('contribute.registerQuickProvider', [{ id: 'global-search' }]), { ok: false, error: 'permission denied: contribute' })
    assert.deepEqual(f.control.requested, [])
    assert.equal(f.permissions.hasPermission(f.manifest, 'future.system.capability'), false)
    f.manifest.permissions.push('fs.read')
    f.control.allow = false
    assert.equal((await f.call('localFiles.read', [{ handleId: 'selected' }])).ok, false)
    assert.equal(f.calls.length, 0)
    f.control.allow = true
    assert.deepEqual(await f.call('localFiles.read', [{ handleId: 'selected' }]), { ok: true, data: 'selected file' })
    f.grants.set('fs.read', 'deny')
    const count = f.control.requested.length
    assert.equal((await f.call('localFiles.read', [{ handleId: 'selected' }])).ok, false)
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
    assert.deepEqual(await f.setGrant('fs.read', 'deny'), { ok: true })
    assert.equal(f.grants.get('fs.read'), 'deny')
    assert.equal(f.scope.isClosing, true)
    assert.equal(f.control.closed, 1)
  } finally { await f.scope.dispose() }
})

test('basic capabilities retain sender/runtime ownership and late sensitive consent is discarded', async () => {
  const f = fixture()
  try {
    assert.equal((await f.call('storage.get', ['draft'], { ...f.event, senderFrame: { url: f.event.sender.mainFrame.url } })).error, 'unauthorized sender')
    assert.equal((await f.call('storage.get', ['draft'], f.event, 'com.other.plugin')).error, 'plugin id mismatch')
    f.manifest.permissions.push('fs.read')
    let release
    f.control.wait = new Promise(resolve => { release = resolve })
    const reading = f.call('localFiles.read', [{ handleId: 'selected' }])
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
    f.control.settings.permissionGrants = { 'fs.read': 'deny' }
    const items = ['permissionGrants', '__proto__', 'constructor', 'prototype', '', 'density'].map(key => ({ key, type: 'text', label: key }))
    assert.equal((await f.call('settings.register', [{ id: 'display', title: 'Display', items }])).ok, true)
    assert.deepEqual(f.control.sections[0].items.map(item => item.key), ['density'])
    f.control.sections[0].items.push({ key: 'permissionGrants', type: 'text' })
    for (const key of ['permissionGrants', '__proto__', 'constructor', 'prototype', '']) {
      assert.deepEqual(await f.call('settings.get', [key]), { ok: false, error: 'reserved plugin settings key' })
      assert.deepEqual(await f.call('settings.set', [key, { 'fs.read': 'allow' }]), { ok: false, error: 'reserved plugin settings key' })
    }
    assert.deepEqual(f.control.settings.permissionGrants, { 'fs.read': 'deny' })
    assert.deepEqual(f.control.requested, [])
  } finally { await f.scope.dispose() }
})
