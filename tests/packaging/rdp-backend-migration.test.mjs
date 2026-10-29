import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Duplex } from 'node:stream'
import * as net from 'node:net'
import * as tls from 'node:tls'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import ts from 'typescript'
import { createSshHost } from '../../eNest_plugin/packages/ssh-backend/client.js'

const require = createRequire(import.meta.url)
const root = fileURLToPath(new URL('../../', import.meta.url))
const backend = 'eNest_plugin/plugins/remote-desktop/backend/'
const read = path => readFileSync(resolve(root, path), 'utf8')
const compiled = new Map()
function loader(adapters = {}, globals = {}) {
  const cache = new Map()
  const load = path => {
    path = resolve(root, path)
    if (cache.has(path)) return cache.get(path).exports
    if (!compiled.has(path)) compiled.set(path, ts.transpileModule(readFileSync(path, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText)
    const module = { exports: {} }; cache.set(path, module)
    new Function('require', 'module', 'exports', ...Object.keys(globals), compiled.get(path))(name => {
      if (Object.hasOwn(adapters, name)) return adapters[name]
      if (name.startsWith('node:')) return require(name)
      if (name.startsWith('.')) return load(resolve(dirname(path), name + '.ts'))
      throw Error(`Unexpected dependency ${name}`)
    }, module, module.exports, ...Object.values(globals))
    return module.exports
  }
  return load
}
const settle = async () => { for (let i = 0; i < 15; i++) await Promise.resolve() }
async function until(predicate, timeout = 1500) {
  const end = Date.now() + timeout
  while (!predicate()) {
    if (Date.now() > end) throw Error('Fixture condition timed out')
    await new Promise(resolve => setTimeout(resolve, 2))
  }
}
const REQUEST = Buffer.from([3, 0, 0, 19, 14, 0xe0, 0, 0, 0, 0, 0, 1, 0, 8, 0, 3, 0, 0, 0])
const CONFIRM = Buffer.from([3, 0, 0, 19, 14, 0xd0, 0, 0, 0, 0, 0, 2, 0, 8, 0, 2, 0, 0, 0])
const wrap = (tag, payload) => Buffer.concat([Buffer.from([tag, payload.length]), payload])
const request = () => wrap(0x30, Buffer.concat([wrap(0xa0, wrap(2, Buffer.from([0x0d, 0x3e]))), wrap(0xa2, wrap(0x0c, Buffer.from('ignored.example:9999'))), wrap(0xa6, wrap(4, REQUEST))]))
const mask = (payload, opcode = 2, fin = true) => {
  const key = Buffer.from([1, 2, 3, 4])
  const header = payload.length < 126 ? Buffer.from([(fin ? 128 : 0) | opcode, 128 | payload.length]) : Buffer.from([(fin ? 128 : 0) | opcode, 254, payload.length >> 8, payload.length & 255])
  return Buffer.concat([header, key, Buffer.from(payload.map((value, index) => value ^ key[index % 4]))])
}

function fixture(t, { origin = 'enest://plugin', approve = true, hostRequest, proxy = 'DIRECT', socketError = false } = {}) {
  const requests = [], rawSockets = [], tlsSockets = [], proxyCalls = [], releases = []
  const controller = new AbortController(), disposers = new Set()
  const scope = { signal: controller.signal, isCurrent: () => !controller.signal.aborted, addDisposer(fn) { disposers.add(fn); return () => disposers.delete(fn) } }
  class Raw extends Duplex {
    constructor() { super(); this.writes = []; this.remoteAddress = '192.0.2.10'; rawSockets.push(this) }
    _read() {}
    _write(bytes, _, callback) {
      this.writes.push(Buffer.from(bytes)); callback()
      queueMicrotask(() => { if (!this.destroyed) { this.push(CONFIRM.subarray(0, 2)); this.push(CONFIRM.subarray(2, 7)); this.push(CONFIRM.subarray(7)) } })
    }
    connect(port, host) { this.target = { host, port }; queueMicrotask(() => socketError ? this.destroy(Error('ECONNREFUSED fixture')) : this.emit('connect')); return this }
  }
  class Secure extends Duplex {
    constructor(options) { super(); this.options = options; this.writes = []; tlsSockets.push(this); queueMicrotask(() => this.emit('secureConnect')) }
    _read() {}
    _write(bytes, _, callback) { this.writes.push(Buffer.from(bytes)); callback() }
    getPeerCertificate() { return { raw: Buffer.from('fixture-not-a-real-cert'), fingerprint256: 'AA:BB:CC' } }
  }
  const load = loader({ 'node:net': { ...net, Socket: Raw }, 'node:tls': { connect: options => new Secure(options) }, './socketProxy': {
    async openSocketProxy(config, destination, password, options) {
      proxyCalls.push({ config, host: destination.host, port: destination.port, password })
      const socket = new Raw(); options.ownSocket(socket); return socket
    }
  } })
  const hostCall = async (method, params) => {
    requests.push({ method, params })
    if (['endpoint.revoke', 'activity.release'].includes(method)) releases.push({ method, params })
    if (hostRequest) { const result = hostRequest(method, params); if (result !== undefined) return result }
    if (method === 'network.resolveProxy') return { proxy }
    if (method === 'dialog.confirm') return typeof approve === 'function' ? approve() : approve
  }
  const { RdpBridgeService, readX224Record, parseProxyRoute } = load(backend + 'rdpBridge.ts')
  const service = new RdpBridgeService({ pluginId: 'com.github.eNest.remote-desktop', scope, pageOrigin: origin, hostCall })
  t.after(async () => { service.dispose(); for (const socket of [...rawSockets, ...tlsSockets]) socket.destroy(); await service.drain() })
  const abort = () => { controller.abort(); for (const dispose of [...disposers]) dispose() }
  return { service, requests, releases, rawSockets, tlsSockets, proxyCalls, parseProxyRoute, readX224Record, abort, load }
}

async function client(t, wsUrl, options = {}) {
  const url = new URL(wsUrl), socket = net.createConnection({ host: '127.0.0.1', port: Number(url.port) })
  t.after(() => socket.destroy())
  socket.on('error', () => {})
  let closed = false, upgraded = false, buffer = Buffer.alloc(0), responseHeader = ''
  const frames = []
  const { decodeWsFrame } = loader()(backend + 'wsFrames.ts')
  socket.on('close', () => { closed = true })
  socket.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk])
    if (!upgraded) {
      const end = buffer.indexOf('\r\n\r\n')
      if (end < 0) return
      assert.match(buffer.subarray(0, end).toString(), /^HTTP\/1.1 101/)
      responseHeader = buffer.subarray(0, end).toString()
      upgraded = true; buffer = buffer.subarray(end + 4)
    }
    while (buffer.length) {
      const result = decodeWsFrame(buffer)
      if (!result) return
      frames.push(result.frame); buffer = buffer.subarray(result.offset)
    }
  })
  const header = [
    `GET ${url.pathname}?token=${options.token ?? url.searchParams.get('token')} HTTP/1.1`,
    `Host: ${options.host ?? url.host}`, `Origin: ${options.origin ?? 'enest://plugin'}`,
    'Connection: Upgrade', 'Upgrade: websocket', 'Sec-WebSocket-Version: 13',
    `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}`, options.extra ?? '', '\r\n'
  ].filter((line, index, rows) => line || index === rows.length - 1).join('\r\n')
  socket.once('connect', () => socket.write(header))
  await until(() => upgraded || closed)
  return { socket, frames, get responseHeader() { return responseHeader }, get upgraded() { return upgraded }, get closed() { return closed }, send(bytes) { socket.write(mask(bytes)) } }
}

