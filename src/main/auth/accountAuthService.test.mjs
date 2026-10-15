import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import ts from 'typescript'
const require = createRequire(import.meta.url)
function load(file, mocks) {
  const module = { exports: {} }
  const js = ts.transpileModule(readFileSync(new URL(file, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  new Function('require', 'module', 'exports', js)(id => mocks[id] ?? require(id), module, module.exports)
  return module.exports
}

test('release configuration requires a configured flow and rejects insecure remote exchange URLs', () => {
  const keys = ['ENEST_GITHUB_CLIENT_ID', 'ENEST_GITHUB_TOKEN_EXCHANGE_URL', 'ENEST_GITHUB_DEVICE_FLOW']
  const previous = Object.fromEntries(keys.map(k => [k, process.env[k]]))
  const app = { isPackaged: true }
  const { getGithubAuthConfig } = load('./authConfig.ts', { electron: { app } })
  try {
    for (const key of keys) delete process.env[key]
    assert.equal(getGithubAuthConfig().available, false)
    process.env.ENEST_GITHUB_CLIENT_ID = 'fixture'
    assert.equal(getGithubAuthConfig().available, false)
    for (const endpoint of ['http://remote.example/oauth', 'https://user:pass@publisher.example/oauth', 'https://publisher.example/oauth?secret=x']) {
      process.env.ENEST_GITHUB_TOKEN_EXCHANGE_URL = endpoint
      assert.equal(getGithubAuthConfig().available, false)
    }
    process.env.ENEST_GITHUB_TOKEN_EXCHANGE_URL = 'https://publisher.example/oauth'
    assert.equal(getGithubAuthConfig().available, true)
    process.env.ENEST_GITHUB_TOKEN_EXCHANGE_URL = 'http://127.0.0.1:8787/oauth'
    assert.equal(getGithubAuthConfig().available, false)
    app.isPackaged = false
    assert.equal(getGithubAuthConfig().available, true)
    delete process.env.ENEST_GITHUB_TOKEN_EXCHANGE_URL
    process.env.ENEST_GITHUB_DEVICE_FLOW = '1'
    assert.equal(getGithubAuthConfig().available, true)
  } finally { for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key] } }
})

test('provider registry restores pending session and rejects inherited or unknown provider IDs', async () => {
  const session = { mode: 'web', verificationUri: 'https://github.com/login/oauth/authorize', expiresInSeconds: 120 }
  let calls = 0
  const api = load('./accountAuthService.ts', {
    './authConfig': { getGithubAuthConfig: () => ({ available: true }) },
    './githubAuthService': { getProfileUser: () => null, getGithubLoginSession: () => session, isLoginPolling: () => true,
      startGithubLogin: async () => { calls++; return session }, cancelGithubLogin() {}, logoutGithub() {} },
  })
  const state = api.getAccountState()
  assert.equal(state.pendingProviderId, 'github')
  assert.deepEqual(state.session, session)
  assert.deepEqual(state.providers, [{ id: 'github', name: 'GitHub', available: true }])
  for (const id of ['__proto__', 'constructor', 'other', {}, null]) {
    assert.equal((await api.loginAccount(id)).ok, false)
    assert.throws(() => api.logoutAccount(id), /不支持/)
    assert.throws(() => api.cancelAccountLogin(id), /不支持/)
  }
  assert.equal(calls, 0)
  assert.deepEqual(await api.loginAccount('github'), { ok: true, data: session })
  assert.equal(calls, 1)
})
