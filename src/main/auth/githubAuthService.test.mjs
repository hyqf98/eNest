import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import ts from 'typescript'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
const { createGithubExchangeServer } = await import(pathToFileURL(resolve('docs/examples/github-oauth-exchange.mjs')).href)

const require = createRequire(import.meta.url)
function load(file, mocks = {}) {
  const js = ts.transpileModule(readFileSync(new URL(file, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const module = { exports: {} }
  new Function('require', 'module', 'exports', js)(name => mocks[name] ?? require(name), module, module.exports)
  return module.exports
}
const loopback = load('./oauthLoopback.ts')
const tick = () => new Promise(resolve => setTimeout(resolve, 10))
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'enest-auth-'))
  const f = { events: [], urls: [], exchanges: [], user: null, browserError: false, config: { available: true, clientId: 'fixture', exchangeUrl: 'https://publisher.example/oauth/github/exchange' }, focused: 0, blockProfile: null, profileSignals: [], persistError: false }
  f.api = load('./githubAuthService.ts', {
    electron: {
      net: { fetch: async (url, init) => {
        if (url === f.config.exchangeUrl) { f.exchanges.push(JSON.parse(init.body)); return Response.json({ access_token: 'fixture-secret' }) }
        if (url === 'https://api.github.com/user') { f.profileSignals.push(init.signal); if (f.blockProfile) await f.blockProfile; return Response.json({ login: 'test', name: 'Tester', avatar_url: null, html_url: 'https://github.com/test' }) }
        throw new Error(`Unexpected URL ${url}`)
      } },
      safeStorage: { isEncryptionAvailable: () => true, encryptString: s => Buffer.from('encrypted:' + s), decryptString: b => b.toString().slice(10) },
      shell: { openExternal: async url => { f.urls.push(new URL(url)); if (f.browserError) throw new Error('Browser unavailable') } },
    },
    '@main/paths/pathsService': { getAppPaths: () => ({ data: dir }) },
    '@main/settings/SettingsStore': { settingsStore: { getAll: () => ({ profile: { user: f.user } }), setProfileUser: user => { if (f.persistError) throw new Error('Profile storage failed'); f.user = user } } },
    '@main/window/createShellWindow': { sendShellEvent: e => f.events.push(e), getMainWindow: () => ({ isDestroyed: () => false, isMinimized: () => false, show() {}, focus() { f.focused++ } }) },
    '@main/window/orbRailViews': { setOrbProfile() {} }, '@main/logs/logService': { logInfo() {}, logWarn() {} },
    './authConfig': { getGithubAuthConfig: () => f.config }, './oauthLoopback': loopback,
  })
  f.callback = (state) => {
    const authorize = f.urls.at(-1)
    const url = new URL(authorize.searchParams.get('redirect_uri'))
    url.search = new URLSearchParams({ state: state ?? authorize.searchParams.get('state'), code: 'fixture-code' }).toString()
    return fetch(url)
  }
  f.close = () => { f.api.cancelGithubLogin(); rmSync(dir, { recursive: true, force: true }) }
  f.tokenExists = () => existsSync(join(dir, 'github.token'))
  return f
}

test('valid browser flow waits for exchange, persists profile and wakes eNest; invalid state does not consume session', async () => {
  const f = fixture()
  try {
    const starting = f.api.startGithubLogin()
    await assert.rejects(f.api.startGithubLogin(), /已有登录/)
    const session = await starting
    assert.equal(session.mode, 'web')
    assert.equal(f.api.getGithubLoginSession().verificationUri, session.verificationUri)
    const invalid = await f.callback('wrong-state')
    assert.equal(invalid.status, 400)
    assert.equal(f.api.isLoginPolling(), true)
    const valid = await f.callback()
    assert.match(await valid.text(), /已登录/)
    assert.equal(f.user.login, 'test')
    assert.equal(f.focused, 1)
    assert.equal(f.tokenExists(), true)
    assert.equal(f.api.isLoginPolling(), false)
    assert.equal(f.api.getGithubLoginSession(), null)
    assert.equal(f.exchanges[0].code, 'fixture-code')
    assert.ok(f.exchanges[0].code_verifier.length >= 43)
    assert.equal('client_secret' in f.exchanges[0], false)
  } finally { f.close() }
})