test('host socketBridge is protocol agnostic; Remote alone composes RDP and shared SSH runtime', () => {
  assert.doesNotMatch(read('src/main/net/socketBridge.ts'), /rdp|CleanPath|X\.224|confirmPluginOperation|rejectUnauthorized:\s*false/i)
  assert.match(read(backend + 'index.ts'), /startSshWorker\(context/)
  assert.match(read(backend + 'index.ts'), /'rdp\.open'/)
  for (const path of ['src/runtime.ts', 'src/worker.ts']) assert.doesNotMatch(read('eNest_plugin/packages/ssh-backend/' + path), /remote-desktop|rdpBridge|RDCleanPath/)
  const manifest = JSON.parse(read('eNest_plugin/plugins/remote-desktop/plugin.json'))
  assert.equal(manifest.version, '0.0.1'); assert.equal(manifest.engines.enest, '>=0.2.2'); assert.ok(manifest.permissions.includes('backend.node'))
})

test('generic host socket bridge accepts Chromium compression offer and transparently echoes application bytes', async t => {
  const sockets = new Set(), received = [], endpointReleases = [], activity = [], disposers = new Set()
  const server = net.createServer(socket => { sockets.add(socket); socket.on('error', () => {}); socket.on('data', bytes => { received.push(Buffer.from(bytes)); socket.write(bytes) }) })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => { for (const socket of sockets) socket.destroy(); server.close() })
  const controller = new AbortController()
  const scope = { owner: { generation: 1 }, signal: controller.signal, isCurrent: () => !controller.signal.aborted, acquireActivity() { activity.push('acquire'); return () => activity.push('release') }, addDisposer(fn) { disposers.add(fn); return () => disposers.delete(fn) } }
  const bridge = loader({
    '@main/net/hostProxy': { async openHostProxy() { return null } },
    '@main/plugin/pluginSessionPolicy': { allowPluginEndpoint(_owner, url, kind) { assert.equal(kind, 'webSocket'); return () => endpointReleases.push(url) } },
    '@main/plugin/PluginRegistry': { pluginRegistry: { get() { return undefined } } },
    '@main/plugin/PluginHost': { pluginHost: { isOpened: () => true, sendEvent() {} } },
    '@main/plugin/PluginRuntimeScope': { getRuntimeScope: () => scope },
    '@main/net/wsFrames': loader()('src/main/net/wsFrames.ts')
  })('src/main/net/socketBridge.ts')
  t.after(() => bridge.releaseSockets('fixture'))
  const { socketId } = await bridge.socketConnect('fixture', { host: '127.0.0.1', port: server.address().port })
  const endpoint = await bridge.socketServeWs('fixture', socketId)
  const c = await client(t, endpoint.url, { extra: 'Sec-WebSocket-Extensions: permessage-deflate; client_max_window_bits' })
  assert.equal(c.upgraded, true); assert.doesNotMatch(c.responseHeader, /sec-websocket-extensions/i)
  c.send(request())
  await until(() => c.frames.length)
  assert.deepEqual(received, [request()]); assert.deepEqual(c.frames[0].payload, request())
  bridge.releaseSockets('fixture')
  assert.deepEqual(activity, ['acquire', 'release']); assert.equal(endpointReleases.length, 1)
})

