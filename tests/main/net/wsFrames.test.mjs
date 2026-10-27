import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

const root = fileURLToPath(new URL('../../../', import.meta.url))

async function loadModule(relPath) {
  const absPath = fileURLToPath(new URL(relPath, 'file://' + root))
  const result = await build({
    stdin: { contents: readFileSync(absPath, 'utf8'), resolveDir: root, sourcefile: absPath, loader: 'ts' },
    tsconfig: root + 'tsconfig.node.json',
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'node'
  })
  const api = await import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64'))
  return api
}

const ws = await loadModule('src/main/net/wsFrames.ts')

/** 构造一个 client → server 帧（masked，RFC6455 §5.3 示例的 mask 算法） */
function clientFrame(opcode, payload, fin = true) {
  const mask = Buffer.from([0x12, 0x34, 0x56, 0x78])
  const len = payload.length
  let header
  if (len < 126) {
    header = Buffer.allocUnsafe(2)
    header[1] = 0x80 | len
  } else if (len < 65536) {
    header = Buffer.allocUnsafe(4)
    header[1] = 0x80 | 126
    header.writeUInt16BE(len, 2)
  } else {
    header = Buffer.allocUnsafe(10)
    header[1] = 0x80 | 127
    header.writeBigUInt64BE(BigInt(len), 2)
  }
  header[0] = (fin ? 0x80 : 0) | opcode
  const masked = Buffer.from(payload)
  for (let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i & 3]
  return Buffer.concat([header, mask, masked])
}

test('decodeWsFrame: unmask 小帧（<126）', () => {
  const payload = Buffer.from('hello websocket', 'utf8')
  const frame = clientFrame(ws.WS_OPCODE.text, payload)
  const decoded = ws.decodeWsFrame(frame)
  assert.ok(decoded)
  assert.equal(decoded.frame.opcode, ws.WS_OPCODE.text)
  assert.equal(decoded.frame.fin, true)
  assert.equal(decoded.frame.payload.toString('utf8'), 'hello websocket')
  assert.equal(decoded.offset, frame.length)
})

test('decodeWsFrame: 16 位扩展长度（126..65535）', () => {
  const payload = Buffer.alloc(5000, 0xab)
  const frame = clientFrame(ws.WS_OPCODE.binary, payload)
  const decoded = ws.decodeWsFrame(frame)
  assert.ok(decoded)
  assert.equal(decoded.frame.payload.length, 5000)
  assert.deepEqual([...decoded.frame.payload.subarray(0, 4)], [0xab, 0xab, 0xab, 0xab])
})

test('decodeWsFrame: 64 位扩展长度（>=65536）', () => {
  const payload = Buffer.alloc(70000, 0x11)
  const frame = clientFrame(ws.WS_OPCODE.binary, payload)
  const decoded = ws.decodeWsFrame(frame)
  assert.ok(decoded)
  assert.equal(decoded.frame.payload.length, 70000)
})

test('decodeWsFrame: 数据不足返回 null（分片到达）', () => {
  const payload = Buffer.alloc(300, 1)
  const frame = clientFrame(ws.WS_OPCODE.binary, payload)
  // 头 100 字节到达
  assert.equal(ws.decodeWsFrame(frame.subarray(0, 100)), null)
  assert.equal(ws.decodeWsFrame(frame.subarray(0, 2)), null)
  // 完整到达
  const decoded = ws.decodeWsFrame(frame)
  assert.ok(decoded)
})

test('decodeWsFrame: FIN=0 分片帧保留 fin 位', () => {
  const frame = clientFrame(ws.WS_OPCODE.binary, Buffer.from('x'), false)
  const decoded = ws.decodeWsFrame(frame)
  assert.ok(decoded)
  assert.equal(decoded.frame.fin, false)
})

test('encode/decode 往返：server 帧不 mask，客户端语义解码（服务端帧 unmasked）', () => {
  const payload = Buffer.from([1, 2, 3, 254, 255, 0])
  const encoded = ws.encodeWsBinary(payload)
  const decoded = ws.decodeWsFrame(encoded)
  assert.ok(decoded)
  assert.equal(decoded.frame.opcode, ws.WS_OPCODE.binary)
  assert.deepEqual([...decoded.frame.payload], [...payload])
})

test('text frame / encodeWsClose / encodeWsPong', () => {
  const text = ws.encodeWsFrame(ws.WS_OPCODE.text, Buffer.from('你好', 'utf8'))
  const dt = ws.decodeWsFrame(text)
  assert.equal(dt.frame.payload.toString('utf8'), '你好')

  const close = ws.encodeWsClose(1008)
  const dc = ws.decodeWsFrame(close)
  assert.equal(dc.frame.opcode, ws.WS_OPCODE.close)
  assert.equal(dc.frame.payload.readUInt16BE(0), 1008)

  const pingPayload = Buffer.from('hb')
  const pong = ws.encodeWsPong(pingPayload)
  const dp = ws.decodeWsFrame(pong)
  assert.equal(dp.frame.opcode, ws.WS_OPCODE.pong)
  assert.equal(dp.frame.payload.toString(), 'hb')
})

test('handshakeResponse: RFC6455 §4.2.2 Accept 基准向量', () => {
  // 协议规范给出的经典示例："x3JJHMbDL1EzLkh9GBhXDw==" → "HSmrc0sMlYUkAGmm5OPpG2HaGWk="
  const key = 'x3JJHMbDL1EzLkh9GBhXDw=='
  const expected = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
  assert.equal(ws.wsAcceptKey(key), expected)
  const res = ws.handshakeResponse(key)
  assert.match(res, /^HTTP\/1\.1 101 Switching Protocols/)
  assert.match(res, new RegExp('Sec-WebSocket-Accept: ' + expected))
  assert.match(res, /Upgrade: websocket/)
  assert.ok(res.endsWith('\r\n\r\n'))
})

test('decodeWsFrame: 超大帧声明拒绝（>16MB）', () => {
  // 声明 64 位长度 17MB，仅 10 字节头
  const header = Buffer.allocUnsafe(10)
  header[0] = 0x82
  header[1] = 0x80 | 127
  header.writeBigUInt64BE(BigInt(17 * 1024 * 1024), 2)
  assert.throws(() => ws.decodeWsFrame(header), /too large/)
})

test('连续帧缓冲：一次解出多帧并推进 offset', () => {
  const a = clientFrame(ws.WS_OPCODE.binary, Buffer.from('abc'))
  const b = clientFrame(ws.WS_OPCODE.text, Buffer.from('def'))
  let buf = Buffer.concat([a, b])
  const first = ws.decodeWsFrame(buf)
  assert.equal(first.frame.payload.toString(), 'abc')
  buf = buf.subarray(first.offset)
  const second = ws.decodeWsFrame(buf)
  assert.equal(second.frame.payload.toString(), 'def')
  assert.equal(second.offset, buf.length)
})
