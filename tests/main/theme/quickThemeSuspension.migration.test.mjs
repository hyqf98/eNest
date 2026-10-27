import assert from 'node:assert/strict'
import * as crypto from 'node:crypto'
import { constants, readFileSync } from 'node:fs'
import * as path from 'node:path'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

const outputs = new Map()
function production(relative, dependencies) {
  if (!outputs.has(relative)) {
    const source = readFileSync(new URL(relative, new URL("../../../src/main/theme/", import.meta.url)), 'utf8')
    const result = ts.transpileModule(source, {
      reportDiagnostics: true,
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
    })
    assert.deepEqual(result.diagnostics?.filter(item => item.category === ts.DiagnosticCategory.Error) ?? [], [])
    outputs.set(relative, result.outputText)
  }
  const module = { exports: {} }
  const require = name => {
    assert.ok(Object.hasOwn(dependencies, name), `Unexpected production dependency: ${name}`)
    return dependencies[name]
  }
  const execute = vm.runInNewContext(`(function(require, module, exports) {\n${outputs.get(relative)}\n})`, {
    Buffer, URL, performance, TextEncoder, TextDecoder
  }, { filename: relative, timeout: 1000 })
  execute(require, module, module.exports)
  return module.exports
}

function deferred() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

function protocolFixture() {
  const state = { installed: true, files: true, realpathGate: null, realpathEntered: null, failAppearance: false }
  const source = 'fixture.theme'
  const appearance = {
    revision: 1, theme: { source, id: 'fixture-pack', version: '1.0.0' },
    quick: { version: 1, entry: 'quick/launcher.html' }, mode: 'light', tokens: {},
    fonts: { body: 'sans', heading: 'sans', mono: 'mono', scale: 1 },
    components: { controlRadius: 8, cardRadius: 12, panelRadius: 16, borderWidth: 1 },
    animation: { effective: 'low' }
  }
  const info = { size: 64, isSymbolicLink: () => false, isDirectory: () => true, isFile: () => true }
  const registry = {
    getAssetRootPath: id => id === source && state.installed ? '/fixture/source' : null,
    getManifest: id => id === source && state.installed ? { id: source } : null,
    isEnabled: id => id === source && state.installed,
    getBuildRevision: () => 'fixture-build',
    onInstalledChanged() {}
  }
  const api = production('./quickThemeProtocol.ts', {
    'node:crypto': crypto,
    'node:fs': { constants },
    'node:fs/promises': {
      realpath: async value => {
        if (state.realpathGate) {
          const gate = state.realpathGate
          state.realpathGate = null
          state.realpathEntered?.resolve()
          await gate.promise
        }
        if (!state.files) throw new Error('fixture file removed')
        return value
      },
      lstat: async () => { if (!state.files) throw new Error('fixture file removed'); return info },
      stat: async () => { if (!state.files) throw new Error('fixture file removed'); return info },
      open: async () => { throw new Error('Resource byte reads are not part of this isolated fixture') }
    },
    'node:path': path,
    '@shared/pluginContract': { isPluginAssetPath: value => value === appearance.quick.entry },
    '@shared/theme/colors': { parseThemeColor: () => true },
    '@shared/types/ipc': { IpcChannels: {} },
    '@main/plugin/PluginRegistry': { pluginRegistry: registry },
    '@main/theme/appearanceService': {
      getAppearance: () => { if (state.failAppearance) throw new Error('fixture appearance failed'); return appearance },
      appearanceService: { subscribeAppearance() {} }
    },
    '@main/theme/themePacks': { themePackRegistry: { get: id => id === appearance.theme.id ? {
      schemaVersion: 2, source, quick: appearance.quick
    } : null } },
    './quickThemeBridge': { QUICK_THEME_BRIDGE_FILE: '__bridge.js', QUICK_THEME_BRIDGE_SOURCE: '' }
  })
  return { api, state, source, appearance, registry }
}

