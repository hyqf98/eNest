import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import vm from 'node:vm'
import ts from 'typescript'

const require = createRequire(import.meta.url)
const pluginId = 'fixture.export-owner'
const root = join(tmpdir(), 'enest-virtual-export-no-real-files')
const normal = join(root, 'normal.txt'), delayed = join(root, 'delayed.txt')
const icon = { isEmpty: () => false }
const info = { isFile: () => true, isDirectory: () => false, size: 1 }
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
function load(name, imports) {
  const code = ts.transpileModule(readFileSync(new URL(`../../src/main/plugin/${name}.ts`, new URL("../../tools/packaging/", import.meta.url)), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  }).outputText
  const module = { exports: {} }
  vm.runInNewContext(code, { module, exports: module.exports, Buffer, AbortController, setTimeout, clearTimeout, console,
    require(name) {
      if (Object.hasOwn(imports, name)) return imports[name]
      if (name.startsWith('node:')) return require(name)
      throw new Error(`Unexpected fixture import ${name}`)
    } })
  return module.exports
}
function fixture(options = {}) {
  const metadata = [], iconCalls = [], ids = [], drags = [], leases = new Set()
  const acquire = () => { const token = Symbol(); leases.add(token); return () => leases.delete(token) }
  const api = load('localFiles', {
    electron: {
      app: { getFileIcon: async path => { iconCalls.push(path); return options.getIcon ? options.getIcon(path) : icon } },
      nativeImage: { createEmpty: () => icon, createFromBuffer: () => icon }
    },
    'node:crypto': { randomUUID: () => { const id = `export-${ids.length + 1}`; ids.push(id); return id } },
    'node:fs': { realpathSync: path => path, statSync: () => info },
    'node:fs/promises': {
      realpath: async path => { metadata.push(['realpath', path]); return options.realpath ? options.realpath(path) : path },
      stat: async path => { metadata.push(['stat', path]); return options.stat ? options.stat(path) : info }
    },
    '@main/plugin/PluginHost': { pluginHost: {
      acquireWindowInteraction: acquire,
      getWebContents: () => ({ isDestroyed: () => false, startDrag: input => drags.push(input) })
    } },
    '@main/window/createQuickWindow': { acquireQuickInteraction: acquire },
    '@main/plugin/activityRegistry': { acquirePluginActivity: acquire }
  })
  return { api, metadata, iconCalls, ids, drags, leases,
    assertExport(id, path) {
      assert.equal(api.startLocalDrag(pluginId, id), true)
      assert.equal(drags.at(-1).file, path)
      api.endLocalDrag(pluginId)
      assert.equal(leases.size, 0)
    } }
}

test('stopping a delayed export cannot mint a grant or revoke other exports in the same runtime', async () => {
  const native = deferred(), f = fixture({ getIcon: path => path === delayed ? native.promise : icon })
  const previous = await f.api.createLocalExport(pluginId, [normal])
  const controller = new AbortController()
  const pending = f.api.createLocalExport(pluginId, [delayed], { signal: controller.signal })
  const rejected = assert.rejects(pending, /export cancelled/)
  await until(() => f.iconCalls.includes(delayed))
  const independentPath = join(root, 'independent.txt')
  const independent = await f.api.createLocalExport(pluginId, [independentPath])
  controller.abort(); native.resolve(icon)
  await rejected
  assert.equal(f.ids.length, 2, 'cancelled backend export never allocates a grant id')
  assert.throws(() => f.api.startLocalDrag(pluginId, 'export-3'), /not prepared/)
  f.assertExport(previous.exportId, normal)
  f.assertExport(independent.exportId, independentPath)
})

test('metadata cancellation is checked before icon lookup and does not mint an export', async () => {
  for (const stage of ['realpath', 'stat']) {
    const native = deferred(), controller = new AbortController()
    const f = fixture({ [stage]: () => native.promise })
    const pending = f.api.createLocalExport(pluginId, [delayed], { signal: controller.signal })
    const rejected = assert.rejects(pending, /export cancelled/)
    await until(() => f.metadata.some(([kind]) => kind === stage))
    controller.abort(); native.resolve(stage === 'realpath' ? delayed : info)
    await rejected
    assert.equal(f.iconCalls.length, 0)
    assert.equal(f.ids.length, 0)
  }
})