test('loopback WS endpoint uses backend PID plus generic owner leases, never opens target until authenticated', async t => {
  const f = fixture(t), result = await f.service.open({ host: 'rdp.invalid', port: 3389 })
  assert.equal(f.rawSockets.length, 0)
  assert.deepEqual(f.requests.map(value => value.method), ['activity.acquire', 'endpoint.allow'])
  const grant = f.requests[1].params
  assert.equal(grant.pid, process.pid); assert.equal(grant.kind, 'webSocket'); assert.equal(grant.token, result.bridgeId)
  assert.match(grant.url, /^ws:\/\/127\.0\.0\.1:\d+\/rdp$/)
  f.service.close(result.bridgeId); f.service.close(result.bridgeId); await f.service.drain()
  assert.deepEqual(f.releases.map(value => value.method).sort(), ['activity.release', 'endpoint.revoke'])
})

test('invalid target/origin and the eight-bridge quota are rejected before opening extra resources', async t => {
  const bad = fixture(t, { origin: null })
  await assert.rejects(bad.service.open({ host: 'rdp.invalid', port: 3389 }), /origin/)
  assert.equal(bad.requests.length, 0)
  const f = fixture(t)
  for (const input of [{ host: 'x/path', port: 3389 }, { host: 'x\r\ny', port: 3389 }, { host: 'x', port: 0 }, { host: 'x', port: '3389' }]) await assert.rejects(f.service.open(input), /invalid/)
  for (let i = 0; i < 8; i++) await f.service.open({ host: 'rdp.invalid', port: 3389 })
  await assert.rejects(f.service.open({ host: 'rdp.invalid', port: 3389 }), /limit/)
  f.abort(); await f.service.drain()
  assert.equal(f.releases.filter(value => value.method === 'endpoint.revoke').length, 8)
  await assert.rejects(f.service.open({ host: 'rdp.invalid', port: 3389 }), /closing/)
})

