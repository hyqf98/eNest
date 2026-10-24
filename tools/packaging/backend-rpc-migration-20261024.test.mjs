import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import vm from 'node:vm'
import test from 'node:test'
import ts from 'typescript'

const source = ts.transpileModule(readFileSync(new URL('../../src/main/plugin/pluginBackendRpc.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText
const turn = () => new Promise(resolve => setImmediate(resolve))
function fixture() {
  const children = [], events = [], registrations = new Set(), activities = new Set(), timers = new Map()
  let cleanup = Promise.resolve(), current, token = 0
  const scope = { owner: { pluginId: 'fixture.plugin', generation: 1, wcId: 2 }, signal: new AbortController().signal,
    isCurrent: () => current === scope, isClosing: false, failures: [],
    acquireActivity() { const key = ++token; activities.add(key); return () => activities.delete(key) }, addDisposer() { return () => {} } }
  current = scope
  class Utility extends EventEmitter {
    constructor() { super(); this.pid = children.length + 1000; this.messages = [] }
    postMessage(message) { this.messages.push(message); if (message.type === 'shutdown') queueMicrotask(() => this.emit('exit', 0)) }
    kill() { queueMicrotask(() => this.emit('exit', 0)) }
  }
  class Control {
    async beginClose() {}
    async stopChildren() {}
    async confirmChildrenExited() {}
    async dispose() { await cleanup }
    async request() { if (!scope.isCurrent()) throw new Error('stale'); return true }
  }
  const imports = {
    electron: { webContents: { fromId: () => ({ getURL: () => 'enest://plugin/fixture.plugin/index.html' }) }, utilityProcess: { fork() { const child = new Utility(); children.push(child); return child } } },
    './PluginRuntimeScope': { getRuntimeScope: () => current },
    './pluginBackend': { resolvePluginBackendPackage: () => ({ entry: '/fixture/worker.cjs', root: '/fixture' }) },
    './PluginHost': { pluginHost: { sendEvent: (...args) => events.push(args) } },
    './pluginBackendControl': { PluginBackendControl: Control },
    './pluginOwnedProcesses': { registerPluginProcess(info) { registrations.add(info); return () => registrations.delete(info) } },
    '@main/paths/pathsService': { getAppPaths: () => ({ data: '/fixture/data' }) }
  }
  const module = { exports: {} }
  vm.runInNewContext(source, { module, exports: module.exports, console, Buffer, performance, URL, process: { env: {}, execPath: '/fixture/Electron', kill() {} },
    setTimeout(fn, ms) { if ([50, 250, 900].includes(ms)) return setTimeout(fn, 0); const handle = { ms, fn }; timers.set(handle, handle); return handle },
    clearTimeout(handle) { if (!timers.delete(handle)) clearTimeout(handle) },
    require: name => { assert.ok(name in imports, name); return imports[name] } })
  return { ...module.exports, children, events, registrations, activities, timers, scope,
    setCleanup(promise) { cleanup = promise }, stale() { current = null },
    async respond(data, ok = true) { const child = children.at(-1), request = child.messages.filter(m => m.method).at(-1); child.emit('message', { id: request.id, ok, data, error: ok ? undefined : 'fixture failure' }); await turn() }
  }
}

test('per-operation timeout is bounded before spawn; calls and diagnostics stay payload-free', async () => {
  const f = fixture()
  for (const timeoutMs of [0, -1, 249, 86_400_001, Infinity, 1.1]) assert.throws(() => f.callPluginBackend('fixture.plugin', 'run', [], { timeoutMs }), /timeout/)
  assert.equal(f.children.length, 0)
  const request = f.callPluginBackend('fixture.plugin', 'run', ['sensitive-fixture'], { timeoutMs: 60_000 })
  assert.equal(f.children[0].messages[0].context.pageOrigin, 'enest://plugin')
  assert.ok([...f.timers.values()].some(timer => timer.ms === 60_000))
  await f.respond({ done: true }); assert.equal((await request).done, true)
  const stats = f.getBackendDiagnostics()[0]
  assert.equal(stats.completed, 1); assert.equal(stats.failed, 0); assert.equal(stats.pending, 0)
  assert.ok(stats.lastDurationMs >= 0); assert.doesNotMatch(JSON.stringify(stats), /sensitive-fixture/)
  await f.stopPluginBackend('fixture.plugin')
  assert.equal(f.registrations.size, 0); assert.equal(f.activities.size, 0)
})

test('backend.stop retains replacement barrier until asynchronous capability cleanup completes', async () => {
  const f = fixture(); let finish
  const cleanup = new Promise(resolve => { finish = resolve }); f.setCleanup(cleanup)
  const request = f.callPluginBackend('fixture.plugin', 'work')
  const rejected = assert.rejects(request, /stopped/)
  const stopped = f.stopPluginBackend('fixture.plugin')
  await rejected
  for (let i = 0; i < 10; i++) await turn()
  assert.equal(f.getBackendDiagnostics()[0].closing, true)
  assert.throws(() => f.callPluginBackend('fixture.plugin', 'replacement'), /retiring/)
  assert.equal(f.children.length, 1); assert.equal(f.registrations.size, 1)
  finish(); await stopped
  assert.equal(f.getBackendDiagnostics().length, 0); assert.equal(f.activities.size, 0)
  const next = f.callPluginBackend('fixture.plugin', 'replacement')
  await f.respond('next'); assert.equal(await next, 'next')
  assert.equal(f.children.length, 2)
  await f.stopPluginBackend('fixture.plugin')
})

test('business events remain inside backend.event; a foreign or stale payload cannot impersonate host events', async () => {
  const f = fixture(), request = f.callPluginBackend('fixture.plugin', 'run')
  const child = f.children[0]
  child.emit('message', { event: 'ssh.data', data: { pluginId: 'other', text: 'fixture' } })
  assert.equal(f.events[0][0], 'fixture.plugin'); assert.equal(f.events[0][1].type, 'backend.event')
  await f.respond('ok'); await request
  f.stale(); child.emit('message', { event: 'ssh.data', data: {} })
  assert.equal(f.events.length, 1)
  await assert.rejects(f.stopPluginBackend('fixture.plugin'), /stale/)
})

test('new timeout applies to the whole worker, rejects all work, and releases only after retirement', async () => {
  const f = fixture(), a = f.callPluginBackend('fixture.plugin', 'slow', [], { timeoutMs: 1000 }), b = f.callPluginBackend('fixture.plugin', 'other')
  const rejected = Promise.all([assert.rejects(a, /timed out/), assert.rejects(b, /timed out/)])
  ;[...f.timers.values()].find(timer => timer.ms === 1000).fn()
  await rejected
  await f.stopPluginBackend('fixture.plugin')
  assert.equal(f.getBackendDiagnostics().length, 0); assert.equal(f.activities.size, 0); assert.equal(f.registrations.size, 0)
})

test('unexpected idle exit emits one owner-bound lifecycle event; intentional stop stays quiet', async () => {
  const f = fixture(), request = f.callPluginBackend('fixture.plugin', 'run')
  await f.respond('ok'); await request
  f.children[0].emit('exit', 17)
  assert.equal(f.events.length, 1)
  assert.equal(f.events[0][1].event, 'backend.exit')
  assert.equal(f.events[0][1].data.code, 17)
  await f.stopPluginBackend('fixture.plugin')
  assert.equal(f.events.length, 1)
})

test('fatal error followed by exit emits once, but errors after intentional stop stay quiet', async () => {
  for (const intentional of [false, true]) {
    const f = fixture(), request = f.callPluginBackend('fixture.plugin', 'run')
    await f.respond('ok'); await request
    const stopped = intentional ? f.stopPluginBackend('fixture.plugin') : null
    f.children[0].emit('error', new Error('fixture fatal error'))
    await (stopped ?? f.stopPluginBackend('fixture.plugin'))
    assert.equal(f.events.length, intentional ? 0 : 1)
    if (!intentional) assert.equal(f.events[0][1].event, 'backend.exit')
    assert.equal(f.getBackendDiagnostics().length, 0)
  }
})
