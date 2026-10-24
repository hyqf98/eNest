import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import * as fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import ts from 'typescript'

const require = createRequire(import.meta.url)
const compiled = new Map(), root = new URL('../../', import.meta.url), OWNER = 'com.fixture.screen'
function load(path, imports = {}) {
  if (!compiled.has(path)) compiled.set(path, ts.transpileModule(readFileSync(new URL(path, root), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  }).outputText)
  const module = { exports: {} }
  new Function('require', 'module', 'exports', compiled.get(path))(name => {
    if (Object.hasOwn(imports, name)) return imports[name]
    if (name.startsWith('node:')) return require(name)
    throw new Error(`Unexpected dependency ${name}`)
  }, module, module.exports)
  return module.exports
}
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const bytes = value => new Uint8Array(Buffer.from(value)).buffer

async function fixture(t, overrides = {}) {
  const data = await fs.mkdtemp(join(tmpdir(), 'enest-file-stream-fixture-'))
  const scopes = load('src/main/plugin/PluginRuntimeScope.ts'), scope = scopes.createRuntimeScope({ pluginId: OWNER, generation: 1, wcId: 1 })
  const api = load('src/main/plugin/pluginFileStreams.ts', {
    'node:fs/promises': { ...fs, ...overrides },
    '@main/paths/pathsService': { getAppPaths: () => ({ data }) }, '@main/plugin/PluginRuntimeScope': scopes
  })
  const directory = join(data, 'plugin-files', createHash('sha256').update(OWNER).digest('hex'))
  t.after(async () => { await api.disposeFileStreams(); await scope.dispose(); await fs.rm(data, { recursive: true, force: true }) })
  return { api, data, directory, scopes, scope }
}

test('private streams serialize partial writes, enforce ordering and retain completed outputs', async t => {
  let writes = 0
  const f = await fixture(t, { async open(...args) {
    const file = await fs.open(...args)
    return { close: () => file.close(), sync: () => file.sync(), write(buffer, offset, length, position) { writes++; return file.write(buffer, offset, Math.min(2, length), position) } }
  } })
  await assert.rejects(f.api.openFileStream(OWNER, { extension: '../webm' }), /extension/)
  const { streamId } = await f.api.openFileStream(OWNER, { extension: 'webm' })
  await assert.rejects(f.api.writeFileStream(OWNER, streamId, 1, bytes('wrong')), /sequence/)
  await assert.rejects(f.api.writeFileStream(OWNER, streamId, 0, new ArrayBuffer(512 * 1024 + 1)), /512/)
  await f.api.writeFileStream(OWNER, streamId, 0, bytes('fixture'))
  await f.api.writeFileStream(OWNER, streamId, 1, bytes('-only'))
  const saved = await f.api.finishFileStream(OWNER, streamId)
  assert.equal(saved.size, 12); assert.ok(writes > 2)
  assert.equal(await fs.readFile(saved.path, 'utf8'), 'fixture-only')
  assert.deepEqual(await fs.readdir(f.directory), [`${streamId}.webm`])
  assert.deepEqual(f.api.getFileStreamDiagnostics(), { streams: 0, pendingWrites: 0, queuedBytes: 0 })
  assert.equal(f.scope.activityCount, 0)
})

test('stream quotas are reserved before async IO and foreign incarnations cannot write or abort', async t => {
  const f = await fixture(t)
  const pending = [f.api.openFileStream(OWNER, { extension: 'webm' }), f.api.openFileStream(OWNER, { extension: 'webm' })]
  await assert.rejects(f.api.openFileStream(OWNER, { extension: 'webm' }), /limit/)
  const [first, second] = await Promise.all(pending)
  await assert.rejects(f.api.writeFileStream('com.foreign', first.streamId, 0, bytes('x')), /owned/)
  await assert.rejects(f.api.abortFileStream('com.foreign', first.streamId), /owned/)
  assert.equal(await f.api.abortFileStream(OWNER, first.streamId), true)
  assert.equal(await f.api.abortFileStream(OWNER, second.streamId), true)
  assert.equal(await f.api.abortFileStream(OWNER, second.streamId), false)
  assert.deepEqual(await fs.readdir(f.directory), [])
})

test('existing stream drains during beforeClose but cannot be opened after markClosing', async t => {
  const f = await fixture(t), { streamId } = await f.api.openFileStream(OWNER, { extension: 'webm' })
  await f.api.writeFileStream(OWNER, streamId, 0, bytes('before-'))
  f.scope.markClosing()
  await assert.rejects(f.api.openFileStream(OWNER, { extension: 'webm' }), /closing/)
  await f.api.writeFileStream(OWNER, streamId, 1, bytes('close'))
  const result = await f.api.finishFileStream(OWNER, streamId)
  assert.equal(await fs.readFile(result.path, 'utf8'), 'before-close')
  await f.scope.dispose()
  assert.equal(await fs.readFile(result.path, 'utf8'), 'before-close')
})