test('WS rejects foreign Origin, host, duplicate headers and token, but declines browser compression offers with a valid 101', async t => {
  const f = fixture(t), result = await f.service.open({ host: 'rdp.invalid', port: 3389 })
  for (const options of [{ origin: 'https://attacker.invalid' }, { host: 'localhost:' + new URL(result.wsUrl).port }, { token: '0'.repeat(64) }, { extra: 'Origin: enest://plugin' }]) {
    const c = await client(t, result.wsUrl, options); assert.equal(c.upgraded, false)
  }
  const good = await client(t, result.wsUrl, { extra: 'Sec-WebSocket-Extensions: permessage-deflate; client_max_window_bits' })
  assert.equal(good.upgraded, true)
  assert.doesNotMatch(good.responseHeader, /sec-websocket-extensions/i)
  assert.equal((await client(t, result.wsUrl)).upgraded, false)
  assert.equal(f.rawSockets.length, 0)
  good.socket.destroy(); await until(() => f.releases.length === 2)
})

test('X.224 split packets and TLS approval gate keep queued credentials private; DER destination cannot redirect', async t => {
  let approval
  const f = fixture(t, { approve: () => new Promise(resolve => { approval = resolve }) })
  const result = await f.service.open({ host: 'rdp.invalid', port: 3389 }), c = await client(t, result.wsUrl)
  c.send(request()); c.send(Buffer.from('sensitive-fixture'))
  await until(() => approval)
  assert.deepEqual(f.rawSockets[0].target, { host: 'rdp.invalid', port: 3389 })
  assert.deepEqual(f.rawSockets[0].writes, [REQUEST])
  assert.equal(f.tlsSockets[0].options.servername, 'rdp.invalid')
  assert.equal(f.tlsSockets[0].writes.length, 0); assert.equal(c.frames.length, 0)
  assert.match(f.requests.find(value => value.method === 'dialog.confirm').params.detail, /AA:BB:CC/)
  approval(true)
  await until(() => c.frames.some(value => value.opcode === 2))
  assert.equal(c.frames[0].payload[0], 0x30)
  assert.deepEqual(f.tlsSockets[0].writes, [Buffer.from('sensitive-fixture')])
  f.tlsSockets[0].push(Buffer.from('desktop-bytes'))
  await until(() => c.frames.length >= 2)
  assert.equal(c.frames[1].payload.toString(), 'desktop-bytes')
  c.socket.destroy(); await until(() => f.releases.length === 2)
  assert.ok(f.rawSockets[0].destroyed); assert.ok(f.tlsSockets[0].destroyed)
})

test('certificate refusal and approval after close never forward queued credentials and release all leases', async t => {
  for (const late of [false, true]) {
    let approval
    const f = fixture(t, { approve: () => new Promise(resolve => { approval = resolve }) })
    const result = await f.service.open({ host: 'rdp.invalid', port: 3389 }), c = await client(t, result.wsUrl)
    c.send(request()); c.send(Buffer.from('never-forward'))
    await until(() => approval)
    if (late) f.service.close(result.bridgeId)
    approval(late)
    await until(() => f.releases.length === 2 && c.closed)
    assert.equal(f.tlsSockets[0].writes.length, 0)
    assert.equal(f.rawSockets[0].destroyed, true); assert.equal(f.tlsSockets[0].destroyed, true)
    if (!late) assert.equal(c.frames[0]?.payload[0], 0x30)
  }
})

