import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import ts from 'typescript'

const require = createRequire(import.meta.url)
const MiB = 1024 * 1024
const tick = () => new Promise(resolve => setImmediate(resolve))
const memoryRow = (pid, overrides = {}) => ({
  pid, startedAt: pid * 10_000, kind: 'renderer', pluginIds: [], shared: false,
  memoryBytes: 2 * MiB, residentBytes: MiB, metric: 'footprint', ...overrides
})
const cpuRow = (pid, creationTime, cumulativeCPUUsage, overrides = {}) => ({
  pid, creationTime, type: 'Tab', cpu: { cumulativeCPUUsage, percentCPUUsage: 999_999 }, memory: {}, ...overrides
})

function fixture() {
  let now = 0, source, written, memoryCalls = 0
  const timers = new Map(), logs = []
  const state = {
    memory: { sampledAt: 1700000000000, processes: [] },
    owned: [],
    diagnostics: {
      host: { logicalTabs: 32, hibernated: 25, coldShellTabs: 4, lazyDetached: 2, opening: 0, closing: 0, retiring: 0, entries: [] },
      resources: [], utilities: [], backgrounds: [], renderers: [], processes: [],
      auxiliary: { windows: 0, captureWindows: 0, reservedSlots: 0, payloadReservationBytes: 0 },
      streams: { streams: 0, pendingWrites: 0, queuedBytes: 0 },
      session: { bytes: 0, residentBytes: 0, plugins: 0 },
      localStorage: { cacheBytes: 0, dirtyBytes: 0, dirtyKeys: 0, plugins: 0 }
    }
  }
  const setTimer = (callback, delay) => {
    const handle = { unref() {} }
    timers.set(handle, { callback, at: now + delay })
    return handle
  }
  const clearTimer = handle => timers.delete(handle)
  function load(file, adapters = {}) {
    const output = ts.transpileModule(readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true }
    }).outputText
    const module = { exports: {} }
    const dependencies = { 'node:perf_hooks': { performance: { now: () => now } }, ...adapters }
    new Function('require', 'module', 'exports', 'setTimeout', 'clearTimeout', output)(
      name => Object.hasOwn(dependencies, name) ? dependencies[name] : require(name),
      module, module.exports, setTimer, clearTimer)
    return module.exports
  }
  const types = load('src/shared/types/performanceCapture.ts')
  const { PerformanceCaptureRecorder } = load('src/main/plugin/performanceCaptureRecorder.ts', { '@shared/types/performanceCapture': types })
  class ObservedRecorder extends PerformanceCaptureRecorder {
    constructor(input) { super(input); source = input }
  }
  const capture = load('src/main/plugin/pluginPerformanceCapture.ts', {
    electron: {
      app: { once() {}, getVersion: () => 'fixture-0.2.3' },
      BaseWindow: { getAllWindows: () => [{ isDestroyed: () => false, isFocused: () => true, isVisible: () => true }] },
      webContents: { getAllWebContents: () => [{ isDestroyed: () => false, isDevToolsOpened: () => false }] },
      dialog: { showSaveDialog: async () => ({ canceled: false, filePath: '/fixture-only/not-written.json' }) }
    },
    'node:fs/promises': { writeFile: async (_path, data, options) => { written = { data, options } } },
    'node:os': { cpus: () => [1, 2], freemem: () => 4096 * MiB, totalmem: () => 16384 * MiB, release: () => 'fixture' },
    '@main/plugin/pluginDiagnostics': { getPluginDiagnostics: () => state.diagnostics },
    '@main/plugin/pluginMemoryMonitor': { getPluginMemoryDiagnosticSnapshot: async () => { memoryCalls++; return state.memory } },
    '@main/plugin/pluginOwnedProcesses': { getPluginOwnedProcesses: () => state.owned },
    '@main/window/createShellWindow': { getMainWindow: () => null },
    '@main/logs/logService': { logInfo: (_source, message) => logs.push(message) },
    '@main/plugin/performanceCaptureRecorder': { PerformanceCaptureRecorder: ObservedRecorder }
  })
  return {
    state, logs, capture,
    get memoryCalls() { return memoryCalls },
    async sampleAt(time, previous = null) { now = time; return source.collect((previous?.sequence ?? 0) + 1, 0, previous) },
    async advance(ms) {
      now += ms
      for (const [handle, timer] of [...timers]) if (timer.at <= now) { timers.delete(handle); timer.callback() }
      await tick()
    },
    async exportReport() {
      assert.equal((await capture.exportPerformanceCapture()).exported, true)
      assert.equal(written.options.mode, 0o600)
      return JSON.parse(written.data)
    }
  }
}