test('disposal while native open is pending closes the late file handle and removes the partial file', async t => {
  const entered = deferred(), release = deferred()
  let closed = 0
  const f = await fixture(t, { async open(...args) {
    const file = await fs.open(...args); entered.resolve(); await release.promise
    return { close: () => { closed++; return file.close() }, sync: () => file.sync(), write: (...values) => file.write(...values) }
  } })
  const opening = f.api.openFileStream(OWNER, { extension: 'webm' })
  const rejected = assert.rejects(opening, /closing/)
  await entered.promise
  const disposing = f.scope.dispose(Date.now() + 5_000)
  release.resolve(); await rejected; await disposing
  assert.equal(closed, 1); assert.deepEqual(await fs.readdir(f.directory), [])
  assert.equal(f.api.getFileStreamDiagnostics().streams, 0)
})

test('disposal racing final rename removes the just-published output instead of returning stale success', async t => {
  const entered = deferred(), release = deferred()
  const f = await fixture(t, { async rename(...args) { await fs.rename(...args); entered.resolve(); await release.promise } })
  const { streamId } = await f.api.openFileStream(OWNER, { extension: 'webm' })
  await f.api.writeFileStream(OWNER, streamId, 0, bytes('fixture'))
  const finish = f.api.finishFileStream(OWNER, streamId), rejected = assert.rejects(finish, /closing/)
  await entered.promise
  const disposing = f.scope.dispose(Date.now() + 5_000)
  release.resolve(); await rejected; await disposing
  assert.deepEqual(await fs.readdir(f.directory), []); assert.equal(f.scope.activityCount, 0)
})

test('small queued chunks have a pending-count cap and cancelled IO stays reserved until cleanup', async t => {
  const entered = deferred(), release = deferred()
  const f = await fixture(t, { async open(...args) {
    const file = await fs.open(...args)
    return { close: () => file.close(), sync: () => file.sync(), async write(...values) { entered.resolve(); await release.promise; return file.write(...values) } }
  } })
  const a = await f.api.openFileStream(OWNER, { extension: 'webm' }), b = await f.api.openFileStream(OWNER, { extension: 'webm' })
  const pending = Array.from({ length: 16 }, (_, i) => f.api.writeFileStream(OWNER, a.streamId, i, bytes('x')))
  const observed = Promise.allSettled(pending)
  await assert.rejects(f.api.writeFileStream(OWNER, a.streamId, 16, bytes('x')), /byte limit/)
  await entered.promise
  const abort = f.api.abortFileStream(OWNER, a.streamId)
  await assert.rejects(f.api.openFileStream(OWNER, { extension: 'webm' }), /limit/)
  release.resolve(); await abort
  assert.ok((await observed).every(result => result.status === 'rejected'))
  await f.api.abortFileStream(OWNER, b.streamId)
  assert.deepEqual(f.api.getFileStreamDiagnostics(), { streams: 0, pendingWrites: 0, queuedBytes: 0 })
})

test('private output deletion requires closed runtime; restart reclaims only UUID partials', async t => {
  const f = await fixture(t)
  await fs.mkdir(f.directory, { recursive: true })
  const orphan = '12345678-1234-1234-1234-123456789abc.part'
  await fs.writeFile(join(f.directory, orphan), 'fixture orphan')
  await fs.writeFile(join(f.directory, 'keep.webm'), 'saved fixture')
  const { streamId } = await f.api.openFileStream(OWNER, { extension: 'webm' })
  assert.equal((await fs.readdir(f.directory)).includes(orphan), false)
  await f.api.writeFileStream(OWNER, streamId, 0, bytes('saved'))
  await f.api.finishFileStream(OWNER, streamId)
  await assert.rejects(f.api.clearPluginFileStreams(OWNER), /Close plugin/)
  await f.scope.dispose()
  await f.api.clearPluginFileStreams(OWNER)
  await assert.rejects(fs.stat(f.directory), { code: 'ENOENT' })
})

test('private disk quotas account for completed sparse outputs without reading their bytes', async t => {
  const f = await fixture(t)
  await fs.mkdir(f.directory, { recursive: true })
  const file = await fs.open(join(f.directory, 'saved.webm'), 'w')
  await file.truncate(3 * 1024 ** 3 + 1); await file.close()
  await assert.rejects(f.api.openFileStream(OWNER, { extension: 'webm' }), /storage limit/)
  assert.equal(f.api.getFileStreamDiagnostics().streams, 0)
})