test('callback requires state and rejects replay; provider error text is never reflected', async () => {
  const callback = await loopback.listenOAuthLoopback('expected')
  try {
    const invalid = await fetch(callback.redirectUri + '?state=wrong&error=%3Cscript%3E')
    assert.equal(invalid.status, 400)
    assert.doesNotMatch(await invalid.text(), /<script>/)
    const response = fetch(callback.redirectUri + '?state=expected&error=%3Cscript%3E')
    assert.match((await callback.result).error, /取消/)
    assert.equal((await fetch(callback.redirectUri + '?state=expected&code=again')).status, 409)
    callback.complete(false)
    assert.doesNotMatch(await (await response).text(), /<script>/)
  } finally { callback.close() }
})

test('cancel during profile fetch discards stale credentials and boot refresh cannot restore a logged-out user', async () => {
  const f = fixture()
  try {
    await f.api.startGithubLogin()
    let release
    f.blockProfile = new Promise(resolve => { release = resolve })
    const callback = f.callback()
    while (f.exchanges.length === 0) await tick()
    f.api.cancelGithubLogin()
    assert.equal(f.profileSignals[0].aborted, true)
    release()
    await callback
    await tick()
    assert.equal(f.user, null)
    assert.equal(f.tokenExists(), false)
    f.blockProfile = null
    await f.api.startGithubLogin()
    await f.callback()
    assert.equal(f.user.login, 'test')
    f.blockProfile = new Promise(resolve => { release = resolve })
    const refresh = f.api.refreshProfileOnBoot()
    f.api.logoutGithub()
    release()
    await refresh
    assert.equal(f.user, null)
    assert.equal(f.tokenExists(), false)
  } finally { f.close() }
})

test('unconfigured provider and browser failure release the pending session', async () => {
  const f = fixture()
  try {
    f.config.available = false
    f.config.availabilityError = '此版本尚未配置 GitHub 登录应用，请联系发布方完成登录配置。'
    await assert.rejects(f.api.startGithubLogin(), { message: f.config.availabilityError })
    assert.equal(f.urls.length, 0)
    assert.equal(f.api.isLoginPolling(), false)
    assert.equal(f.api.getGithubLoginSession(), null)
    f.config.available = true
    f.browserError = true
    await assert.rejects(f.api.startGithubLogin(), /Browser unavailable/)
    assert.equal(f.api.isLoginPolling(), false)
    assert.equal(f.api.getGithubLoginSession(), null)
  } finally { f.close() }
})

test('publisher endpoint restricts redirects and keeps client secret on server', async () => {
  const upstreams = []
  const server = createGithubExchangeServer({ clientId: 'publisher-id', clientSecret: 'server-only', fetchImpl: async (url, options) => { upstreams.push({ url, body: JSON.parse(options.body) }); return Response.json({ access_token: 'token', secret: 'never-return' }) } })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const endpoint = `http://127.0.0.1:${server.address().port}/oauth/github/exchange`
  const data = { code: 'abc123', code_verifier: 'v'.repeat(64), redirect_uri: 'http://127.0.0.1:12345/callback' }
  const post = body => fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  try {
    assert.equal((await post({ ...data, redirect_uri: 'https://attacker.example/callback' })).status, 400)
    assert.equal(upstreams.length, 0)
    assert.deepEqual(await (await post(data)).json(), { access_token: 'token' })
    assert.equal(upstreams[0].body.client_secret, 'server-only')
    assert.equal(upstreams[0].body.client_id, 'publisher-id')
    assert.equal((await post({ ...data, code_verifier: 'short' })).status, 400)
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
})


test('profile persistence failure never reports browser success and clears the saved token', async () => {
  const f = fixture()
  try {
    f.persistError = true
    await f.api.startGithubLogin()
    const response = await f.callback()
    assert.match(await response.text(), /未能完成登录/)
    assert.equal(f.tokenExists(), false)
    assert.equal(f.user, null)
    assert.equal(f.api.isLoginPolling(), false)
    assert.ok(f.events.some(e => e.type === 'account-login-status' && e.phase === 'error'))
  } finally { f.close() }
})
