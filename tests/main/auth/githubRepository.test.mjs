import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import ts from 'typescript'

const require = createRequire(import.meta.url)
function source(file, imports = {}) {
  const module = { exports: {} }
  const code = ts.transpileModule(readFileSync(new URL(`../../../src/${file}`, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  new Function('require', 'exports', 'module', code)(name => imports[name] ?? require(name), module.exports, module)
  return module.exports
}
const session = { user: { id: 27, login: 'fixture' }, token: 'fixture-only', signal: new AbortController().signal, check() {} }
const repo = { id: 84, node_id: 'repo-node', name: 'my-plugin-data', private: true, archived: false, owner: { id: 27, type: 'User' } }
const fail = status => new Response(null, { status })
function fixture(responses, onRequest) {
  const calls = []
  const electron = { net: { fetch: async (url, options) => {
      const target = new URL(url)
      calls.push({ path: target.pathname, page: target.searchParams.get('page'), method: options.method, data: options.body && JSON.parse(options.body) })
      assert.equal(new URL(url).origin, 'https://api.github.com')
      assert.equal(options.redirect, 'error')
      assert.equal(options.credentials, 'omit')
      assert.ok(responses.length, 'unexpected network request')
      const response = responses.shift()
      onRequest?.(calls.length)
      if (response instanceof Error) throw response
      return response
  } } }
  const api = source('main/auth/githubRepository.ts', {
    './githubTransport': source('main/auth/githubTransport.ts', { electron, '@main/net/boundedResponse': source('main/net/boundedResponse.ts') }),
    '@main/plugin/packageIdentity': { isPackageId: id => typeof id === 'string' && /^com\.example\.[a-z]+$/.test(id) },
    '@shared/types/githubSync': source('shared/types/githubSync.ts'),
  })
  return { api, calls }
}

test('safe reads retry a reset and a temporary 503, but stop after three attempts', async () => {
  const recovered = fixture([new TypeError('net::ERR_CONNECTION_RESET'), fail(503), Response.json(repo)])
  assert.equal((await recovered.api.resolveRepository(session, repo.name, false)).id, repo.id)
  assert.deepEqual(recovered.calls.map(row => row.method), ['GET', 'GET', 'GET'])
  const offline = fixture([fail(502), fail(503), fail(504)])
  await assert.rejects(offline.api.resolveRepository(session, repo.name, false), /504/)
  assert.equal(offline.calls.length, 3)
})

test('rate-limit hints, cancellation, access denials and uncertain writes never cause blind replays', async () => {
  for (const response of [fail(401), fail(403), fail(429), new Response(null, { status: 429, headers: { 'retry-after': '60' } })]) {
    const denied = fixture([response]); await assert.rejects(denied.api.resolveRepository(session, repo.name, false)); assert.equal(denied.calls.length, 1)
  }
  const reset = fixture([new Response(null, { status: 403, headers: { 'retry-after': '0' } }), Response.json(repo)])
  assert.equal((await reset.api.resolveRepository(session, repo.name, false)).id, repo.id)
  const abort = new AbortController(), cancelled = fixture([fail(503)], () => setTimeout(() => abort.abort(), 10))
  await assert.rejects(cancelled.api.resolveRepository({ ...session, signal: abort.signal }, repo.name, false), { name: 'AbortError' })
  assert.equal(cancelled.calls.length, 1)
  const create = fixture([fail(404), fail(502)])
  await assert.rejects(create.api.resolveRepository(session, repo.name, true), /502/)
  assert.deepEqual(create.calls.map(row => row.method), ['GET', 'POST'])
  const head = { branch: 'ref', oid: 'a'.repeat(40), tree: 'b'.repeat(40) }
  const fresh = Response.json({ data: { node: { name: repo.name, isPrivate: true, owner: session.user, defaultBranchRef: { id: head.branch, target: { oid: head.oid, tree: { oid: head.tree } } } } } })
  const commit = fixture([fail(502), fresh, new TypeError('net::ERR_CONNECTION_RESET')]), content = Buffer.from('synthetic')
  await assert.rejects(commit.api.uploadSnapshot(session, { repository: { ...repo, node: repo.node_id }, head, plugins: [] }, { pluginId: 'com.example.a', bytes: content.length, sha: commit.api.blobSha(content) }, content), /ERR_CONNECTION_RESET/)
  assert.deepEqual(commit.calls.map(row => row.data.query.split('(')[0]), ['query', 'query', 'mutation'])
})

test('explicit connection creates only the requested personal private repo and verifies its immutable identity', async () => {
  const { api, calls } = fixture([fail(404), Response.json(repo, { status: 201 }), Response.json(repo)])
  assert.deepEqual(await api.resolveRepository(session, repo.name, true), { name: repo.name, id: repo.id, node: repo.node_id })
  assert.deepEqual(calls.map(call => [call.method, call.path]), [['GET', '/repos/fixture/my-plugin-data'], ['POST', '/user/repos'], ['GET', '/repos/fixture/my-plugin-data']])
  assert.deepEqual([calls[1].data.name, calls[1].data.private, calls[1].data.auto_init], [repo.name, true, true])
})

test('an existing private repo is reused, but public, foreign, replaced or unavailable bindings are never created over', async () => {
  const existing = fixture([Response.json(repo)])
  assert.equal((await existing.api.resolveRepository(session, repo.name, true)).id, repo.id)
  for (const response of [Response.json({ ...repo, private: false }), Response.json({ ...repo, owner: { id: 9, type: 'User' } }), Response.json({ ...repo, id: 61 }), fail(403), fail(404)]) {
    const { api, calls } = fixture([response])
    await assert.rejects(api.resolveRepository(session, repo.name, true, repo.id))
    assert.equal(calls.length, 1)
  }
})

test('hidden name collisions require access instead of changing visibility or guessing a new name', async () => {
  const { api, calls } = fixture([fail(404), fail(422), fail(404)])
  await assert.rejects(api.resolveRepository(session, repo.name, true), /名称不可用|尚未授权/)
  assert.deepEqual(calls.map(call => call.method), ['GET', 'POST', 'GET'])
  for (const invalid of ['../other', 'someone/repo', '.git', '', 'my.git', '...']) assert.throws(() => api.syncRepoName(invalid))
})

test('a created private repo hidden from the installation is reported by name and receives no data', async () => {
  const { api, calls } = fixture([fail(404), Response.json(repo, { status: 201 }), fail(404)])
  await assert.rejects(api.resolveRepository(session, repo.name, true), /已创建私库 fixture\/my-plugin-data.*原名重试.*尚未上传/)
  assert.deepEqual(calls.map(call => call.method), ['GET', 'POST', 'GET'])
})

const suggested = { ...repo, description: 'Private plugin data synced by eNest' }
const privatePage = start => Array.from({ length: 100 }, (_, index) => ({ ...repo, name: `user-project-${start + index}`, id: 1000 + start + index }))
const pageWithNext = rows => Response.json(rows, { headers: { Link: '<https://api.github.com/user/repos?page=2>; rel="next"' } })

test('a new device discovers a custom sync repo on a later page and verifies its marker without writing', async () => {
  const responses = [pageWithNext(privatePage(0)), Response.json([suggested]), Response.json(repo)]
  const { api, calls } = fixture(responses)
  const marker = Buffer.from(JSON.stringify({ format: 'enest.plugin-sync/v1', accountId: session.user.id, repositoryId: repo.id, plugins: [] }))
  const markerSha = api.blobSha(marker)
  responses.push(Response.json({ data: { node: { ...repo, isPrivate: true, owner: session.user, defaultBranchRef: { id: 'ref', target: { oid: 'a'.repeat(40), tree: { oid: 'b'.repeat(40) } } } } } }),
    Response.json({ truncated: false, tree: [{ path: '.enest-sync.json', mode: '100644', type: 'blob', sha: markerSha, size: marker.length }] }), new Response(marker))
  assert.deepEqual(await api.findExistingSyncRepository(session), { id: repo.id, name: repo.name, node: repo.node_id })
  assert.deepEqual(calls.filter(call => call.path === '/user/repos').map(call => call.page), ['1', '2'])
  assert.ok(calls.every(call => call.method === 'GET' || call.path === '/graphql' && call.data.query.startsWith('query')))
})

test('automatic discovery does not guess when another candidate is on a later page or listing is incomplete', async () => {
  const first = [suggested, ...privatePage(0).slice(1)]
  const ambiguous = fixture([pageWithNext(first), Response.json([{ ...suggested, id: 85, name: 'other-sync-repo' }])])
  assert.equal(await ambiguous.api.findExistingSyncRepository(session), null)
  assert.deepEqual(ambiguous.calls.map(call => call.page), ['1', '2'])
  const incomplete = fixture([pageWithNext(first), ...[100, 200, 300, 400].map(start => pageWithNext(privatePage(start)))])
  assert.equal(await incomplete.api.findExistingSyncRepository(session), null)
  assert.deepEqual(incomplete.calls.map(call => call.page), ['1', '2', '3', '4', '5'])
})

test('a concurrent change to the default branch prevents both snapshot and manifest writes', async () => {
  const { api, calls } = fixture([Response.json({ data: { node: { name: repo.name, owner: { login: 'fixture' }, isPrivate: true, isArchived: false, defaultBranchRef: { id: 'ref', target: { oid: 'c'.repeat(40), tree: { oid: 'd'.repeat(40) } } } } } })])
  const bytes = Buffer.from('snapshot')
  const index = { repository: { ...repo, node: repo.node_id }, head: { branch: 'ref', oid: 'a'.repeat(40), tree: 'b'.repeat(40) }, plugins: [] }
  await assert.rejects(api.uploadSnapshot(session, index, { pluginId: 'com.example.a', bytes: bytes.length, sha: api.blobSha(bytes) }, bytes), /新提交/)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].data.query.startsWith('query'), true)
  assert.deepEqual(index.plugins, [])
})
