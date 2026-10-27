import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import * as fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import ts from 'typescript'

const require = createRequire(import.meta.url)
const root = new URL('../../../', import.meta.url)
const OWNER = 'com.fixture.outputs'
const bytes = value => Uint8Array.from(Buffer.from(value)).buffer
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }

function load(path, imports = {}) {
  const code = ts.transpileModule(readFileSync(new URL(path, root), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  }).outputText
  const module = { exports: {} }
  new Function('require', 'module', 'exports', code)(name => {
    if (Object.hasOwn(imports, name)) return imports[name]
    if (name.startsWith('node:')) return require(name)
    throw new Error(`Unexpected dependency: ${name}`)
  }, module, module.exports)
  return module.exports
}

async function fixture(t, { io = {}, pick } = {}) {
  const data = await fs.mkdtemp(join(tmpdir(), 'enest-private-outputs-'))
  const scopes = load('src/main/plugin/PluginRuntimeScope.ts')
  const scope = scopes.createRuntimeScope({ pluginId: OWNER, generation: 1, wcId: 1 })
  const target = join(data, 'exported.webm')
  const fileSystem = { ...fs, ...io }
  const storageIO = load('src/main/plugin/pluginStorageIO.ts', { 'node:fs/promises': fileSystem })
  const api = load('src/main/plugin/pluginFileStreams.ts', {
    'node:fs/promises': fileSystem,
    './pluginStorageIO': storageIO,
    '@main/paths/pathsService': { getAppPaths: () => ({ data }) },
    '@main/plugin/PluginRuntimeScope': scopes,
    '@main/plugin/localFiles': {
      async pickLocalSaveFile(pluginId, options, control) {
        assert.equal(pluginId, OWNER); control.assertCurrent()
        const result = pick ? await pick({ control, options, target }) : { id: 'selected' }
        control.assertCurrent()
        return result
      },
      async resolveLocalFileHandle(pluginId, id, access) {
        assert.equal(pluginId, OWNER); assert.equal(id, 'selected'); assert.equal(access, 'write')
        return target
      }
    },
    '@main/plugin/pluginInteractionPolicy': {
      assertInteractive(owner) { if (!owner.isCurrent() || owner.isClosing) throw new Error('owner is closing') }
    }
  })
  const directory = join(data, 'plugin-files', createHash('sha256').update(OWNER).digest('hex'))
  t.after(async () => {
    await scopes.getRuntimeScope(OWNER)?.dispose()
    await api.disposeFileStreams()
    await fs.rm(data, { recursive: true, force: true })
  })
  async function save(value = 'first-second') {
    const { streamId } = await api.openFileStream(OWNER, { extension: 'webm' })
    await api.writeFileStream(OWNER, streamId, 0, bytes(value))
    return api.finishFileStream(OWNER, streamId)
  }
  return { api, data, directory, scope, scopes, target, save }
}

test('finished and legacy outputs share paged metadata, bounded reads and real removal', async t => {
  const f = await fixture(t), saved = await f.save()
  const legacyId = randomUUID()
  await fs.writeFile(join(f.directory, `${legacyId}.webm`), 'legacy')
  await fs.writeFile(join(f.directory, `${randomUUID()}.part`), 'incomplete')
  const first = await f.api.listPluginStoredFiles(OWNER, { limit: 1 })
  const second = await f.api.listPluginStoredFiles(OWNER, { limit: 1, cursor: first.nextCursor })
  assert.deepEqual([...first.items, ...second.items].map(item => item.id), [saved.id, legacyId].sort())
  assert.equal(second.nextCursor, null)
  assert.ok(first.items.every(item => !('path' in item)))
  const chunk = await f.api.getPluginStoredFile(OWNER, saved.id, { offset: 6, length: 3 })
  assert.equal(Buffer.from(chunk.bytes).toString(), 'sec')
  assert.equal(chunk.nextOffset, 9)
  const end = await f.api.getPluginStoredFile(OWNER, saved.id, { offset: saved.size })
  assert.equal(end.bytes.byteLength, 0); assert.equal(end.nextOffset, null)
  assert.equal(Buffer.from((await f.api.getPluginStoredFile(OWNER, legacyId)).bytes).toString(), 'legacy')
  assert.equal(await f.api.removePluginStoredFile(OWNER, saved.id), true)
  assert.equal(await f.api.getPluginStoredFile(OWNER, saved.id), null)
  assert.equal(await f.api.removePluginStoredFile(OWNER, saved.id), false)
})

