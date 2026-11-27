import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0i8AAAAASUVORK5CYII=', 'base64')
const output = '12345678-1234-4123-8123-123456789abc.txt'
const generation = '.asset-12345678-1234-4123-8123-123456789abd.blob'
const attachment = '12345678-1234-4123-8123-123456789abe'
const hash = id => createHash('sha256').update(id).digest('hex')
const version = revision => ({ fixture: 'synthetic data only', revision })
const encoded = text => Buffer.from(text)

export async function initializeDevice(host, root) {
  host.paths.setAppPathsRoot(root)
  host.paths.ensureAppDirs()
  assert.equal(host.paths.getAppPaths().root, root)
  assert.equal(await host.kvStore.initDatabase(), 'sqlite')
  host.storage.initPluginStorage()
  await host.files.recoverPluginSync()
}
async function seed(host) {
  const [alpha, beta, excluded] = host.ids, root = host.paths.getAppPaths().data, owner = hash(alpha)
  for (const id of host.ids) host.storage.setPluginStorageValue(id, 'document', version(id === excluded ? 'local-only' : 1))
  const samples = [
    ['plugin-documents', owner, 'documents', 'note.json', encoded(JSON.stringify({ text: '跨设备示例' }))],
    ['plugin-documents', owner, 'blobs', 'picture.json', encoded(JSON.stringify({ mime: 'image/png', bytes: png.length }))],
    ['plugin-documents', owner, 'blobs', 'picture.blob', png],
    ['plugin-assets', owner, 'files', generation, png],
    ['plugin-assets', owner, 'files', 'swatch.png.meta.json', encoded(JSON.stringify({ assetId: 'swatch.png', name: 'swatch', mime: 'image/png', bytes: png.length, createdAt: 1, file: generation }))],
    ['plugin-attachments', owner, `${attachment}.blob`, png],
    ['plugin-attachments', owner, `${attachment}.json`, encoded(JSON.stringify({ mime: 'image/png' }))],
    ['plugin-files', owner, output, encoded('completed file / 仅供测试')],
    ['secrets', alpha, 'excluded.fixture', encoded('SYNTHETIC-VAULT-SENTINEL')],
  ]
  for (const sample of samples) {
    const bytes = sample.pop(), name = sample.pop(), directory = join(root, ...sample)
    await mkdir(directory, { recursive: true }); await writeFile(join(directory, name), bytes)
  }
  assert.ok((await host.collectPluginDataUsage()).plugins.find(item => item.pluginId === alpha).data.bytes > 0)
  assert.deepEqual(host.storage.getPluginStorageValue(beta, 'document'), version(1))
}
export async function publishFixture(host, accountId, repo) {
  const [alpha, beta] = host.ids
  const state = await host.sync.githubSyncState(accountId)
  assert.equal(state.repository.id, repo.id)
  assert.equal(state.cloud.length, 0, 'refuse to publish fixtures into a nonempty remote manifest')
  await seed(host)
  const snapshot = await host.files.readSnapshot(alpha, () => {})
  assert.equal(snapshot.files.length, 8)
  assert.equal(host.files.encodeSnapshot(snapshot).includes(Buffer.from('SYNTHETIC-VAULT-SENTINEL').toString('base64')), false)
  const report = await host.sync.syncGithubPlugins({ accountId, repositoryId: repo.id, direction: 'upload', pluginIds: [alpha, beta] })
  assert.deepEqual(report.items.map(item => item.status), ['done', 'done'], JSON.stringify(report.items))
  assert.deepEqual((await host.sync.githubSyncState(accountId)).cloud.map(item => item.pluginId).sort(), [alpha, beta].sort())
  console.log('PASS: selective batch upload; data outside the selected namespaces was not published')
}
export async function restoreFixture(host, accountId, repo) {
  const [alpha, beta, excluded] = host.ids
  assert.equal(host.storage.getPluginStorageValue(alpha, 'document'), undefined)
  const report = await host.sync.syncGithubPlugins({ accountId, repositoryId: repo.id, direction: 'restore', pluginIds: [alpha] })
  assert.equal(report.items[0].status, 'done', JSON.stringify(report.items))
  assert.deepEqual(host.storage.getPluginStorageValue(alpha, 'document'), version(1))
  assert.equal(host.storage.getPluginStorageValue(beta, 'document'), undefined)
  const root = host.paths.getAppPaths().data, owner = hash(alpha)
  assert.equal(String(await readFile(join(root, 'plugin-files', owner, output))), 'completed file / 仅供测试')
  assert.deepEqual(JSON.parse(await readFile(join(root, 'plugin-documents', owner, 'documents', 'note.json'), 'utf8')), { text: '跨设备示例' })
  for (const path of [join('plugin-documents', owner, 'blobs', 'picture.blob'), join('plugin-assets', owner, 'files', generation), join('plugin-attachments', owner, `${attachment}.blob`)]) assert.deepEqual(await readFile(join(root, path)), png)
  await assert.rejects(readFile(join(root, 'secrets', alpha, 'excluded.fixture')), { code: 'ENOENT' })
  await host.sync.setGithubAutoRestore(accountId, repo.id, true)
  assert.deepEqual(host.storage.getPluginStorageValue(beta, 'document'), version(1))
  assert.equal(host.storage.getPluginStorageValue(excluded, 'document'), undefined)
  host.storage.commitPluginStorage(alpha, [{ op: 'set', key: 'document', value: version('edited on B') }])
  console.log('PASS: selected restore, byte-exact assets/documents/outputs, vault exclusion and opt-in restore-all')
}
export async function updateFixture(host, accountId, repo) {
  const ids = host.ids.slice(0, 2)
  for (const id of ids) host.storage.setPluginStorageValue(id, 'document', version(2))
  const report = await host.sync.syncGithubPlugins({ accountId, repositoryId: repo.id, direction: 'upload', pluginIds: ids })
  assert.deepEqual(report.items.map(item => item.status), ['done', 'done'], JSON.stringify(report.items))
  console.log('PASS: existing binding updates the same repository without creating another')
}
export async function verifyAutoRestore(host, accountId, repo) {
  const [alpha, beta] = host.ids
  const state = await host.sync.githubSyncState(accountId)
  assert.equal(state.autoRestore, true)
  assert.deepEqual(host.storage.getPluginStorageValue(alpha, 'document'), version('edited on B'))
  assert.deepEqual(host.storage.getPluginStorageValue(beta, 'document'), version(2))
  const conflict = state.report.items.find(item => item.pluginId === alpha)
  assert.equal(conflict?.status, 'conflict')
  const result = await host.sync.syncGithubPlugins({ accountId, repositoryId: repo.id, direction: 'restore', pluginIds: [alpha], resolve: conflict.conflict })
  assert.equal(result.items[0].status, 'done')
  assert.deepEqual(host.storage.getPluginStorageValue(alpha, 'document'), version(2))
  console.log('PASS: startup restore preserved a local conflict, accepted the clean update, then applied explicitly selected resolution')
}
