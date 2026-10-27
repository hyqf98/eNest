import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import ts from 'typescript'

const require = createRequire(import.meta.url)
const tick = () => new Promise(resolve => setImmediate(resolve))
function fixture() {
  let now = 0
  const timers = new Map(), logs = []
  const setTimer = (callback, delay) => { const handle = { unref() {} }; timers.set(handle, { callback, at: now + delay }); return handle }
  const clearTimer = handle => timers.delete(handle)
  function load(file, adapters = {}) {
    const source = ts.transpileModule(readFileSync(new URL(`../../${file}`, new URL("../../tools/packaging/", import.meta.url)), 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true }
    }).outputText
    const module = { exports: {} }
    const dependencies = { 'node:perf_hooks': { performance: { now: () => now } }, ...adapters }
    new Function('require', 'module', 'exports', 'setTimeout', 'clearTimeout', source)(
      name => Object.hasOwn(dependencies, name) ? dependencies[name] : require(name), module, module.exports, setTimer, clearTimer)
    return module.exports
  }
  const types = load('src/shared/types/performanceCapture.ts')
  const { PerformanceCaptureRecorder } = load('src/main/plugin/performanceCaptureRecorder.ts', { '@shared/types/performanceCapture': types })
  async function advance(ms) {
    now += ms
    for (const [handle, timer] of [...timers]) if (timer.at <= now) { timers.delete(handle); timer.callback() }
    await tick()
  }
  const sample = sequence => ({ sequence, sampledAt: Date.now(), elapsedMs: now, collectionMs: 1, memorySampledAt: Date.now(), memoryError: false,
    systemFreeMemoryBytes: 1, processes: [], processesTruncated: false, memory: { measuredBytes: 0, unavailableProcesses: 0, uniqueProcesses: 0, metrics: [] },
    cpu: { intervalMs: null, oneCorePercent: null, measuredProcesses: 0, unavailableProcesses: 0, newProcesses: 0, exitedProcesses: 0 },
    host: { logicalTabs: 0, live: 0, hibernated: 0, coldShellTabs: 0, lazyDetached: 0, opening: 0, closing: 0, retiring: 0 }, plugins: [], resources: [], counters: {},
    windows: { total: 1, focused: 1, visible: 1, devTools: 0 } })
  return { load, types, PerformanceCaptureRecorder, logs, timers, sample, advance }
}

test('recording is opt-in, single-flight, and stopping waits for the in-flight sample without scheduling another', async () => {
  const f = fixture()
  let calls = 0, release
  const recorder = new f.PerformanceCaptureRecorder({ metadata: () => ({}), log: value => f.logs.push(value), collect: async sequence => {
    calls++; await new Promise(resolve => { release = resolve }); return f.sample(sequence)
  } })
  assert.equal(recorder.state().status, 'idle'); assert.equal(f.timers.size, 0); assert.equal(calls, 0)
  const started = recorder.start()
  assert.equal(recorder.start().captureId, started.captureId)
  await tick(); await f.advance(5000)
  assert.equal(calls, 1)
  const stopped = recorder.stop()
  assert.equal(recorder.state().status, 'stopping')
  assert.throws(() => recorder.start(), /stopping/)
  release(); await stopped; await f.advance(5000)
  assert.equal(calls, 1); assert.equal(f.timers.size, 0)
  assert.equal(recorder.report().samples.length, 1)
  const state = recorder.state(); state.sampleCount = 999
  assert.equal(recorder.state().sampleCount, 1)
})

test('recording enforces duration and serialized-buffer limits and never logs thrown error content', async () => {
  const f = fixture()
  const recorder = new f.PerformanceCaptureRecorder({ metadata: () => ({}), log: value => f.logs.push(value), collect: async () => { throw new Error('/secret/path?token=PRIVATE') } })
  recorder.start(); await tick()
  assert.equal(recorder.state().failedSamples, 1)
  await f.advance(f.types.PERFORMANCE_CAPTURE_LIMITS.durationMs)
  assert.equal(recorder.state().status, 'stopped'); assert.equal(recorder.state().stopReason, 'time-limit')
  assert.equal(f.logs.join('').includes('PRIVATE'), false)
  const large = new f.PerformanceCaptureRecorder({ metadata: () => ({}), log() {}, collect: async sequence => ({ ...f.sample(sequence), oversized: 'x'.repeat(4 * 1024 * 1024) }) })
  large.start(); await tick(); await tick()
  assert.equal(large.state().status, 'stopped'); assert.equal(large.state().stopReason, 'size-limit')
  assert.equal(large.state().sampleCount, 0); assert.equal(large.state().retainedBytes, 0)
})