function uninstallerFixture(protocol) {
  const calls = []
  const afterClear = deferred()
  const state = { blocks: 0, lockGate: null, afterClearGate: null, failRemove: false,
    failScan: false, failClose: false, failStop: false, privateValue: 'existing-provider-state' }
  const pluginHost = {
    blockPlugin(id) { calls.push(['block', id]); state.blocks++; return () => { state.blocks--; calls.push(['release', id]) } },
    async closePlugin() { if (state.failClose) throw new Error('fixture close failed') },
    beginUninstall() {}, finishUninstall() {}
  }
  const api = production('../plugin/PluginUninstaller.ts', {
    electron: { app: { getPath: () => '/fixture/userData' }, session: { fromPartition: () => ({ async clearStorageData() {} }) } },
    'node:fs': { existsSync: value => value === `/fixture/plugins/${protocol.source}` },
    'node:fs/promises': { async rm(value) {
      calls.push(['rm', value])
      if (state.failRemove) throw new Error('fixture remove failed')
      protocol.state.files = false
    } },
    'node:path': path,
    '@shared/constants': { pluginPartition: id => id, pluginPartitionDirName: id => id },
    '@main/db/pluginStorage': { clearPluginStorage() {} },
    '@main/logs/logService': { logError() {}, logInfo() {}, logWarn() {} },
    '@main/paths/pathsService': { getAppPaths: () => ({ plugins: '/fixture/plugins' }), pluginStorageFile: id => `/fixture/storage/${id}.json` },
    '@main/vault/secretVault': { vaultClearPlugin() {} },
    '@main/window/createShellWindow': { sendShellEvent() {} },
    '@main/plugin/PluginSessionStore': { clearPluginSession() {}, deleteSessionSnapshot() {} },
    '@main/plugin/pluginEnabledStore': { async clearPluginDisabled() {} },
    '@main/plugin/PermissionService': { permissionService: { cancelFor() {} } },
    '@main/plugin/PluginInstaller': {
      cancelPluginInstalls(id) { calls.push(['cancel', id]) },
      async withInstallLock(id, action) { calls.push(['lock', id]); if (state.lockGate) await state.lockGate.promise; return action() }
    },
    '@main/plugin/pluginProtocol': { async invalidatePluginCodeCache() {}, invalidatePluginFileCache() {} },
    '@main/plugin/PluginHost': { pluginHost },
    '@main/plugin/PluginRegistry': { pluginRegistry: {
      get: () => ({ name: 'Fixture', rootPath: '/fixture/source' }),
      removeDevPlugin() {},
      async scan() { if (state.failScan) throw new Error('fixture scan failed'); if (!state.failRemove) protocol.state.installed = false }
    } },
    '@main/dev/DevConsole': { async forgetDevPlugin() {} },
    '@main/settings/SettingsStore': { settingsStore: {
      async removePluginSettings() { afterClear.resolve(); if (state.afterClearGate) await state.afterClearGate.promise }
    } },
    '@main/theme/themePacks': { themePackRegistry: { async removeBySource() { return [] } } },
    '@main/contrib/ContributionRegistry': { contributionRegistry: { unregisterBySource() {} } },
    '@main/timer/deadlineTaskService': { async clearPluginDeadlineTasks() {} },
    '@main/plugin/pluginBackgroundRuntime': {
      refreshPluginBackgrounds() {},
      stopPluginBackground() { if (state.failStop) throw new Error('fixture stop failed') }
    },
    '@main/plugin/pluginPrivateDocuments': { async clearPrivateDocuments() {} },
    '@main/plugin/pluginFileStreams': { async clearPluginFileStreams() {} },
    '@main/plugin/pluginFiles': { async clearPluginBlobs() {} },
    '@main/theme/quickStateService': { quickProviderStates: { removeSource(id) {
      calls.push(['clear-provider-state', id]); state.privateValue = null
    } } },
    '@main/theme/quickThemeProtocol': protocol.api
  })
  return { api, state, calls, afterClear, writeFromProvider(key, value) {
    if (!protocol.api.getQuickThemeStateOwner(key)) throw new Error('provider retired')
    state.privateValue = value
  } }
}

test('suspension immediately retires the grant and rejects config, owner and resource identities until release', async () => {
  const { api, source } = protocolFixture()
  const original = await api.getQuickThemeConfig()
  assert.ok(original)
  assert.equal(api.getQuickThemeStateOwner(original.key).source, source)
  const resume = api.suspendQuickThemeSource(source)
  assert.equal(api.getQuickThemeStateOwner(original.key), null)
  assert.equal(api.isCurrentQuickThemeEntryUrl(original.url), false)
  assert.equal(await api.getQuickThemeConfig(), null)
  resume()
  assert.equal(api.getQuickThemeStateOwner(original.key), null)
  const replacement = await api.getQuickThemeConfig()
  assert.ok(replacement)
  assert.notEqual(replacement.key, original.key)
  assert.equal(api.getQuickThemeStateOwner(original.key), null)
  assert.equal(api.getQuickThemeStateOwner(replacement.key).source, source)
})

test('nested suspension tokens release idempotently and only the last release permits a fresh grant', async () => {
  const { api, source } = protocolFixture()
  const original = await api.getQuickThemeConfig()
  const first = api.suspendQuickThemeSource(source), second = api.suspendQuickThemeSource(source)
  first(); first()
  assert.equal(await api.getQuickThemeConfig(), null)
  second(); second()
  const replacement = await api.getQuickThemeConfig()
  assert.notEqual(replacement.key, original.key)
  assert.equal(api.getQuickThemeStateOwner(original.key), null)
})

test('suspending an unrelated source does not retire the selected provider', async () => {
  const { api } = protocolFixture()
  const original = await api.getQuickThemeConfig()
  const resume = api.suspendQuickThemeSource('another.theme')
  assert.equal((await api.getQuickThemeConfig()).key, original.key)
  assert.ok(api.getQuickThemeStateOwner(original.key))
  resume()
  assert.equal((await api.getQuickThemeConfig()).key, original.key)
})

