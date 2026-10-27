import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import ts from 'typescript'

const require = createRequire(import.meta.url)
const js = ts.transpileModule(readFileSync(new URL('../../../src/main/proxy/proxyService.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText
function fixture() {
  const rules = [], session = { setProxy: async options => rules.push(options.proxyRules) }
  const mocks = {
    electron: { session: { defaultSession: session, fromPartition: () => session } },
    '@shared/constants': { SHELL_PARTITION: 'fixture' },
    '@main/logs/logService': { logInfo() {}, logWarn() {} },
    '@main/plugin/PluginRegistry': { pluginRegistry: { list: () => [] } },
    '@main/settings/SettingsStore': {}
  }
  const module = { exports: {} }
  new Function('require', 'module', 'exports', js)(name => mocks[name] ?? require(name), module, module.exports)
  return { api: module.exports, rules }
}

test('HTTP proxy applies one valid URL to Chromium and Node, and restores inherited environment', async () => {
  const f = fixture(), keys = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY']
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]))
  try {
    await f.api.applyProxy({ type: 'http', host: '127.0.0.1', port: 8888 })
    assert.equal(process.env.HTTP_PROXY, 'http://127.0.0.1:8888')
    assert.equal(process.env.HTTPS_PROXY, process.env.HTTP_PROXY)
    assert.ok(f.rules.every(rule => rule === 'http://127.0.0.1:8888'))
    await f.api.applyProxy({ type: 'none' })
    for (const key of keys) assert.equal(process.env[key], previous[key])
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key]
      else process.env[key] = previous[key]
    }
  }
})

test('proxy rules preserve system auto detection, direct and specified IPv6 hosts', () => {
  const { api } = fixture()
  assert.equal(api.buildProxyRules({ type: 'system' }), 'system')
  assert.equal(api.buildProxyRules({ type: 'none' }), '')
  assert.equal(api.buildProxyEnvUrl({ type: 'http', host: '::1', port: 8888 }), 'http://[::1]:8888')
  assert.equal(api.normalizeProxy({ type: 'socks5', host: 'localhost', port: 1080 }).type, 'system')
  assert.equal(api.normalizeProxy({ type: 'custom', url: 'http://localhost:8888' }).type, 'system')
})
