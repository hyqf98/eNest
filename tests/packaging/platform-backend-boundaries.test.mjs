import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import ts from 'typescript'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
function load(file, adapters = {}, processMock = process) {
  const output = ts.transpileModule(readFileSync(new URL(`../../${file}`, new URL("../../tools/packaging/", import.meta.url)), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true }
  }).outputText
  const module = { exports: {} }
  new Function('require', 'module', 'exports', 'process', output)(name => name in adapters ? adapters[name] : require(name), module, module.exports, processMock)
  return module.exports
}

test('target packages are selected first but remain installable only on the matching platform', async () => {
  const { validatePluginDistribution, marketRegistryNames } = load('src/main/plugin/pluginDistribution.ts')
  assert.deepEqual(marketRegistryNames('darwin', 'arm64'), ['registry-darwin-arm64.json', 'registry.json'])
  assert.deepEqual(marketRegistryNames('linux', 'arm64'), ['registry.json'])
  const root = await mkdtemp(join(tmpdir(), 'enest-target-contract-'))
  try {
    await validatePluginDistribution(root, 'darwin', 'arm64')
    await mkdir(join(root, 'assets')); await mkdir(join(root, 'backend'))
    const marker = join(root, 'assets/enest-distribution.json'), inventory = join(root, 'backend/dependency-inventory.json')
    await writeFile(marker, JSON.stringify({ schemaVersion: 1, target: 'darwin-arm64' }))
    await validatePluginDistribution(root, 'darwin', 'arm64')
    await assert.rejects(validatePluginDistribution(root, 'darwin', 'x64'), /targets darwin-arm64/)
    await writeFile(inventory, JSON.stringify({ target: 'universal' }))
    await assert.rejects(validatePluginDistribution(root), /Conflicting/)
    await rm(inventory); await rm(marker); await symlink('/missing-file', marker)
    await assert.rejects(validatePluginDistribution(root), /Invalid/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

function controlFixture() {
  let rows = [row(10, 1, 100), row(11, 10, 101), row(12, 11, 102), row(99, 1, 90)]
  const killed = [], endpoints = [], registrations = new Set(), scope = { owner: { pluginId: 'test.plugin', generation: 1 }, isClosing: false,
    signal: new AbortController().signal, active: true, count: 0, isCurrent() { return this.active },
    acquireActivity() { this.count++; return () => this.count-- }
  }
  const { PluginBackendControl, descendantsOf } = load('src/main/plugin/pluginBackendControl.ts', {
    electron: { session: { defaultSession: { resolveProxy: async () => 'PROXY 127.0.0.1:7890' } } },
    './pluginProcessMemory': { sampleProcessMemory: async () => rows },
    './pluginSessionPolicy': { allowPluginEndpoint: (...args) => { const endpoint = { args, closed: false }; endpoints.push(endpoint); return () => { endpoint.closed = true } } },
    './pluginOwnedProcesses': { registerPluginProcess: item => { registrations.add(item); return () => registrations.delete(item) } }
  }, { kill: (...args) => killed.push(args) })
  return { control: new PluginBackendControl(scope, () => 10), scope, killed, endpoints, registrations, descendantsOf, setRows: value => { rows = value } }
}
function row(pid, parentPid, startedAt) { return { pid, parentPid, startedAt, memoryBytes: 1, residentBytes: 1, metric: 'footprint' } }

test('backend controls are generation-owned, reject foreign PIDs and remote endpoints, and revoke on shutdown', async () => {
  const f = controlFixture(), c = f.control
  await c.request('activity.acquire', { token: 'job', reason: 'download' }); assert.equal(f.scope.count, 1)
  await c.request('activity.acquire', { token: 'job', reason: 'download' }); assert.equal(f.scope.count, 1)
  await assert.rejects(c.request('process.track', { pid: 99 }), /not a live descendant/)
  await assert.rejects(c.request('endpoint.allow', { token: 'bad', url: 'https://example.com', kind: 'subFrame', pid: 11 }), /loopback/)
  await c.request('endpoint.allow', { token: 'web', url: 'http://127.0.0.1:9981/', kind: 'subFrame', pid: 11 })
  assert.equal(f.endpoints.length, 1)
  assert.deepEqual(await c.request('network.resolveProxy', { url: 'https://example.com/file' }), { proxy: 'PROXY 127.0.0.1:7890' })
  await c.beginClose(); assert.equal(f.endpoints[0].closed, true)
  await assert.rejects(c.request('activity.acquire', { token: 'late', reason: 'late' }), /closing/)
  await c.request('activity.release', { token: 'job' }); assert.equal(f.scope.count, 0)
  c.dispose(); assert.equal(f.scope.count, 0)
})

test('backend child cleanup survives reparenting, never kills reused PIDs and cannot abandon a live child', async () => {
  const f = controlFixture(), c = f.control
  await c.request('process.track', { pid: 11 }); await c.request('process.untrack', { pid: 11 })
  assert.equal(f.registrations.size, 1)
  await c.beginClose()
  f.setRows([row(10, 1, 100), row(11, 1, 101), row(12, 1, 999), row(99, 1, 90)])
  await c.stopChildren('SIGTERM')
  assert.deepEqual(f.killed, [[11, 'SIGTERM']])
  f.setRows([row(10, 1, 100), row(11, 1, 1000)])
  await c.stopChildren('SIGKILL'); await c.confirmChildrenExited()
  assert.deepEqual(f.killed, [[11, 'SIGTERM']]); assert.equal(f.registrations.size, 0)
})

test('updater dependencies are deferred and concurrent first checks load/configure them once', async () => {
  let loads = 0
  const updater = new EventEmitter(); updater.checkForUpdates = async () => ({ updateInfo: {} })
  const f = load('src/main/update/updateService.ts', {
    electron: { app: { getVersion: () => '0.2.0', isPackaged: true } },
    'electron-updater': new Proxy({}, { get(_target, prop) { if (prop === '__esModule') return false; if (prop === 'autoUpdater') { loads++; return updater } } }),
    '@main/logs/logService': { logInfo() {}, logWarn() {}, logError() {} },
    '@main/window/createShellWindow': { sendShellEvent() {} }, '@main/plugin/shellNotices': { broadcastNotice() {} }
  })
  f.initUpdateService(); assert.equal(loads, 0)
  await Promise.all([f.checkForUpdates(), f.checkForUpdates()])
  assert.equal(loads, 1); assert.equal(updater.listenerCount('update-available'), 1)
})

test('DSH no longer has host business imports or dedicated IPC, permission and preload API', () => {
  for (const file of ['src/main/ipc/pluginHandlers.ts', 'src/main/plugin/PluginHost.ts', 'src/preload/pluginPreload.ts', 'src/shared/types/plugin.ts']) {
    const source = readFileSync(new URL(`../../${file}`, new URL("../../tools/packaging/", import.meta.url)), 'utf8')
    assert.doesNotMatch(source, /@main\/dsh|@shared\/types\/dsh-workbench|dsh\.workbench|dsh\.connect|dsh\.admin/)
  }
})
