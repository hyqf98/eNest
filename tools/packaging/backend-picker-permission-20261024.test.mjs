import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import vm from 'node:vm'
import ts from 'typescript'

const require = createRequire(import.meta.url)
const pluginId = 'fixture.backend-picker'
const virtualRoot = join(tmpdir(), 'enest-virtual-picker-no-real-files')
const selected = join(virtualRoot, 'selected.txt')
const second = join(virtualRoot, 'second.txt')
const info = { isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false, size: 17 }

function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
async function until(condition) {
  for (let i = 0; i < 30; i++) {
    if (condition()) return
    await new Promise(resolve => setImmediate(resolve))
  }
  assert.fail('fixture did not reach expected state')
}
function load(file, imports, globals = {}) {
  const output = ts.transpileModule(readFileSync(new URL(`../../src/main/plugin/${file}.ts`, import.meta.url), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  }).outputText
  const module = { exports: {} }
  vm.runInNewContext(output, { module, exports: module.exports, Buffer, AbortController, AbortSignal,
    setTimeout, clearTimeout, console, ...globals, require(name) {
      if (Object.hasOwn(imports, name)) return imports[name]
      if (name.startsWith('node:')) return require(name)
      throw new Error(`Unexpected fixture dependency ${name}`)
    } })
  return module.exports
}
function leaseTracker() {
  const leases = new Set()
  return { leases, acquire(kind) { const token = Symbol(kind); leases.add(token); return () => { leases.delete(token) } } }
}
function pickerFixture(options = {}) {
  const resources = leaseTracker(), calls = [], metadata = [], ids = []
  const dialog = Object.fromEntries(['showOpenDialog', 'showSaveDialog'].map(method => [method, (...args) => {
    const pending = deferred()
    calls.push({ method, options: args.at(-1), ...pending })
    return pending.promise
  }]))
  const fs = {
    realpath: async path => { metadata.push(['realpath', path]); return options.realpath ? options.realpath(path) : path },
    stat: async path => { metadata.push(['stat', path]); return options.stat ? options.stat(path) : info },
    lstat: async path => { metadata.push(['lstat', path]); return options.lstat ? options.lstat(path) : info }
  }
  const api = load('localFiles', {
    electron: { dialog },
    'node:crypto': { randomUUID: () => { const id = `fixture-id-${ids.length + 1}`; ids.push(id); return id } },
    'node:fs/promises': fs,
    '@main/plugin/PluginHost': { pluginHost: { getContainerWindow: () => ({}), acquireWindowInteraction: () => resources.acquire('window') } },
    '@main/window/createQuickWindow': { acquireQuickInteraction: () => resources.acquire('quick') },
    '@main/plugin/activityRegistry': { acquirePluginActivity: () => resources.acquire('activity') }
  })
  return { api, resources, calls, metadata, ids }
}

test('selected native file/save handles preserve normal access; cancelled controls open no dialogs', async () => {
  const f = pickerFixture()
  const read = f.api.pickLocalFiles(pluginId)
  f.calls[0].resolve({ canceled: false, filePaths: [selected] })
  const [handle] = await read
  assert.equal(await f.api.resolveLocalFileHandle(pluginId, handle.id), selected)
  await assert.rejects(f.api.resolveLocalFileHandle(pluginId, handle.id, 'write'), /invalid/)
  const save = f.api.pickLocalSaveFile(pluginId, { defaultName: 'chosen.txt' })
  f.calls[1].resolve({ canceled: false, filePath: second })
  const saved = await save
  assert.equal(await f.api.resolveLocalFileHandle(pluginId, saved.id, 'write'), second)
  assert.equal(f.resources.leases.size, 0)
  const controller = new AbortController(); controller.abort()
  await assert.rejects(f.api.pickLocalFiles(pluginId, {}, { signal: controller.signal }), /cancelled/)
  await assert.rejects(f.api.pickLocalSaveFile(pluginId, {}, { signal: controller.signal }), /cancelled/)
  assert.equal(f.calls.length, 2)
  assert.equal(f.resources.leases.size, 0)
})

