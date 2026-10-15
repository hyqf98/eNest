import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import ts from 'typescript'

const require = createRequire(import.meta.url)
function fixture({ backendError } = {}) {
  const children = [], events = [], entries = []
  const abort = new AbortController()
  let current = true
  const scope = {
    owner: { pluginId: 'owner', generation: 1, wcId: 4 }, signal: abort.signal,
    isCurrent: () => current, acquireActivity: () => () => {}, addDisposer: () => () => {}
  }
  class Child extends EventEmitter {
    messages = []
    postMessage(message) { this.messages.push(message) }
    kill() { this.emit('exit', 0); return true }
  }
  const mocks = {
    electron: { utilityProcess: { fork(entry) { entries.push(entry); const child = new Child(); children.push(child); return child } } },
    '@main/plugin/pluginBackend': { resolvePluginBackendEntry(id) { assert.equal(id, 'owner'); if (backendError) throw backendError; return '/plugins/owner/backend/index.cjs' } },
    '@main/plugin/PluginRuntimeScope': { getRuntimeScope: () => scope },
    '@main/plugin/PluginHost': { pluginHost: { sendEvent: (id, event) => events.push({ id, event }) } },
    '@main/vault/secretVault': { resolveSecret: () => undefined },
    '@main/logs/logService': { logWarn() {} }
  }
  const source = readFileSync(new URL('./mwSessionManager.ts', import.meta.url), 'utf8')
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const module = { exports: {} }
  new Function('require', 'module', 'exports', js)(name => mocks[name] ?? require(name), module, module.exports)
  return { api: module.exports, children, events, entries, retire: () => { current = false } }
}

test('middleware resolves the owning plugin backend and cannot spawn an unauthorized backend', async () => {
  const denied = fixture({ backendError: new Error('backend.node permission denied') })
  await assert.rejects(denied.api.mwTest('owner', { kind: 'mqtt' }), /backend.node permission denied/)
  assert.equal(denied.children.length, 0)
  const f = fixture()
  const pending = f.api.mwTest('owner', { kind: 'mqtt' })
  const child = f.children[0], request = child.messages[0]
  assert.deepEqual(f.entries, ['/plugins/owner/backend/index.cjs'])
  child.emit('message', { id: request.id, ok: true, data: { ok: true } })
  assert.deepEqual(await pending, { ok: true })
  child.emit('exit', 0)
})

test('plugin backend events cannot target another plugin or outlive their runtime', async () => {
  const f = fixture()
  const pending = f.api.mwTest('owner', { kind: 'mqtt' })
  const child = f.children[0], request = child.messages[0]
  child.emit('message', { id: request.id, ok: true, data: { ok: true } })
  await pending
  const event = { event: 'mw.error', pluginId: 'other', payload: { error: 'forged' } }
  child.emit('message', event)
  assert.equal(f.events.length, 0)
  child.emit('message', { ...event, pluginId: 'owner' })
  assert.equal(f.events.length, 1)
  assert.equal(f.events[0].id, 'owner')
  f.retire()
  child.emit('message', { ...event, pluginId: 'owner' })
  assert.equal(f.events.length, 1)
  child.emit('exit', 0)
})