test('IDs, ranges and active streams never grant arbitrary paths or cross-owner access', async t => {
  const f = await fixture(t), saved = await f.save()
  assert.throws(() => f.api.getPluginStoredFile(OWNER, saved.path), /ID/)
  assert.throws(() => f.api.getPluginStoredFile(OWNER, saved.id, { offset: -1 }), /offset/)
  assert.throws(() => f.api.getPluginStoredFile(OWNER, saved.id, { offset: Number.MAX_SAFE_INTEGER + 1 }), /offset/)
  assert.throws(() => f.api.getPluginStoredFile(OWNER, saved.id, { length: 0 }), /length/)
  assert.throws(() => f.api.getPluginStoredFile(OWNER, saved.id, { length: 524289 }), /length/)
  assert.throws(() => f.api.getPluginStoredFile(OWNER, saved.id, null), /options/)
  assert.throws(() => f.api.getPluginStoredFile(OWNER, saved.id, { offset: null }), /offset/)
  assert.throws(() => f.api.listPluginStoredFiles(OWNER, { limit: null }), /limit/)
  assert.throws(() => f.api.exportPluginStoredFile(OWNER, saved.id, { defaultName: null }), /name/)
  assert.throws(() => f.api.listPluginStoredFiles(OWNER, { limit: 201 }), /limit/)
  await assert.rejects(f.api.openFileStream(OWNER, { extension: 'part' }), /extension/)
  const foreign = f.scopes.createRuntimeScope({ pluginId: 'com.foreign', generation: 1, wcId: 2 })
  assert.equal(await f.api.getPluginStoredFile('com.foreign', saved.id), null)
  assert.equal(await f.api.removePluginStoredFile('com.foreign', saved.id), false)
  await foreign.dispose()
  const active = await f.api.openFileStream(OWNER, { extension: 'webm' })
  await assert.rejects(f.api.getPluginStoredFile(OWNER, active.streamId), /not finished/)
  assert.equal((await f.api.listPluginStoredFiles(OWNER)).items.length, 1)
  await f.api.abortFileStream(OWNER, active.streamId)
})

test('removing an old completed file releases the next stream reservation', async t => {
  const f = await fixture(t)
  await fs.mkdir(f.directory, { recursive: true })
  const id = randomUUID(), handle = await fs.open(join(f.directory, `${id}.webm`), 'w')
  await handle.truncate(3 * 1024 ** 3 + 1); await handle.close()
  await assert.rejects(f.api.openFileStream(OWNER, { extension: 'webm' }), /storage limit/)
  await assert.rejects(f.api.getPluginStoredFile(OWNER, id), /1 GiB/)
  assert.equal(await f.api.removePluginStoredFile(OWNER, id), true)
  const opened = await f.api.openFileStream(OWNER, { extension: 'webm' })
  await f.api.abortFileStream(OWNER, opened.streamId)
})

test('beforeClose drains an existing stream while completed-output calls reject the retired owner', async t => {
  const f = await fixture(t), { streamId } = await f.api.openFileStream(OWNER, { extension: 'webm' })
  await f.api.writeFileStream(OWNER, streamId, 0, bytes('before-close'))
  f.scope.markClosing()
  assert.throws(() => f.api.listPluginStoredFiles(OWNER), /closing/)
  const saved = await f.api.finishFileStream(OWNER, streamId)
  await f.scope.dispose()
  f.scopes.createRuntimeScope({ pluginId: OWNER, generation: 2, wcId: 3 })
  assert.equal(Buffer.from((await f.api.getPluginStoredFile(OWNER, saved.id)).bytes).toString(), 'before-close')
})

test('completed-output requests are bounded and old queued reads cannot cross a runtime replacement', async t => {
  const entered = deferred(), release = deferred()
  let hold = true
  const f = await fixture(t, { io: { async open(path, ...options) {
    const file = await fs.open(path, ...options)
    if (hold && String(path).endsWith('.webm')) { hold = false; entered.resolve(); await release.promise }
    return file
  } } })
  const saved = await f.save()
  const pending = Array.from({ length: 16 }, () => f.api.getPluginStoredFile(OWNER, saved.id))
  const observed = Promise.allSettled(pending)
  assert.throws(() => f.api.getPluginStoredFile(OWNER, saved.id), /queue is full/)
  await entered.promise
  await f.scope.dispose()
  f.scopes.createRuntimeScope({ pluginId: OWNER, generation: 2, wcId: 3 })
  release.resolve()
  assert.ok((await observed).every(result => result.status === 'rejected'))
  assert.ok(await f.api.getPluginStoredFile(OWNER, saved.id))
})