test('shared renderer owners retain one PID measurement instead of adding memory once per plugin', async () => {
  const f = fixture()
  const shared = memoryRow(10, { pluginIds: ['fixture.alpha', 'fixture.beta'], shared: true, memoryBytes: 7 * MiB })
  // The memory monitor supplies the owner union on each PID row; repeated rows must not multiply its charge.
  f.state.memory.processes = [shared, { ...shared }, memoryRow(20, { kind: 'host', memoryBytes: 3 * MiB }),
    memoryRow(30, { pluginIds: ['fixture.alpha'], memoryBytes: null, residentBytes: null, metric: 'unavailable' })]
  assert.equal(f.memoryCalls, 0)
  assert.equal(f.capture.getPerformanceCaptureState().status, 'idle')
  assert.equal(f.memoryCalls, 0)
  const sample = await f.sampleAt(0)
  assert.equal(sample.processes.length, 3)
  assert.equal(sample.memory.uniqueProcesses, 3)
  assert.equal(sample.memory.measuredBytes, 10 * MiB)
  assert.equal(sample.memory.unavailableProcesses, 1)
  assert.deepEqual(sample.processes.find(row => row.pid === 10).pluginIds, ['fixture.alpha', 'fixture.beta'])
  assert.equal(sample.processes.find(row => row.pid === 10).shared, true)
  assert.deepEqual(sample.memory.metrics.sort(), ['footprint', 'unavailable'])
})

test('owner generations require exact PID evidence across foreground, background, auxiliary and native owners', async () => {
  const f = fixture(), pluginId = 'fixture.alpha'
  f.state.memory.processes = [10, 20, 30, 40, 50, 60, 70].map(pid => memoryRow(pid, { pluginIds: [pluginId] }))
  f.state.diagnostics.resources = [{ pluginId, generation: 11, wcId: 101, closing: false, activities: [], resources: 1 }]
  f.state.diagnostics.renderers = [
    { pluginId, generation: 11, wcId: 101, pid: 10, pids: [10] },
    { pluginId, generation: 77, wcId: 202, pid: 20, pids: [20] },
    { pluginId, generation: 11, wcId: 303, pid: 30, pids: [30, 70] },
    { pluginId, generation: 11, wcId: 404, pid: 50, pids: [50] },
    { pluginId, generation: 77, wcId: 505, pid: 50, pids: [50] },
    { pluginId: 'fixture.other', generation: 99, wcId: 606, pid: 60, pids: [60] }
  ]
  f.state.diagnostics.backgrounds = [{ pluginId, generation: 77, wcId: 202, pending: 0 }]
  f.state.owned = [{ pluginId, generation: 88, kind: 'utility', pid: 40 }]
  const sample = await f.sampleAt(0)
  const generations = Object.fromEntries(sample.processes.map(row => [row.pid, row.owners[0].generation]))
  assert.deepEqual(generations, { 10: 11, 20: 77, 30: 11, 40: 88, 50: null, 60: null, 70: 11 })
})

test('background, auxiliary capture and queued file resources enter bounded capture without their payloads', async () => {
  const f = fixture()
  f.state.diagnostics.backgrounds = [{ pending: 2, command: 'PRIVATE_COMMAND' }, { pending: 3, payload: 'PRIVATE_PAYLOAD' }]
  f.state.diagnostics.auxiliary = { windows: 4, captureWindows: 1, reservedSlots: 5, payloadReservationBytes: 4096, source: 'PRIVATE_SOURCE' }
  f.state.diagnostics.streams = { streams: 2, pendingWrites: 3, queuedBytes: 1.5 * MiB, path: 'PRIVATE_PATH' }
  f.state.diagnostics.utilities = [{ pending: 7 }]
  const sample = await f.sampleAt(0)
  assert.deepEqual(Object.fromEntries(['backgrounds', 'backgroundPending', 'auxiliaryWindows', 'captureWindows', 'fileStreams', 'queuedFileBytes']
    .map(key => [key, sample.counters[key]])), {
    backgrounds: 2, backgroundPending: 5, auxiliaryWindows: 4, captureWindows: 1, fileStreams: 2, queuedFileBytes: 1.5 * MiB
  })
  assert.equal(sample.counters.utilities, 1)
  assert.equal(sample.counters.utilityPending, 7)
  assert.equal(JSON.stringify(sample).includes('PRIVATE_'), false)
  assert.equal(Object.hasOwn(sample.counters, 'reservedSlots'), false)
  assert.equal(Object.hasOwn(sample.counters, 'payloadReservationBytes'), false)
})