test('backend stop immediately releases native picker leases and rejects uncancellable late answers', async () => {
  for (const method of ['pickLocalFiles', 'pickLocalSaveFile']) {
    const f = pickerFixture(), controller = new AbortController()
    const pending = f.api[method](pluginId, {}, { signal: controller.signal })
    assert.equal(f.resources.leases.size, 3)
    const rejection = assert.rejects(pending, /cancelled/)
    controller.abort()
    assert.equal(f.resources.leases.size, 0)
    await rejection
    f.calls[0].resolve({ canceled: false, filePaths: [selected], filePath: selected })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(f.metadata.length, 0)
    assert.equal(f.ids.length, 1, 'late native selection does not mint a file handle')
    await assert.rejects(f.api.resolveLocalFileHandle(pluginId, 'fixture-id-2'), /invalid/)
  }
})

test('backend stop during selected-file metadata never mints read or save grants', async () => {
  for (const method of ['pickLocalFiles', 'pickLocalSaveFile']) {
    const metadata = deferred(), f = pickerFixture({ stat: () => metadata.promise, lstat: () => metadata.promise })
    const controller = new AbortController()
    const pending = f.api[method](pluginId, {}, { signal: controller.signal })
    const rejection = assert.rejects(pending, /cancelled/)
    f.calls[0].resolve({ canceled: false, filePaths: [selected], filePath: selected })
    await until(() => f.metadata.some(([kind]) => kind === 'stat' || kind === 'lstat'))
    controller.abort()
    assert.equal(f.resources.leases.size, 0)
    metadata.resolve(info)
    await rejection
    assert.equal(f.ids.length, 1)
    await assert.rejects(f.api.resolveLocalFileHandle(pluginId, 'fixture-id-2'), /invalid/)
  }
})

test('multiselect cancellation rolls back only this picker grants, including before pending metadata finishes', async () => {
  const metadata = deferred(), f = pickerFixture({ stat: path => path === second ? metadata.promise : info })
  const previous = await f.api.grantLocalFile(pluginId, join(virtualRoot, 'previous.txt'))
  const controller = new AbortController()
  const pending = f.api.pickLocalFiles(pluginId, { multiple: true }, { signal: controller.signal })
  const rejection = assert.rejects(pending, /cancelled/)
  f.calls[0].resolve({ canceled: false, filePaths: [selected, second] })
  await until(() => f.ids.length === 3)
  assert.equal(await f.api.resolveLocalFileHandle(pluginId, 'fixture-id-3'), selected)
  controller.abort()
  assert.equal(f.resources.leases.size, 0)
  await assert.rejects(f.api.resolveLocalFileHandle(pluginId, 'fixture-id-3'), /invalid/)
  assert.equal(await f.api.resolveLocalFileHandle(pluginId, previous.id), join(virtualRoot, 'previous.txt'))
  metadata.resolve(info)
  await rejection
  assert.equal(f.ids.length, 3)
})

test('picker backend guard and runtime incarnation checks are enforced after native/metadata awaits', async () => {
  const f = pickerFixture(); let current = true
  const pending = f.api.pickLocalFiles(pluginId, {}, { assertCurrent: () => { if (!current) throw new Error('backend retired') } })
  current = false
  f.calls[0].resolve({ canceled: false, filePaths: [selected] })
  await assert.rejects(pending, /backend retired/)
  assert.equal(f.ids.length, 1)
  const old = f.api.pickLocalSaveFile(pluginId)
  f.api.releaseLocalFiles(pluginId)
  assert.equal(f.resources.leases.size, 0)
  f.calls[1].resolve({ canceled: false, filePath: second })
  await assert.rejects(old, /expired/)
})

