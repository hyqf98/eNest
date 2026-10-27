import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { EventEmitter } from 'node:events'
import ts from 'typescript'

const require = createRequire(import.meta.url)
function load(file, adapters, processMock = process) {
  const output = ts.transpileModule(readFileSync(new URL(`../../${file}`, new URL("../../tools/packaging/", import.meta.url)), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true }
  }).outputText
  const module = { exports: {} }
  new Function('require', 'module', 'exports', 'process', output)(name => Object.hasOwn(adapters, name) ? adapters[name] : require(name), module, module.exports, processMock)
  return module.exports
}
function row(pid, parentPid, startedAt) { return { pid, parentPid, startedAt, memoryBytes: 1, residentBytes: 1, metric: 'footprint' } }
const tick = () => new Promise(resolve => setImmediate(resolve))
async function waitForShutdown(child) {
  for (let attempt = 0; attempt < 20; attempt++) {
    if (child.messages.some(message => message.type === 'shutdown')) return
    await tick()
  }
  throw new Error('shutdown request missing after initial process identity capture')
}

function fixture() {
  let current, nextPid = 100, rows = [], killDescendants = true
  const children = [], registrations = new Set(), events = [], signals = []
  const registerPluginProcess = registration => { registrations.add(registration); return () => registrations.delete(registration) }
  function generation(number) {
    const controller = new AbortController(), disposers = new Set(), activity = new Set()
    const scope = {
      owner: { pluginId: 'fixture.plugin', generation: number, wcId: number + 10 }, signal: controller.signal,
      isClosing: false, failures: [], activity, disposers,
      isCurrent: () => current === scope,
      acquireActivity(reason) { const token = Symbol(reason); activity.add(token); return () => activity.delete(token) },
      addDisposer(dispose) { disposers.add(dispose); return () => disposers.delete(dispose) },
      close() { scope.isClosing = true; controller.abort() }
    }
    current = scope
    return scope
  }
  const first = generation(1)
  const processMock = { execPath: process.execPath, env: {}, kill(pid, signal) {
    if (signal === 0) {
      if (!rows.some(value => value.pid === pid)) throw Object.assign(new Error('No such process'), { code: 'ESRCH' })
      return true
    }
    signals.push([pid, signal])
    const backend = children.find(child => child.pid === pid)
    if (backend) backend.exit()
    else if (killDescendants) rows = rows.filter(value => value.pid !== pid)
  } }
  const { PluginBackendControl } = load('src/main/plugin/pluginBackendControl.ts', {
    electron: { session: { defaultSession: { resolveProxy: async () => 'DIRECT' } } },
    './pluginProcessMemory': { sampleProcessMemory: async () => rows.map(value => ({ ...value })) },
    './pluginSessionPolicy': { allowPluginEndpoint: () => () => {} },
    './pluginOwnedProcesses': { registerPluginProcess }
  }, processMock)
  class Utility extends EventEmitter {
    constructor() { super(); this.pid = ++nextPid; this.messages = []; this.exited = false; rows.push(row(this.pid, 1, this.pid * 10)) }
    postMessage(message) { this.messages.push(message) }
    kill() { this.exit(); return true }
    exit() { if (this.exited) return; this.exited = true; rows = rows.filter(value => value.pid !== this.pid); this.emit('exit', 0) }
  }
  const rpc = load('src/main/plugin/pluginBackendRpc.ts', {
    electron: { utilityProcess: { fork() { const child = new Utility(); children.push(child); queueMicrotask(() => child.emit('spawn')); return child } } },
    './PluginRuntimeScope': { getRuntimeScope: () => current },
    './pluginBackend': { resolvePluginBackendPackage() { if (current.isClosing) throw new Error('current scope is closing'); return { entry: '/fixture/package/backend/index.cjs', root: '/fixture/package' } } },
    './PluginHost': { pluginHost: { sendEvent: (pluginId, payload) => events.push({ pluginId, payload }) } },
    './pluginOwnedProcesses': { registerPluginProcess }, './pluginBackendControl': { PluginBackendControl },
    '@main/paths/pathsService': { getAppPaths: () => ({ data: '/fixture/data' }) }
  }, processMock)
  async function control(child, id, method, params) {
    child.emit('message', { type: 'host.request', id, method, params })
    for (let attempt = 0; attempt < 20; attempt++) {
      const reply = child.messages.find(message => message.type === 'host.response' && message.id === id)
      if (reply) return reply
      await tick()
    }
    throw new Error('host control response missing')
  }
  function addDescendant(child, pid) { rows.push(row(pid, child.pid, child.pid * 10 + 1)) }
  function backendRegistration(child) { return [...registrations].find(value => value.kind === 'backend' && value.getPid() === child.pid) }
  return { rpc, first, generation, children, registrations, events, signals, control, addDescendant, backendRegistration,
    setKillDescendants(value) { killDescendants = value } }
}