test('late activity/endpoint grants are released after disposal and never return a live URL', async t => {
  for (const delayed of ['activity.acquire', 'endpoint.allow']) {
    let finish
    const f = fixture(t, { hostRequest: method => method === delayed ? new Promise(resolve => { finish = resolve }) : undefined })
    const pending = f.service.open({ host: 'rdp.invalid', port: 3389 })
    const rejected = assert.rejects(pending, /closing/)
    await until(() => finish)
    f.abort(); finish(undefined); await rejected; await f.service.drain()
    assert.equal(f.releases.filter(value => value.method === 'activity.release').length, 1)
    assert.equal(f.releases.filter(value => value.method === 'endpoint.revoke').length, delayed === 'endpoint.allow' ? 1 : 0)
  }
})

test('proxy-selected targets use CONNECT, unsupported proxy never falls through, and local SSH tunnel bypasses proxy', async t => {
  const f = fixture(t, { proxy: 'PROXY proxy.invalid:8080; DIRECT' })
  const result = await f.service.open({ host: 'rdp.invalid', port: 3389 }), c = await client(t, result.wsUrl)
  c.send(request()); await until(() => c.frames.length)
  assert.deepEqual(f.proxyCalls, [{ config: { type: 'http-connect', host: 'proxy.invalid', port: 8080 }, host: 'rdp.invalid', port: 3389, password: null }])
  assert.equal(f.rawSockets[0].target, undefined)
  assert.equal(f.parseProxyRoute('DIRECT'), null)
  assert.deepEqual(f.parseProxyRoute('SOCKS5 localhost:1080'), { type: 'socks5', host: 'localhost', port: 1080 })
  for (const rule of ['HTTPS proxy.invalid:443; DIRECT', 'SOCKS4 localhost:1080', 'SOCKS localhost:1080; DIRECT', '', 'PROXY x:0']) assert.throws(() => f.parseProxyRoute(rule))
  const unsupported = fixture(t, { proxy: 'HTTPS proxy.invalid:443; DIRECT' })
  const rejected = await unsupported.service.open({ host: 'rdp.invalid', port: 3389 }), r = await client(t, rejected.wsUrl)
  r.send(request()); await until(() => r.closed)
  assert.equal(unsupported.rawSockets.length, 0)
  const local = fixture(t), direct = await local.service.open({ host: '127.0.0.1', port: 32109 }), d = await client(t, direct.wsUrl)
  d.send(request()); await until(() => d.frames.length)
  assert.equal(local.requests.some(value => value.method === 'network.resolveProxy'), false)
})

test('invalid/unmasked frames and failed remote connections retire endpoints and activity', async t => {
  for (const kind of ['unmasked', 'text', 'failure']) {
    const f = fixture(t, { socketError: kind === 'failure' })
    const result = await f.service.open({ host: 'rdp.invalid', port: 3389 }), c = await client(t, result.wsUrl)
    if (kind === 'unmasked') c.socket.write(Buffer.from([0x82, 1, 0]))
    else if (kind === 'text') c.socket.write(mask(Buffer.from('text'), 1))
    else c.send(request())
    await until(() => c.closed && f.releases.length === 2)
    if (kind !== 'failure') assert.equal(f.rawSockets.length, 0)
    else assert.equal(c.frames[0]?.payload[0], 0x30)
  }
})

test('X.224 reader rejects close/abort/malformed records and removes its listeners', async t => {
  const f = fixture(t)
  for (const kind of ['close', 'abort', 'bad']) {
    const socket = new Duplex({ read() {}, write(_data, _encoding, callback) { callback() } }), controller = new AbortController()
    socket.on('error', () => {})
    const pending = f.readX224Record(socket, controller.signal)
    const rejection = assert.rejects(pending, /closed|Invalid/)
    if (kind === 'close') socket.destroy()
    else if (kind === 'abort') controller.abort()
    else socket.push(Buffer.from([0, 0, 0, 10]))
    await rejection
    assert.equal(socket.listenerCount('data'), 0); socket.destroy()
  }
})