test('export holds its source until native confirmation and queued deletion finish', async t => {
  const entered = deferred(), release = deferred()
  const f = await fixture(t, { async pick() { entered.resolve(); await release.promise; return { id: 'selected' } } })
  const saved = await f.save('export-content')
  await fs.writeFile(f.target, 'previous-user-file')
  const exporting = f.api.exportPluginStoredFile(OWNER, saved.id)
  await entered.promise
  let removed = false
  const removing = f.api.removePluginStoredFile(OWNER, saved.id).then(value => { removed = true; return value })
  assert.equal(removed, false)
  release.resolve()
  assert.deepEqual(await exporting, { ok: true, path: f.target, size: 14 })
  assert.equal(await removing, true)
  assert.equal(await fs.readFile(f.target, 'utf8'), 'export-content')
  assert.equal((await fs.readdir(f.data)).some(name => name.startsWith('.enest-export-')), false)
})

test('native save cancellation preserves both the original target and private output', async t => {
  const f = await fixture(t, { pick: async () => null }), saved = await f.save()
  await fs.writeFile(f.target, 'original')
  assert.equal(await f.api.exportPluginStoredFile(OWNER, saved.id), null)
  assert.equal(await fs.readFile(f.target, 'utf8'), 'original')
  assert.ok(await f.api.getPluginStoredFile(OWNER, saved.id))
})

test('failed copying cleans the temporary destination without truncating the selected file', async t => {
  const f = await fixture(t, { io: { async open(path, ...options) {
    const file = await fs.open(path, ...options)
    if (!String(path).includes('.enest-export-')) return file
    return new Proxy(file, { get(target, key) {
      if (key === 'write') return async () => { throw new Error('fixture disk failure') }
      const value = target[key]
      return typeof value === 'function' ? value.bind(target) : value
    } })
  } } })
  const saved = await f.save('new-content')
  await fs.writeFile(f.target, 'original')
  await assert.rejects(f.api.exportPluginStoredFile(OWNER, saved.id), /disk failure/)
  assert.equal(await fs.readFile(f.target, 'utf8'), 'original')
  assert.equal((await fs.readdir(f.data)).some(name => name.startsWith('.enest-export-')), false)
})

test('late native response cannot export after the requesting runtime closes', async t => {
  const entered = deferred(), release = deferred()
  const f = await fixture(t, { async pick() { entered.resolve(); await release.promise; return { id: 'selected' } } })
  const saved = await f.save()
  await fs.writeFile(f.target, 'original')
  const exporting = f.api.exportPluginStoredFile(OWNER, saved.id), rejected = assert.rejects(exporting, /closing/)
  await entered.promise
  f.scope.markClosing(); release.resolve()
  await rejected
  assert.equal(await fs.readFile(f.target, 'utf8'), 'original')
  await f.scope.dispose()
  await f.api.clearPluginFileStreams(OWNER)
  await assert.rejects(fs.stat(f.directory), { code: 'ENOENT' })
})

test('a symlinked owner directory is never read as private output', async t => {
  const f = await fixture(t)
  const outside = join(f.data, 'outside'), id = randomUUID()
  await fs.mkdir(outside)
  await fs.writeFile(join(outside, `${id}.webm`), 'unrelated-file')
  await fs.mkdir(join(f.directory, '..'), { recursive: true })
  await fs.symlink(outside, f.directory, 'dir')
  await assert.rejects(f.api.getPluginStoredFile(OWNER, id), /canonical/)
  await assert.rejects(f.api.removePluginStoredFile(OWNER, id), /canonical/)
  assert.equal(await fs.readFile(join(outside, `${id}.webm`), 'utf8'), 'unrelated-file')
})

test('removing a corrupt output symlink never follows its unrelated target', async t => {
  const f = await fixture(t), id = randomUUID(), outside = join(f.data, 'unrelated.webm')
  await fs.mkdir(f.directory, { recursive: true })
  await fs.writeFile(outside, 'unrelated-file')
  await fs.symlink(outside, join(f.directory, `${id}.webm`))
  await assert.rejects(f.api.getPluginStoredFile(OWNER, id), /regular file/)
  assert.equal(await f.api.removePluginStoredFile(OWNER, id), true)
  assert.equal(await fs.readFile(outside, 'utf8'), 'unrelated-file')
})

