import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import ts from 'typescript'

const require = createRequire(import.meta.url)
const sourceRoot = new URL('../../../src/main/', import.meta.url)
function load(file, adapters = {}, platform = 'darwin') {
  const { outputText } = ts.transpileModule(fs.readFileSync(new URL(file, sourceRoot), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  })
  const module = { exports: {} }
  new Function('require', 'module', 'exports', 'process', outputText)(
    name => adapters[name] ?? require(name), module, module.exports,
    { platform, env: {}, cwd: () => process.cwd() }
  )
  return module.exports
}

function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function gate() { return { entered: deferred(), released: deferred() } }
const tick = () => new Promise(resolve => setTimeout(resolve, 0))

function fixture(platform = 'darwin') {
  const directory = fs.mkdtempSync(join(tmpdir(), 'enest-async-credentials-'))
  const first = join(directory, 'first'), second = join(directory, 'second')
  fs.mkdirSync(first); fs.mkdirSync(second)
  const state = { root: first, rootGeneration: 0, available: true, backend: 'gnome_libsecret',
    encryptCalls: 0, decryptCalls: 0, encryptGate: null, decryptGate: null,
    encryptFailure: false, rotate: false, prefix: 'v11:', user: null, events: [] }
  const safeStorage = {
    isAsyncEncryptionAvailable: async () => state.available,
    getSelectedStorageBackend: () => state.backend,
    encryptStringAsync: async text => {
      state.encryptCalls++
      const held = state.encryptGate
      if (held) { held.entered.resolve(); await held.released.promise }
      if (state.encryptFailure) throw new Error('Keyring unavailable')
      return Buffer.from(state.prefix + text)
    },
    decryptStringAsync: async buffer => {
      state.decryptCalls++
      const held = state.decryptGate
      if (held) { held.entered.resolve(); await held.released.promise }
      const value = buffer.toString()
      return { result: value.slice(value.indexOf(':') + 1), shouldReEncrypt: state.rotate || value.startsWith('legacy:') }
    }
  }
  const secure = load('vault/secureStorage.ts', { electron: { safeStorage } }, platform)
  const paths = { getAppPaths: () => ({ data: state.root }), getAppPathsGeneration: () => state.rootGeneration,
    defaultDataRoot: () => first }
  const adapters = { '@main/paths/pathsService': paths, './secureStorage': secure,
    '@main/vault/secureStorage': secure, '@main/logs/logService': { logInfo() {}, logWarn() {} } }
  const vault = load('vault/secretVault.ts', adapters, platform)
  const mcp = load('mcp/mcpCredentialStore.ts', adapters, platform)
  const callback = { result: deferred(), completed: deferred(), closed: false }
  const auth = load('auth/githubAuthService.ts', {
    ...adapters,
    electron: {
      shell: { openExternal: async () => {} },
      net: { fetch: async url => {
        if (url === 'https://publisher.example/exchange') return Response.json({ access_token: 'fixture-token' })
        if (url === 'https://api.github.com/user') return Response.json({ login: 'fixture', name: 'Fixture', avatar_url: null, html_url: null })
        throw new Error(`Unexpected URL: ${url}`)
      } }
    },
    './authConfig': { getGithubAuthConfig: () => ({ available: true, clientId: 'fixture', exchangeUrl: 'https://publisher.example/exchange' }) },
    './oauthLoopback': { listenOAuthLoopback: async () => ({ redirectUri: 'http://127.0.0.1:12345/callback', result: callback.result.promise,
      complete: success => callback.completed.resolve(success), close: () => { callback.closed = true } }) },
    '@main/settings/SettingsStore': { settingsStore: { getAll: () => ({ profile: { user: state.user } }), setProfileUser: user => { state.user = user } } },
    '@main/window/createShellWindow': { sendShellEvent: event => state.events.push(event), getMainWindow: () => null },
    '@main/window/orbRailViews': { setOrbProfile() {} }
  }, platform)
  const vaultFile = (id, key) => join(state.root, 'secrets', id, Buffer.from(key).toString('base64url') + '.bin')
  const writeLegacy = (id, key, value) => {
    const file = vaultFile(id, key)
    fs.mkdirSync(join(state.root, 'secrets', id), { recursive: true })
    fs.writeFileSync(file, Buffer.concat([Buffer.from([0]), Buffer.from('legacy:' + value)]))
    return `sv:${id}:${Buffer.from(key).toString('base64url')}`
  }
  return { state, first, second, secure, vault, mcp, auth, callback, vaultFile, writeLegacy,
    switchRoot(root) { if (state.root !== root) { state.root = root; state.rootGeneration++ } },
    close() { auth.cancelGithubLogin(); fs.rmSync(directory, { recursive: true, force: true }) } }
}

