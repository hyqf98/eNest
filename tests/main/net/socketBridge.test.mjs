import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer, Server } from 'node:net'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { connect as wsConnectRaw } from 'node:net'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const absPath = fileURLToPath(new URL('src/main/net/socketBridge.ts', 'file://' + root))

const events = []
// 单一 bundle 同时导出 socketBridge 与 PluginRuntimeScope，保证共享同一模块实例
// （socketBridge 经 getRuntimeScope 查 scope，必须与测试侧 createRuntimeScope 同 Map）
const bridgePath = fileURLToPath(new URL('../../../src/main/net/socketBridge.ts', import.meta.url))
const scopePath = fileURLToPath(new URL('../../../src/main/plugin/PluginRuntimeScope.ts', import.meta.url))
const entry = `export * from ${JSON.stringify(bridgePath)};\nexport * from ${JSON.stringify(scopePath)};\n`
const result = await build({
  stdin: { contents: entry, resolveDir: root, loader: 'js' },
  tsconfig: root + 'tsconfig.node.json',
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
  plugins: [{
    name: 'stub-host',
    setup(b) {
      b.onResolve({ filter: /^@main\/plugin\/(pluginSessionPolicy|PluginRegistry)$/ }, args => ({ path: args.path, namespace: 'policy' }))
      b.onLoad({ filter: /.*/, namespace: 'policy' }, () => ({ contents: 'export const allowPluginEndpoint = () => () => {}; export const pluginRegistry = { get: () => undefined }' }))
      b.onResolve({ filter: /^@main\/plugin\/PluginPermissions$/ }, () => ({ path: 'permissions', namespace: 'permission' }))
      b.onLoad({ filter: /.*/, namespace: 'permission' }, () => ({ contents: 'export const confirmPluginOperation = async () => {}' }))
      b.onResolve({ filter: /^@main\/proxy\/proxyService$/ }, () => ({ path: 'proxy', namespace: 'proxy' }))
      b.onLoad({ filter: /.*/, namespace: 'proxy' }, () => ({ contents: 'export const getActiveProxy = () => ({type:"none"})' }))
      b.onResolve({ filter: /^@main\/plugin\/PluginHost$/ }, () => ({ path: 'host', namespace: 'stub' }))
      b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
        contents: 'export const pluginHost = { isOpened: () => true, sendEvent: (_id, p) => { globalThis.__socketEvents().push(p) } }'
      }))
    }
  }]
})
globalThis.__socketEvents = () => events
const api = await import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64'))
const scopeApi = api

const PLUGIN = 'test.socket.plugin'
/** 每个测试用独立 pluginId 建 scope（createRuntimeScope 同 id 二次创建会抛错） */
let scopeSeq = 0
function makeScope() {
  const pluginId = `${PLUGIN}.g${++scopeSeq}`
  return { pluginId, scope: scopeApi.createRuntimeScope({ pluginId, generation: scopeSeq, wcId: 100 + scopeSeq }) }
}

/** 极简 ws client：RFC6455 握手 + masked binary 帧发送 + unmasked 帧接收 */

test('socketBridge 全链路：connect → send/echo → net.data 事件 → close → 释放', async () => {
  const { pluginId, scope } = makeScope()
  const echo = createServer(sock => sock.on('data', d => sock.write(d)))
  await new Promise(r => echo.listen(0, '127.0.0.1', r))
  const port = echo.address().port
  try {
    const { socketId } = await api.socketConnect(pluginId, { host: '127.0.0.1', port })
    assert.ok(socketId.startsWith('sk-'))
    // 发 utf8 文本（非 base64 形态）→ echo 回 → net.data（base64）
    const sent = api.socketSend(pluginId, socketId, 'ping-echo')
    assert.equal(sent.sent, 'ping-echo'.length)
    await new Promise(r => setTimeout(r, 120))
    events.length = 0
    api.socketSend(pluginId, socketId, 'hello')
    await new Promise(r => setTimeout(r, 150))
    const dataEvent = events.find(e => e.type === 'net.data' && e.socketId === socketId)
    assert.ok(dataEvent, 'net.data event emitted')
    assert.equal(Buffer.from(dataEvent.chunk, 'base64').toString('utf8'), 'hello')
    // list
    const list = api.socketList(pluginId)
    assert.equal(list.length, 1)
    assert.equal(list[0].host, '127.0.0.1')
    assert.equal(list[0].port, port)
    // close → net.close
    events.length = 0
    assert.equal(api.socketClose(pluginId, socketId), true)
    await new Promise(r => setTimeout(r, 50))
    assert.ok(events.some(e => e.type === 'net.close' && e.socketId === socketId))
    assert.equal(api.socketList(pluginId).length, 0)
    // scope dispose 幂等（socket 已清）
    scope.dispose()
  } finally {
    echo.close()
  }
})