function permissionFixture(options = {}) {
  const resources = leaseTracker(), activity = leaseTracker(), calls = [], timers = [], saved = [], grants = new Map()
  const controller = new AbortController(), manifest = { name: 'Fixture', permissions: ['backend.node'] }
  const scope = { owner: { pluginId }, signal: controller.signal, isClosing: false, isCurrent: () => true,
    acquireActivity: () => { const release = activity.acquire('consent'); options.onAcquire?.(); return release } }
  const win = { isDestroyed: () => false, isMinimized: () => false, restore() {}, show() {} }
  const imports = {
    electron: { dialog: { showMessageBox: (_win, input) => { const pending = deferred(); calls.push({ input, ...pending }); return pending.promise } } },
    '@shared/types/plugin': { PLUGIN_PERMISSIONS: ['backend.node', 'db.connect', 'db.query', 'notify'] },
    '@shared/permissionLabels': { permissionLabel: value => value },
    '@shared/pluginPermissionPolicy': { isBuiltinCapability: () => false },
    '@main/settings/SettingsStore': { settingsStore: {
      getPermissionGrant: (owner, permission) => grants.get(`${owner}/${permission}`) || 'ask',
      setPermissionGrant: async (owner, permission, value) => { saved.push([owner, permission, value]); grants.set(`${owner}/${permission}`, value) }
    } },
    '@main/plugin/PluginRuntimeScope': { getRuntimeScope: () => scope },
    '@main/window/createShellWindow': { getMainWindow: () => win },
    '@main/logs/logService': { logWarn() {} },
    '@main/plugin/PluginHost': { pluginHost: { getContainerWindow: () => win, acquireWindowInteraction: () => resources.acquire('window') } },
    '@main/plugin/PluginRegistry': { pluginRegistry: { getManifest: () => manifest } },
    '@main/window/createQuickWindow': { acquireQuickInteraction: () => resources.acquire('quick') },
    '@main/clipboard/clipboardHistory': { revalidateClipboardPolling() {} }
  }
  const { PermissionService } = load('PermissionService', imports, {
    setTimeout: (callback, milliseconds) => { const timer = { callback, milliseconds, active: true, unref() {} }; timers.push(timer); return timer },
    clearTimeout: timer => { timer.active = false }
  })
  return { service: new PermissionService(), calls, timers, saved, resources, activity, scope, manifest, controller, imports }
}

test('permission deduplication is backend-owner scoped; stopping one consumer preserves another queued consent', async () => {
  const f = permissionFixture(), a = new AbortController(), b = new AbortController()
  const first = f.service.request(pluginId, 'backend.node', 'fixture', undefined, a.signal)
  assert.equal(f.service.request(pluginId, 'backend.node', 'fixture', undefined, a.signal), first)
  const second = f.service.request(pluginId, 'backend.node', 'fixture', undefined, b.signal)
  assert.notEqual(first, second)
  await until(() => f.calls.length === 1)
  assert.equal(f.activity.leases.size, 2)
  a.abort()
  assert.equal(f.activity.leases.size, 1)
  assert.equal(await first, false)
  await until(() => f.calls.length === 2)
  assert.equal(f.calls[0].input.signal.aborted, true)
  assert.equal(f.calls[1].input.signal.aborted, false)
  assert.equal(f.resources.leases.size, 2, 'old native dialog no longer owns UI leases')
  f.calls[1].resolve({ response: 1 })
  assert.equal(await second, true)
  f.calls[0].resolve({ response: 2 })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(f.saved.length, 0, 'late native approval does not persist grants')
  assert.equal(f.service.isGranted(pluginId, 'backend.node'), true)
  assert.equal(f.activity.leases.size, 0)
  assert.equal(f.resources.leases.size, 0)
})

test('cancelling a queued permission does not abort the active native request or its grant', async () => {
  const f = permissionFixture(), a = new AbortController(), b = new AbortController()
  const first = f.service.request(pluginId, 'backend.node', 'fixture', undefined, a.signal)
  const second = f.service.request(pluginId, 'backend.node', 'fixture', undefined, b.signal)
  await until(() => f.calls.length === 1)
  b.abort()
  assert.equal(await second, false)
  assert.equal(f.calls[0].input.signal.aborted, false)
  assert.equal(f.activity.leases.size, 1)
  f.calls[0].resolve({ response: 1 })
  assert.equal(await first, true)
  assert.equal(f.service.isGranted(pluginId, 'backend.node'), true)
  assert.equal(f.calls.length, 1)
})