test('Remote RDP frontend opens only its private backend and closes idempotently; VNC remains generic', async () => {
  const calls = [], window = { enest: { backend: { call: async (method, args) => { calls.push([method, args]); return { bridgeId: 'rdp-fixture', wsUrl: 'ws://127.0.0.1:32110/rdp?token=fixture' } } } } }
  loader({ '@enest/ssh-backend/client': { createSshHost } }, { window })('eNest_plugin/plugins/remote-desktop/src/js/connection.js')
  const transport = await window.RdpConnection.openTransport({ protocol: 'rdp', host: 'rdp.invalid', port: 3389 })
  assert.equal(transport.bridgeId, 'rdp-fixture'); assert.match(transport.wsUrl, /\/rdp/)
  await transport.close(); await transport.close()
  assert.deepEqual(calls, [['rdp.open', [{ host: 'rdp.invalid', port: 3389 }]], ['rdp.close', ['rdp-fixture']]])
  await assert.rejects(window.RdpConnection.openTransport({ protocol: 'vnc', host: 'vnc.invalid', port: 5900 }), /更新/)
})

test('RDP connection diagnostics send a valid X.224 probe and reject an error DER response', async () => {
  const protocol = loader()(backend + 'rdpProtocol.ts')
  for (const success of [true, false]) {
    const sent = [], calls = [], response = success ? protocol.buildRdpCleanPathResponse('127.0.0.1:3389', CONFIRM, [Buffer.from('fixture')]) : protocol.buildRdpCleanPathError(1)
    class WebSocket {
      constructor() { queueMicrotask(() => this.onopen?.()) }
      send(bytes) { sent.push(Buffer.from(bytes)); queueMicrotask(() => this.onmessage?.({ data: Uint8Array.from(response).buffer })) }
      close() { queueMicrotask(() => this.onclose?.()) }
    }
    const window = { enest: { backend: { call: async (method, args) => { calls.push([method, args]); return { bridgeId: 'probe', wsUrl: 'ws://127.0.0.1:12345/rdp' } } } } }
    loader({ '@enest/ssh-backend/client': { createSshHost } }, { window, WebSocket })('eNest_plugin/plugins/remote-desktop/src/js/connection.js')
    const result = await window.RdpConnection.testConnection({ protocol: 'rdp', host: 'localhost', port: 3389 })
    assert.equal(result.ok, success)
    assert.deepEqual(protocol.parseRdpCleanPathRequest(sent[0]).x224ConnectionRequest, REQUEST)
    assert.equal(calls.filter(value => value[0] === 'rdp.close').length, 1)
  }
})

test('composable runtime initializes only validated owners and cleans extension without contaminating static SSH entry', async () => {
  const messages = [], exits = [], contextSeen = [], cleanup = [], globals = { process: { parentPort: { on(_name, fn) { this.receive = fn }, postMessage(message) { messages.push(message) } }, exit(code) { exits.push(code) } } }
  const bridge = { configureHostBridge() {}, receiveHostReply() {}, disposeHostBridge() { cleanup.push('host') }, hostCall() { return Promise.resolve(true) }, acquirePluginActivity() { return () => {} } }
  const ssh = new Proxy({ releaseSshSessions() { cleanup.push('ssh') } }, { get: (target, name) => target[name] || (() => true) })
  const load = loader({ './sshSessionManager': ssh, './sshWorkbench': { sshWorkbench() {} }, './hostBridge': bridge }, globals)
  const { startSshWorker } = load('eNest_plugin/packages/ssh-backend/src/runtime.ts')
  startSshWorker(context => { contextSeen.push(context); return { methods: { 'rdp.fixture': (owner, value) => ({ owner, value }) }, dispose() { cleanup.push('rdp') } } })
  const send = data => globals.process.parentPort.receive({ data })
  send({ type: 'init', pluginId: 'owner', generation: 0, wcId: 1, context: { protocolVersion: 1, pageOrigin: 'enest://plugin' } })
  assert.equal(contextSeen.length, 0)
  send({ type: 'init', pluginId: 'owner', generation: 1, wcId: 1, context: { protocolVersion: 1, pageOrigin: 'enest://plugin' } })
  assert.equal(contextSeen[0].pageOrigin, 'enest://plugin')
  send({ id: 1, pluginId: 'foreign', method: 'rdp.fixture', args: ['secret'] })
  send({ id: 2, pluginId: 'owner', method: 'rdp.fixture', args: ['fixture'] }); await settle()
  assert.match(messages.find(message => message.id === 1).error, /owner/)
  assert.deepEqual(messages.find(message => message.id === 2).data, { owner: 'owner', value: 'fixture' })
  send({ type: 'shutdown' }); await settle()
  assert.deepEqual(cleanup, ['ssh', 'rdp', 'host']); assert.deepEqual(exits, [0])
})