test('socketSend defaults to UTF-8 even for base64-shaped protocol commands; binary is explicit', async () => {
  const { pluginId, scope } = makeScope()
  const received = []
  const server = createServer(socket => socket.on('data', data => received.push(data)))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const { socketId } = await api.socketConnect(pluginId, { host: '127.0.0.1', port: server.address().port })
    for (const command of ['PING', 'USER', 'HELO']) assert.equal(api.socketSend(pluginId, socketId, command).sent, 4)
    assert.equal(api.socketSend(pluginId, socketId, 'AAH/', 'base64').sent, 3)
    assert.throws(() => api.socketSend(pluginId, socketId, 'not base64!', 'base64'), /base64/)
    assert.throws(() => api.socketSend(pluginId, socketId, 'PING', 'auto'), /encoding/)
    const deadline = Date.now() + 2000
    while (Buffer.concat(received).length < 15 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10))
    assert.deepEqual(Buffer.concat(received), Buffer.concat([Buffer.from('PINGUSERHELO'), Buffer.from([0, 1, 255])]))
  } finally { await scope.dispose(); server.close() }
})

test('failed WebSocket bridge listening releases the bridge and the next call binds a real port', async () => {
  const { pluginId, scope } = makeScope()
  const server = createServer()
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const listen = Server.prototype.listen
  try {
    const { socketId } = await api.socketConnect(pluginId, { host: '127.0.0.1', port: server.address().port })
    Server.prototype.listen = function () { queueMicrotask(() => this.emit('error', Error('fixture listen failed'))); return this }
    await assert.rejects(api.socketServeWs(pluginId, socketId), /fixture listen failed/)
    Server.prototype.listen = listen
    const opening = api.socketServeWs(pluginId, socketId)
    await assert.rejects(api.socketServeWs(pluginId, socketId), /still starting/)
    const endpoint = await opening
    assert.ok(endpoint.port > 0)
    assert.ok(endpoint.url.startsWith(`ws://127.0.0.1:${endpoint.port}/`))
  } finally { Server.prototype.listen = listen; await scope.dispose(); server.close() }
})

test('socketBridge：连接拒绝错误可读；未知 socket 拒绝', async () => {
  const { pluginId, scope } = makeScope()
  try {
    // 占住端口但不 listen 的方式：连一个已关闭端口（找一个未监听端口）
    const probe = createServer()
    await new Promise(r => probe.listen(0, '127.0.0.1', r))
    const deadPort = probe.address().port
    probe.close()
    await new Promise(r => setTimeout(r, 50))
    await assert.rejects(
      () => api.socketConnect(pluginId, { host: '127.0.0.1', port: deadPort, timeoutMs: 2000 }),
      /connect failed/
    )
    assert.throws(() => api.socketSend(pluginId, 'sk-none', 'x'), /socket not found/)
    assert.equal(api.socketClose(pluginId, 'sk-none'), false)
  } finally {
    scope.dispose()
  }
})

test('socketBridge：scope dispose 释放全部 socket（PluginHost disposer 挂载点语义）', async () => {
  const echo = createServer(sock => sock.on('data', d => sock.write(d)))
  await new Promise(r => echo.listen(0, '127.0.0.1', r))
  const port = echo.address().port
  const { pluginId, scope } = makeScope()
  try {
    const a = await api.socketConnect(pluginId, { host: '127.0.0.1', port })
    const b = await api.socketConnect(pluginId, { host: '127.0.0.1', port })
    assert.equal(api.socketList(pluginId).length, 2)
    scope.dispose()
    await new Promise(r => setTimeout(r, 50))
    assert.equal(api.socketList(pluginId).length, 0, 'all sockets released on scope dispose')
    assert.ok(a.socketId && b.socketId)
  } finally {
    echo.close()
  }
})