test('async secure storage rejects unavailable and Linux basic-text fallback without using deprecated APIs', async () => {
  const f = fixture('linux')
  try {
    f.state.available = false
    await assert.rejects(f.secure.encryptCredential('secret'), /unavailable/)
    assert.equal(f.state.encryptCalls, 0)
    f.state.available = true
    f.state.backend = 'basic_text'
    await assert.rejects(f.secure.encryptCredential('secret'), /unavailable/)
    f.state.backend = 'gnome_libsecret'
    f.state.prefix = 'v10:'
    await assert.rejects(f.secure.encryptCredential('secret'), /basic-text/)
    await assert.rejects(f.secure.decryptCredential(Buffer.from('v10:secret')), /basic-text/)
    assert.equal(f.state.decryptCalls, 0)
  } finally { f.close() }
})

test('legacy vault ciphertext is asynchronously decrypted and re-encrypted with its envelope retained', async () => {
  const f = fixture()
  try {
    const ref = f.writeLegacy('com.test.vault', 'token', 'old-secret')
    assert.equal(await f.vault.resolveSecret('com.test.vault', ref), 'old-secret')
    assert.deepEqual(fs.readFileSync(f.vaultFile('com.test.vault', 'token')), Buffer.concat([Buffer.from([0]), Buffer.from('v11:old-secret')]))
    const before = fs.readFileSync(f.vaultFile('com.test.vault', 'token'))
    f.state.rotate = true; f.state.encryptFailure = true
    await assert.rejects(f.vault.resolveSecret('com.test.vault', ref), /encryption failed/)
    assert.deepEqual(fs.readFileSync(f.vaultFile('com.test.vault', 'token')), before)
  } finally { f.close() }
})

test('vault remove, plugin clear, owner retirement and data-root ABA each cancel pending encryption', async () => {
  for (const cancel of ['remove', 'clear', 'owner', 'root']) {
    const f = fixture()
    try {
      let current = true
      const held = f.state.encryptGate = gate()
      const pending = f.vault.vaultSet('com.test.vault', 'token', 'secret', () => { if (!current) throw new Error('owner retired') })
      const rejected = assert.rejects(pending, /cancelled|retired/)
      await held.entered.promise
      if (cancel === 'remove') f.vault.vaultRemove('com.test.vault', 'token')
      if (cancel === 'clear') assert.equal(f.vault.vaultClearPlugin('com.test.vault'), 0)
      if (cancel === 'owner') current = false
      if (cancel === 'root') { f.switchRoot(f.second); f.switchRoot(f.first) }
      held.released.resolve()
      await rejected
      assert.equal(fs.existsSync(f.vaultFile('com.test.vault', 'token')), false)
    } finally { f.close() }
  }
})

test('vault key rotation cannot recreate a removed credential', async () => {
  const f = fixture()
  try {
    const ref = f.writeLegacy('com.test.vault', 'token', 'old-secret')
    const held = f.state.encryptGate = gate()
    const pending = f.vault.resolveSecret('com.test.vault', ref)
    const rejected = assert.rejects(pending, /cancelled/)
    await held.entered.promise
    f.vault.vaultRemove('com.test.vault', ref)
    held.released.resolve()
    await rejected
    assert.equal(fs.existsSync(f.vaultFile('com.test.vault', 'token')), false)
  } finally { f.close() }
})

