import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import * as fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import vm from 'node:vm'
import ts from 'typescript'

const require = createRequire(import.meta.url)
function load(file, imports = {}) {
  const source = ts.transpileModule(readFileSync(new URL(`../../src/main/plugin/${file}.ts`, new URL("../../tools/packaging/", import.meta.url)), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  }).outputText
  const module = { exports: {} }
  vm.runInNewContext(source, { module, exports: module.exports, Buffer, Uint8Array, AbortController,
    setTimeout, clearTimeout, console, require(name) {
      if (Object.hasOwn(imports, name)) return imports[name]
      if (name.startsWith('node:')) return require(name)
      throw new Error(`Unexpected dependency ${name}`)
    } })
  return module.exports
}
const { PluginBackendFiles } = load('pluginBackendFiles')
async function fixture(t) {
  const root = await fs.mkdtemp(join(tmpdir(), 'enest-backend-files-test-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  let current = true
  const check = () => { if (!current) throw new Error('stale owner') }
  const handles = new Map()
  const streams = new PluginBackendFiles(async id => { if (!handles.has(id)) throw new Error('foreign handle'); return handles.get(id) }, check)
  t.after(() => streams.dispose())
  return { root, streams, handles, check, expire() { current = false } }
}

test('stream handles are opaque, owner scoped, bounded and revalidate selected file identity', async t => {
  const f = await fixture(t), path = join(f.root, 'a.bin')
  await fs.writeFile(path, Buffer.from('abcdef')); f.handles.set('chosen', path)
  await assert.rejects(f.streams.open('foreign'), /foreign/)
  const opened = await f.streams.open('chosen')
  assert.deepEqual(Object.keys(opened).sort(), ['name', 'size', 'token'])
  assert.equal(opened.size, 6)
  const result = await f.streams.read({ token: opened.token, offset: 1, length: 3 })
  assert.equal(Buffer.from(result.bytes).toString(), 'bcd')
  assert.equal(result.bytesRead, 3)
  for (const args of [{ offset: -1, length: 1 }, { offset: 0, length: 262145 }, { offset: 0.1, length: 1 }, { offset: Number.MAX_SAFE_INTEGER, length: 2 }]) {
    await assert.rejects(f.streams.read({ token: opened.token, ...args }), /bounded/)
  }
  await fs.appendFile(path, 'changed')
  await assert.rejects(f.streams.read({ token: opened.token, offset: 0, length: 1 }), /changed/)
  await f.streams.close(opened.token)
  await f.streams.close(opened.token)
  await assert.rejects(f.streams.read({ token: opened.token, offset: 0, length: 1 }), /closed/)
})

test('large sparse and empty files stream without whole-file buffering; symlink and directory rejected', async t => {
  const f = await fixture(t), path = join(f.root, 'large.bin')
  const fd = await fs.open(path, 'w'); await fd.truncate(3 * 1024 ** 3); await fd.close()
  f.handles.set('large', path); f.handles.set('dir', f.root)
  const large = await f.streams.open('large')
  assert.equal(large.size, 3 * 1024 ** 3)
  assert.equal((await f.streams.read({ token: large.token, offset: large.size - 16, length: 16 })).bytesRead, 16)
  const empty = join(f.root, 'empty'); await fs.writeFile(empty, ''); f.handles.set('empty', empty)
  assert.equal((await f.streams.read({ token: (await f.streams.open('empty')).token, offset: 0, length: 1 })).bytesRead, 0)
  await assert.rejects(f.streams.open('dir'), /regular/)
  if (process.platform !== 'win32') {
    const link = join(f.root, 'symlink'); await fs.symlink(path, link); f.handles.set('symlink', link)
    await assert.rejects(f.streams.open('symlink'))
  }
})

test('64 open and 8 active read quotas cover concurrent reservations; close/read and stale owner do not leak', async t => {
  const f = await fixture(t), path = join(f.root, 'source')
  await fs.writeFile(path, Buffer.alloc(512 * 1024)); f.handles.set('ok', path)
  const pending = Array.from({ length: 64 }, () => f.streams.open('ok'))
  await assert.rejects(f.streams.open('ok'), /limit/)
  const files = await Promise.all(pending)
  const reads = Array.from({ length: 8 }, () => f.streams.read({ token: files[0].token, offset: 0, length: 256 * 1024 }))
  const settled = Promise.allSettled(reads)
  await assert.rejects(f.streams.read({ token: files[0].token, offset: 0, length: 1 }), /limit/)
  await f.streams.close(files[0].token)
  assert.ok((await settled).every(row => row.status === 'rejected'))
  f.expire()
  await assert.rejects(f.streams.read({ token: files[1].token, offset: 0, length: 1 }), /stale/)
  await f.streams.dispose()
  await f.streams.close(files[1].token)
})

function capabilitiesFixture() {
  let current = true, confirmed = false, confirmError, resolveSecret
  const requests = [], storage = new Map()
  const { PluginBackendCapabilities } = load('pluginBackendCapabilities', {
    './pluginBackendFiles': { PluginBackendFiles },
    '@shared/types/plugin': { PLUGIN_PERMISSIONS: ['backend.node', 'ssh.agent'] },
    './PluginPermissions': {
      authorizePluginPermission: async (...args) => { requests.push(['authorize', ...args]); if (args[1] !== 'ssh.agent') throw new Error('denied') },
      confirmPluginOperation: async (...args) => { requests.push(['confirm', ...args]); if (confirmError) throw confirmError; if (!confirmed) throw new Error('operation cancelled') }
    },
    '@main/vault/secretVault': { resolveSecret: (...args) => { requests.push(['secret', ...args]); return resolveSecret ? resolveSecret() : 'fixture-only-secret' } },
    '@main/db/pluginStorage': {
      getPluginStorageValue: (owner, key) => storage.get(`${owner}/${key}`),
      setPluginStorageValue: (owner, key, value) => storage.set(`${owner}/${key}`, value)
    },
    './localFiles': { createLocalExport: async (id, paths) => { requests.push(['export', id, paths]); return { exportId: 'fixture-export' } } }
  })
  const scope = { owner: { pluginId: 'fixture.plugin', generation: 1, wcId: 1 } }
  const capabilities = new PluginBackendCapabilities(scope, () => { if (!current) throw new Error('stale') })
  return { capabilities, requests, expire() { current = false; capabilities.beginClose() }, confirm(value, error) { confirmed = value; confirmError = error }, secret(fn) { resolveSecret = fn } }
}

test('generic secret/storage/authorization derive ownership; unknown permissions and stale replies fail', async () => {
  const f = capabilitiesFixture(), api = f.capabilities
  assert.equal(await api.request('secret.resolve', { ref: 'ref', pluginId: 'other' }), 'fixture-only-secret')
  assert.deepEqual(f.requests[0], ['secret', 'fixture.plugin', 'ref'])
  await api.request('storage.set', { key: 'own', value: 4, pluginId: 'other' })
  assert.equal(await api.request('storage.get', { key: 'own' }), 4)
  assert.equal(await api.request('permission.authorize', { permission: 'ssh.agent', summary: 'Fixture' }), true)
  await assert.rejects(api.request('permission.authorize', { permission: 'unknown', summary: 'Fixture' }), /Unknown/)
  await assert.rejects(api.request('permission.authorize', { permission: 'backend.node', summary: 'Fixture' }), /denied/)
  f.secret(() => { f.expire(); return 'must-not-return' })
  await assert.rejects(api.request('secret.resolve', { ref: 'ref' }), /stale/)
  await api.dispose()
})

test('native confirmation ignores forged confirmed flag and requests visible source-labelled modal', async () => {
  const f = capabilitiesFixture(), params = { title: 'Fixture', message: 'Apply?', detail: 'No user data', confirmed: true }
  assert.equal(await f.capabilities.request('dialog.confirm', params), false)
  f.confirm(true)
  assert.equal(await f.capabilities.request('dialog.confirm', params), true)
  const [, owner, message, detail, options] = f.requests.at(-1)
  assert.equal(owner, 'fixture.plugin'); assert.equal(message, 'Apply?'); assert.equal(detail, 'No user data')
  assert.equal(options.title, 'Fixture'); assert.equal(options.requireVisible, true)
  f.confirm(false, new Error('runtime unavailable'))
  await assert.rejects(f.capabilities.request('dialog.confirm', params), /unavailable/)
  await assert.rejects(f.capabilities.request('dialog.confirm', { ...params, title: 'x'.repeat(161) }), /argument/)
  f.expire(); assert.equal(options.signal.aborted, true)
  await f.capabilities.dispose()
})

test('temporary exports are private, cannot escape through symlinks, and are removed on disposal', async () => {
  const a = capabilitiesFixture(), b = capabilitiesFixture()
  const directory = await a.capabilities.request('files.exportDirectory', {})
  try {
    const file = join(directory, 'fixture.txt'); await fs.writeFile(file, 'fixture')
    await a.capabilities.request('files.export', { paths: [file] })
    await assert.rejects(b.capabilities.request('files.export', { paths: [file] }), /outside/)
    if (process.platform !== 'win32') {
      const link = join(directory, 'escape'); await fs.symlink(import.meta.filename, link)
      await assert.rejects(a.capabilities.request('files.export', { paths: [link] }), /outside/)
    }
  } finally { a.expire(); b.expire(); await a.capabilities.dispose(); await b.capabilities.dispose() }
  await assert.rejects(fs.stat(directory), { code: 'ENOENT' })
})

test('preload and dispatcher expose generic capabilities, not business transports', () => {
  const preload = readFileSync(new URL('../../src/preload/pluginPreload.ts', import.meta.url), 'utf8')
  const dispatcher = readFileSync(new URL('../../src/main/ipc/pluginHandlers.ts', import.meta.url), 'utf8')
  const ipc = readFileSync(new URL('../../src/shared/types/ipc.ts', import.meta.url), 'utf8')
  for (const source of [preload, dispatcher]) {
    assert.doesNotMatch(source, /case '(?:ssh|db|mw|agent|lan)\./)
    assert.doesNotMatch(source, /@main\/(?:ssh|database|middleware)\//)
  }
  assert.doesNotMatch(ipc, /type: '(?:ssh|mw|lan)\./)
  assert.match(preload, /deadlineTasks:/)
  assert.match(preload, /stop: \(\) => call\('backend.stop'\)/)
  assert.match(dispatcher, /callPluginBackend\(pluginId, args\[0\], args\[1\], args\[2\]\)/)
})