test('a pause and release fences an already in-flight config even when selection has not changed', async () => {
  const { api, state, source } = protocolFixture()
  state.realpathGate = deferred(); state.realpathEntered = deferred()
  const gate = state.realpathGate
  const pending = api.getQuickThemeConfig()
  await state.realpathEntered.promise
  const resume = api.suspendQuickThemeSource(source)
  resume()
  gate.resolve()
  assert.equal(await pending, null)
  assert.ok(await api.getQuickThemeConfig())
})

test('uninstall suspends the source before waiting for an existing install lock', async () => {
  const protocol = protocolFixture(), fixture = uninstallerFixture(protocol)
  const original = await protocol.api.getQuickThemeConfig()
  fixture.state.lockGate = deferred()
  const pending = fixture.api.uninstallPlugin(protocol.source)
  assert.equal(fixture.state.blocks, 1)
  assert.equal(protocol.api.getQuickThemeStateOwner(original.key), null)
  assert.equal(await protocol.api.getQuickThemeConfig(), null)
  fixture.state.lockGate.resolve()
  assert.equal((await pending).ok, true)
  assert.equal(fixture.state.blocks, 0)
  assert.equal(protocol.api.getQuickThemeStateOwner(original.key), null)
})

test('the post-delete asynchronous cleanup window cannot recreate provider state before the registry scan', async () => {
  const protocol = protocolFixture(), fixture = uninstallerFixture(protocol)
  const original = await protocol.api.getQuickThemeConfig()
  fixture.state.afterClearGate = deferred()
  const pending = fixture.api.uninstallPlugin(protocol.source)
  await fixture.afterClear.promise
  assert.equal(protocol.state.installed, true)
  assert.equal(fixture.state.privateValue, null)
  assert.throws(() => fixture.writeFromProvider(original.key, 'late private state'), /provider retired/)
  assert.equal(await protocol.api.getQuickThemeConfig(), null)
  fixture.state.afterClearGate.resolve()
  assert.equal((await pending).ok, true)
  assert.equal(fixture.state.privateValue, null)
  assert.equal(fixture.state.blocks, 0)
})

test('a failed registry scan after file deletion cannot revive an old key, including after reinstall', async () => {
  const protocol = protocolFixture(), fixture = uninstallerFixture(protocol)
  const original = await protocol.api.getQuickThemeConfig()
  fixture.state.failScan = true
  const result = await fixture.api.uninstallPlugin(protocol.source)
  assert.equal(result.ok, false)
  assert.match(result.error, /registry scan failed/)
  assert.equal(protocol.state.installed, true)
  assert.equal(protocol.state.files, false)
  assert.equal(fixture.state.privateValue, null)
  assert.equal(fixture.state.blocks, 0)
  assert.equal(protocol.api.getQuickThemeStateOwner(original.key), null)
  assert.equal(await protocol.api.getQuickThemeConfig(), null)
  protocol.state.files = true
  const replacement = await protocol.api.getQuickThemeConfig()
  assert.ok(replacement)
  assert.notEqual(replacement.key, original.key)
  assert.equal(protocol.api.getQuickThemeStateOwner(original.key), null)
})

test('failed file removal preserves private state but permanently retires the old grant', async () => {
  const protocol = protocolFixture(), fixture = uninstallerFixture(protocol)
  const original = await protocol.api.getQuickThemeConfig()
  fixture.state.failRemove = true
  assert.equal((await fixture.api.uninstallPlugin(protocol.source)).ok, false)
  assert.equal(fixture.state.privateValue, 'existing-provider-state')
  assert.equal(fixture.calls.some(([operation]) => operation === 'clear-provider-state'), false)
  assert.equal(fixture.state.blocks, 0)
  assert.equal(protocol.api.getQuickThemeStateOwner(original.key), null)
  assert.notEqual((await protocol.api.getQuickThemeConfig()).key, original.key)
})

test('early close failure and synchronous background failure both release native and Quick barriers', async () => {
  for (const failure of ['failClose', 'failStop']) {
    const protocol = protocolFixture(), fixture = uninstallerFixture(protocol)
    const original = await protocol.api.getQuickThemeConfig()
    fixture.state[failure] = true
    if (failure === 'failStop') await assert.rejects(fixture.api.uninstallPlugin(protocol.source), /fixture stop failed/)
    else assert.equal((await fixture.api.uninstallPlugin(protocol.source)).ok, false)
    assert.equal(fixture.state.blocks, 0)
    assert.equal(fixture.state.privateValue, 'existing-provider-state')
    assert.equal(protocol.api.getQuickThemeStateOwner(original.key), null)
    assert.notEqual((await protocol.api.getQuickThemeConfig()).key, original.key)
  }
})

test('failed suspension initialization cannot leak a PluginHost barrier or a source suspension token', async () => {
  const protocol = protocolFixture(), fixture = uninstallerFixture(protocol)
  const original = await protocol.api.getQuickThemeConfig()
  protocol.state.failAppearance = true
  await assert.rejects(fixture.api.uninstallPlugin(protocol.source), /fixture appearance failed/)
  assert.equal(fixture.state.blocks, 0)
  assert.equal(fixture.state.privateValue, 'existing-provider-state')
  protocol.state.failAppearance = false
  assert.equal((await protocol.api.getQuickThemeConfig()).key, original.key)
})