test('RPC and host-control IDs occupy separate namespaces, and stale generations cannot emit or acquire', async () => {
  const f = fixture()
  let resolved = false
  const pending = f.rpc.callPluginBackend('fixture.plugin', 'workbench', []).then(value => { resolved = true; return value })
  const child = f.children[0], request = child.messages.find(message => message.method === 'workbench')
  const init = child.messages.find(message => message.type === 'init')
  assert.deepEqual(init.context, { protocolVersion: 1, appDataPath: '/fixture/data', packagePath: '/fixture/package', appExecPath: process.execPath })
  assert.equal((await f.control(child, request.id, 'activity.acquire', { token: 'job', reason: 'fixture job' })).ok, true)
  await tick()
  assert.equal(resolved, false, 'a host-control reply must not complete the renderer RPC with the same ID')
  child.emit('message', { event: 'dsh.event', data: { type: 'runtime-progress' } })
  assert.deepEqual(f.events[0], { pluginId: 'fixture.plugin', payload: { type: 'backend.event', event: 'dsh.event', data: { type: 'runtime-progress' } } })
  child.emit('message', { id: request.id, ok: true, data: 'workbench-result' })
  assert.equal(await pending, 'workbench-result')
  const registration = f.backendRegistration(child)
  f.generation(2)
  assert.equal((await f.control(child, 500, 'activity.acquire', { token: 'late', reason: 'stale caller' })).ok, false)
  child.emit('message', { event: 'dsh.event', data: { type: 'late' } })
  assert.equal(f.events.length, 1)
  assert.equal((await f.control(child, 501, 'activity.release', { token: 'job' })).ok, true)
  const closing = registration.stop()
  await waitForShutdown(child)
  child.exit()
  await closing
  assert.equal(f.first.activity.size, 0)
})

test('backend exit and shutdown acknowledgements cannot bypass descendant retirement before a new generation', async () => {
  const f = fixture()
  const pending = f.rpc.callPluginBackend('fixture.plugin', 'workbench', [])
  const child = f.children[0], request = child.messages.find(message => message.method === 'workbench')
  child.emit('message', { id: request.id, ok: true, data: {} }); await pending
  f.addDescendant(child, 500)
  assert.equal((await f.control(child, 20, 'process.track', { pid: 500 })).ok, true)
  const registration = f.backendRegistration(child)
  const closing = registration.stop()
  child.emit('message', { type: 'shutdown.complete', ok: true })
  child.exit()
  const next = f.generation(2)
  assert.throws(() => f.rpc.callPluginBackend('fixture.plugin', 'workbench', []), /still retiring/)
  assert.equal(f.children.length, 1)
  await closing
  assert.ok(f.signals.some(([pid]) => pid === 500))
  assert.equal(f.registrations.size, 0)
  const reopened = f.rpc.callPluginBackend('fixture.plugin', 'workbench', [])
  const second = f.children[1], secondRequest = second.messages.find(message => message.method === 'workbench')
  assert.equal(second.messages.find(message => message.type === 'init').generation, next.owner.generation)
  second.emit('message', { id: secondRequest.id, ok: true, data: 'new-generation' })
  assert.equal(await reopened, 'new-generation')
  const stopSecond = f.backendRegistration(second).stop()
  await waitForShutdown(second)
  second.exit(); await stopSecond
})

test('unconfirmed descendant exit rejects disposal and keeps the retirement barrier', async () => {
  const f = fixture()
  const pending = f.rpc.callPluginBackend('fixture.plugin', 'workbench', [])
  const child = f.children[0], request = child.messages.find(message => message.method === 'workbench')
  child.emit('message', { id: request.id, ok: true, data: {} }); await pending
  f.addDescendant(child, 500)
  assert.equal((await f.control(child, 20, 'process.track', { pid: 500 })).ok, true)
  f.setKillDescendants(false)
  const closing = f.backendRegistration(child).stop()
  child.exit()
  await assert.rejects(closing, /descendant exit not confirmed/)
  assert.ok(f.first.failures.some(message => message.includes('descendant exit not confirmed')))
  f.generation(2)
  assert.throws(() => f.rpc.callPluginBackend('fixture.plugin', 'workbench', []), /still retiring/)
  assert.equal(f.children.length, 1)
})
