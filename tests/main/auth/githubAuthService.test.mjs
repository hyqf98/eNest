import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import ts from 'typescript'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
const { createGithubExchangeServer } = await import(pathToFileURL(resolve('scripts/auth/github-oauth-exchange.mjs')).href)

const require = createRequire(import.meta.url)
function load(file, mocks = {}) {
  const js = ts.transpileModule(readFileSync(new URL(file, new URL("../../../src/main/auth/", import.meta.url)), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const module = { exports: {} }
  new Function('require', 'module', 'exports', js)(name => mocks[name] ?? require(name), module, module.exports)
  return module.exports
}
const loopback = load('./oauthLoopback.ts')
const tick = () => new Promise(resolve => setTimeout(resolve, 10))
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'enest-auth-'))
  const f = { events: [], urls: [], exchanges: [], user: null, browserError: false, config: { available: true, clientId: 'fixture', exchangeUrl: 'https://publisher.example/oauth/github/exchange' }, focused: 0, blockProfile: null, profileSignals: [], persistError: false }
  const electron = {
      app: { focus() {} },
      net: { fetch: async (url, init) => {
        if (url === 'https://github.com/login/device/code' && f.deviceCode) return Response.json(f.deviceCode)
        if (url === 'https://github.com/login/oauth/access_token' && f.tokenRequest) return f.tokenRequest(init)
        if (url === 'https://avatars.githubusercontent.com/u/17?s=160' && f.avatarRequest) return f.avatarRequest(init)
        if (url === f.config.exchangeUrl) { f.exchanges.push(JSON.parse(init.body)); return Response.json({ access_token: 'fixture-secret' }) }
        if (url === 'https://api.github.com/user') { f.profileSignals.push(init.signal); if (f.blockProfile) await f.blockProfile; return f.profileRequest ? f.profileRequest() : Response.json({ id: 17, login: 'test', name: 'Tester', avatar_url: null, html_url: 'https://github.com/test' }) }
        throw new Error(`Unexpected URL ${url}`)
      } },
      shell: { openExternal: async url => { f.urls.push(new URL(url)); if (f.browserError) throw new Error('Browser unavailable') } },
  }
  const storage = {
    '@main/paths/pathsService': { getAppPaths: () => ({ data: dir }), getAppPathsGeneration: () => 0 },
    '@main/settings/SettingsStore': { settingsStore: { getProfileUser: () => f.user, setProfileUser: user => { if (f.persistError) throw new Error('Profile storage failed'); f.user = user } } },
  }
  f.api = load('./githubAuthService.ts', {
    electron, ...storage, './githubMemorySession': load('./githubMemorySession.ts', storage),
    '@main/vault/githubAccountStorage': {
      isLegacyGithubCiphertext: bytes => bytes.subarray(0, 3).toString() === 'v10',
      sealGithubCredential: async token => { if (f.sealDenied) throw new Error('interaction required'); return Buffer.from(`encrypted:${token}`) },
      openGithubCredential: async bytes => { f.diskReads++; return { result: bytes.toString().slice(10), shouldReEncrypt: false } },
    },
    './githubTransport': load('./githubTransport.ts', { electron, '@main/net/boundedResponse': load('../net/boundedResponse.ts') }), './githubCredential': load('./githubCredential.ts'),
    '@main/clipboard/clipboardNativeEvents': { writeClipboardText: async () => {} },
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
  f.diskReads = 0
  f.seedLegacy = () => { f.user = { githubId: 17, login: 'test' }; writeFileSync(join(dir, 'github.token'), 'v10legacy-fixture') }
  f.seedExpiring = () => {
    f.user = { githubId: 17, login: 'test', connectedAt: Date.now() - 60000 }
    writeFileSync(join(dir, 'github.token'), 'encrypted:' + JSON.stringify({ access: 'fixture-old', refresh: 'fixture-original-refresh', clientId: f.config.clientId, expiresAt: Date.now() - 1000, refreshExpiresAt: Date.now() + 60000 }), { mode: 0o600 })
  }
  return f
}

const rotated = () => Response.json({ access_token: 'fixture-renewed', refresh_token: 'fixture-rotated-refresh', expires_in: 28800, refresh_token_expires_in: 86400 })

test('a locked store still completes device sign-in and syncs in memory without a token or profile on disk', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const host = fixture()
  try {
    host.config.deviceFlow = true; host.sealDenied = true; host.tokenRequest = rotated
    host.deviceCode = { device_code: 'fixture-device', user_code: 'FAKE-C0DE', expires_in: 60, interval: 3 }
    await host.api.startGithubLogin(); context.mock.timers.tick(3000); await new Promise(resolve => setImmediate(resolve))
    assert.equal(host.api.getGithubCredentialNotice(), 'session-only'); assert.equal(host.api.getProfileUser().githubId, 17)
    assert.equal((await host.api.getGithubSyncSession()).token, 'fixture-renewed'); assert.equal(host.tokenExists(), false); assert.equal(host.user, null)
    host.api.disposeGithubSession(); assert.equal(await host.api.hasGithubToken(), false); assert.equal(host.api.getProfileUser(), null)
  } finally { host.close() }
})

