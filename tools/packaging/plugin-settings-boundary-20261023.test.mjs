import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import ts from 'typescript'

const require = createRequire(import.meta.url)
function load(file, adapters) {
  const source = ts.transpileModule(readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  }).outputText
  const module = { exports: {} }
  new Function('require', 'module', 'exports', source)(name => adapters[name] ?? require(name), module, module.exports)
  return module.exports
}

test('generic settings gate distinguishes private values from page actions and host-reserved keys', () => {
  const keys = load('src/shared/pluginSettingsKeys.ts', {})
  const rows = [{ id: 'prefs', source: 'fixture.plugin', data: { title: 'Preferences', items: [
    { key: 'enabled', type: 'switch', default: false }, { key: 'count', type: 'number', default: 0 },
    { key: 'manage', type: 'page', entry: { code: 'settings' } }, { key: 'permissionGrants', type: 'text' }
  ] } }]
  const { PluginSettingsBridge } = load('src/main/settings/PluginSettingsBridge.ts', {
    '@main/window/createShellWindow': { sendShellEvent() {} }, '@main/contrib/ContributionRegistry': { contributionRegistry: { listSlot: () => rows } },
    '@main/settings/SettingsStore': { settingsStore: {} }, '@main/logs/logService': { logWarn() {} }, '@shared/pluginSettingsKeys': keys
  })
  const bridge = new PluginSettingsBridge()
  assert.equal(bridge.isWritableKey('fixture.plugin', 'enabled'), true)
  assert.equal(bridge.isWritableKey('fixture.plugin', 'count'), true)
  for (const key of ['manage', 'missing', 'permissionGrants', '__proto__', 'constructor', 'prototype']) assert.equal(bridge.isWritableKey('fixture.plugin', key), false, key)
  assert.equal(bridge.isWritableKey('other.plugin', 'enabled'), false)
  assert.equal(bridge.get('fixture.plugin', 'enabled'), false)
  assert.equal(bridge.get('fixture.plugin', 'count'), 0)
  assert.equal(bridge.get('fixture.plugin', 'manage'), undefined)
})

test('both native settings write paths use the same gate and DSH links its existing plugin-owned manage route', () => {
  for (const file of ['src/main/ipc/pluginHandlers.ts', 'src/main/ipc/shellHandlers.ts']) {
    assert.match(readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8'), /pluginSettingsBridge\.isWritableKey\(/)
  }
  const manifest = JSON.parse(readFileSync(new URL('../../eNest_plugin/plugins/dsh/plugin.json', import.meta.url), 'utf8'))
  const page = manifest.contributes.settings.flatMap(section => section.items).find(item => item.type === 'page')
  assert.equal(page.entry.code, 'manage')
  assert.ok(manifest.features.some(feature => feature.code === page.entry.code))
  assert.equal(manifest.version, '0.3.1'); assert.equal(manifest.engines.enest, '>=0.2.1')
})
