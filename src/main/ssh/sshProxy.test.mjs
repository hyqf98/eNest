import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { once } from 'node:events'
import ts from 'typescript'
import { startTestProxy } from './sshProxyTestUtils.mjs'

const require = createRequire(import.meta.url), module = { exports: {} }
new Function('require', 'module', 'exports', ts.transpileModule(readFileSync(new URL('./sshProxy.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText)(require, module, module.exports)
const { openSshProxy } = module.exports

for (const type of ['http-connect', 'socks5']) for (const authenticated of [false, true]) {
  test(`${type}: fragmented handshake and coalesced SSH banner (${authenticated ? 'vault-style password' : 'no auth'})`, async t => {
    const username = authenticated ? '代理用户' : '', password = authenticated ? 'secret:✓' : ''
    const proxy = await startTestProxy(type, { username, password }); t.after(() => proxy.close())
    const socket = await openSshProxy({ type, host: '127.0.0.1', port: proxy.port, username }, { host: 'db.internal', port: 2222 }, password || null, { signal: new AbortController().signal, timeoutMs: 1000, ownSocket: socket => t.after(() => socket.destroy()) })
    const data = once(socket, 'data'); socket.resume()
    assert.equal((await data)[0].toString(), 'SSH-2.0-fixture\r\n')
    assert.deepEqual(proxy.targets, ['db.internal:2222'])
    if (authenticated) assert.equal(proxy.credentials[0], username + ':' + password)
  })
}

for (const type of ['http-connect', 'socks5']) test(`${type}: rejects authentication failure without exposing response secrets`, async t => {
  const proxy = await startTestProxy(type, { username: 'alice', password: 'pw', rejectAuth: true }); t.after(() => proxy.close())
  await assert.rejects(openSshProxy({ type, host: '127.0.0.1', port: proxy.port, username: 'alice' }, { host: 'internal', port: 22 }, 'pw', { signal: new AbortController().signal, timeoutMs: 1000, ownSocket() {} }), error => /认证失败/.test(error.message) && !/Secret from proxy|body|alice|pw/.test(error.message))
})

test('proxy IPv6 target encoding and HTTP authority preserve every address bit', async t => {
  for (const type of ['http-connect', 'socks5']) {
    const proxy = await startTestProxy(type); t.after(() => proxy.close())
    const socket = await openSshProxy({ type, host: '127.0.0.1', port: proxy.port }, { host: '::ffff:192.0.2.12', port: 22 }, null, { signal: new AbortController().signal, timeoutMs: 1000, ownSocket() {} })
    socket.destroy()
    assert.equal(proxy.targets[0], type === 'http-connect' ? '[::ffff:192.0.2.12]:22' : '00000000000000000000ffffc000020c:22')
  }
  assert.throws(() => openSshProxy({ type: 'socks5', host: '127.0.0.1', port: 1080 }, { host: 'fe80::1%eth0', port: 22 }, null, { signal: new AbortController().signal, timeoutMs: 100, ownSocket() {} }), /接口区域/)
})

test('abort and timeout destroy the reserved transport before rejecting', async t => {
  const peers = new Set(), server = createServer(socket => { peers.add(socket); socket.on('close', () => peers.delete(socket)) })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(async () => { for (const socket of peers) socket.destroy(); await new Promise(resolve => server.close(resolve)) })
  for (const mode of ['abort', 'timeout']) {
    const controller = new AbortController(); let owned
    const pending = openSshProxy({ type: 'socks5', host: '127.0.0.1', port: server.address().port }, { host: 'internal', port: 22 }, null, { signal: controller.signal, timeoutMs: 100, ownSocket: socket => { owned = socket } })
    if (mode === 'abort') controller.abort()
    await assert.rejects(pending, mode === 'abort' ? /closing/ : /超时/)
    assert.equal(owned.destroyed, true)
  }
})

test('unbounded HTTP headers, SOCKS downgrade and invalid frames are rejected', async t => {
  for (const [type, response, expected] of [['http-connect', Buffer.alloc(32769, 65), /过长/], ['socks5', Buffer.from([5, 0]), /认证方式/], ['socks5', Buffer.from([5, 2, 1, 0, 5, 0, 1, 1]), /格式无效/]]) {
    const peers = new Set(), server = createServer(socket => { peers.add(socket); socket.on('error', () => {}); socket.once('data', () => socket.write(response)) })
    server.listen(0, '127.0.0.1'); await once(server, 'listening')
    t.after(async () => { for (const socket of peers) socket.destroy(); await new Promise(resolve => server.close(resolve)) })
    await assert.rejects(openSshProxy({ type, host: '127.0.0.1', port: server.address().port, username: 'u' }, { host: 'internal', port: 22 }, 'p', { signal: new AbortController().signal, timeoutMs: 1000, ownSocket() {} }), expected)
  }
})
