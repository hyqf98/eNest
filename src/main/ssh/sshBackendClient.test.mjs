import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { EventEmitter } from 'node:events'
import ts from 'typescript'
const require = createRequire(import.meta.url)
function load(file, mocks) {
  const code = ts.transpileModule(readFileSync(new URL(file, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const module = { exports: {} }
  new Function('require', 'module', 'exports', code)(name => mocks[name] ?? require(name), module, module.exports)
  return module.exports
}
function fixture() {
  const runtime = load('../plugin/PluginRuntimeScope.ts', {}), children = [], events = [], fileCalls = [], secretCalls = []
  let active = 0
  const scope = runtime.createRuntimeScope({ pluginId: 'owner', generation: 1, wcId: 11 })
  class Child extends EventEmitter {
    sent = []; killed = false
    postMessage(message) { this.sent.push(message) }
    kill() { this.killed = true; this.emit('exit', 0); return true }
  }
  const api = load('./sshBackendClient.ts', {
    electron: { utilityProcess: { fork() { const child = new Child(); children.push(child); return child } } },
    '@main/plugin/pluginBackend': { resolvePluginBackendEntry: () => '/installed/plugin/backend/index.cjs' },
    '@main/plugin/PluginRuntimeScope': runtime,
    '@main/plugin/activityRegistry': { acquirePluginActivity: () => { active++; return () => active-- } },
    '@main/plugin/PluginPermissions': { authorizePluginPermission: async () => {} },
    '@main/plugin/localFiles': { resolveLocalFileHandle: async (...args) => { fileCalls.push(args); return '/granted/file' } },
    '@main/db/pluginStorage': { getPluginStorageValue: () => undefined, setPluginStorageValue() {} },
    '@main/vault/secretVault': { resolveSecret: (...args) => { secretCalls.push(args); return 'owned-secret' } },
    '@main/plugin/PluginHost': { pluginHost: { sendEvent: (...args) => events.push(args) } },
    '@main/logs/logService': { logInfo() {}, logWarn() {} }
  })
  const flush = () => new Promise(resolve => setImmediate(resolve))
  return { api, scope, runtime, children, events, fileCalls, secretCalls, active: () => active, flush }
}

test('worker host calls are owner-bound and keep file handles and permission names validated', async () => {
  const f = fixture(), request = f.api.callSshBackend('owner', 'ssh.listSessions', [])
  const child = f.children[0]
  assert.deepEqual(child.sent[0], { type: 'init', pluginId: 'owner', generation: 1, wcId: 11 })
  child.emit('message', { hostCall: 1, method: 'secret.resolve', pluginId: 'victim', args: ['secret-ref'] })
  child.emit('message', { hostCall: 2, method: 'files.resolve', pluginId: 'victim', args: ['selected-handle', 'write'] })
  child.emit('message', { hostCall: 3, method: 'permission.authorize', args: ['shell.exec', 'bypass'] })
  child.emit('message', { hostCall: 4, method: 'files.resolve', args: ['selected-handle', 'arbitrary'] })
  await f.flush()
  assert.deepEqual(f.secretCalls, [['owner', 'secret-ref']])
  assert.deepEqual(f.fileCalls, [['owner', 'selected-handle', 'write']])
  assert.equal(child.sent.find(x => x.hostResult === 3).ok, false)
  assert.equal(child.sent.find(x => x.hostResult === 4).ok, false)
  child.emit('message', { id: 1, ok: true, data: [] }); assert.deepEqual(await request, [])
  f.api.releaseSshBackend('owner'); child.emit('exit', 0)
})

test('runtime abort rejects requests, releases persistent activities and ignores late events', async () => {
  const f = fixture(), request = f.api.callSshBackend('owner', 'ssh.connect', [{}])
  const child = f.children[0]
  child.emit('message', { hostCall: 1, method: 'activity.acquire', args: ['lease', 'connection', 'SSH connected'] })
  await f.flush(); assert.equal(f.active(), 1); assert.equal(f.scope.activityCount, 2)
  f.scope.markClosing()
  await assert.rejects(request, /closing/)
  assert.equal(f.active(), 0); assert.equal(f.scope.activityCount, 0)
  child.emit('message', { hostEvent: 'event', args: [{ type: 'ssh.data', sessionId: 'old', data: 'late' }] })
  assert.deepEqual(f.events, [])
  assert.ok(child.sent.some(x => x.type === 'dispose'))
  child.emit('exit', 0)
})

test('late generation cleanup and old process exit cannot stop a replacement backend', async () => {
  const f = fixture(), first = f.api.callSshBackend('owner', 'ssh.listSessions', [])
  f.children[0].emit('message', { id: 1, ok: true, data: [] }); await first
  await f.scope.dispose()
  const replacementScope = f.runtime.createRuntimeScope({ pluginId: 'owner', generation: 2, wcId: 12 })
  const next = f.api.callSshBackend('owner', 'ssh.listSessions', [])
  const child = f.children[1]
  f.api.releaseSshBackend('owner', 1); f.children[0].emit('exit', 0)
  assert.equal(child.killed, false); assert.equal(replacementScope.activityCount, 1)
  child.emit('message', { id: 1, ok: true, data: ['new'] }); assert.deepEqual(await next, ['new'])
  f.api.releaseSshBackend('owner', 2); child.emit('exit', 0)
})

test('unexpected process exit rejects in-flight calls and reports an owned SSH error', async () => {
  const f = fixture(), request = f.api.callSshBackend('owner', 'ssh.exec', [{}])
  f.children[0].emit('exit', 7)
  await assert.rejects(request, /exited \(7\)/)
  assert.equal(f.scope.activityCount, 0)
  assert.equal(f.events[0][0], 'owner'); assert.equal(f.events[0][1].type, 'ssh.error')
})

test('a host reply racing a broken worker channel closes ownership without an unhandled rejection', async () => {
  const f = fixture(), request = f.api.callSshBackend('owner', 'ssh.connect', [{}])
  const rejected = assert.rejects(request, /channel closed/), child = f.children[0]
  child.postMessage = () => { throw new Error('channel closed') }
  child.emit('message', { hostCall: 1, method: 'secret.resolve', args: ['secret-ref'] })
  await f.flush(); await rejected
  assert.equal(f.scope.activityCount, 0)
  child.emit('exit', 1)
})