/** 极简 ws client：RFC6455 握手 + masked binary 帧发送 + unmasked 帧接收 */
function rawWsClient(port, token, origin = 'enest://plugin') {
  return new Promise((resolve, reject) => {
    const key = Buffer.alloc(16, 7).toString('base64')
    const sock = wsConnectRaw(port, () => {
      sock.write(`GET /bridge?token=${token} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nOrigin: ${origin}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`)
    })
    let buf = Buffer.alloc(0)
    let upgraded = false
    const frames = []
    const waiters = []
    const onFrame = frame => {
      const w = waiters.shift()
      if (w) w(frame); else frames.push(frame)
    }
    const tryParse = () => {
      // server 帧不 mask
      if (buf.length < 2) return
      const len = buf[1] & 0x7f
      let off = 2
      let realLen = len
      if (len === 126) { if (buf.length < 4) return; realLen = buf.readUInt16BE(2); off = 4 }
      else if (len === 127) { if (buf.length < 10) return; realLen = Number(buf.readBigUInt64BE(2)); off = 10 }
      if (buf.length < off + realLen) return
      const payload = buf.subarray(off, off + realLen)
      const opcode = buf[0] & 0x0f
      buf = buf.subarray(off + realLen)
      onFrame({ opcode, payload })
      tryParse()
    }
    sock.on('data', chunk => {
      buf = Buffer.concat([buf, chunk])
      if (!upgraded) {
        const idx = buf.indexOf('\r\n\r\n')
        if (idx < 0) return
        const head = buf.subarray(0, idx).toString()
        buf = buf.subarray(idx + 4)
        if (!/101 Switching Protocols/.test(head)) { reject(new Error('handshake failed: ' + head.split('\n')[0])); sock.destroy(); return }
        upgraded = true
        resolve({
          sock,
          send: data => {
            const mask = Buffer.from([1, 2, 3, 4])
            const masked = Buffer.from(data)
            for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i & 3]
            const header = Buffer.allocUnsafe(2 + 4)
            header[0] = 0x82
            header[1] = 0x80 | masked.length
            mask.copy(header, 2)
            sock.write(Buffer.concat([header, masked]))
          },
          next: () => new Promise(r => { const f = frames.shift(); if (f) r(f); else waiters.push(r) }),
          close: () => sock.destroy()
        })
        tryParse()
        return
      }
      tryParse()
    })
    sock.on('error', reject)
    // 服务端拒绝（destroy）时可能只有 close 没有 error：未完成握手即关闭按失败处理
    sock.on('close', () => { if (!upgraded) reject(new Error('handshake failed: connection closed by server')) })
  })
}

test('socketBridge serveWs：token 校验 + ws ↔ TCP 双向二进制直通', async () => {
  const echo = createServer(sock => sock.on('data', d => sock.write(d)))
  await new Promise(r => echo.listen(0, '127.0.0.1', r))
  const port = echo.address().port
  const { pluginId, scope } = makeScope()
  try {
    const { socketId } = await api.socketConnect(pluginId, { host: '127.0.0.1', port })
    const { url, token, port: wsPort } = await api.socketServeWs(pluginId, socketId)
    assert.match(url, new RegExp(`^ws://127\\.0\\.0\\.1:${wsPort}/bridge\\?token=${token}$`))
    const ws = await rawWsClient(wsPort, token)
    // ws → TCP → echo → ws
    ws.send(Buffer.from('bridge-roundtrip'))
    const back = await ws.next()
    assert.equal(back.opcode, 2, 'binary frame back')
    assert.equal(back.payload.toString('utf8'), 'bridge-roundtrip')
    // TCP 侧主动推送（echo 模拟服务端帧）→ ws 二进制
    ws.close()
  } finally {
    scope.dispose()
    echo.close()
  }
})

