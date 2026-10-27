import assert from 'node:assert/strict'
import test from 'node:test'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'
import ts from 'typescript'

const require = createRequire(import.meta.url)
const javascript = ts.transpileModule(fs.readFileSync(new URL('../../../src/main/vault/secretVault.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText

function fixture(platform = 'darwin') {
  const directory = fs.mkdtempSync(join(tmpdir(), 'enest-vault-boundary-'))
  const key = randomBytes(32)
  const state = { available: true, backend: 'gnome_libsecret', encryptCalls: 0, decryptCalls: 0, failEncrypt: false, failRename: false, logs: [] }
  const adapters = {
    electron: { safeStorage: {
      isEncryptionAvailable: () => state.available,
      getSelectedStorageBackend: () => state.backend,
      encryptString: plain => {
        state.encryptCalls++
        if (state.failEncrypt) throw new Error('test encryption failed')
        const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv)
        const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
        return Buffer.concat([iv, cipher.getAuthTag(), encrypted])
      },
      decryptString: encrypted => {
        state.decryptCalls++
        const decipher = createDecipheriv('aes-256-gcm', key, encrypted.subarray(0, 12))
        decipher.setAuthTag(encrypted.subarray(12, 28))
        return Buffer.concat([decipher.update(encrypted.subarray(28)), decipher.final()]).toString('utf8')
      }
    } },
    'node:fs': { ...fs, renameSync: (...args) => {
      if (state.failRename) throw new Error('test rename failed')
      return fs.renameSync(...args)
    } },
    '@main/paths/pathsService': { getAppPaths: () => ({ data: directory }) },
    '@main/logs/logService': { logWarn: (_area, message) => state.logs.push(message) }
  }
  const module = { exports: {} }
  new Function('require', 'module', 'exports', 'process', javascript)(name => adapters[name] ?? require(name), module, module.exports, { platform })
  const path = (id, name) => join(directory, 'secrets', id, Buffer.from(name).toString('base64url') + '.bin')
  return { api: module.exports, state, directory, path, close: () => fs.rmSync(directory, { recursive: true, force: true }) }
}

test('secrets use secure encryption and remain isolated between plugin namespaces', () => {
  const f = fixture()
  try {
    const a = f.api.vaultSet('com.test.a', 'account', 'private-a').secretRef
    const b = f.api.vaultSet('com.test.b', 'account', 'private-b').secretRef
    assert.equal(f.api.resolveSecret('com.test.a', a), 'private-a')
    assert.equal(f.api.resolveSecret('com.test.b', b), 'private-b')
    assert.equal(fs.readFileSync(f.path('com.test.a', 'account'))[0], 0)
    assert.equal(fs.readFileSync(f.path('com.test.a', 'account')).includes(Buffer.from('private-a')), false)
    const calls = f.state.decryptCalls
    assert.throws(() => f.api.resolveSecret('com.test.a', b), /does not belong/)
    assert.equal(f.state.decryptCalls, calls)
    assert.equal(f.api.vaultHas('com.test.a', b), false)
    assert.throws(() => f.api.vaultRemove('com.test.a', b), /another plugin/)
    assert.equal(f.api.resolveSecret('com.test.b', b), 'private-b')
    f.api.vaultRemove('com.test.a', a)
    assert.equal(f.api.resolveSecret('com.test.a', a), null)
    assert.equal(f.api.vaultHas('com.test.b', b), true)
  } finally { f.close() }
})

test('vaultClearPlugin removes the whole plugin namespace without touching other plugins', () => {
  const f = fixture()
  try {
    f.api.vaultSet('com.test.a', 'account', 'private-a')
    f.api.vaultSet('com.test.a', 'token', 'private-a2')
    const b = f.api.vaultSet('com.test.b', 'account', 'private-b').secretRef
    assert.equal(f.api.vaultClearPlugin('com.test.a'), 2)
    assert.equal(fs.existsSync(join(f.directory, 'secrets', 'com.test.a')), false)
    assert.equal(f.api.vaultHas('com.test.a', 'account'), false)
    assert.equal(f.api.resolveSecret('com.test.a', 'account'), null)
    assert.equal(f.api.resolveSecret('com.test.b', b), 'private-b')
    // 幂等：目录已不存在时返回 0
    assert.equal(f.api.vaultClearPlugin('com.test.a'), 0)
    // 路径敏感字符的插件 ID 走同一 sanitize 目录，按目录整删不越界
    f.api.vaultSet('com.test/a', 'k', 'v')
    assert.equal(f.api.vaultClearPlugin('com.test/a'), 1)
    assert.equal(fs.existsSync(join(f.directory, 'secrets', 'com.test_a')), false)
    assert.equal(fs.existsSync(join(f.directory, 'secrets', 'com.test.b')), true)
  } finally { f.close() }
})

test('unavailable or weak storage never writes fallback ciphertext and preserves existing credentials', () => {
  for (const platform of ['darwin', 'win32', 'linux']) {
    const f = fixture(platform)
    try {
      const ref = f.api.vaultSet('com.test.secure', 'account', 'original').secretRef
      const before = fs.readFileSync(f.path('com.test.secure', 'account'))
      f.state.available = false
      assert.throws(() => f.api.vaultSet('com.test.secure', 'account', 'replacement'), /secure credential storage unavailable/)
      assert.throws(() => f.api.resolveSecret('com.test.secure', ref), /secure credential storage unavailable/)
      assert.deepEqual(fs.readFileSync(f.path('com.test.secure', 'account')), before)
      f.state.available = true
      if (platform === 'linux') {
        for (const backend of ['basic_text', 'unknown']) {
          f.state.backend = backend
          assert.throws(() => f.api.vaultSet('com.test.secure', 'account', 'replacement'), /secure credential storage unavailable/)
          assert.throws(() => f.api.resolveSecret('com.test.secure', ref), /secure credential storage unavailable/)
          assert.deepEqual(fs.readFileSync(f.path('com.test.secure', 'account')), before)
        }
        f.state.backend = 'kwallet6'
      }
      f.state.failEncrypt = true
      assert.throws(() => f.api.vaultSet('com.test.secure', 'account', 'replacement'), /encryption failed/)
      assert.deepEqual(fs.readFileSync(f.path('com.test.secure', 'account')), before)
      f.state.failEncrypt = false
      f.state.failRename = true
      assert.throws(() => f.api.vaultSet('com.test.secure', 'account', 'replacement'), /rename failed/)
      assert.deepEqual(fs.readFileSync(f.path('com.test.secure', 'account')), before)
      assert.equal(fs.readdirSync(join(f.directory, 'secrets', 'com.test.secure')).length, 1)
      f.state.failRename = false
      assert.equal(f.api.resolveSecret('com.test.secure', ref), 'original')
    } finally { f.close() }
  }
})

test('legacy XOR, unknown tags and damaged blobs require re-entry without changing their bytes', () => {
  const f = fixture()
  try {
    const ref = f.api.vaultSet('com.test.legacy', 'account', 'secret').secretRef
    const path = f.path('com.test.legacy', 'account')
    for (const blob of [Buffer.alloc(0), Buffer.from([0]), Buffer.from([1, 20, 30]), Buffer.from([2, 20, 30]), Buffer.from([0, 20, 30])]) {
      fs.writeFileSync(path, blob)
      assert.throws(() => f.api.resolveSecret('com.test.legacy', ref), /re-entry|re-enter credentials/)
      assert.deepEqual(fs.readFileSync(path), blob)
      assert.equal(f.api.vaultHas('com.test.legacy', ref), true)
    }
    f.api.vaultSet('com.test.legacy', 'account', 'newly-entered')
    assert.equal(f.api.resolveSecret('com.test.legacy', ref), 'newly-entered')
  } finally { f.close() }
})

test('vault quotas count UTF-8 bytes and reject oversized writes without overwriting a secret', () => {
  const f = fixture()
  try {
    const id = 'com.test.vault-size'
    const key = '界'.repeat(42)
    const ref = f.api.vaultSet(id, key, '😀'.repeat(16384)).secretRef
    assert.equal(f.api.resolveSecret(id, ref), '😀'.repeat(16384))
    const before = fs.readFileSync(f.path(id, key))
    assert.throws(() => f.api.vaultSet(id, '界'.repeat(43), 'a'), /128 UTF-8 bytes/)
    assert.throws(() => f.api.vaultSet(id, key, '😀'.repeat(16385)), /64 KiB/)
    assert.deepEqual(fs.readFileSync(f.path(id, key)), before)
    assert.equal(fs.readdirSync(join(f.directory, 'secrets', id)).length, 1)
  } finally { f.close() }
})

test('entry and ciphertext quotas reject growth but permit reducing or deleting existing over-quota data', () => {
  const f = fixture()
  try {
    const countId = 'com.test.vault-count'
    f.api.vaultSet(countId, 'entry-0', 'original')
    for (let i = 1; i < 256; i++) fs.writeFileSync(f.path(countId, 'entry-' + i), Buffer.from([1, 20]))
    assert.throws(() => f.api.vaultSet(countId, 'new', 'value'), /entry quota exceeded/)
    f.api.vaultSet(countId, 'entry-0', 'replaced')
    fs.writeFileSync(f.path(countId, 'legacy-over-limit'), Buffer.from([1, 20]))
    f.api.vaultSet(countId, 'entry-0', 'small')
    f.api.vaultRemove(countId, 'legacy-over-limit')
    f.api.vaultRemove(countId, 'entry-1')
    f.api.vaultSet(countId, 'new', 'value')
    assert.equal(fs.readdirSync(join(f.directory, 'secrets', countId)).length, 256)

    const bytesId = 'com.test.vault-bytes'
    const ref = f.api.vaultSet(bytesId, 'account', 'a long original secret').secretRef
    fs.writeFileSync(f.path(bytesId, 'legacy-large'), Buffer.from([1, 20]))
    fs.truncateSync(f.path(bytesId, 'legacy-large'), 8 * 1024 * 1024)
    const before = fs.readFileSync(f.path(bytesId, 'account'))
    assert.throws(() => f.api.vaultSet(bytesId, 'new', 'value'), /ciphertext quota exceeded/)
    assert.throws(() => f.api.vaultSet(bytesId, 'account', 'much longer replacement secret than the original'), /ciphertext quota exceeded/)
    assert.deepEqual(fs.readFileSync(f.path(bytesId, 'account')), before)
    f.api.vaultSet(bytesId, 'account', 'short')
    assert.equal(f.api.resolveSecret(bytesId, ref), 'short')
    f.api.vaultRemove(bytesId, 'legacy-large')
    f.api.vaultSet(bytesId, 'new', 'works')

    const legacyKey = '界'.repeat(45)
    fs.writeFileSync(f.path(bytesId, legacyKey), Buffer.alloc(96 * 1024))
    const largeRef = f.api.vaultSet(bytesId, legacyKey, 'a'.repeat(80 * 1024)).secretRef
    assert.equal(f.api.resolveSecret(bytesId, largeRef).length, 80 * 1024)
    assert.throws(() => f.api.vaultSet(bytesId, legacyKey, 'a'.repeat(85 * 1024)), /64 KiB/)
    f.api.vaultSet(bytesId, legacyKey, 'replaced within quota')
    assert.equal(f.api.resolveSecret(bytesId, largeRef), 'replaced within quota')
  } finally { f.close() }
})
