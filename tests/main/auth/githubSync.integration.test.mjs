import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { syncFixtureBundle } from './syncFixtureBundle.mjs'
import { initializeDevice, publishFixture, restoreFixture, updateFixture, verifyAutoRestore } from './syncScenario.mjs'

const require = createRequire(import.meta.url), source = await syncFixtureBundle()
function device(request) {
  const module = { exports: {} }
  new Function('require', 'module', 'exports', source)(require, module, module.exports)
  module.exports.runtime.request = request
  return module.exports
}
const digest = value => createHash('sha1').update(value).digest('hex')
const blob = bytes => digest(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes]))
function github() {
  let repo, commit = digest('initial'), creations = 0
  const files = new Map([['README.md', Buffer.from('Existing user file')]]), blobs = new Map()
  const tree = () => {
    const top = [], nested = []
    for (const [path, bytes] of files) {
      const sha = blob(bytes)
      blobs.set(sha, bytes)
      const parts = path.split('/'), name = parts.at(-1)
      ;(parts.length === 1 ? top : nested).push({ path: name, mode: '100644', type: 'blob', sha, size: bytes.length })
    }
    const folder = digest(JSON.stringify(nested))
    if (nested.length) top.push({ mode: '040000', type: 'tree', path: '.enest-sync', sha: folder })
    return { root: digest(JSON.stringify(top)), folder, top, nested }
  }
  return { files, get creations() { return creations }, async request(input, init) {
    const url = new URL(input), path = url.pathname, body = init.body ? JSON.parse(init.body) : undefined
    assert.equal(url.origin, 'https://api.github.com'); assert.equal(init.redirect, 'error')
    if (path === '/user/repos' && init.method === 'POST') {
      if (repo) return new Response(null, { status: 422 })
      assert.equal(body.private, true); assert.equal(body.auto_init, true); creations++
      repo = { ...body, id: 84, node_id: 'repo', owner: { id: 27, type: 'User', login: 'fixture' } }
      return Response.json(repo, { status: 201 })
    }
    if (path === '/user/repos') return Response.json(repo ? [repo] : [])
    if (!repo) return new Response(null, { status: 404 })
    const prefix = `/repos/fixture/${repo.name}`
    if (path === prefix) return Response.json(repo)
    if (path === '/graphql' && body.query.startsWith('query')) return Response.json({ data: { node: { name: repo.name, owner: repo.owner, isPrivate: true, isArchived: false, isEmpty: false,
      defaultBranchRef: { id: 'branch', target: { oid: commit, tree: { oid: tree().root } } } } } })
    if (path === '/graphql') {
      const change = body.variables.input
      assert.equal(change.expectedHeadOid, commit); assert.equal(change.branch.id, 'branch')
      for (const file of change.fileChanges.additions) files.set(file.path, Buffer.from(file.contents, 'base64'))
      commit = digest(commit + tree().root)
      return Response.json({ data: { createCommitOnBranch: { commit: { oid: commit, tree: { oid: tree().root } } } } })
    }
    if (path.startsWith(`${prefix}/git/trees/`)) {
      const oid = path.split('/').pop(), snapshot = tree()
      assert.ok(oid === snapshot.root || oid === snapshot.folder)
      return Response.json({ truncated: false, tree: oid === snapshot.root ? snapshot.top : snapshot.nested })
    }
    if (path.startsWith(`${prefix}/git/blobs/`)) { const bytes = blobs.get(path.split('/').pop()); assert.ok(bytes); return new Response(bytes) }
    throw new Error('Unexpected GitHub fixture endpoint')
  } }
}