test('socketBridge serveWs：错误 token 拒绝；二次连接 token 一次性拒绝', async () => {
  const echo = createServer(sock => sock.on('data', d => sock.write(d)))
  await new Promise(r => echo.listen(0, '127.0.0.1', r))
  const port = echo.address().port
  const { pluginId, scope } = makeScope()
  try {
    const { socketId } = await api.socketConnect(pluginId, { host: '127.0.0.1', port })
    const { token, port: wsPort } = await api.socketServeWs(pluginId, socketId)
    // 错 token：握手应失败（连接被 destroy）
    await assert.rejects(() => rawWsClient(wsPort, 'wrong-token-value'), /handshake failed|error/i)
    await assert.rejects(() => rawWsClient(wsPort, token, 'https://attacker.example'), /handshake failed|error/i)
    await assert.rejects(() => rawWsClient(wsPort, token, ''), /handshake failed|error/i)
    // 对 token 的首个连接成功后关闭
    const ws = await rawWsClient(wsPort, token)
    ws.close()
    await new Promise(r => setTimeout(r, 100))
    // 一次性：token 已消费（首连接后 consumed=true）→ 再连被拒
    await assert.rejects(() => rawWsClient(wsPort, token), /handshake failed|error/i)
  } finally {
    scope.dispose()
    echo.close()
  }
})

// ── rdp 模式（RDCleanPath ASN.1 + TLS 终止）──

/** 构造最小合法 RDCleanPath Request（DER）：[0] version [2] destination [6] x224 */
function buildCleanPathRequest(destination, x224, version = 3390) {
  const wrap = (tag, content) => {
    const len = content.length
    const lenBytes = len < 0x80 ? Buffer.from([len]) : Buffer.from([0x81, len])
    return Buffer.concat([Buffer.from([tag]), lenBytes, content])
  }
  const integer = value => {
    const bytes = []
    let temp = value
    while (temp > 0) { bytes.unshift(temp & 0xff); temp >>= 8 }
    return wrap(0x02, Buffer.from(bytes))
  }
  const utf8 = str => wrap(0x0c, Buffer.from(str, 'utf8'))
  return wrap(0x30, Buffer.concat([
    wrap(0xa0, integer(version)),
    wrap(0xa2, utf8(destination)),
    wrap(0xa6, wrap(0x04, x224))
  ]))
}

test('rdp ASN.1：parse/build RDCleanPath 往返；嗅探低误报', () => {
  const x224 = Buffer.from([0x03, 0x00, 0x00, 0x0b, 0x06, 0xe0, 0x00, 0x00, 0x00, 0x00, 0x00])
  const req = buildCleanPathRequest('127.0.0.1:3389', x224)
  assert.equal(api.looksLikeRdpCleanPathRequest(req), true)
  assert.equal(api.looksLikeRdpCleanPathRequest(Buffer.from('RFB 003.008\n')), false)
  assert.equal(api.looksLikeRdpCleanPathRequest(Buffer.from([0x30])), false) // 过短
  const parsed = api.parseRdpCleanPathRequest(req)
  assert.equal(parsed.destination, '127.0.0.1:3389')
  assert.deepEqual([...parsed.x224ConnectionRequest], [...x224])
  // response / error 结构可解（自往返）
  const resp = api.buildRdpCleanPathResponse('127.0.0.1:3389', x224, [Buffer.from([0xaa, 0xbb])])
  assert.equal(resp[0], 0x30)
  assert.ok(resp.length > x224.length)
  const errPdu = api.buildRdpCleanPathError(1, 502)
  assert.equal(errPdu[0], 0x30)
  // 版本不符应拒绝
  assert.throws(() => api.parseRdpCleanPathRequest(buildCleanPathRequest('h:1', x224, 3391)), /version/)
  // 缺 destination：version 合法（3390）但无 [2]
  assert.throws(() => api.parseRdpCleanPathRequest(
    Buffer.from([0x30, 0x07, 0xa0, 0x05, 0x02, 0x03, 0x0d, 0x3e])
  ), /destination|truncated DER/)
})

