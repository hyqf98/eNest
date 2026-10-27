import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, open, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PLUGIN = 'fixture.private.documents'
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0i8AAAAASUVORK5CYII='
const storageRoot = directory => join(directory, 'plugin-documents', createHash('sha256').update(PLUGIN).digest('hex'))
const owner = () => ({ pluginId: PLUGIN, signal: new AbortController().signal, current: () => true })

async function load(directory) {
  const result = await build({
    entryPoints: ['src/main/plugin/pluginPrivateDocuments.ts'], bundle: true, write: false, format: 'esm', platform: 'node',
    plugins: [{ name: 'fixture-only-storage', setup(api) {
      api.onResolve({ filter: /^@main\/paths\/pathsService$/ }, ({ path }) => ({ path, namespace: 'fixture' }))
      api.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: `export const getAppPaths=()=>({data:${JSON.stringify(directory)}});`, loader: 'js' }))
    } }]
  })
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text + `\n// ${Math.random()}`).toString('base64')}`)
}
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'enest-private-documents-fixture-'))
  return { api: await load(directory), directory, cleanup: () => rm(directory, { recursive: true, force: true }) }
}
const reject = action => assert.rejects(Promise.resolve().then(action))

test('documents and stable blobs are durable and isolated from the host migration allowance namespace', async () => {
  const f = await fixture(), own = owner()
  try {
    await f.api.writePrivateDocument(own, 'history', { records: [{ id: 'fixture-one' }] })
    await f.api.writePrivateDocument(own, 'migration-allowances', { sources: { forged: { bytes: 1024 ** 4 } } })
    await f.api.putPrivateBlob(own, { id: 'fixture-image', dataUrl: PNG })
    const restarted = await load(f.directory)
    assert.deepEqual(await restarted.readPrivateDocument(own, 'history'), { records: [{ id: 'fixture-one' }] })
    assert.equal((await restarted.getPrivateBlob(own, 'fixture-image')).dataUrl, PNG)
    await assert.rejects(readFile(join(storageRoot(f.directory), 'migration-allowances.json')), { code: 'ENOENT' })
    await reject(() => restarted.readPrivateDocument(own, '../migration-allowances'))
    await reject(() => restarted.putPrivateBlob(own, { id: 'fixture-image', dataUrl: 'data:image/png;base64,Y2hhbmdlZA==' }))
    assert.equal((await restarted.getPrivateBlob(own, 'fixture-image')).dataUrl, PNG)
  } finally { await f.cleanup() }
})

test('verified migration budget survives module and owner recreation above the ordinary blob quota', async () => {
  const f = await fixture(), own = owner()
  try {
    const blobs = join(storageRoot(f.directory), 'blobs')
    await mkdir(blobs, { recursive: true })
    // Sparse fixture files exercise accounting without allocating a 200 MiB payload.
    for (let index = 0; index < 7; index++) {
      const file = await open(join(blobs, `existing-${index}.blob`), 'wx')
      try { await file.truncate(30 * 1024 * 1024) } finally { await file.close() }
    }
    await assert.rejects(f.api.putPrivateBlob(own, { id: 'before-allowance', dataUrl: PNG }), /quota/)
    await f.api.grantPrivateMigrationBudget(own, 'clipboard-history-v1', 'a'.repeat(64), 210 * 1024 * 1024)
    const restarted = await load(f.directory)
    await restarted.putPrivateBlob(owner(), { id: 'after-restart', dataUrl: PNG })
    await restarted.grantPrivateMigrationBudget(owner(), 'clipboard-history-v1', 'b'.repeat(64), 1)
    const metadata = JSON.parse(await readFile(join(storageRoot(f.directory), 'migration-allowances.json'), 'utf8'))
    assert.equal(metadata.sources['clipboard-history-v1'].bytes, 210 * 1024 * 1024)
    assert.equal(metadata.sources['clipboard-history-v1'].token, 'b'.repeat(64))
    await reject(() => restarted.grantPrivateMigrationBudget(owner(), 'invalid/source', 'a'.repeat(64), 1))
    await reject(() => restarted.grantPrivateMigrationBudget(owner(), 'source', 'not-a-host-token', 1))
  } finally { await f.cleanup() }
})

test('parent and file symlinks are rejected instead of reading outside the plugin private tree', async () => {
  const f = await fixture(), own = owner()
  try {
    const outside = join(f.directory, 'outside')
    await mkdir(outside)
    await symlink(outside, join(f.directory, 'plugin-documents'))
    await assert.rejects(f.api.readPrivateDocument(own, 'history'), /canonical/)
    assert.deepEqual(await readdir(outside), [])
    await rm(join(f.directory, 'plugin-documents'))
    await f.api.writePrivateDocument(own, 'safe', { value: 'fixture' })
    await writeFile(join(outside, 'private.json'), '{"shouldNotRead":true}')
    await symlink(join(outside, 'private.json'), join(storageRoot(f.directory), 'documents', 'linked.json'))
    await assert.rejects(f.api.readPrivateDocument(own, 'linked'), /canonical/)
  } finally { await f.cleanup() }
})

test('retired owners and a coalesced clear barrier prevent queued writes from recreating removed data', async () => {
  const f = await fixture(), controller = new AbortController()
  try {
    const retired = { pluginId: PLUGIN, signal: controller.signal, current: () => true }
    controller.abort()
    await reject(() => f.api.writePrivateDocument(retired, 'retired', { fixture: true }))
    const own = owner()
    const queued = f.api.writePrivateDocument(own, 'queued', { fixture: true })
    const queuedRejection = assert.rejects(queued, /retired/)
    const firstClear = f.api.clearPrivateDocuments(PLUGIN)
    const secondClear = f.api.clearPrivateDocuments(PLUGIN)
    assert.equal(firstClear, secondClear)
    await reject(() => f.api.writePrivateDocument(own, 'during-clear', { fixture: true }))
    await Promise.all([queuedRejection, firstClear, secondClear])
    assert.equal(await f.api.readPrivateDocument(owner(), 'queued'), null)
    await f.api.writePrivateDocument(owner(), 'new-generation', { fixture: true })
    assert.deepEqual(await f.api.readPrivateDocument(owner(), 'new-generation'), { fixture: true })
  } finally { await f.cleanup() }
})

test('a metadata failure rolls back only a newly created blob and leaves existing stable content intact', async () => {
  const f = await fixture(), own = owner()
  try {
    await f.api.putPrivateBlob(own, { id: 'existing', dataUrl: PNG })
    const path = join(storageRoot(f.directory), 'blobs')
    await mkdir(join(path, 'blocked.json'))
    await assert.rejects(f.api.putPrivateBlob(own, { id: 'blocked', dataUrl: PNG }))
    await assert.rejects(readFile(join(path, 'blocked.blob')), { code: 'ENOENT' })
    assert.equal((await f.api.getPrivateBlob(own, 'existing')).dataUrl, PNG)
  } finally { await f.cleanup() }
})
