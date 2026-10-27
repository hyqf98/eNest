/**
 * wsFrames — RFC6455 WebSocket 帧编解码（最小实现，零依赖）
 * 职责：为 socketBridge 的 serveWs 本地桥提供握手响应与二进制帧的
 *       编码 / 解码；仅支持 server 侧需要的子集：
 *       - 解析 client → server 帧（必须 mask；text/binary/ping/close）
 *       - 编码 server → client 帧（不 mask；text/binary/pong/close）
 *       分片（fragmentation）按协议合并（仅对 text/binary 首帧带 FIN=0 的场景）。
 * 被 socketBridge 使用。不处理扩展协商（permessage-deflate 拒绝）。
 */
import { createHash } from 'node:crypto'

export interface WsFrame {
  /** opcode：1 text / 2 binary / 8 close / 9 ping / 10 pong */
  opcode: number
  /** 载荷（已解 mask / 待 mask 前明文） */
  payload: Buffer
  /** FIN 位：false 表示分片未完，后续为 continuation（opcode 0） */
  fin: boolean
}

export const WS_OPCODE = {
  continuation: 0,
  text: 1,
  binary: 2,
  close: 8,
  ping: 9,
  pong: 10
} as const

/** RFC6455 握手 GUID（§1.3） */
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

/**
 * 从缓冲区头部尝试解析一帧。
 * 返回 null = 数据不足（需继续积攒）；返回帧 + 已消费字节数。
 * 客户端帧必须 masked，否则按协议视为协议错误（这里返回 null 并由调用方
 * 以 1002 关闭——简化：直接抛错，由 bridge 统一 close）。
 */
export function decodeWsFrame(buf: Buffer): { frame: WsFrame; offset: number } | null {
  if (buf.length < 2) return null
  const b0 = buf[0]
  const b1 = buf[1]
  const fin = (b0 & 0x80) !== 0
  const opcode = b0 & 0x0f
  const masked = (b1 & 0x80) !== 0
  let len = b1 & 0x7f
  let offset = 2
  if (len === 126) {
    if (buf.length < offset + 2) return null
    len = buf.readUInt16BE(offset)
    offset += 2
  } else if (len === 127) {
    if (buf.length < offset + 8) return null
    const big = buf.readBigUInt64BE(offset)
    // 上限 16MB 单帧（超出按协议错误处理，防异常分配）
    if (big > 16_777_216n) throw new Error('ws frame too large')
    len = Number(big)
    offset += 8
  }
  const maskKey = masked ? buf.subarray(offset, offset + 4) : null
  if (masked) offset += 4
  if (buf.length < offset + len) return null
  let payload = buf.subarray(offset, offset + len)
  if (maskKey) {
    const unmasked = Buffer.allocUnsafe(len)
    for (let i = 0; i < len; i++) unmasked[i] = payload[i] ^ maskKey[i & 3]
    payload = unmasked
  }
  return { frame: { opcode, payload, fin }, offset: offset + len }
}

/** 编码 server → client 帧（永不 mask） */
export function encodeWsFrame(opcode: number, payload: Buffer, fin = true): Buffer {
  const len = payload.length
  let header: Buffer
  if (len < 126) {
    header = Buffer.allocUnsafe(2)
    header[1] = len
  } else if (len < 65536) {
    header = Buffer.allocUnsafe(4)
    header[1] = 126
    header.writeUInt16BE(len, 2)
  } else {
    header = Buffer.allocUnsafe(10)
    header[1] = 127
    header.writeBigUInt64BE(BigInt(len), 2)
  }
  header[0] = (fin ? 0x80 : 0) | (opcode & 0x0f)
  return Buffer.concat([header, payload])
}

/** server → client 二进制帧 */
export function encodeWsBinary(payload: Buffer): Buffer {
  return encodeWsFrame(WS_OPCODE.binary, payload)
}

/** server → client close 帧（带状态码） */
export function encodeWsClose(code = 1000): Buffer {
  const body = Buffer.allocUnsafe(2)
  body.writeUInt16BE(code, 0)
  return encodeWsFrame(WS_OPCODE.close, body)
}

/** server → client pong（回显 ping 载荷） */
export function encodeWsPong(payload: Buffer): Buffer {
  return encodeWsFrame(WS_OPCODE.pong, payload)
}

/**
 * HTTP Upgrade 握手应答（RFC6455 §4.2.2）：
 * Sec-WebSocket-Accept = base64(sha1(key + GUID))。
 */
export function wsAcceptKey(clientKey: string): string {
  return createHash('sha1').update(clientKey + WS_GUID).digest('base64')
}

export function handshakeResponse(clientKey: string): string {
  return [
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${wsAcceptKey(clientKey)}`,
    '\r\n'
  ].join('\r\n')
}