test('real loopback TCP upgrades to TLS after fragmented X.224 and echoes approved plaintext only', async t => {
  const directory = mkdtempSync(resolve(tmpdir(), 'enest-rdp-tls-fixture-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  // An ephemeral fixture certificate, never a user key or a remote connection.
  execFileSync('/usr/bin/openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', resolve(directory, 'key.pem'), '-out', resolve(directory, 'cert.pem'), '-subj', '/CN=localhost', '-days', '1'], { stdio: 'ignore' })
  const secureContext = tls.createSecureContext({ key: readFileSync(resolve(directory, 'key.pem')), cert: readFileSync(resolve(directory, 'cert.pem')) })
  const sockets = new Set(), plaintext = [], approvals = []
  const server = net.createServer(socket => {
    sockets.add(socket); socket.on('error', () => {})
    let received = Buffer.alloc(0)
    const data = chunk => {
      received = Buffer.concat([received, chunk])
      if (received.length < REQUEST.length) return
      assert.deepEqual(received, REQUEST)
      socket.removeListener('data', data); socket.pause()
      socket.write(CONFIRM.subarray(0, 3))
      setTimeout(() => {
        socket.write(CONFIRM.subarray(3))
        const secure = new tls.TLSSocket(socket, { isServer: true, secureContext })
        sockets.add(secure); secure.on('error', () => {})
        secure.on('data', chunk => { plaintext.push(chunk.toString()); secure.write(chunk) })
        secure.resume()
      }, 2)
    }
    socket.on('data', data)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => { for (const socket of sockets) socket.destroy(); server.close() })
  const controller = new AbortController(), disposers = new Set()
  const scope = { signal: controller.signal, isCurrent: () => !controller.signal.aborted, addDisposer(fn) { disposers.add(fn); return () => disposers.delete(fn) } }
  const { RdpBridgeService } = loader()(backend + 'rdpBridge.ts')
  const service = new RdpBridgeService({ pluginId: 'com.github.eNest.remote-desktop', scope, pageOrigin: 'enest://plugin', async hostCall(method, params) { if (method === 'dialog.confirm') { approvals.push(params); return true } } })
  t.after(async () => { service.dispose(); await service.drain() })
  const result = await service.open({ host: '127.0.0.1', port: server.address().port }), c = await client(t, result.wsUrl)
  c.send(request()); c.send(Buffer.from('loopback-only'))
  await until(() => c.frames.length >= 2, 4000)
  assert.equal(approvals.length, 1); assert.match(approvals[0].detail, /(?:[A-F0-9]{2}:){31}[A-F0-9]{2}/)
  assert.deepEqual(plaintext, ['loopback-only']); assert.equal(c.frames[1].payload.toString(), 'loopback-only')
})

test('owned RDP and composable SSH TypeScript entrypoints have no diagnostics', () => {
  const program = ts.createProgram([resolve(root, backend + 'index.ts'), resolve(root, 'eNest_plugin/packages/ssh-backend/src/worker.ts')], {
    noEmit: true, strict: true, skipLibCheck: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler, types: ['node'], baseUrl: root,
    paths: { '@enest/ssh-backend/runtime': ['eNest_plugin/packages/ssh-backend/src/runtime.ts'] }
  })
  const diagnostics = ts.getPreEmitDiagnostics(program).map(value => `${value.file?.fileName ?? ''}: ${ts.flattenDiagnosticMessageText(value.messageText, '\n')}`)
  assert.deepEqual(diagnostics, [])
})