test('two independent data roots sync selected data, auto-restore on restart and preserve conflicts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'enest-sync-roundtrip-')), remote = github(), first = device(remote.request), second = device(remote.request), reboot = device(remote.request)
  const name = 'custom-private-fixture', id = 27, repo = { id: 84, name }
  try {
    await initializeDevice(first, join(root, 'A')); await initializeDevice(second, join(root, 'B'))
    assert.equal(remote.creations, 0)
    first.sync.restoreGithubOnLogin()
    await first.sync.connectGithubRepository(id, name)
    await first.sync.connectGithubRepository(id, name)
    await publishFixture(first, id, repo)
    const discovered = once(second.events, 'github-sync-finished', { signal: AbortSignal.timeout(5000) })
    second.sync.restoreGithubOnLogin(); await discovered
    assert.equal((await second.sync.githubSyncState(id)).autoRestore, false)
    await restoreFixture(second, id, repo); second.kvStore.close()
    await updateFixture(first, id, repo)
    await initializeDevice(reboot, join(root, 'B'))
    const restored = once(reboot.events, 'github-sync-finished', { signal: AbortSignal.timeout(5000) })
    reboot.sync.restoreGithubOnLogin(); await restored; await reboot.sync.waitForGithubSync(); await verifyAutoRestore(reboot, id, repo)
    assert.equal(remote.creations, 1); assert.equal(String(remote.files.get('README.md')), 'Existing user file')
    reboot.sync.disconnectGithubRepository(id, repo.id)
    assert.equal((await reboot.sync.githubSyncState(id)).repository, null)
  } finally {
    for (const client of [first, second, reboot]) { client.storage.flushAll(); client.kvStore.close() }
    await rm(root, { recursive: true, force: true }); assert.equal(existsSync(root), false)
  }
})

test('interrupted multi-file restore rolls back and releases its journal before a retry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'enest-sync-rollback-')), host = device(() => { throw new Error('unexpected network') })
  try {
    await initializeDevice(host, root)
    const id = host.ids[0], current = await host.files.readSnapshot(id, () => {})
    const next = { ...current, files: ['first.json', 'second.json'].map(name => ({ area: 'documents', name, data: Buffer.from('"fixture"').toString('base64') })), storage: [['key', '"new"']] }
    const first = join(root, 'data', 'plugin-documents', createHash('sha256').update(id).digest('hex'), 'documents', 'first.json')
    await assert.rejects(host.files.restoreSnapshot(current, next, () => { if (existsSync(first)) throw new Error('cancelled') }), /cancelled/)
    assert.deepEqual(await host.files.readSnapshot(id, () => {}), current)
    assert.equal(host.kvStore.getDatabase().prepare('SELECT count(*) AS count FROM plugin_sync_recovery').get().count, 0)
    await host.files.restoreSnapshot(current, next, () => {}); assert.deepEqual(await host.files.readSnapshot(id, () => {}), next)
  } finally { host.kvStore.close(); await rm(root, { recursive: true, force: true }) }
})

test('retrying just a failed upload reconciles an already accepted commit instead of publishing it twice', async () => {
  const root = await mkdtemp(join(tmpdir(), 'enest-sync-reconcile-')), remote = github(), uploads = []
  const host = device(async (url, options) => {
    const response = await remote.request(url, options)
    const title = options.body && JSON.parse(options.body).variables?.input?.message?.headline
    if (title?.startsWith('Sync ')) {
      uploads.push(title)
      if (uploads.length === 2) throw new TypeError('net::ERR_CONNECTION_RESET')
    }
    return response
  })
  try {
    await initializeDevice(host, root)
    const pluginIds = host.ids.slice(0, 2), input = { accountId: 27, repositoryId: 84, direction: 'upload', pluginIds }
    await host.sync.connectGithubRepository(27, 'retry-fixture')
    for (const id of pluginIds) host.storage.setPluginStorageValue(id, 'fixture', { id })
    const initial = await host.sync.syncGithubPlugins(input)
    assert.deepEqual(initial.items.map(item => item.status), ['done', 'error'])
    const failed = initial.items.filter(item => item.status === 'error').map(item => item.pluginId)
    const retried = await host.sync.syncGithubPlugins({ ...input, pluginIds: failed })
    assert.deepEqual(retried.items, [{ pluginId: pluginIds[1], status: 'unchanged', message: undefined, conflict: undefined }])
    assert.deepEqual(uploads, pluginIds.map(id => `Sync ${id}`))
  } finally { host.storage.flushAll(); host.kvStore.close(); await rm(root, { recursive: true, force: true }) }
})