test('CPU uses monotonic cumulative deltas and rejects PID reuse, unknown identity, mismatched identity and counter regression', async () => {
  const f = fixture()
  f.state.memory.processes = [10, 20, 30, 40, 50, 60].map(pid => memoryRow(pid))
  f.state.diagnostics.processes = [
    cpuRow(10, 100000, 3), cpuRow(20, 200000, 5), cpuRow(30, null, 8),
    cpuRow(40, 401200, 9), cpuRow(50, 500000, 10)
  ]
  const first = await f.sampleAt(0)
  assert.equal(first.cpu.oneCorePercent, null)
  assert.equal(first.cpu.measuredProcesses, 0)
  assert.equal(first.cpu.unavailableProcesses, 6)
  f.state.memory.processes[1] = memoryRow(20, { startedAt: 900000 })
  f.state.diagnostics.processes = [
    cpuRow(10, 100000, 3.5), cpuRow(20, 900000, 100), cpuRow(30, null, 12),
    cpuRow(40, 401200, 13), cpuRow(50, 500000, 1)
  ]
  const second = await f.sampleAt(5000, first)
  assert.equal(second.cpu.intervalMs, 5000)
  assert.equal(second.cpu.oneCorePercent, 10)
  assert.equal(second.cpu.measuredProcesses, 1)
  assert.equal(second.cpu.unavailableProcesses, 5)
  assert.equal(second.cpu.newProcesses, 1)
  assert.equal(second.cpu.exitedProcesses, 1)
  assert.equal(second.processes.find(row => row.pid === 10).cpuOneCorePercent, 10)
  for (const pid of [20, 30, 40, 50, 60]) assert.equal(second.processes.find(row => row.pid === pid).cpuOneCorePercent, null)
  for (const pid of [30, 40, 60]) assert.equal(second.processes.find(row => row.pid === pid).cpuCumulativeSeconds, null)
  assert.equal(JSON.stringify(second).includes('percentCPUUsage'), false)
})

test('native-only PID reuse counts the retired identity and its replacement without inventing CPU usage', async () => {
  const f = fixture()
  f.state.memory.processes = [memoryRow(80, { kind: 'utility', startedAt: 1000, pluginIds: ['fixture.alpha'] })]
  const first = await f.sampleAt(0)
  f.state.memory.processes = [memoryRow(80, { kind: 'utility', startedAt: 9000, pluginIds: ['fixture.alpha'] })]
  const second = await f.sampleAt(5000, first)
  assert.equal(second.cpu.newProcesses, 1)
  assert.equal(second.cpu.exitedProcesses, 1)
  assert.equal(second.cpu.measuredProcesses, 0)
  assert.equal(second.cpu.oneCorePercent, null)
  assert.equal(second.processes[0].cpuStartedAt, null)
})

test('actual recorder log summaries and exported samples agree on PID totals, CPU and new resource counters', async () => {
  const f = fixture()
  f.state.memory.processes = [memoryRow(10, { memoryBytes: 8 * MiB, pluginIds: ['fixture.alpha', 'fixture.beta'], shared: true }),
    memoryRow(20, { kind: 'host', memoryBytes: 2 * MiB })]
  f.state.diagnostics.processes = [cpuRow(10, 100000, 3), cpuRow(20, 200000, 2)]
  f.state.diagnostics.host.entries = [{ pluginId: 'fixture.alpha', generation: 2, wcId: 1, state: 'visible', secret: 'PRIVATE_PAYLOAD' }]
  f.state.diagnostics.backgrounds = [{ pending: 2 }, { pending: 1 }]
  f.state.diagnostics.auxiliary = { windows: 3, captureWindows: 1 }
  f.state.diagnostics.streams = { streams: 2, queuedBytes: 512 * 1024 }
  f.capture.startPerformanceCapture()
  await tick()
  f.state.diagnostics.processes = [cpuRow(10, 100000, 3.5), cpuRow(20, 200000, 2.25)]
  await f.advance(5000)
  const report = await f.exportReport(), last = report.samples.at(-1)
  assert.equal(report.schema, 'enest.performance.v2')
  assert.equal(report.state.status, 'stopped')
  assert.equal(report.samples.length, 2)
  assert.equal(last.cpu.oneCorePercent, 15)
  assert.equal(last.cpu.measuredProcesses, 2)
  assert.equal(last.cpu.unavailableProcesses, 0)
  assert.equal(last.counters.backgroundPending, 3)
  assert.equal(last.counters.captureWindows, 1)
  assert.equal(last.counters.queuedFileBytes, 512 * 1024)
  const summaries = f.logs.filter(message => message.startsWith('sample '))
  assert.equal(summaries.length, report.samples.length)
  for (const [index, sample] of report.samples.entries()) {
    const values = Object.fromEntries(summaries[index].split(' ').slice(1).map(part => part.split('=')))
    assert.equal(Number(values.sequence), sample.sequence)
    assert.equal(Number(values.processes), sample.memory.uniqueProcesses)
    assert.equal(values.measuredMiB, (sample.memory.measuredBytes / MiB).toFixed(1))
    assert.equal(values.cpuOneCorePercent, sample.cpu.oneCorePercent === null ? 'unavailable' : sample.cpu.oneCorePercent.toFixed(2))
    assert.equal(Number(values.cpuUnmeasured), sample.cpu.unavailableProcesses)
    for (const key of ['logicalTabs', 'live', 'hibernated', 'coldShellTabs', 'lazyDetached']) assert.equal(Number(values[key]), sample.host[key])
    for (const key of ['backgrounds', 'auxiliaryWindows', 'fileStreams']) assert.equal(Number(values[key]), sample.counters[key])
  }
  assert.equal(JSON.stringify(report).includes('PRIVATE_PAYLOAD'), false)
  assert.equal(f.logs.join('\n').includes('PRIVATE_PAYLOAD'), false)
  const calls = f.memoryCalls
  await f.advance(10_000)
  assert.equal(f.memoryCalls, calls)
})