test('permission timeout cancels only its request and advances the queue without waiting for native response', async () => {
  const f = permissionFixture(), a = new AbortController(), b = new AbortController()
  const first = f.service.request(pluginId, 'backend.node', 'fixture', undefined, a.signal)
  const second = f.service.request(pluginId, 'backend.node', 'fixture', undefined, b.signal)
  await until(() => f.calls.length === 1)
  assert.equal(f.timers[0].milliseconds, 60_000)
  f.timers[0].callback()
  assert.equal(await first, false)
  await until(() => f.calls.length === 2)
  assert.equal(f.activity.leases.size, 1)
  f.calls[1].resolve({ response: 2 })
  assert.equal(await second, true)
  assert.equal(f.saved.length, 1)
  f.calls[0].resolve({ response: 2 })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(f.saved.length, 1)
  assert.equal(f.resources.leases.size, 0)
})

test('backend cancellation does not revoke earlier runtime consent, including abort before listener registration', async () => {
  const f = permissionFixture(), granted = f.service.request(pluginId, 'backend.node', 'fixture')
  await until(() => f.calls.length === 1)
  f.calls[0].resolve({ response: 1 })
  assert.equal(await granted, true)
  f.manifest.permissions.push('db.query')
  const controller = new AbortController()
  const pending = f.service.request(pluginId, 'db.query', 'fixture', undefined, controller.signal)
  await until(() => f.calls.length === 2)
  controller.abort()
  assert.equal(await pending, false)
  assert.equal(f.service.isGranted(pluginId, 'backend.node'), true)
  assert.equal(f.service.isGranted(pluginId, 'db.query'), false)
  f.calls[1].resolve({ response: 2 })
  const pre = new AbortController()
  const race = permissionFixture({ onAcquire: () => pre.abort() })
  assert.equal(await race.service.request(pluginId, 'backend.node', 'fixture', undefined, pre.signal), false)
  assert.equal(race.activity.leases.size, 0)
  assert.equal(race.calls.length, 0)
})

test('runtime shutdown cancels every scoped consent but a backend abort stays isolated', async () => {
  const f = permissionFixture(), a = new AbortController(), b = new AbortController()
  const first = f.service.request(pluginId, 'backend.node', 'fixture', undefined, a.signal)
  const second = f.service.request(pluginId, 'backend.node', 'fixture', undefined, b.signal)
  await until(() => f.calls.length === 1)
  f.scope.isClosing = true; f.controller.abort()
  assert.deepEqual(await Promise.all([first, second]), [false, false])
  await until(() => f.resources.leases.size === 0)
  assert.equal(f.activity.leases.size, 0)
  assert.equal(f.calls.length, 1)
  f.calls[0].resolve({ response: 2 })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(f.saved.length, 0)
})

test('generic authorize forwards backend AbortSignal and rejects even a late true result', async () => {
  const f = permissionFixture(), calls = [], pending = deferred(), controller = new AbortController()
  const api = load('PluginPermissions', { ...f.imports,
    '@main/plugin/PermissionService': { permissionService: { request: (...args) => { calls.push(args); return pending.promise } } }
  })
  const authorize = api.authorizePluginPermission(pluginId, 'backend.node', 'fixture', controller.signal)
  const rejection = assert.rejects(authorize, /closing or stale/)
  await until(() => calls.length === 1)
  assert.equal(calls[0][4], controller.signal)
  controller.abort(); pending.resolve(true)
  await rejection
  await assert.rejects(api.authorizePluginPermission(pluginId, 'backend.node', 'fixture', controller.signal), /unavailable/)
  assert.equal(calls.length, 1)
})