test('a completed rename survives disposal and is recoverable by the next runtime', async t => {
  let f, disposal
  f = await fixture(t, { io: { async rename(from, to) {
    await fs.rename(from, to)
    if (String(from).endsWith('.part')) disposal = f.scope.dispose()
  } } })
  const { streamId } = await f.api.openFileStream(OWNER, { extension: 'webm' })
  await f.api.writeFileStream(OWNER, streamId, 0, bytes('committed'))
  await assert.rejects(f.api.finishFileStream(OWNER, streamId), /was committed but its owner is closing/)
  await disposal
  f.scopes.createRuntimeScope({ pluginId: OWNER, generation: 2, wcId: 3 })
  assert.equal(Buffer.from((await f.api.getPluginStoredFile(OWNER, streamId)).bytes).toString(), 'committed')
  assert.equal(await f.api.abortFileStream(OWNER, streamId), false)
  assert.equal(f.api.getFileStreamDiagnostics().streams, 0)
})

test('directory sync failure reports a committed output instead of deleting it', { skip: process.platform === 'win32' }, async t => {
  let f
  f = await fixture(t, { io: { async open(path, ...options) {
    const file = await fs.open(path, ...options)
    if (String(path) !== f.directory) return file
    return new Proxy(file, { get(target, key) {
      if (key === 'sync') return async () => { throw new Error('fixture directory sync failure') }
      const value = target[key]
      return typeof value === 'function' ? value.bind(target) : value
    } })
  } } })
  const { streamId } = await f.api.openFileStream(OWNER, { extension: 'webm' })
  await f.api.writeFileStream(OWNER, streamId, 0, bytes('committed'))
  await assert.rejects(f.api.finishFileStream(OWNER, streamId), /was committed but its durability is uncertain/)
  assert.equal(Buffer.from((await f.api.getPluginStoredFile(OWNER, streamId)).bytes).toString(), 'committed')
  assert.equal(await f.api.abortFileStream(OWNER, streamId), false)
  assert.equal(f.scope.activityCount, 0)
})

test('export reports an already committed target if its owner closes after rename', async t => {
  let f
  f = await fixture(t, { io: { async rename(from, to) {
    await fs.rename(from, to)
    if (to === f.target) f.scope.markClosing()
  } } })
  const saved = await f.save('committed-export')
  await fs.writeFile(f.target, 'original')
  await assert.rejects(f.api.exportPluginStoredFile(OWNER, saved.id), /Export was committed but its owner is closing/)
  assert.equal(await fs.readFile(f.target, 'utf8'), 'committed-export')
  assert.equal((await fs.readdir(f.data)).some(name => name.startsWith('.enest-export-')), false)
})

test('known IDs remain readable and removable above the listing entry limit', async t => {
  const f = await fixture(t, { io: { async opendir(path) {
    return { async *[Symbol.asyncIterator]() {
      for (let index = 0; index < 8193; index++) yield { name: `untracked-${index}` }
      for await (const entry of await fs.opendir(path)) yield entry
    } }
  } } })
  const id = randomUUID()
  await fs.mkdir(f.directory, { recursive: true })
  await fs.writeFile(join(f.directory, `${id}.webm`), 'legacy-over-limit')
  await assert.rejects(f.api.listPluginStoredFiles(OWNER), /directory entry limit/)
  await assert.rejects(f.api.openFileStream(OWNER, { extension: 'webm' }), /directory entry limit/)
  assert.equal(Buffer.from((await f.api.getPluginStoredFile(OWNER, id)).bytes).toString(), 'legacy-over-limit')
  assert.equal(await f.api.removePluginStoredFile(OWNER, id), true)
  assert.equal(await f.api.getPluginStoredFile(OWNER, id), null)
})

test('known-ID scanning is bounded and refuses ambiguous IDs without deleting either file', async t => {
  let oversized = false
  const f = await fixture(t, { io: { async opendir(path) {
    if (!oversized) return fs.opendir(path)
    return { async *[Symbol.asyncIterator]() {
      for (let index = 0; index <= 262144; index++) yield { name: `untracked-${index}` }
    } }
  } } })
  const saved = await f.save('original')
  const duplicate = join(f.directory, `${saved.id}.mp4`)
  await fs.writeFile(duplicate, 'duplicate')
  await assert.rejects(f.api.removePluginStoredFile(OWNER, saved.id), /ambiguous/)
  assert.equal(await fs.readFile(saved.path, 'utf8'), 'original')
  assert.equal(await fs.readFile(duplicate, 'utf8'), 'duplicate')
  oversized = true
  await assert.rejects(f.api.getPluginStoredFile(OWNER, saved.id), /lookup scan limit/)
  await assert.rejects(f.api.removePluginStoredFile(OWNER, saved.id), /lookup scan limit/)
})