test('serveWs rdp 模式：RDCleanPath → X.224 → TLS → 明文直通（全链路）', async () => {
  const tls = await import('node:tls')
  const netMod = await import('node:net')
  const fs = await import('node:fs')
  const { execFileSync } = await import('node:child_process')
  // openssl 生成一次性自签证书（测试服务器模拟 RDP 自签 TLS）
  const path = `/tmp/rdp-test-${Date.now()}`
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', `${path}.key`, '-out', `${path}.crt`, '-days', '1', '-subj', '/CN=127.0.0.1'])
  const key = { pem: fs.readFileSync(`${path}.key`), cert: fs.readFileSync(`${path}.crt`), rm: () => { fs.rmSync(`${path}.key`, { force: true }); fs.rmSync(`${path}.crt`, { force: true }) } }
  // 假 RDP 服务端：读 X.224 Request → 回 X.224 Confirm → TLS 升级 → 明文 echo
  const x224Confirm = Buffer.from([0x03, 0x00, 0x00, 0x0b, 0x06, 0xd0, 0x00, 0x00, 0x12, 0x34, 0x00])
  let sawX224 = false
  const rdpServer = netMod.createServer(sock => {
    sock.once('data', chunk => {
      sawX224 = chunk.length > 0 && chunk[0] === 0x03
      sock.write(x224Confirm, () => {
        sock.removeAllListeners('data')
        const tlsSock = new tls.TLSSocket(sock, { isServer: true, key: key.pem, cert: key.cert, rejectUnauthorized: false })
        tlsSock.on('data', d => tlsSock.write(d))
        tlsSock.on('error', () => {})
      })
    })
    sock.on('error', () => {})
  })
  await new Promise(r => rdpServer.listen(0, '127.0.0.1', r))
  const { pluginId, scope } = makeScope()
  try {
    const { socketId } = await api.socketConnect(pluginId, { host: '127.0.0.1', port: rdpServer.address().port })
    const { token, port: wsPort } = await api.socketServeWs(pluginId, socketId)
    const ws = await rawWsClient(wsPort, token)
    // 发 RDCleanPath Request → 期望先收到 RDCleanPath Response（0x30 开头）
    ws.send(buildCleanPathRequest('127.0.0.1:3389', Buffer.from([0x03, 0x00, 0x00, 0x0b, 0x06, 0xe0, 0x00, 0x00, 0x00, 0x00, 0x00])))
    const resp = await ws.next()
    assert.equal(resp.opcode, 2)
    assert.equal(resp.payload[0], 0x30, 'RDCleanPath response is DER SEQUENCE')
    assert.ok(sawX224, 'fake server received X.224 request')
    // 协商完成后明文 echo 直通
    ws.send(Buffer.from('rdp-plaintext-roundtrip'))
    const back = await ws.next()
    assert.equal(back.payload.toString('utf8'), 'rdp-plaintext-roundtrip')
    ws.close()
  } finally {
    key.rm()
    scope.dispose()
    rdpServer.close()
    await new Promise(r => setTimeout(r, 50))
  }
})

test('serveWs rdp 模式：非 rdp 首消息直通不受影响（noVNC RFB 兼容）', async () => {
  const echo = createServer(sock => sock.on('data', d => sock.write(d)))
  await new Promise(r => echo.listen(0, '127.0.0.1', r))
  const port = echo.address().port
  const { pluginId, scope } = makeScope()
  try {
    const { socketId } = await api.socketConnect(pluginId, { host: '127.0.0.1', port })
    const { token, port: wsPort } = await api.socketServeWs(pluginId, socketId)
    const ws = await rawWsClient(wsPort, token)
    // RFB 版本串（文本首字节 'R'=0x52）→ 不命中嗅探，直接直通
    ws.send(Buffer.from('RFB 003.008\n'))
    const back = await ws.next()
    assert.equal(back.payload.toString('utf8'), 'RFB 003.008\n')
    ws.close()
  } finally {
    scope.dispose()
    echo.close()
  }
})

test('bridge rejects malformed frames without escaping into the main-process event loop', async () => {
  const echo = createServer(sock => sock.on('data', d => sock.write(d)))
  await new Promise(r => echo.listen(0, '127.0.0.1', r))
  const {pluginId,scope}=makeScope()
  try {
    const {socketId}=await api.socketConnect(pluginId,{host:'127.0.0.1',port:echo.address().port})
    const endpoint=await api.socketServeWs(pluginId,socketId)
    const ws=await rawWsClient(endpoint.port,endpoint.token)
    const closed=new Promise(resolve=>ws.sock.once('close',resolve))
    // Unmasked input is forbidden even if its token and Origin were valid.
    ws.sock.write(Buffer.from([0x82,0x01,0x61]))
    await closed
    assert.equal(api.socketList(pluginId).length,1)
  } finally { await scope.dispose(); echo.close() }
})
