import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { build } from 'esbuild'

const root = fileURLToPath(new URL('../../../', import.meta.url))

async function fixture(run) {
  const directory = await mkdtemp(join(tmpdir(), 'enest-storage-commit-'))
  let api
  try {
    const result = await build({
      stdin: {
        contents: "export * from '@main/db/pluginStorage'; export {kvStore} from '@main/db/sqliteService';",
        resolveDir: root
      },
      tsconfig: join(root, 'tsconfig.node.json'), bundle: true, write: false,
      platform: 'node', format: 'esm',
      plugins: [{ name: 'private-storage-path', setup(builder) {
        builder.onResolve({ filter: /^@main\/paths\/pathsService$/ }, () => ({ path: 'paths', namespace: 'fixture' }))
        builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({
          contents: `export const pluginStorageDir = () => ${JSON.stringify(join(directory, 'legacy'))}; export const getAppPaths = () => ({database:${JSON.stringify(join(directory, 'enest.db'))}});`,
          loader: 'js'
        }))
      } }]
    })
    api = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`)
    assert.equal(await api.kvStore.initDatabase(join(directory, 'enest.db')), 'sqlite')
    api.initPluginStorage()
    await run(api, api.kvStore.getDatabase())
  } finally {
    api?.flushAll()
    api?.kvStore.close()
    await rm(directory, { recursive: true, force: true })
  }
}

test('durable flush commits only its owner and emits a fresh barrier even after the timer batch', async () => {
  await fixture(async (api, db) => {
    api.setPluginStorageValue('alpha', 'draft', { value: 1 })
    api.setPluginStorageValue('beta', 'draft', { value: 2 })
    const receipt = api.flushPluginStorage('alpha')
    assert.equal(receipt.committedKeys, 1)
    assert.ok(receipt.commitId)
    assert.ok(receipt.committedAt > 0)
    assert.equal(db.prepare('SELECT value FROM plugin_storage WHERE plugin_id = ?').get('beta'), undefined)
    assert.equal(api.getStorageDiagnostics().dirtyKeys, 1)
    assert.equal(db.prepare('PRAGMA synchronous').get().synchronous, 1)
    assert.equal(api.flushAll(), true)
    const next = api.flushPluginStorage('alpha')
    assert.equal(next.committedKeys, 0)
    assert.notEqual(next.commitId, receipt.commitId)
    assert.equal(db.prepare('SELECT commit_id FROM plugin_storage_barriers WHERE plugin_id = ?').get('alpha').commit_id, next.commitId)
  })
})

test('atomic commit includes pending values and validates the whole batch before publishing', async () => {
  await fixture(async (api, db) => {
    api.setPluginStorageValue('alpha', 'old', 'remove-me')
    api.setPluginStorageValue('alpha', 'pending', true)
    const receipt = api.commitPluginStorage('alpha', [
      { op: 'set', key: 'result', value: { assetId: 'opaque-image-id' } },
      { op: 'remove', key: 'old' }
    ])
    assert.equal(receipt.committedKeys, 3)
    assert.equal(api.getStorageDiagnostics().dirtyKeys, 0)
    assert.equal(api.getPluginStorageValue('alpha', 'old'), undefined)
    assert.deepEqual(api.getPluginStorageValue('alpha', 'result'), { assetId: 'opaque-image-id' })
    assert.equal(db.prepare('SELECT value FROM plugin_storage WHERE plugin_id = ? AND key = ?').get('alpha', 'pending').value, 'true')
    for (const operations of [
      [], Array.from({ length: 101 }, (_, i) => ({ op: 'remove', key: `${i}` })),
      [{ op: 'set', key: 'new', value: 1 }, { op: 'remove', key: 'new' }],
      [{ op: 'set', key: 'new', value: 1 }, { op: 'set', key: 'bad', value: Infinity }],
      [{ op: 'remove', key: 'new', value: true }],
      [{ op: 'set', key: 'new', value: 'x'.repeat(512 * 1024) }]
    ]) assert.throws(() => api.commitPluginStorage('alpha', operations))
    assert.equal(api.getPluginStorageValue('alpha', 'new'), undefined)
    assert.equal(api.getStorageDiagnostics().dirtyKeys, 0)
  })
})

test('commit failure rolls back new values while keeping already accepted pending values', async () => {
  await fixture(async (api, db) => {
    api.commitPluginStorage('alpha', [{ op: 'set', key: 'stable', value: 'before' }])
    const previous = db.prepare('SELECT commit_id FROM plugin_storage_barriers WHERE plugin_id = ?').get('alpha').commit_id
    api.setPluginStorageValue('alpha', 'queued', 'retained')
    db.exec("CREATE TRIGGER fail_storage_commit BEFORE INSERT ON plugin_storage WHEN NEW.key = 'failure' BEGIN SELECT RAISE(ABORT, 'injected failure'); END")
    try {
      assert.throws(() => api.commitPluginStorage('alpha', [
        { op: 'set', key: 'stable', value: 'after' },
        { op: 'set', key: 'failure', value: true }
      ]), /commit failed/)
      assert.equal(api.getPluginStorageValue('alpha', 'stable'), 'before')
      assert.equal(api.getPluginStorageValue('alpha', 'failure'), undefined)
      assert.equal(api.getPluginStorageValue('alpha', 'queued'), 'retained')
      assert.equal(api.getStorageDiagnostics().dirtyKeys, 1)
      assert.equal(db.prepare('SELECT commit_id FROM plugin_storage_barriers WHERE plugin_id = ?').get('alpha').commit_id, previous)
      assert.equal(db.prepare('PRAGMA synchronous').get().synchronous, 1)
    } finally { db.exec('DROP TRIGGER fail_storage_commit') }
    api.flushPluginStorage('alpha')
    api.clearPluginStorage('alpha')
    assert.equal(db.prepare('SELECT commit_id FROM plugin_storage_barriers WHERE plugin_id = ?').get('alpha'), undefined)
    assert.equal(api.getPluginStorageValue('alpha', 'queued'), undefined)
  })
})

test('key-count and aggregate batch budgets reject before altering existing data', async () => {
  await fixture(async (api) => {
    for (let batch = 0; batch < 10; batch += 1) api.commitPluginStorage('alpha', Array.from({ length: 100 }, (_, i) => ({ op: 'set', key: `${batch * 100 + i}`, value: i })))
    assert.throws(() => api.commitPluginStorage('alpha', [{ op: 'set', key: 'overflow', value: true }]), /quota/)
    api.commitPluginStorage('alpha', [{ op: 'remove', key: '0' }, { op: 'set', key: 'replacement', value: true }])
    assert.throws(() => api.commitPluginStorage('beta', Array.from({ length: 17 }, (_, i) => ({ op: 'set', key: `${i}`, value: 'x'.repeat(512 * 1024 - 2) }))), /8 MiB/)
    assert.equal(api.getPluginStorageValue('beta', '0'), undefined)
  })
})