test('a legacy sign-in is left encrypted and never opened by a background refresh', async () => {
  const host = fixture()
  try {
    host.seedLegacy(); await host.api.refreshProfileOnBoot()
    assert.equal(host.diskReads, 0); assert.equal(host.api.getGithubCredentialNotice(), 'reauth-required')
    assert.equal(host.api.getProfileUser(), null); assert.equal(host.tokenExists(), true)
    host.api.logoutGithub(); assert.equal(host.tokenExists(), false); assert.equal(host.api.getGithubCredentialNotice(), undefined)
  } finally { host.close() }
})

test('a failed avatar refresh keeps the cached picture for the same account and URL but not a changed URL', async () => {
  const f = fixture(), avatar = 'https://avatars.githubusercontent.com/u/17', cached = 'data:image/png;base64,dGVzdA=='
  try {
    f.seedExpiring(); Object.assign(f.user, { avatarUrl: avatar, avatarDataUrl: cached })
    f.tokenRequest = rotated
    f.profileRequest = () => Response.json({ id: 17, login: 'test', name: 'Tester', avatar_url: avatar })
    let attempts = 0
    f.avatarRequest = () => { attempts++; return new Response(null, { status: 404 }) }
    await f.api.refreshProfileOnBoot(); assert.equal(attempts, 1); assert.equal(f.user.avatarDataUrl, cached)
    f.user.avatarUrl = 'https://avatars.githubusercontent.com/u/17?old=1'
    await f.api.refreshProfileOnBoot(); assert.equal(attempts, 2); assert.equal(f.user.avatarDataUrl, null); assert.equal(f.tokenExists(), true)
  } finally { f.close() }
})

test('a pending device grant on HTTP 400 keeps waiting and ignores token-shaped fields in the error', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const f = fixture()
  try {
    f.config.deviceFlow = true
    f.deviceCode = { device_code: 'fixture-device', user_code: 'FAKE-C0DE', expires_in: 60, interval: 3 }
    let polls = 0
    f.tokenRequest = async () => ++polls === 1 ? Response.json({ error: 'authorization_pending', access_token: 'not-a-grant' }, { status: 400 }) : rotated()
    const login = await f.api.startGithubLogin()
    assert.equal(login.mode, 'device'); assert.equal(f.urls[0].href, 'https://github.com/login/device')
    context.mock.timers.tick(3000); await new Promise(resolve => setImmediate(resolve))
    assert.equal(polls, 1); assert.equal(f.api.isLoginPolling(), true); assert.equal(f.tokenExists(), false); assert.equal(f.user, null)
    context.mock.timers.tick(3000); await new Promise(resolve => setImmediate(resolve))
    assert.equal(polls, 2); assert.equal(f.api.isLoginPolling(), false); assert.equal(f.user.githubId, 17); assert.equal(f.focused, 1)
  } finally { f.close() }
})

test('concurrent sync and boot refresh share one device token renewal, reload it and never steal focus', async () => {
  const f = fixture(), entered = Promise.withResolvers(), release = Promise.withResolvers()
  try {
    f.seedExpiring(); const connected = f.user.connectedAt
    let renewals = 0
    f.tokenRequest = async init => {
      renewals++; assert.deepEqual(JSON.parse(init.body), { client_id: 'fixture', grant_type: 'refresh_token', refresh_token: 'fixture-original-refresh' })
      entered.resolve(); await release.promise; return rotated()
    }
    const startups = Promise.all([f.api.refreshProfileOnBoot(), f.api.getGithubSyncSession(), f.api.getGithubSyncSession()])
    await entered.promise; release.resolve()
    const [, first, second] = await startups
    assert.equal(first.token, 'fixture-renewed'); assert.equal(second.token, first.token); assert.equal(renewals, 1)
    assert.equal(f.focused, 0); assert.equal(f.user.connectedAt, connected)
    f.api.disposeGithubSession(); assert.throws(() => first.check())
    assert.equal((await f.api.getGithubSyncSession()).token, 'fixture-renewed'); assert.equal(renewals, 1)
  } finally { release.resolve(); f.close() }
})

test('a temporary renewal failure preserves the profile, but an explicit revoked refresh grant signs out', async () => {
  const f = fixture()
  try {
    f.seedExpiring()
    f.tokenRequest = async () => new Response(null, { status: 503 })
    await assert.rejects(f.api.getGithubSyncSession(), /503/)
    assert.equal(f.tokenExists(), true); assert.equal(f.user.githubId, 17)
    f.tokenRequest = async () => Response.json({ access_token: 'not-a-grant' }, { status: 400 })
    await assert.rejects(f.api.getGithubSyncSession(), /GitHub 400/)
    assert.equal(f.tokenExists(), true); assert.equal(f.user.githubId, 17)
    f.tokenRequest = async () => Response.json({ error: 'invalid_grant' }, { status: 400 })
    await assert.rejects(f.api.getGithubSyncSession(), /授权已失效/)
    assert.equal(f.tokenExists(), false); assert.equal(f.user, null)
  } finally { f.close() }
})

test('signing out during token rotation does not restore a stale credential', async () => {
  const f = fixture(), entered = Promise.withResolvers(), release = Promise.withResolvers()
  try {
    f.seedExpiring()
    f.tokenRequest = async init => { entered.resolve(init.signal); await release.promise; return rotated() }
    const pending = f.api.getGithubSyncSession(), signal = await entered.promise
    f.api.logoutGithub(); assert.equal(signal.aborted, true); release.resolve()
    await assert.rejects(pending); assert.equal(f.user, null); assert.equal(f.tokenExists(), false)
  } finally { release.resolve(); f.close() }
})

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
