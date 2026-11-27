import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'
import ts from 'typescript'

const require = createRequire(import.meta.url)
const worker = new Function('require', 'process', readFileSync(new URL('../../../src/native/account-storage/account-storage.cjs', import.meta.url), 'utf8'))
const source = readFileSync(new URL('../../../src/main/vault/githubAccountStorage.ts', import.meta.url), 'utf8')
const adapter = new Function('require', 'module', 'exports', 'process', ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText)

function fixture(platform) {
  const state = { forks: 0, dpapi: 0, locked: false }, key = randomBytes(32)
  const utilityProcess = { fork() {
    state.forks++
    const child = new EventEmitter(), parentPort = new EventEmitter()
    child.pid = 1; child.kill = () => { child.pid = undefined }
    parentPort.postMessage = value => { const copied = structuredClone(value); queueMicrotask(() => child.emit('message', copied)) }
    child.postMessage = value => parentPort.emit('message', { data: structuredClone(value) })
    worker(name => name === './account-storage.node' ? () => { if (state.locked) throw new Error(); return Buffer.from(key) } : require(name), { parentPort })
    queueMicrotask(() => child.emit('spawn'))
    return child
  } }
  const modules = { electron: { app: { isPackaged: false, getAppPath: () => '/fixture' }, utilityProcess },
    './secureStorage': { encryptCredential: async () => { state.dpapi++; return Buffer.from('v10windows') }, decryptCredential: async () => { state.dpapi++; return { result: 'windows', shouldReEncrypt: true } } } }
  const module = { exports: {} }
  adapter(name => modules[name] ?? require(name), module, module.exports, { platform })
  return { ...module.exports, state }
}

for (const platform of ['darwin', 'linux']) test(`${platform}: authenticated envelopes, denial and legacy reads never initialize Electron Safe Storage`, async () => {
  const store = fixture(platform), token = 'synthetic-sensitive-access'
  const first = await store.sealGithubCredential(token), second = await store.sealGithubCredential(token)
  assert.notDeepEqual(first, second); assert.equal(first.includes(token), false)
  assert.deepEqual(await store.openGithubCredential(first), { result: token, shouldReEncrypt: false })
  first[first.length - 1] ^= 1; await assert.rejects(store.openGithubCredential(first))
  const calls = store.state.forks, old = Buffer.from('v10legacy')
  assert.equal(store.isLegacyGithubCiphertext(old), true); await assert.rejects(store.openGithubCredential(old)); assert.equal(store.state.forks, calls)
  store.state.locked = true; await assert.rejects(store.sealGithubCredential(token)); await assert.rejects(store.openGithubCredential(second))
  assert.equal(store.state.dpapi, 0)
})

test('Windows retains its existing OS protected ciphertext and does not launch a Unix worker', async () => {
  const store = fixture('win32'), old = await store.sealGithubCredential('fixture')
  assert.equal(store.isLegacyGithubCiphertext(old), false)
  assert.deepEqual(await store.openGithubCredential(old), { result: 'windows', shouldReEncrypt: true })
  assert.equal(store.state.dpapi, 2); assert.equal(store.state.forks, 0)
})