test('vault writes remain FIFO and account for concurrent creation at the entry quota', async () => {
  const f = fixture()
  try {
    const held = f.state.encryptGate = gate()
    const first = f.vault.vaultSet('com.test.vault', 'token', 'first')
    await held.entered.promise
    const second = f.vault.vaultSet('com.test.vault', 'token', 'second')
    assert.equal(f.state.encryptCalls, 1)
    f.state.encryptGate = null; held.released.resolve()
    const [, { secretRef }] = await Promise.all([first, second])
    assert.equal(await f.vault.resolveSecret('com.test.vault', secretRef), 'second')
    for (let i = 0; i < 254; i++) f.writeLegacy('com.test.vault', `entry-${i}`, 'value')
    const created = f.vault.vaultSet('com.test.vault', 'last', 'value')
    const rejected = assert.rejects(f.vault.vaultSet('com.test.vault', 'over', 'value'), /entry quota/)
    await created; await rejected
    assert.equal(fs.readdirSync(join(f.first, 'secrets', 'com.test.vault')).length, 256)
  } finally { f.close() }
})

test('vault rejects oversized payloads before queueing and bounds pending operations per plugin and globally', async () => {
  const f = fixture()
  try {
    const held = f.state.encryptGate = gate()
    const pending = []
    for (let plugin = 0; plugin < 4; plugin++) {
      for (let index = 0; index < 16; index++) pending.push(f.vault.vaultSet(`com.test.limit${plugin}`, 'token', `secret-${index}`))
    }
    await held.entered.promise
    await assert.rejects(f.vault.vaultSet('com.test.limit0', 'token', 'x'.repeat(64 * 1024 + 1)), /64 KiB/)
    await assert.rejects(f.vault.vaultSet('com.test.limit0', 'token', 'extra'), /operation limit/)
    await assert.rejects(f.vault.vaultSet('com.test.extra', 'token', 'extra'), /operation limit/)
    f.state.encryptGate = null; held.released.resolve()
    await Promise.all(pending)
    await f.vault.vaultSet('com.test.extra', 'token', 'recovered')
  } finally { f.close() }
})

test('vault plugin queue allowance cannot be multiplied by changing data roots', async () => {
  const f = fixture()
  try {
    const held = f.state.encryptGate = gate()
    const pending = Array.from({ length: 16 }, () => f.vault.vaultSet('com.test.limit', 'token', 'secret'))
    const settled = Promise.allSettled(pending)
    await held.entered.promise
    f.switchRoot(f.second)
    await assert.rejects(f.vault.vaultSet('com.test.limit', 'token', 'extra'), /operation limit/)
    f.state.encryptGate = null; held.released.resolve()
    assert.ok((await settled).every(result => result.status === 'rejected'))
    await f.vault.vaultSet('com.test.limit', 'token', 'recovered')
  } finally { f.close() }
})

test('MCP concurrent initialization shares one token and re-encrypts old ciphertext without rotating the token', async () => {
  const f = fixture()
  try {
    const [first, second] = await Promise.all([f.mcp.readOrCreateMcpToken(), f.mcp.readOrCreateMcpToken()])
    assert.equal(first, second)
    assert.equal(f.state.encryptCalls, 1)
    const file = join(f.first, 'host-mcp', 'token.bin')
    fs.writeFileSync(file, 'legacy:' + first)
    assert.equal(await f.mcp.readOrCreateMcpToken(), first)
    assert.equal(fs.readFileSync(file, 'utf8'), 'v11:' + first)
    const saved = fs.readFileSync(file)
    f.state.encryptFailure = true
    await assert.rejects(f.mcp.replaceMcpToken(), /不会降级为明文/)
    assert.deepEqual(fs.readFileSync(file), saved)
  } finally { f.close() }
})

test('MCP shutdown invalidation prevents pending creation and rotation writes', async () => {
  for (const existing of [false, true]) {
    const f = fixture()
    try {
      const oldToken = existing ? await f.mcp.readOrCreateMcpToken() : null
      const held = f.state.encryptGate = gate()
      const pending = f.mcp.replaceMcpToken()
      const rejected = assert.rejects(pending, /已取消/)
      await held.entered.promise
      f.mcp.invalidateMcpTokenOperations()
      held.released.resolve()
      await rejected
      const file = join(f.first, 'host-mcp', 'token.bin')
      if (existing) assert.equal(fs.readFileSync(file, 'utf8'), 'v11:' + oldToken)
      else assert.equal(fs.existsSync(file), false)
    } finally { f.close() }
  }
})

