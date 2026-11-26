import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import ts from 'typescript'

const source = readFileSync(new URL('../../../src/main/plugin/pluginMemoryMonitor.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
const tick = () => new Promise(resolve => setImmediate(resolve))
const row = (pid, parentPid = 0, startedAt = pid * 1000) => ({ pid, parentPid, startedAt, memoryBytes: 128, residentBytes: 64, metric: 'private' })

function fixture() {
  const timers = new Set(), settings = { enabled: true, alertsEnabled: false, warningThresholdMiB: 512 }
  const state = { metrics: 0, scans: [], children: [], rows: [row(10)] }
  const emptyOwners = { getMemoryOwners: () => [] }
  const dependencies = {
    electron: { app: { getAppMetrics: () => { state.metrics++; return [{ pid: 10, memory: {}, creationTime: 10000 }] } }, webContents: { getAllWebContents: () => [] } },
    '@main/settings/SettingsStore': { settingsStore: { getPluginMemoryMonitorSettings: () => settings } },
    '@shared/types/pluginMemory': { normalizePluginMemoryMonitor: () => ({ ...settings }) },
    '@main/plugin/PluginRegistry': { pluginRegistry: { get: () => null } },
    '@main/plugin/PluginHost': { pluginHost: { ...emptyOwners, isClosing: () => false } },
    '@main/home/HomeSurfaceManager': { homeSurfaceManager: emptyOwners },
    '@main/plugin/pluginBackgroundRuntime': { getBackgroundMemoryOwners: () => [] },
    '@main/window/pluginAuxiliaryWindows': { getAuxiliaryMemoryOwners: () => [] },
    '@main/plugin/pluginOwnedProcesses': { getPluginOwnedProcesses: () => state.children },
    '@main/plugin/PluginRuntimeScope': { getRuntimeScope: () => null },
    '@main/plugin/pluginProcessMemory': { sampleProcessMemory: async pids => { state.scans.push(pids); return state.rows } },
    '@main/clipboard/nativeClipboard': { getNativeClipboardProcessId: () => undefined },
    '@main/logs/logService': { logWarn: (_scope, message) => assert.fail(message) },
    '@main/window/createShellWindow': {}, '@main/window/notificationOverlay': {}
  }
  const api = {}
  new Function('require', 'exports', 'setTimeout', 'clearTimeout', compiled)(name => dependencies[name], api,
    callback => { timers.add(callback); return callback }, callback => timers.delete(callback))
  const advance = async () => {
    await tick()
    assert.equal(timers.size, 1)
    const [callback] = timers
    timers.delete(callback); callback(); await tick()
  }
  return { api, state, settings, timers, advance }
}

test('idle monitoring skips OS work but inspections and opt-in diagnostics still sample the host', async () => {
  const { api, state, settings, timers, advance } = fixture()
  api.startPluginMemoryMonitor(); await advance()
  assert.deepEqual([state.metrics, state.scans.length], [0, 0])
  const [panel, recording] = await Promise.all([api.getPluginMemorySnapshot(true), api.getPluginMemoryDiagnosticSnapshot()])
  assert.equal(panel.hostMemoryBytes, 128); assert.equal(recording.hostMemoryBytes, 128)
  await advance(); assert.deepEqual([state.metrics, state.scans.length], [1, 1])
  settings.enabled = false; api.applyPluginMemoryMonitorSetting()
  assert.equal((await api.getPluginMemorySnapshot(true)).sampledAt, null)
  assert.equal((await api.getPluginMemoryDiagnosticSnapshot()).hostMemoryBytes, 128)
  assert.equal(state.scans.length, 2); assert.equal(timers.size, 0)
})

test('detached descendants are sampled after close until their process identity disappears or changes', async () => {
  const { api, state, advance } = fixture()
  state.children = [{ pid: 20, pluginId: 'fixture', kind: 'backend', generation: 1 }]
  state.rows.push(row(20), row(21, 20))
  api.startPluginMemoryMonitor(); await tick()
  state.children = []; state.rows = [row(10), row(21)]
  await api.refreshPluginMemoryAfterClose()
  assert.ok(state.scans.at(-1).includes(21))
  assert.deepEqual((await api.getPluginMemorySnapshot()).plugins[0].processes.map(item => item.pid), [21])
  state.rows = [row(10), row(21, 0, 99000)]
  await advance()
  assert.deepEqual((await api.getPluginMemorySnapshot()).plugins, [])
  const scans = state.scans.length
  await advance(); assert.equal(state.scans.length, scans)
  api.stopPluginMemoryMonitor()
})