test('native export deduplicates PID memory, matches CPU creation identities, redacts payloads and retains cancelled exports', async () => {
  const f = fixture()
  let phase = 0, cancel = true, written
  const memoryProcess = (pid, startedAt) => ({ pid, startedAt, kind: 'renderer', pluginIds: ['fixture.plugin'], shared: false, memoryBytes: 100, residentBytes: 80, metric: 'footprint' })
  const metrics = () => [
    { pid: 10, creationTime: 100, type: 'Tab', cpu: { cumulativeCPUUsage: phase ? 3.5 : 3, percentCPUUsage: 999 }, memory: {} },
    { pid: 20, creationTime: phase ? 300 : 200, type: 'Tab', cpu: { cumulativeCPUUsage: phase ? 100 : 5 }, memory: {} }
  ]
  const capture = f.load('src/main/plugin/pluginPerformanceCapture.ts', {
    electron: { app: { once() {}, getVersion: () => 'fixture' }, BaseWindow: { getAllWindows: () => [{ isDestroyed: () => false, isFocused: () => true, isVisible: () => true }] },
      webContents: { getAllWebContents: () => [{ isDestroyed: () => false, isDevToolsOpened: () => true }] }, dialog: { showSaveDialog: async () => ({ canceled: cancel, filePath: '/user-selected/PRIVATE.json' }) } },
    'node:fs/promises': { writeFile: async (path, data, options) => { written = { path, data, options } } },
    'node:os': { cpus: () => [1, 2], freemem: () => 1000, totalmem: () => 2000, release: () => 'fixture' },
    '@main/plugin/pluginDiagnostics': { getPluginDiagnostics: () => ({ sampledAt: Date.now(), host: { logicalTabs: 32, hibernated: 26, coldShellTabs: 5, lazyDetached: 2, opening: 0, closing: 0, retiring: 0,
      entries: [{ pluginId: 'fixture.plugin', generation: 2, wcId: 1, state: 'visible', tabSessionId: 'PRIVATE' }] },
      resources: [{ pluginId: 'fixture.plugin', generation: 2, wcId: 1, closing: false, activities: ['PRIVATE command'], resources: 4 }], utilities: [{ pending: 1, secret: 'PRIVATE' }],
      session: { bytes: 3, residentBytes: 2, plugins: 1, payload: 'PRIVATE' }, localStorage: { cacheBytes: 3, dirtyBytes: 1, dirtyKeys: 1, plugins: 1, lastFlushError: 'PRIVATE/path' }, processes: metrics() }) },
    '@main/plugin/pluginMemoryMonitor': { getPluginMemoryDiagnosticSnapshot: async () => ({ sampledAt: Date.now(), error: 'PRIVATE error',
      processes: [memoryProcess(10, 100), memoryProcess(10, 100), memoryProcess(20, phase ? 300 : 200), memoryProcess(30, 400)] }) },
    '@main/plugin/pluginOwnedProcesses': { getPluginOwnedProcesses: () => [] }, '@main/window/createShellWindow': { getMainWindow: () => null },
    '@main/logs/logService': { logInfo: (_source, message) => f.logs.push(message) },
    '@main/plugin/performanceCaptureRecorder': { PerformanceCaptureRecorder: f.PerformanceCaptureRecorder }
  })
  capture.startPerformanceCapture(); await tick()
  phase = 1; await f.advance(5000)
  const cancelled = await capture.exportPerformanceCapture()
  assert.equal(cancelled.exported, false); assert.equal(capture.getPerformanceCaptureState().status, 'stopped')
  cancel = false; assert.equal((await capture.exportPerformanceCapture()).exported, true)
  const report = JSON.parse(written.data), last = report.samples.at(-1)
  assert.equal(report.schema, 'enest.performance.v2')
  assert.equal(last.host.coldShellTabs, 5); assert.equal(last.host.lazyDetached, 2); assert.equal(Object.hasOwn(last.host, 'lazy'), false)
  assert.match(f.logs.join('\n'), /logicalTabs=32 live=1 hibernated=26 coldShellTabs=5 lazyDetached=2/)
  assert.equal(last.memory.uniqueProcesses, 3); assert.equal(last.memory.measuredBytes, 300)
  assert.equal(last.cpu.oneCorePercent, 10); assert.equal(last.cpu.measuredProcesses, 1); assert.equal(last.cpu.unavailableProcesses, 2)
  assert.equal(last.processes.find(value => value.pid === 20).cpuOneCorePercent, null)
  assert.equal(last.processes.find(value => value.pid === 30).cpuCumulativeSeconds, null)
  assert.equal(last.windows.devTools, 1); assert.equal(last.windows.focused, 1); assert.equal(last.windows.total, 1); assert.equal(last.counters.activities, 1)
  assert.equal(last.resources[0].generation, 2); assert.equal(last.memoryError, true)
  assert.equal(written.data.includes('PRIVATE'), false); assert.equal(written.data.includes('percentCPUUsage'), false)
  assert.equal(f.logs.join('').includes('PRIVATE'), false); assert.equal(written.options.mode, 0o600)
})

