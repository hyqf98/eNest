import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

const source = file => ts.transpileModule(readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText
const controlSource = source('src/main/plugin/pluginBackendControl.ts')
const rpcSource = source('src/main/plugin/pluginBackendRpc.ts')
function load(source, imports, globals) {
  const module = { exports: {} }
  vm.runInNewContext(source, { module, exports: module.exports, console, Buffer,
    require: name => { assert.ok(name in imports, `Unexpected import: ${name}`); return imports[name] }, ...globals })
  return module.exports
}
const turn = () => new Promise(resolve => setImmediate(resolve))
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const row = (pid, parentPid, startedAt, metric = 'footprint') => ({ pid, parentPid, startedAt, memoryBytes: 1, residentBytes: 1, metric })

function fixture({ rpc = false, deferSpawn = false } = {}) {
  let rows = [], current, nextPid = 100, killChildren = true, killBackend = true, nextSample
  const registrations = new Set(), signals = [], utilities = [], activities = new Set(), calls = []
  const registerPluginProcess = registration => { registrations.add(registration); return () => registrations.delete(registration) }
  const sampleProcessMemory = async () => {
    calls.push('sample')
    const override = nextSample; nextSample = undefined
    return override ? override() : rows.map(value => ({ ...value }))
  }
  function generation(value) {
    const controller = new AbortController(), disposers = new Set()
    const scope = { owner: { pluginId: 'fixture.plugin', generation: value, wcId: value + 10 },
      signal: controller.signal, isClosing: false, failures: [], isCurrent: () => current === scope,
      acquireActivity(reason) { const token = Symbol(reason); activities.add(token); return () => activities.delete(token) },
      addDisposer(dispose) { disposers.add(dispose); return () => disposers.delete(dispose) },
    }
    current = scope
    return scope
  }
  const first = generation(1)
  const processMock = { platform: 'darwin', env: {}, execPath: '/fixture/Electron', kill(pid, signal) {
    if (signal === 0) {
      if (!rows.some(value => value.pid === pid)) throw Object.assign(new Error('exited'), { code: 'ESRCH' })
      return true
    }
    signals.push([pid, signal])
    const backend = utilities.find(child => child.pid === pid)
    if (backend) { if (killBackend) backend.exit() }
    else if (killChildren) rows = rows.filter(value => value.pid !== pid)
  } }
  const { PluginBackendControl, descendantsOf } = load(controlSource, {
    electron: { session: { defaultSession: { resolveProxy: async () => 'DIRECT' } } },
    './pluginProcessMemory': { sampleProcessMemory }, './pluginOwnedProcesses': { registerPluginProcess },
    './pluginSessionPolicy': { allowPluginEndpoint: () => () => {} },
  }, { process: processMock })
  class Utility extends EventEmitter {
    constructor() {
      super(); this.assignedPid = ++nextPid; this.pid = deferSpawn ? undefined : this.assignedPid
      this.messages = []; this.exited = false
      if (this.pid) rows.push(row(this.pid, 1, 1_000_123))
    }
    spawn() { if (!this.pid) { this.pid = this.assignedPid; rows.push(row(this.pid, 1, 1_000_123)) } this.emit('spawn') }
    postMessage(message) { this.messages.push(message) }
    kill() { if (killBackend) this.exit() }
    exit() { if (this.exited) return; this.exited = true; rows = rows.filter(value => value.pid !== this.pid); this.emit('exit', 0) }
  }
  const api = rpc ? load(rpcSource, {
    electron: { utilityProcess: { fork() { const child = new Utility(); utilities.push(child); if (!deferSpawn) queueMicrotask(() => child.spawn()); return child } } },
    './PluginRuntimeScope': { getRuntimeScope: () => current },
    './pluginBackend': { resolvePluginBackendPackage: () => ({ entry: '/fixture/backend.cjs', root: '/fixture' }) },
    './PluginHost': { pluginHost: { sendEvent() {} } }, './pluginOwnedProcesses': { registerPluginProcess },
    './pluginBackendControl': { PluginBackendControl }, '@main/paths/pathsService': { getAppPaths: () => ({ data: '/fixture/data' }) },
  }, { process: processMock, setTimeout: (callback, ms) => setTimeout(callback, ms >= 3000 ? 200 : 0), clearTimeout }) : null
  const control = new PluginBackendControl(first, () => 101)
  const registration = child => [...registrations].find(value => value.kind === 'backend' && value.getPid() === child.pid)
  async function open() {
    const request = api.callPluginBackend('fixture.plugin', 'fixture', [])
    const child = utilities.at(-1), message = child.messages.find(value => value.method === 'fixture')
    child.emit('message', { id: message.id, ok: true, data: 'ok' })
    assert.equal(await request, 'ok')
    return child
  }
  async function host(child, id, method, params) {
    child.emit('message', { type: 'host.request', id, method, params })
    for (let index = 0; index < 20; index++) {
      const response = child.messages.find(value => value.type === 'host.response' && value.id === id)
      if (response) return response
      await turn()
    }
    throw Error('missing host response')
  }
  return { control, descendantsOf, registrations, signals, activities, utilities, first, api, generation, registration, open, host, calls,
    setRows(value) { rows = value }, setSample(value) { nextSample = value },
    setKillChildren(value) { killChildren = value }, setKillBackend(value) { killBackend = value },
  }
}

test('native -> ps precision downgrade neither kills nor forgets; native recovery can retire the same child', async () => {
  for (const startedAt of [1_000_456, 1_000_000]) {
    const f = fixture()
    const parent = 999_123
    f.setRows([row(101, 1, parent), row(202, 101, startedAt)])
    await f.control.request('process.track', { pid: 202 })
    f.setRows([row(101, 1, 999_000, 'resident'), row(202, 101, 1_000_000, 'resident')])
    await assert.rejects(f.control.stopChildren('SIGTERM'), /capture not confirmed/)
    await f.control.request('process.untrack', { pid: 202 })
    await assert.rejects(f.control.confirmChildrenExited(), /not confirmed/)
    assert.equal(f.signals.length, 0)
    assert.equal(f.registrations.size, 1)
    f.setRows([row(101, 1, parent), row(202, 1, startedAt)])
    await f.control.stopChildren('SIGKILL')
    await f.control.confirmChildrenExited()
    assert.deepEqual(f.signals, [[202, 'SIGKILL']])
    assert.equal(f.registrations.size, 0)
  }
})

test('precise PID reuse retires old ownership without signaling the replacement', async () => {
  const f = fixture()
  f.setRows([row(101, 1, 1_000_123), row(202, 101, 1_000_456)])
  await f.control.request('process.track', { pid: 202 })
  f.setRows([row(101, 1, 1_000_123), row(202, 1, 1_000_789)])
  await f.control.stopChildren('SIGKILL')
  await f.control.confirmChildrenExited()
  assert.equal(f.signals.length, 0)
  assert.equal(f.registrations.size, 0)
})

test('a coarse initial root sample does not permanently prevent later precise tracking', async () => {
  const f = fixture()
  f.setRows([row(101, 1, 1_000_000, 'resident'), row(202, 101, 1_001_000, 'resident')])
  await assert.rejects(f.control.request('process.track', { pid: 202 }), /not a live descendant/)
  f.setRows([row(101, 1, 1_000_123), row(202, 101, 1_001_456)])
  await f.control.request('process.track', { pid: 202 })
  assert.equal(f.registrations.size, 1)
  await f.control.stopChildren('SIGTERM'); await f.control.confirmChildrenExited()
})

test('late untrack cannot erase a newly tracked incarnation using the same PID', async () => {
  const f = fixture(), pending = deferred()
  f.setRows([row(101, 1, 1_000_123), row(202, 101, 1_001_456)])
  await f.control.request('process.track', { pid: 202 })
  f.setSample(() => pending.promise)
  const untracking = f.control.request('process.untrack', { pid: 202 })
  const replacement = [row(101, 1, 1_000_123), row(202, 101, 1_002_456)]
  f.setRows(replacement)
  await f.control.request('process.track', { pid: 202 })
  pending.resolve(replacement)
  await untracking
  assert.equal(f.registrations.size, 1)
  await f.control.stopChildren('SIGTERM'); await f.control.confirmChildrenExited()
  assert.deepEqual(f.signals, [[202, 'SIGTERM']])
})

test('failed close capture remains retryable rather than caching a rejected capture forever', async () => {
  const f = fixture()
  f.setRows([row(101, 1, 1_000_123), row(202, 101, 1_001_456)])
  await f.control.request('process.track', { pid: 202 })
  f.setSample(async () => { throw Error('sampler unavailable') })
  await assert.rejects(f.control.beginClose(), /sampler unavailable/)
  await f.control.stopChildren('SIGTERM'); await f.control.confirmChildrenExited()
  assert.equal(f.registrations.size, 0)
})

for (const [label, initialRows] of [
  ['coarse fallback', pid => [row(pid, 1, 1_000_000, 'resident'), row(202, pid, 1_001_000, 'resident')]],
  ['unavailable metadata', pid => [row(pid, 1, 0, 'unavailable'), row(202, pid, 0, 'unavailable')]],
]) test(`first close with ${label} retains the live backend until an explicit precise retry`, async () => {
  const f = fixture({ rpc: true }), child = await f.open(), registration = f.registration(child)
  f.setRows(initialRows(child.pid))
  await assert.rejects(registration.stop(), /capture not confirmed/)
  assert.equal(child.exited, false, 'uncertain capture must not orphan an untracked child by killing its parent')
  assert.equal(child.messages.some(message => message.type === 'shutdown'), false)
  assert.equal(f.signals.length, 0)
  assert.equal(f.registrations.size, 1)
  const samples = f.calls.length
  await new Promise(resolve => setTimeout(resolve, 15))
  assert.equal(f.calls.length, samples, 'sampler recovery is explicit, not a retry loop')
  f.setRows([row(child.pid, 1, 1_000_123), row(202, child.pid, 1_001_456)])
  const retry = registration.stop()
  f.generation(2)
  assert.throws(() => f.api.callPluginBackend('fixture.plugin', 'fixture', []), /still retiring/)
  await retry
  assert.equal(child.exited, true)
  assert.deepEqual(f.signals, [[202, 'SIGTERM']])
  assert.equal(f.registrations.size, 0)
  const next = await f.open()
  await f.registration(next).stop()
})

test('a precise parent with unreadable child identity cannot claim an empty capture', async () => {
  const f = fixture()
  f.setRows([row(101, 1, 1_000_123), row(202, 101, 0, 'unavailable')])
  await assert.rejects(f.control.stopChildren('SIGTERM'), /capture not confirmed/)
  await assert.rejects(f.control.confirmChildrenExited(), /capture not confirmed/)
  assert.equal(f.signals.length, 0)
  f.setRows([row(101, 1, 1_000_123), row(202, 101, 1_001_456)])
  await f.control.stopChildren('SIGTERM'); await f.control.confirmChildrenExited()
  assert.deepEqual(f.signals, [[202, 'SIGTERM']])
})

test('parent exit after an unknown first capture cannot erase the unresolved retirement barrier', async () => {
  const f = fixture({ rpc: true }), child = await f.open(), registration = f.registration(child)
  f.setRows([row(child.pid, 1, 1_000_000, 'resident'), row(202, child.pid, 1_001_000, 'resident')])
  await assert.rejects(registration.stop(), /capture not confirmed/)
  child.exit()
  f.setRows([row(202, 1, 1_001_456)])
  await turn()
  await assert.rejects(registration.stop(), /capture not confirmed/)
  assert.equal(f.signals.length, 0)
  assert.equal(f.registrations.size, 1)
  f.generation(2)
  assert.throws(() => f.api.callPluginBackend('fixture.plugin', 'fixture', []), /still retiring/)
})

test('close before spawn rejects promptly and captures descendants when the native PID becomes available', async () => {
  const f = fixture({ rpc: true, deferSpawn: true })
  const request = f.api.callPluginBackend('fixture.plugin', 'fixture', [])
  const rejected = assert.rejects(request, /backend closed/)
  const child = f.utilities[0], registration = f.registration(child)
  await assert.rejects(registration.stop(), /spawn not confirmed/)
  await rejected
  assert.equal(f.calls.length, 0, 'an unborn root must not cache an empty snapshot')
  assert.equal(child.messages.some(message => message.type === 'shutdown'), false)
  assert.equal(f.registrations.size, 1)
  assert.equal(f.activities.size, 1)
  assert.equal((await f.host(child, 30, 'activity.acquire', { token: 'late', reason: 'closing' })).ok, false)
  await new Promise(resolve => setTimeout(resolve, 15))
  assert.equal(f.calls.length, 0, 'no polling while native spawn is pending')
  f.setRows([row(202, child.assignedPid, 1_001_456)])
  child.spawn()
  await registration.stop()
  assert.equal(child.exited, true)
  assert.deepEqual(f.signals, [[202, 'SIGTERM']])
  assert.equal(f.registrations.size, 0)
  assert.equal(f.activities.size, 0)
})

test('failed shutdown preserves ownership and can recover on the next explicit stop without polling', async () => {
  const f = fixture({ rpc: true }), child = await f.open(), registration = f.registration(child)
  f.setRows([row(child.pid, 1, 1_000_123), row(202, child.pid, 1_001_456)])
  assert.equal((await f.host(child, 20, 'process.track', { pid: 202 })).ok, true)
  assert.equal((await f.host(child, 21, 'activity.acquire', { token: 'work', reason: 'still owned' })).ok, true)
  f.setKillChildren(false)
  const firstClose = registration.stop(); child.exit()
  await assert.rejects(firstClose, /descendant exit not confirmed/)
  assert.ok(f.first.failures.some(value => value.includes('not confirmed')))
  assert.equal(f.registrations.size, 2)
  assert.equal(f.activities.size, 1)
  const samples = f.calls.length
  await new Promise(resolve => setTimeout(resolve, 15))
  assert.equal(f.calls.length, samples, 'there must be no autonomous retry loop')
  f.generation(2)
  f.setKillChildren(true)
  const retry = registration.stop()
  assert.throws(() => f.api.callPluginBackend('fixture.plugin', 'fixture', []), /still retiring/)
  await retry
  assert.equal(f.registrations.size, 0)
  assert.equal(f.activities.size, 0)
  assert.ok(f.first.failures.length, 'the original failure remains observable')
  const next = await f.open()
  assert.equal(f.utilities.length, 2)
  await f.registration(next).stop()
})

test('a late backend exit retries a failed retirement and releases its barriers', async () => {
  const f = fixture({ rpc: true }), child = await f.open(), registration = f.registration(child)
  f.setKillBackend(false)
  await assert.rejects(registration.stop(), /backend exit not confirmed/)
  assert.equal(f.registrations.size, 1)
  child.exit()
  for (let index = 0; index < 30 && f.registrations.size; index++) await new Promise(resolve => setTimeout(resolve, 2))
  assert.equal(f.registrations.size, 0)
  f.generation(2); f.setKillBackend(true)
  const next = await f.open()
  await f.registration(next).stop()
})