test('MCP token queue is bounded while the keyring is blocked and releases cancelled slots', async () => {
  const f = fixture()
  try {
    const held = f.state.encryptGate = gate()
    const pending = Array.from({ length: 8 }, () => f.mcp.replaceMcpToken())
    const settled = Promise.allSettled(pending)
    await held.entered.promise
    await assert.rejects(f.mcp.replaceMcpToken(), /繁忙/)
    f.mcp.invalidateMcpTokenOperations()
    f.state.encryptGate = null; held.released.resolve()
    assert.ok((await settled).every(result => result.status === 'rejected'))
    assert.match(await f.mcp.readOrCreateMcpToken(), /^[A-Za-z0-9_-]{43}$/)
  } finally { f.close() }
})

test('GitHub cancellation, logout and data-root ABA during encryption cannot publish a login', async () => {
  for (const cancel of ['cancel', 'logout', 'root']) {
    const f = fixture()
    try {
      const held = f.state.encryptGate = gate()
      await f.auth.startGithubLogin()
      f.callback.result.resolve({ code: 'fixture-code' })
      await held.entered.promise
      if (cancel === 'cancel') f.auth.cancelGithubLogin()
      if (cancel === 'logout') f.auth.logoutGithub()
      if (cancel === 'root') { f.switchRoot(f.second); f.switchRoot(f.first) }
      held.released.resolve()
      await tick()
      assert.equal(fs.existsSync(join(f.first, 'github.token')), false)
      assert.equal(f.state.user, null)
      assert.equal(f.state.events.some(event => event.phase === 'authorized'), false)
    } finally { f.close() }
  }
})

test('GitHub logout during legacy-token re-encryption cannot resurrect disk or cached credentials', async () => {
  const f = fixture()
  try {
    fs.writeFileSync(join(f.first, 'github.token'), 'legacy:old-token')
    const held = f.state.encryptGate = gate()
    const refreshing = f.auth.refreshProfileOnBoot()
    await held.entered.promise
    f.auth.logoutGithub()
    held.released.resolve()
    await refreshing
    assert.equal(fs.existsSync(join(f.first, 'github.token')), false)
    assert.equal(await f.auth.hasGithubToken(), false)
    assert.equal(f.state.user, null)
  } finally { f.close() }
})

test('GitHub rejects stale decrypt results and retries a temporarily unavailable keyring', async () => {
  const f = fixture()
  try {
    fs.writeFileSync(join(f.first, 'github.token'), 'v11:old-token')
    f.state.available = false
    assert.equal(await f.auth.hasGithubToken(), false)
    f.state.available = true
    const held = f.state.decryptGate = gate()
    const reading = f.auth.hasGithubToken()
    await held.entered.promise
    f.switchRoot(f.second); f.switchRoot(f.first)
    f.state.decryptGate = null; held.released.resolve()
    assert.equal(await reading, false)
    assert.equal(await f.auth.hasGithubToken(), true)
  } finally { f.close() }
})

test('data-root generation changes for effective A -> B -> A switches, not an identical root', () => {
  const paths = load('paths/pathsService.ts', {
    './userPath': { resolveLocalUserPath: input => resolve(input) },
    '@shared/constants': { DATA_DIR_NAME: '.eNest', DATA_SUBDIR: 'data', DATABASE_FILE: 'enest.db', PLUGINS_DIR: 'plugins', SETTINGS_FILE: 'settings.json', THEMES_DIR: 'themes' }
  })
  const root = paths.getAppPathsRoot(), initial = paths.getAppPathsGeneration()
  paths.setAppPathsRoot(root)
  assert.equal(paths.getAppPathsGeneration(), initial)
  paths.setAppPathsRoot(join(root, 'alternate'))
  paths.setAppPathsRoot(root)
  assert.equal(paths.getAppPathsGeneration(), initial + 2)
})
