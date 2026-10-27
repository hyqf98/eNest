import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import ts from 'typescript'

const source = ts.transpileModule(readFileSync(new URL('../../../src/main/plugin/pluginBackendRpc.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText
function fixture() {
  const children = [], events = [], scopes = [], control = { granted: true }
  function newScope() {
    const controller = new AbortController(), disposers = new Set()
    const scope = { owner: { generation: scopes.length + 1, wcId: scopes.length + 1 }, signal: controller.signal, controller, disposers,
      isClosing: false, activityCount: 0, isCurrent: () => control.scope === scope,
      acquireActivity: () => { scope.activityCount++; let released = false; return () => { if (!released) { scope.activityCount--; released = true } } },
      addDisposer: fn => { disposers.add(fn); return () => disposers.delete(fn) }
    }
    scopes.push(scope); control.scope = scope; return scope
  }
  newScope()
  const adapters = {
    electron: { utilityProcess: { fork: () => { const child = new EventEmitter(); child.sent = []; child.kills = 0; child.postMessage = value => child.sent.push(value); child.kill = () => { child.kills++; return true }; children.push(child); return child } } },
    './PluginRuntimeScope': { getRuntimeScope: () => control.scope },
    './pluginBackend': { resolvePluginBackendPackage: () => { if (!control.granted) throw Error('permission denied'); if (!control.scope.isCurrent() || control.scope.isClosing || control.scope.signal.aborted) throw Error('stale runtime'); return { entry: '/fixture/backend/index.cjs', root: '/fixture' } } },
    './PluginHost': { pluginHost: { sendEvent: (...args) => events.push(args) } }
  }
  const module = { exports: {} }
  new Function('require', 'module', 'exports', source + '\n//# sourceURL=pluginBackendRpc.fixture.cjs')(name => { if (!(name in adapters)) throw Error(name); return adapters[name] }, module, module.exports)
  return { ...module.exports, children, events, control, newScope, scopes, cleanup: () => children.forEach(child => child.emit('exit', 0)) }
}
const call = f => f.callPluginBackend('com.test.backend', 'echo', [])
const respond = (child, message, data = 'ok') => child.emit('message', { id: message.id, ok: true, data })

test('invalid requests and denied permission fail before spawning; running process rechecks grants', async () => {
  const f = fixture()
  try {
    for (const [method, args] of [['../read', []], ['a'.repeat(81), []], ['ok', {}], ['ok', ['x'.repeat(4 * 1024 * 1024)]]]) assert.throws(() => f.callPluginBackend('id', method, args), /invalid|exceeds/)
    f.control.granted = false; assert.throws(() => call(f), /permission denied/); assert.equal(f.children.length, 0)
    f.control.granted = true; const pending = call(f), child = f.children[0]; respond(child, child.sent.at(-1)); assert.equal(await pending, 'ok')
    f.control.granted = false; assert.throws(() => call(f), /permission denied/); assert.equal(child.sent.length, 2)
    assert.equal(f.control.scope.activityCount, 0)
  } finally { f.cleanup() }
})

test('32 request cap and response routing bound activity and ignore unknown response ids', async () => {
  const f = fixture()
  try {
    const pending = Array.from({ length: 32 }, () => call(f)), child = f.children[0]
    assert.throws(() => call(f), /too many pending/); assert.equal(f.control.scope.activityCount, 32)
    child.emit('message', { id: 999999, ok: true, data: 'wrong' }); assert.equal(f.control.scope.activityCount, 32)
    const requests = child.sent.filter(x => x.id)
    for (const message of requests.toReversed()) respond(child, message, message.id)
    assert.deepEqual(await Promise.all(pending), requests.map(x => x.id)); assert.equal(f.control.scope.activityCount, 0)
  } finally { f.cleanup() }
})

test('timeout rejects requests, holds activity until actual exit and prevents overlapping replacements', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = fixture()
  try {
    const pending = call(f), rejected = assert.rejects(pending, /timed out/), child = f.children[0]
    t.mock.timers.tick(30000); await rejected
    assert.equal(child.kills, 1); assert.equal(f.control.scope.activityCount, 1)
    assert.throws(() => call(f), /still retiring/); assert.equal(f.children.length, 1)
    child.emit('exit', 9); assert.equal(f.control.scope.activityCount, 0)
    const replacement = call(f), next = f.children[1]; respond(next, next.sent.at(-1)); assert.equal(await replacement, 'ok')
  } finally { f.cleanup() }
})

test('old generation replies/events cannot reach replacement runtime; abort waits for exit', async () => {
  const f = fixture()
  try {
    const old = f.control.scope, request = call(f), rejected = assert.rejects(request, /replaced/), child = f.children[0]
    f.newScope()
    child.emit('message', { event: 'spoofed', data: 'old' }); assert.deepEqual(f.events, [])
    respond(child, child.sent.at(-1)); assert.equal(old.activityCount, 1)
    assert.throws(() => call(f), /still retiring/); await rejected; assert.equal(old.activityCount, 1)
    child.emit('exit', 0); assert.equal(old.activityCount, 0)
    const nextRequest = call(f), nextRejected = assert.rejects(nextRequest, /closed/), next = f.children[1], scope = f.control.scope
    scope.controller.abort(); await nextRejected
    assert.equal(scope.activityCount, 1); next.emit('exit', 0); assert.equal(scope.activityCount, 0)
    assert.equal(scope.disposers.size, 0)
  } finally { f.cleanup() }
})

test('events are owner routed; malformed or oversized messages retire process and release only at exit', async () => {
  for (const bad of [{ event: 'bad event' }, { event: 'data', data: 'x'.repeat(8 * 1024 * 1024) }, null]) {
    const f = fixture()
    try {
      const request = call(f), rejected = assert.rejects(request), child = f.children[0]
      child.emit('message', { event: 'data', pluginId: 'com.other', type: 'ssh.auth', data: { value: 1 } })
      assert.deepEqual(f.events, [['com.test.backend', { type: 'backend.event', event: 'data', data: { value: 1 } }]])
      child.emit('message', bad); await rejected
      assert.equal(f.control.scope.activityCount, 1); assert.equal(child.kills, 1)
      child.emit('message', { event: 'data', data: 'late' }); assert.equal(f.events.length, 1)
      child.emit('exit', 0); assert.equal(f.control.scope.activityCount, 0)
    } finally { f.cleanup() }
  }
})