test('already stopped backend creates no metadata or native icon work', async () => {
  const f = fixture(), controller = new AbortController(); controller.abort()
  await assert.rejects(f.api.createLocalExport(pluginId, [normal], { signal: controller.signal }), /export cancelled/)
  assert.equal(f.metadata.length, 0)
  assert.equal(f.iconCalls.length, 0)
  assert.equal(f.ids.length, 0)
})

test('backend guard and runtime ownership are checked again after native icon lookup', async () => {
  for (const expired of ['backend', 'runtime']) {
    const native = deferred(), f = fixture({ getIcon: () => native.promise }); let current = true
    const pending = f.api.createLocalExport(pluginId, [normal], {
      assertCurrent: () => { if (!current) throw new Error('backend retired') }
    })
    const rejected = assert.rejects(pending, expired === 'backend' ? /backend retired/ : /expired/)
    await until(() => f.iconCalls.length === 1)
    if (expired === 'backend') current = false
    else f.api.releaseLocalFiles(pluginId)
    native.resolve(icon); await rejected
    assert.equal(f.ids.length, 0)
  }
})

test('concurrent first exports commit to one current bag instead of overwriting another result', async () => {
  const firstIcon = deferred(), secondIcon = deferred()
  const f = fixture({ getIcon: path => path === normal ? firstIcon.promise : secondIcon.promise })
  const first = f.api.createLocalExport(pluginId, [normal]), second = f.api.createLocalExport(pluginId, [delayed])
  await until(() => f.iconCalls.length === 2)
  secondIcon.resolve(icon); const b = await second
  firstIcon.resolve(icon); const a = await first
  f.assertExport(a.exportId, normal)
  f.assertExport(b.exportId, delayed)
})

test('128 export quota is enforced at commit even when native icons settle concurrently', async () => {
  const f = fixture()
  const settled = await Promise.allSettled(Array.from({ length: 129 }, () => f.api.createLocalExport(pluginId, [normal])))
  assert.equal(settled.filter(result => result.status === 'fulfilled').length, 128)
  const failed = settled.filter(result => result.status === 'rejected')
  assert.equal(failed.length, 1)
  assert.match(failed[0].reason.message, /export limit/)
  assert.equal(f.ids.length, 128)
  for (const result of settled) if (result.status === 'fulfilled') f.assertExport(result.value.exportId, normal)
})

test('production capability passes backend cancellation into local export and dispose does not wait for OS icons', async () => {
  const native = deferred(), f = fixture({ getIcon: path => path.endsWith('backend.txt') ? native.promise : icon })
  const prior = await f.api.createLocalExport(pluginId, [normal])
  const removed = []
  const { PluginBackendCapabilities } = load('pluginBackendCapabilities', {
    './pluginBackendFiles': { PluginBackendFiles: class { async dispose() {} } },
    '@shared/types/plugin': { PLUGIN_PERMISSIONS: ['backend.node'] },
    './localFiles': f.api,
    'node:fs/promises': {
      mkdtemp: async () => join(root, 'backend-directory'), realpath: async path => path,
      rm: async path => { removed.push(path) }
    }
  })
  // Stop replaces the backend, not the still-live renderer's runtime identity.
  const capability = new PluginBackendCapabilities({ owner: { pluginId } }, () => {})
  const directory = await capability.request('files.exportDirectory', {})
  const path = join(directory, 'backend.txt')
  const pending = capability.request('files.export', { paths: [path] })
  const rejected = assert.rejects(pending, /export cancelled/)
  await until(() => f.iconCalls.includes(path))
  await capability.dispose()
  assert.deepEqual(removed, [directory])
  native.resolve(icon); await rejected
  assert.equal(f.ids.length, 1)
  f.assertExport(prior.exportId, normal)
})
