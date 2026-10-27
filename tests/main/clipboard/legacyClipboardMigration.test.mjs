import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'
import { mkdtemp, writeFile, readFile, mkdir, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const OWNER = 'com.github.eNest.clipboard', SOURCE = 'clipboard-history-v1'
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0i8AAAAASUVORK5CYII=', 'base64')

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'enest-clipboard-migration-fixture-'))
  const result = await build({
    entryPoints: ['src/main/clipboard/legacyClipboardMigration.ts'], bundle: true, write: false, format: 'esm', platform: 'node',
    plugins: [{ name: 'fixture-path', setup(api) {
      api.onResolve({ filter: /^@main\/paths\/pathsService$/ }, ({ path }) => ({ path, namespace: 'fixture' }))
      api.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: `export const getAppPaths=()=>({data:${JSON.stringify(directory)}});`, loader: 'js' }))
    } }]
  })
  const api = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`)
  return { ...api, directory, cleanup: () => rm(directory, { recursive: true, force: true }) }
}

test('migration source is opaque, fixed-owner, and original files survive the durable marker', async () => {
  const f = await fixture()
  try {
    const document = '[{"synthetic":"opaque payload, parsed only by plugin"}]'
    await writeFile(join(f.directory, 'clipboard-history.json'), document)
    await mkdir(join(f.directory, 'clipboard-blobs'))
    await writeFile(join(f.directory, 'clipboard-blobs', 'old.png'), PNG)
    const value = await f.readLegacyClipboardDocument(OWNER, SOURCE)
    assert.equal(value.document, document)
    const budget = await f.getLegacyClipboardImportBudget(OWNER, SOURCE, value.token)
    assert.deepEqual(budget, { bytes: PNG.length, files: 1 })
    const blob = await f.getLegacyClipboardBlob(OWNER, SOURCE, value.token, 'old.png')
    assert.equal(blob.bytes, PNG.length)
    await assert.rejects(f.readLegacyClipboardDocument('different.plugin', SOURCE), /owned/)
    await f.commitLegacyClipboardMigration(OWNER, SOURCE, value.token)
    assert.equal(await f.readLegacyClipboardDocument(OWNER, SOURCE), null)
    assert.equal(await readFile(join(f.directory, 'clipboard-history.json'), 'utf8'), document)
    assert.deepEqual(await readFile(join(f.directory, 'clipboard-blobs', 'old.png')), PNG)
    await f.commitLegacyClipboardMigration(OWNER, SOURCE, value.token)
  } finally { await f.cleanup() }
})

test('source mutation cannot commit a stale snapshot', async () => {
  const f = await fixture()
  try {
    await writeFile(join(f.directory, 'clipboard-history.json'), '[]')
    const value = await f.readLegacyClipboardDocument(OWNER, SOURCE)
    await writeFile(join(f.directory, 'clipboard-history.json'), '["changed"]')
    await assert.rejects(f.commitLegacyClipboardMigration(OWNER, SOURCE, value.token), /changed/)
    assert.notEqual(await f.readLegacyClipboardDocument(OWNER, SOURCE), null)
  } finally { await f.cleanup() }
})

test('traversal and blob symlinks are rejected without reading their targets', async () => {
  const f = await fixture()
  try {
    await writeFile(join(f.directory, 'clipboard-history.json'), '[]')
    await mkdir(join(f.directory, 'clipboard-blobs'))
    await writeFile(join(f.directory, 'outside.png'), PNG)
    await symlink('../outside.png', join(f.directory, 'clipboard-blobs', 'link.png'))
    const value = await f.readLegacyClipboardDocument(OWNER, SOURCE)
    await assert.rejects(f.getLegacyClipboardBlob(OWNER, SOURCE, value.token, '../outside.png'), /attachment name/)
    await assert.rejects(f.getLegacyClipboardBlob(OWNER, SOURCE, value.token, 'link.png'), /regular file/)
    await assert.rejects(f.getLegacyClipboardImportBudget(OWNER, SOURCE, value.token), /inventory/)
  } finally { await f.cleanup() }
})

test('legacy JSON symlink is rejected and a missing source is not an empty committed migration', async () => {
  const f = await fixture()
  try {
    assert.equal(await f.readLegacyClipboardDocument(OWNER, SOURCE), null)
    await writeFile(join(f.directory, 'outside.json'), '[]')
    await symlink('outside.json', join(f.directory, 'clipboard-history.json'))
    await assert.rejects(f.readLegacyClipboardDocument(OWNER, SOURCE), /regular file/)
  } finally { await f.cleanup() }
})