test('authoritative host diagnostics distinguish cold shell placeholders from all other lifecycle states', () => {
  const source = ts.createSourceFile('PluginHost.ts', readFileSync(new URL('../../src/main/plugin/PluginHost.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true)
  const hostClass = source.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'PluginHost')
  const method = hostClass.members.find(node => ts.isMethodDeclaration(node) && node.name.getText(source) === 'getDiagnostics')
  // Run the production read-only method without initializing Electron or the singleton host.
  const output = ts.transpileModule(`export class DiagnosticHost { ${method.getText(source)} }`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  }).outputText
  const module = { exports: {} }
  new Function('module', 'exports', output)(module, module.exports)
  const host = new module.exports.DiagnosticHost()
  for (const field of ['logicalTabs', 'entries', 'hibernated', 'opening', 'closing', 'finalClosing', 'retiringViews', 'reloading', 'transfers', 'restoringDetached', 'tabPresentation']) host[field] = new Map()
  host.lazyDetached = new Set(['detached-restored', 'not-a-shell-tab'])
  const states = new Map([['crashed', 'crash'], ['closed', 'closed'], ['uninstalling', 'clearing-storage']])
  host.getState = id => states.get(id) ?? 'installed'
  host.getPlacement = id => ({ kind: id === 'not-a-shell-tab' ? 'detached' : 'shell' })
  for (const id of ['cold-a', 'cold-b', 'crashed', 'closed', 'uninstalling', 'not-a-shell-tab']) host.logicalTabs.set(id, {})
  for (const field of ['entries', 'hibernated', 'opening', 'closing', 'finalClosing', 'retiringViews', 'reloading', 'transfers']) {
    host.logicalTabs.set(field, {})
    host[field].set(field, { pluginId: field, generation: 1, scope: { owner: { wcId: 1 } } })
  }
  host.entries.set('quick-live', { pluginId: 'quick-live', generation: 2, container: 'quick', scope: { owner: { wcId: 2 } } })
  const first = host.getDiagnostics()
  assert.equal(first.coldShellTabs, 2); assert.equal(first.lazyDetached, 2)
  assert.equal(first.logicalTabs, 14); assert.equal(first.entries.length, 2); assert.equal(first.hibernated, 1)
  assert.equal(Object.hasOwn(first, 'lazy'), false)
  assert.notEqual(first.coldShellTabs, first.logicalTabs - first.entries.length - first.hibernated)
  host.opening.set('cold-a', {})
  assert.equal(host.getDiagnostics().coldShellTabs, 1)
  host.logicalTabs.delete('cold-b')
  assert.equal(host.getDiagnostics().coldShellTabs, 0)
})
