import { openHostProxy } from '@main/net/hostProxy'
import { confirmPluginOperation } from '@main/plugin/PluginPermissions'
import { allowPluginEndpoint } from '@main/plugin/pluginSessionPolicy'
import { pluginRegistry } from '@main/plugin/PluginRegistry'
/**
 * socketBridge — 插件出站 TCP 连接宿主服务（net.socket.*）
 * 职责：以 node:net / node:tls 建立仅出站（outgoing）连接；按 socketId 隔离
 *      与插件归属；经 pluginHost.sendEvent 推送 net.data / net.close；
 *      serveWs 起 127.0.0.1 随机端口的自实现 RFC6455 WebSocket 服务，
 *      一次性 token 校验后把该 socket 的双向二进制流桥给插件页
 *      （vendored noVNC / ironrdp-wasm 直接 new WebSocket，避免逐帧 IPC）。
 *      RDP 模式（首消息自动嗅探）：ironrdp-wasm 客户端期望 ws 侧已完成
 *      RDCleanPath ASN.1 协商 + TLS 终止——首条完整消息命中 RDCleanPath
 *      Request（DER SEQUENCE，version 3390）时进入 rdp 握手：把客户端
 *      X.224 Connection Request 写入既有 TCP 连接 → 读 X.224 Confirm →
 *      node:tls 升级（RDP 自签证书，rejectUnauthorized:false）→ 提取证书链
 *      → 回 RDCleanPath Response → 之后 TLS 明文与 ws 双向直通。
 *      （ASN.1/握手协议移植自 electerm/ironrdp-wasm example/lib/rdp-proxy.js，MIT）
 * 被 pluginHandlers 分发调用（method 以 net.socket.* 开头）；
 * 插件关闭/休眠时经 PluginRuntimeScope disposer → releaseSockets 释放。
 * 安全：
 * - 单插件并发 socket 上限 8；
 * - 连接超时（缺省 10s）与每连接发送速率上限（1MB/s 令牌桶粗粒度背压）；
 * - serveWs 只绑 127.0.0.1，token 一次性（首个命中连接消费，其余拒绝）；
 * - 仅 outgoing，不提供 listen 能力；
 * - rdp 模式不做二次连接：忽略请求中的 destination，TLS 升级固定作用于
 *   net.socket.connect 已建立的那条连接（目标选择权始终在 connect 调用侧）。
 * 关键依赖：node:net / node:tls / node:crypto / PluginHost 事件通道 /
 * wsFrames（帧编解码）。
 */
import * as net from 'node:net'
import * as tls from 'node:tls'
import { randomUUID, timingSafeEqual } from 'node:crypto'
import type { PluginEventPayload } from '@shared/types/ipc'
import { pluginHost } from '@main/plugin/PluginHost'
import { getRuntimeScope, type PluginRuntimeScope } from '@main/plugin/PluginRuntimeScope'
import {
  decodeWsFrame,
  encodeWsBinary,
  encodeWsClose,
  encodeWsPong,
  handshakeResponse,
  WS_OPCODE
} from '@main/net/wsFrames'

/** 单插件并发 socket 上限 */
export const MAX_SOCKETS_PER_PLUGIN = 8
/** 缺省连接超时 */
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000
/** 单 socket 发送令牌桶速率（字节/秒）与容量 */
const SEND_RATE_BYTES_PER_SEC = 1024 * 1024
const SEND_BURST_BYTES = 2 * 1024 * 1024
/** 插件事件推送节流（net.data）：64KB / 20ms 双阈值 */
const EMIT_MIN_BYTES = 64 * 1024
const EMIT_MIN_INTERVAL_MS = 20
/** rdp 模式握手等待上限（X.224 应答 + TLS 升级合计） */
const RDP_HANDSHAKE_TIMEOUT_MS = 15_000
/** rdp 模式首消息（RDCleanPath Request）大小上限 */
const RDP_REQUEST_MAX_BYTES = 64 * 1024

// ── RDCleanPath ASN.1 DER（协议常量；移植自 electerm/ironrdp-wasm rdp-proxy.js，MIT）──
/** RDCleanPath 协议版本号：3389 + 1 */
const RDP_CLEAN_PATH_VERSION = 3390
const TAG_SEQUENCE = 0x30
const TAG_INTEGER = 0x02
const TAG_OCTET_STRING = 0x04
const TAG_UTF8STRING = 0x0c
/** context-specific EXPLICIT tag [n]（constructed） */
const TAG_CTX = (n: number): number => 0xa0 + n

function derEncodeLength(length: number): Buffer {
  if (length < 0x80) return Buffer.from([length])
  const bytes: number[] = []
  let temp = length
  while (temp > 0) {
    bytes.unshift(temp & 0xff)
    temp >>= 8
  }
  return Buffer.from([0x80 | bytes.length, ...bytes])
}

function derWrap(tag: number, content: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), derEncodeLength(content.length), content])
}

function derEncodeInteger(value: number): Buffer {
  if (value === 0) return derWrap(TAG_INTEGER, Buffer.from([0]))
  const bytes: number[] = []
  let temp = value
  while (temp > 0) {
    bytes.unshift(temp & 0xff)
    temp >>= 8
  }
  if (bytes[0] & 0x80) bytes.unshift(0)
  return derWrap(TAG_INTEGER, Buffer.from(bytes))
}

function derEncodeUtf8String(str: string): Buffer {
  return derWrap(TAG_UTF8STRING, Buffer.from(str, 'utf-8'))
}

function derEncodeOctetString(buf: Buffer): Buffer {
  return derWrap(TAG_OCTET_STRING, buf)
}

function derWrapContext(tagNum: number, content: Buffer): Buffer {
  return derWrap(TAG_CTX(tagNum), content)
}

interface DerTlv { tag: number; value: Buffer; totalLength: number }

function derDecodeLength(buf: Buffer, offset: number): { length: number; bytesRead: number } {
  if (offset >= buf.length) throw new Error('invalid DER length')
  const first = buf[offset]
  if (first < 0x80) return { length: first, bytesRead: 1 }
  const numBytes = first & 0x7f
  if (!numBytes || numBytes > 4 || offset + 1 + numBytes > buf.length) throw new Error('invalid DER length')
  let length = 0
  for (let i = 0; i < numBytes; i++) length = length * 256 + buf[offset + 1 + i]
  return { length, bytesRead: 1 + numBytes }
}

function derDecodeTLV(buf: Buffer, offset: number): DerTlv {
  const tag = buf[offset]
  const { length, bytesRead } = derDecodeLength(buf, offset + 1)
  const headerLen = 1 + bytesRead
  if (offset + headerLen + length > buf.length) throw new Error('truncated DER value')
  return { tag, value: buf.subarray(offset + headerLen, offset + headerLen + length), totalLength: headerLen + length }
}

function derDecodeInteger(buf: Buffer): number {
  let val = 0
  for (let i = 0; i < buf.length; i++) val = (val << 8) | buf[i]
  return val
}

function derDecodeChildren(buf: Buffer): DerTlv[] {
  const children: DerTlv[] = []
  let offset = 0
  while (offset < buf.length) {
    const tlv = derDecodeTLV(buf, offset)
    children.push(tlv)
    offset += tlv.totalLength
  }
  return children
}

export interface RdpCleanPathRequest {
  destination: string
  proxyAuth: string
  x224ConnectionRequest: Buffer
  preconnectionBlob?: string
}

/**
 * 解析 RDCleanPath Request PDU（DER）。
 * 结构：SEQUENCE { [0] version INTEGER, [2] destination UTF8String,
 *   [3] proxy_auth UTF8String?, [5] preconnection_blob UTF8String?,
 *   [6] x224_connection_pdu OCTET STRING }（缺省字段可省略）
 */
export function parseRdpCleanPathRequest(data: Buffer): RdpCleanPathRequest {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data)
  const outer = derDecodeTLV(buf, 0)
  if (outer.totalLength !== buf.length) throw new Error('trailing DER data')
  if (outer.tag !== TAG_SEQUENCE) {
    throw new Error(`RDCleanPath: expected SEQUENCE (0x30), got 0x${outer.tag.toString(16)}`)
  }
  let version: number | null = null
  let destination: string | null = null
  let proxyAuth = ''
  let x224ConnectionRequest: Buffer | null = null
  let preconnectionBlob: string | undefined
  for (const child of derDecodeChildren(outer.value)) {
    switch (child.tag & 0x1f) {
      case 0: version = derDecodeInteger(derDecodeTLV(child.value, 0).value); break
      case 2: destination = derDecodeTLV(child.value, 0).value.toString('utf-8'); break
      case 3: proxyAuth = derDecodeTLV(child.value, 0).value.toString('utf-8'); break
      case 5: preconnectionBlob = derDecodeTLV(child.value, 0).value.toString('utf-8'); break
      case 6: x224ConnectionRequest = derDecodeTLV(child.value, 0).value; break
    }
  }
  if (version !== RDP_CLEAN_PATH_VERSION) {
    throw new Error(`RDCleanPath: unsupported version ${version} (expected ${RDP_CLEAN_PATH_VERSION})`)
  }
  if (!destination) throw new Error('RDCleanPath: missing destination')
  if (!x224ConnectionRequest) throw new Error('RDCleanPath: missing x224_connection_pdu')
  return { destination, proxyAuth, x224ConnectionRequest, preconnectionBlob }
}

/** 构造 RDCleanPath Response PDU（DER）：version + X.224 Confirm + 证书链 + server_addr */
export function buildRdpCleanPathResponse(serverAddr: string, x224Response: Buffer, certChain: Buffer[]): Buffer {
  const parts = [
    derWrapContext(0, derEncodeInteger(RDP_CLEAN_PATH_VERSION)),
    derWrapContext(6, derEncodeOctetString(x224Response)),
    derWrapContext(7, derWrap(TAG_SEQUENCE, Buffer.concat(certChain.map(derEncodeOctetString)))),
    derWrapContext(9, derEncodeUtf8String(serverAddr))
  ]
  return derWrap(TAG_SEQUENCE, Buffer.concat(parts))
}

/** 构造 RDCleanPath Error PDU（DER）。errorCode：1=general 2=negotiation */
export function buildRdpCleanPathError(errorCode: number, httpStatusCode?: number): Buffer {
  const errParts = [derWrapContext(0, derEncodeInteger(errorCode))]
  if (httpStatusCode != null) errParts.push(derWrapContext(1, derEncodeInteger(httpStatusCode)))
  return derWrap(TAG_SEQUENCE, Buffer.concat([
    derWrapContext(0, derEncodeInteger(RDP_CLEAN_PATH_VERSION)),
    derWrapContext(1, derWrap(TAG_SEQUENCE, Buffer.concat(errParts)))
  ]))
}

/**
 * 首字节嗅探：RDCleanPath Request 一定是 DER SEQUENCE（0x30）开头且
 * 后随 DER 长度。VNC/RFB（"RFB 003.008\n"）、HTTP 等文本首字节均不命中，
 * 可作低误报的模式判别。
 */
export function looksLikeRdpCleanPathRequest(buf: Buffer): boolean {
  if (buf.length < 8 || buf[0] !== TAG_SEQUENCE) return false
  const second = buf[1]
  if (second < 0x80) return buf.length >= 2 + second
  const numBytes = second & 0x7f
  if (numBytes === 0 || numBytes > 4) return false // indefinite / 超长编码不认
  if (buf.length < 2 + numBytes) return false
  return true
}

/** 从 node:tls peer certificate 提取 DER 证书链（自签循环保护） */
function extractCertChain(peerCert: tls.DetailedPeerCertificate | null): Buffer[] {
  const certs: Buffer[] = []
  if (!peerCert?.raw) return certs
  const seen = new Set<string>()
  let current: tls.DetailedPeerCertificate | undefined = peerCert
  while (current?.raw) {
    const fingerprint = current.fingerprint256 || current.raw.toString('hex')
    if (seen.has(fingerprint)) break
    seen.add(fingerprint)
    certs.push(Buffer.from(current.raw))
    current = current.issuerCertificate && current.issuerCertificate !== current ? current.issuerCertificate : undefined
  }
  return certs
}

export interface BridgeSocket {
  socketId: string
  pluginId: string
  host: string
  port: number
  tls: boolean
  /** 归属 ssh 隧道会话（衔接 tunnel.open 的本地口时记录，便于诊断） */
  sessionId?: string
  status: 'connecting' | 'connected' | 'closed'
  socket: net.Socket
  scope: PluginRuntimeScope
  releaseActivity: () => void
  onScopeAbort?: () => void
  detachScope?: () => void
  /** 发送令牌桶余额与上次补充时间 */
  sendTokens: number
  sendTokensAt: number
  /** 接收节流累积缓冲 */
  pendingRx: Buffer[]
  pendingRxBytes: number
  pendingRxTimer?: NodeJS.Timeout
  /** ws 桥（serveWs 后建立） */
  wsBridge?: WsBridge
  /** rdp 模式：TLS 升级后的明文 socket（替换 entry.socket 参与 rx/tx） */
  tlsSocket?: tls.TLSSocket
  openedAt: number
  rxBytes: number
  txBytes: number
}

interface WsBridge {
  revokeEndpoint?: () => void
  expiresAt?: number
  expiryTimer?: NodeJS.Timeout
  server: net.Server
  port: number
  token: string
  /** 一次性：接受首个带对 token 的连接后置 true */
  consumed: boolean
  client?: net.Socket
  /** client 分帧累积缓冲 */
  clientBuf: Buffer
  closed: boolean
  /**
   * rdp 协商状态：
   * - 'detect'：首条完整消息未到，等待嗅探（RDCleanPath Request 或直通流）
   * - 'negotiating'：已收到 Request，TCP 侧等待 X.224 Confirm + TLS 升级
   * - undefined：非 rdp（首消息非 DER）或协商完成，进入明文直通
   */
  rdpState?: 'detect' | 'negotiating'
  /** rdp 握手期间缓存 ws 侧先行到达的帧载荷（协商完成后按序补发） */
  rdpPendingTx: Buffer[]
  /** rdp 握手失败原因（回 Error PDU 后关桥） */
  rdpError?: string
  clients?: Set<net.Socket>
  fragmentOpcode?: number
  fragments?: Buffer[]
  fragmentBytes?: number
}

const sockets = new Map<string, BridgeSocket>()
let socketSeq = 0

function nextSocketId(): string {
  return `sk-${++socketSeq}-${randomUUID().slice(0, 8)}`
}

function emitToPlugin(pluginId: string, socketId: string, payload: PluginEventPayload): void {
  const entry = sockets.get(socketId)
  if (!entry || entry.pluginId !== pluginId || entry.status === 'closed') return
  if (!entry.scope.isCurrent() || entry.scope.signal.aborted || !pluginHost.isOpened(pluginId)) return
  pluginHost.sendEvent(pluginId, payload)
}

function isSocketCurrent(entry: BridgeSocket): boolean {
  return (
    sockets.get(entry.socketId) === entry &&
    entry.status !== 'closed' &&
    !entry.scope.signal.aborted &&
    entry.scope.isCurrent()
  )
}

/** 当前数据通道：rdp 模式 TLS 升级后为 tlsSocket（明文），否则原始 socket */
function activeDataSocket(entry: BridgeSocket): net.Socket {
  return entry.tlsSocket ?? entry.socket
}

/** flush 接收节流缓冲：合并为单帧推送（ws 桥直通二进制，否则 base64 IPC） */
function flushRx(entry: BridgeSocket): void {
  if (entry.pendingRxTimer) { clearTimeout(entry.pendingRxTimer); entry.pendingRxTimer = undefined }
  if (entry.pendingRxBytes === 0) return
  const merged = Buffer.concat(entry.pendingRx)
  entry.pendingRx = []
  entry.pendingRxBytes = 0
  entry.rxBytes += merged.byteLength
  const ws = entry.wsBridge
  if (ws?.client && !ws.closed) {
    if (ws.client.writableLength + merged.length > 4 * 1024 * 1024) { closeSocket(entry, 'WebSocket receive buffer exceeded'); return }
    try { ws.client.write(encodeWsBinary(merged)); return } catch { /* client 半关：回退 IPC */ }
  }
  emitToPlugin(entry.pluginId, entry.socketId, {
    type: 'net.data',
    socketId: entry.socketId,
    chunk: merged.toString('base64')
  })
}

function scheduleRx(entry: BridgeSocket, chunk: Buffer): void {
  entry.pendingRx.push(chunk)
  entry.pendingRxBytes += chunk.byteLength
  if (entry.pendingRxBytes >= EMIT_MIN_BYTES) {
    flushRx(entry)
    return
  }
  if (!entry.pendingRxTimer) {
    entry.pendingRxTimer = setTimeout(() => flushRx(entry), EMIT_MIN_INTERVAL_MS)
  }
}

function closeWsBridge(ws: WsBridge, code: number): void {
  if (ws.closed) return
  ws.closed = true
  ws.fragments = undefined
  ws.rdpPendingTx = []
  ws.clientBuf = Buffer.alloc(0)
  ws.revokeEndpoint?.()
  if (ws.expiryTimer) clearTimeout(ws.expiryTimer)
  try { ws.client?.write(encodeWsClose(code)) } catch { /* 已断 */ }
  ws.client?.destroy()
  ws.client = undefined
  for (const client of ws.clients ?? []) client.destroy()
  ws.clients?.clear()
  ws.server.close()
  // Node 18.2+：销毁残留连接（旧类型声明缺失，探测式调用）
  ;(ws.server as net.Server & { closeAllConnections?: () => void }).closeAllConnections?.()
}

function closeSocket(entry: BridgeSocket, reason: string): void {
  if (entry.status === 'closed') return
  // 关闭原因先于状态翻转生效：插件主动 close / scope 释放路径同样能收到 net.close 通知
  emitToPlugin(entry.pluginId, entry.socketId, { type: 'net.close', socketId: entry.socketId, reason })
  entry.status = 'closed'
  flushRx(entry)
  if (entry.wsBridge && !entry.wsBridge.closed) closeWsBridge(entry.wsBridge, 1000)
  // 连接失败路径 socket 尚未赋值（null 占位），destroy 需判空
  entry.socket?.destroy()
  entry.tlsSocket?.destroy()
  if (entry.onScopeAbort) entry.scope.signal.removeEventListener('abort', entry.onScopeAbort)
  entry.detachScope?.()
  entry.releaseActivity()
  sockets.delete(entry.socketId)
}

function attachSocket(entry: BridgeSocket, target?: net.Socket): void {
  const socket = target ?? entry.socket
  socket.on('data', (chunk: Buffer) => {
    if (!isSocketCurrent(entry)) { socket.destroy(); return }
    // rdp 模式：raw socket 只承载 X.224/TLS 记录层；明文数据仅来自 tlsSocket
    if (socket !== activeDataSocket(entry)) return
    scheduleRx(entry, chunk)
  })
  socket.on('error', (err: Error) => closeSocket(entry, err.message))
  socket.on('close', () => {
    // TLS 升级会复用同一 raw socket；仅当事件源即当前数据通道时才判定关闭
    if (socket === activeDataSocket(entry)) closeSocket(entry, 'closed')
  })
}

export interface SocketConnectInput {
  sessionId?: string
  host?: string
  port?: number
  tls?: boolean
  timeoutMs?: number
}

export async function socketConnect(
  pluginId: string,
  input: SocketConnectInput
): Promise<{ socketId: string }> {
  const host = String(input?.host ?? '').trim()
  const port = Number(input?.port)
  if (!host || /[\s\0]/.test(host)) throw new Error('host required')
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('port invalid')
  const own = [...sockets.values()].filter(s => s.pluginId === pluginId && s.status !== 'closed')
  if (own.length >= MAX_SOCKETS_PER_PLUGIN) {
    throw new Error(`socket limit reached (${MAX_SOCKETS_PER_PLUGIN} per plugin)`)
  }
  const scope = getRuntimeScope(pluginId)
  if (!scope || !scope.isCurrent() || scope.signal.aborted) throw new Error('plugin runtime is closing')
  const timeoutMs = Math.min(60_000, Math.max(1_000, Number(input?.timeoutMs) || DEFAULT_CONNECT_TIMEOUT_MS))
  const socketId = nextSocketId()
  const useTls = input?.tls === true
  const entry: BridgeSocket = {
    socketId, pluginId, host, port, tls: useTls,
    sessionId: input?.sessionId ? String(input.sessionId) : undefined,
    status: 'connecting',
    socket: null as never as net.Socket,
    scope,
    releaseActivity: scope.acquireActivity('net:socket'),
    sendTokens: SEND_BURST_BYTES,
    sendTokensAt: Date.now(),
    pendingRx: [],
    pendingRxBytes: 0,
    openedAt: Date.now(),
    rxBytes: 0,
    txBytes: 0
  }
  sockets.set(socketId, entry)
  entry.onScopeAbort = () => closeSocket(entry, 'plugin runtime closed')
  scope.signal.addEventListener('abort', entry.onScopeAbort, { once: true })
  entry.detachScope = scope.addDisposer(() => closeSocket(entry, 'scope disposed'))
  try {
    const transport = await openHostProxy({ host, port }, { signal: scope.signal, timeoutMs, ownSocket: socket => { entry.socket = socket } })
    if (!isSocketCurrent(entry)) throw new Error('plugin runtime closed')
    const socket: net.Socket = transport && !useTls ? transport : await new Promise((resolve, reject) => {
      const onFail = (err: Error): void => reject(err)
      let settled = false
      const s = useTls
        ? tls.connect({ ...(transport ? { socket: transport } : { host, port }), rejectUnauthorized: true, servername: net.isIP(host) ? undefined : host }, () => {
            if (settled) return
            settled = true; resolve(s)
          })
        : net.connect({ host, port }, () => {
            if (settled) return
            settled = true; resolve(s)
          })
      entry.socket = s
      const aborted = (): void => { if (!settled) { settled = true; clearTimeout(timer); s.destroy(); reject(new Error('plugin runtime closed')) } }
      scope.signal.addEventListener('abort', aborted, { once: true })
      s.once('close', () => scope.signal.removeEventListener('abort', aborted))
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        s.destroy()
        reject(new Error(`connect failed: timeout (${timeoutMs}ms)`))
      }, timeoutMs)
      s.once('error', (err: Error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        onFail(err)
      })
      const done = (): void => clearTimeout(timer)
      s.once(useTls ? 'secureConnect' : 'connect', done)
    })
    if (!isSocketCurrent(entry)) { socket.destroy(); throw new Error('plugin runtime closed') }
    entry.socket = socket
    entry.status = 'connected'
    attachSocket(entry)
    socket.resume()
    return { socketId }
  } catch (err) {
    closeSocket(entry, (err as Error).message)
    const raw = (err as Error).message
    const msg = /ENOTFOUND|EAI_AGAIN/.test(raw)
      ? `connect failed: host not found (${host})`
      : /ETIMEDOUT/.test(raw)
        ? `connect failed: timeout (${timeoutMs}ms)`
        : /ECONNREFUSED/.test(raw)
          ? `connect failed: connection refused (${host}:${port})`
          : raw.startsWith('connect failed:') ? raw : `connect failed: ${raw}`
    throw new Error(msg)
  }
}

function requireOwnedSocket(pluginId: string, socketId: string): BridgeSocket {
  const entry = sockets.get(String(socketId ?? ''))
  if (!entry || entry.pluginId !== pluginId) throw new Error('socket not found')
  return entry
}

/** 补充令牌桶并返回当前余额 */
function refillSendTokens(entry: BridgeSocket): number {
  const now = Date.now()
  const elapsed = Math.max(0, now - entry.sendTokensAt)
  entry.sendTokensAt = now
  entry.sendTokens = Math.min(
    SEND_BURST_BYTES,
    entry.sendTokens + Math.floor((elapsed / 1000) * SEND_RATE_BYTES_PER_SEC)
  )
  return entry.sendTokens
}

export interface SocketSendResult {
  sent: number
}

export function socketSend(
  pluginId: string,
  socketId: string,
  data: string
): SocketSendResult {
  const entry = requireOwnedSocket(pluginId, socketId)
  if (entry.status !== 'connected') throw new Error('socket not connected')
  if (typeof data !== 'string' || data.length === 0) throw new Error('data required (base64 or utf8)')
  // base64 优先：形如合法 base64 且长度对齐则按二进制发送；否则按 utf8 文本
  let buf: Buffer
  if (data.length % 4 === 0 && data.length > 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(data)) {
    buf = Buffer.from(data, 'base64')
  } else {
    buf = Buffer.from(data, 'utf8')
  }
  if (buf.byteLength > refillSendTokens(entry)) {
    throw new Error(`send rate limited (${SEND_RATE_BYTES_PER_SEC} B/s per socket)`)
  }
  entry.sendTokens -= buf.byteLength
  entry.txBytes += buf.byteLength
  // socket.write 为异步缓冲写；失败统一走 'error' 事件 → net.close
  if (activeDataSocket(entry).writableLength + buf.length > SEND_BURST_BYTES) throw new Error('socket write buffer exceeded')
  activeDataSocket(entry).write(buf)
  return { sent: buf.byteLength }
}

export function socketClose(pluginId: string, socketId: string): boolean {
  const entry = sockets.get(String(socketId ?? ''))
  if (!entry || entry.pluginId !== pluginId) return false
  closeSocket(entry, 'closed by plugin')
  return true
}

export interface SocketListItem {
  socketId: string
  host: string
  port: number
  tls: boolean
  sessionId?: string
  status: string
  openedAt: number
  rxBytes: number
  txBytes: number
  ws?: { port: number; url: string } | null
}

export function socketList(pluginId: string): SocketListItem[] {
  return [...sockets.values()]
    .filter(s => s.pluginId === pluginId)
    .map(s => ({
      socketId: s.socketId,
      host: s.host,
      port: s.port,
      tls: s.tls,
      sessionId: s.sessionId,
      status: s.status,
      openedAt: s.openedAt,
      rxBytes: s.rxBytes,
      txBytes: s.txBytes,
      ws: s.wsBridge ? { port: s.wsBridge.port, url: `ws://127.0.0.1:${s.wsBridge.port}/bridge` } : null
    }))
}

/** token 常量时间比较（防时序侧信道） */
function tokenMatches(expected: string, actual: string): boolean {
  const a = Buffer.from(expected)
  const b = Buffer.from(actual)
  return a.length === b.length && timingSafeEqual(a, b)
}

/** 处理 ws client 帧：binary/text → socket 写；ping → pong；close → 关桥 */
function handleClientFrames(entry: BridgeSocket, ws: WsBridge): void {
  while (true) {
    if (ws.clientBuf.length >= 2 && (!(ws.clientBuf[1] & 0x80) || (ws.clientBuf[0] & 0x70))) throw new Error('invalid client WebSocket frame')
    const decoded = decodeWsFrame(ws.clientBuf)
    if (!decoded) return
    ws.clientBuf = ws.clientBuf.subarray(decoded.offset)
    let { opcode, payload } = decoded.frame
    const { fin } = decoded.frame
    if (![0, 1, 2, 8, 9, 10].includes(opcode) || (opcode >= 8 && (!fin || payload.length > 125))) throw new Error('invalid WebSocket frame')
    if (opcode === WS_OPCODE.continuation) {
      if (!ws.fragments || ws.fragmentOpcode === undefined) throw new Error('unexpected WebSocket continuation')
      ws.fragmentBytes = (ws.fragmentBytes ?? 0) + payload.length
      if (ws.fragmentBytes > 16 * 1024 * 1024 || ws.fragments.length >= 256) throw new Error('WebSocket fragment budget exceeded')
      ws.fragments.push(payload)
      if (!fin) continue
      opcode = ws.fragmentOpcode; payload = Buffer.concat(ws.fragments)
      ws.fragments = undefined; ws.fragmentOpcode = undefined; ws.fragmentBytes = 0
    } else if (opcode === WS_OPCODE.binary || opcode === WS_OPCODE.text) {
      if (ws.fragments) throw new Error('interleaved WebSocket messages')
      if (!fin) { ws.fragmentOpcode = opcode; ws.fragments = [payload]; ws.fragmentBytes = payload.length; continue }
    }
    if (opcode === WS_OPCODE.binary || opcode === WS_OPCODE.text) {
      if (payload.byteLength === 0) continue
      // rdp 模式嗅探/协商：首条完整消息决定模式；协商中缓存后续帧
      if (ws.rdpState === 'detect' || ws.rdpState === 'negotiating') {
        if (payload.byteLength > RDP_REQUEST_MAX_BYTES) {
          ws.rdpError = 'RDCleanPath request too large'
          closeWsBridge(ws, 1009)
          return
        }
        if (ws.rdpState === 'detect') {
          if (!looksLikeRdpCleanPathRequest(payload)) {
            // 非 rdp 客户端（noVNC RFB 等）：立即转直通并补发首帧
            ws.rdpState = undefined
            ws.rdpPendingTx = []
            writeThrough(entry, ws, payload)
            continue
          }
          ws.rdpState = 'negotiating'
          ws.rdpPendingTx = [payload]
          void beginRdpUpgrade(entry, ws, payload)
          continue
        }
        if (ws.rdpPendingTx.reduce((total, part) => total + part.length, 0) + payload.length > 256 * 1024 || ws.rdpPendingTx.length >= 128) throw new Error('RDP negotiation buffer exceeded')
        ws.rdpPendingTx.push(payload)
        continue
      }
      writeThrough(entry, ws, payload)
    } else if (opcode === WS_OPCODE.ping) {
      try { ws.client?.write(encodeWsPong(payload)) } catch { /* 忽略 */ }
    } else if (opcode === WS_OPCODE.close) {
      closeWsBridge(ws, 1000)
      return
    }
    // continuation 帧合并交由调用方（noVNC/rdp 端不发分片；简化丢弃 FIN=0 后的非续帧）
  }
}

/** ws → TCP 直写（令牌桶限速；超限关桥 1008） */
function writeThrough(entry: BridgeSocket, ws: WsBridge, payload: Buffer): void {
  if (entry.status !== 'connected') return
  if (payload.byteLength > refillSendTokens(entry)) {
    closeWsBridge(ws, 1008)
    return
  }
  entry.sendTokens -= payload.byteLength
  entry.txBytes += payload.byteLength
  if (activeDataSocket(entry).writableLength + payload.length > SEND_BURST_BYTES) { closeWsBridge(ws, 1009); return }
  activeDataSocket(entry).write(payload)
}

/**
 * rdp 升级：解析 RDCleanPath Request → X.224 写入既有 TCP → 读 Confirm →
 * TLS 升级（自签放行）→ 回 Response → 明文直通。任一步失败回 Error PDU
 * （best-effort）后关桥；socket 本体不关闭（插件可诊断后重连/释放）。
 */
async function beginRdpUpgrade(entry: BridgeSocket, ws: WsBridge, firstPayload: Buffer): Promise<void> {
  const fail = (message: string): void => {
    if (ws.closed) return
    try { ws.client?.write(encodeWsBinary(buildRdpCleanPathError(1, 502))) } catch { /* 已断 */ }
    ws.rdpError = message
    closeWsBridge(ws, 1011)
  }
  if (entry.status !== 'connected') return fail('socket not connected')
  let request: RdpCleanPathRequest
  try {
    request = parseRdpCleanPathRequest(firstPayload)
  } catch (err) {
    return fail((err as Error).message)
  }
  const raw = entry.socket
  const serverAddr = `${entry.host}:${entry.port}`
  // 暂时脱离 raw socket 的事件接线：X.224/TLS 字节由本函数亲自消费，
  // 避免 attachSocket 的 data 监听把记录层字节灌入明文 rx 流。
  const detachRaw = (): void => { raw.removeAllListeners('data'); raw.removeAllListeners('error'); raw.removeAllListeners('close') }
  try {
    // 1) X.224 Connection Request 写入既有 TCP 连接（目标由 connect 时决定，忽略 request.destination）
    const x224Request = request.x224ConnectionRequest
    detachRaw()
    raw.write(x224Request)
    // 2) 读 X.224 Connection Confirm（整段或首包）
    const x224Response = await new Promise<Buffer>((resolve, reject) => {
      const timer = setTimeout(() => { reject(new Error('RDP handshake timeout (X.224)')) }, RDP_HANDSHAKE_TIMEOUT_MS)
      const onData = (chunk: Buffer): void => {
        clearTimeout(timer)
        if (chunk.length === 0) { reject(new Error('RDP server closed without X.224 response')); return }
        resolve(chunk)
      }
      const onError = (err: Error): void => { clearTimeout(timer); reject(new Error(`RDP connection failed: ${err.message}`)) }
      raw.once('data', onData)
      raw.once('error', onError)
    })
    // 3) TLS 升级（先取得证书，宿主原生确认后才向插件交付连接）
    entry.tlsSocket = await new Promise<tls.TLSSocket>((resolve, reject) => {
      const timer = setTimeout(() => { reject(new Error('RDP handshake timeout (TLS)')) }, RDP_HANDSHAKE_TIMEOUT_MS)
      const tlsSocket = tls.connect(
        { socket: raw, servername: net.isIP(entry.host) ? undefined : entry.host, rejectUnauthorized: false },
        () => {
          clearTimeout(timer)
          resolve(tlsSocket)
        }
      )
      tlsSocket.once('error', (err: Error) => { clearTimeout(timer); reject(new Error(`RDP TLS handshake failed: ${err.message}`)) })
    })
    const certificate = entry.tlsSocket.getPeerCertificate()
    if (!certificate.fingerprint256) throw new Error('RDP server did not supply a certificate fingerprint')
    await confirmPluginOperation(entry.pluginId, '信任此远程桌面服务器证书？', `服务器：${serverAddr}\nSHA-256：${certificate.fingerprint256}\n请核实此指纹后继续；本次连接才会发送登录信息。`)
    // 4) 提取证书链 + 回 RDCleanPath Response
    const certChain = extractCertChain(entry.tlsSocket.getPeerCertificate(true) as tls.DetailedPeerCertificate)
    if (ws.closed) { entry.tlsSocket.destroy(); entry.tlsSocket = undefined; return }
    attachSocket(entry, entry.tlsSocket)
    ws.rdpState = undefined
    const pending = ws.rdpPendingTx
    ws.rdpPendingTx = []
    try { ws.client?.write(encodeWsBinary(buildRdpCleanPathResponse(serverAddr, x224Response, certChain))) } catch { /* 已断 */ }
    // 5) 协商期间缓存的 ws 帧按序补发（含原始 Request 之外的首批明文）
    for (const payload of pending.slice(1)) writeThrough(entry, ws, payload)
  } catch (err) {
    detachRaw()
    // TLS 失败后 raw socket 状态不可靠，整条关闭交由插件重连
    closeSocket(entry, `rdp: ${(err as Error).message}`)
    fail((err as Error).message)
  }
}

export interface ServeWsResult {
  url: string
  token: string
  port: number
}

/**
 * 为已连接 socket 起本地 WebSocket 桥：
 * - 127.0.0.1 随机端口；路径 /bridge?token=xxx（token 一次性，32 字节随机）；
 * - 校验 Upgrade 头 + Sec-WebSocket-Key（无扩展协商，permessage-deflate 拒绝）；
 * - 桥接期间 socket 的 rx 直写 ws 二进制帧，ws 的 binary/text 帧直写 socket；
 * - client 断开仅关桥（socket 保留，可再 serveWs 或继续 net.data 推送）。
 */
export async function socketServeWs(
  pluginId: string,
  socketId: string
): Promise<ServeWsResult> {
  const entry = requireOwnedSocket(pluginId, socketId)
  if (entry.status !== 'connected') throw new Error('socket not connected')
  if (entry.wsBridge && !entry.wsBridge.closed) {
    // 复用既有桥：刷新 token 防泄漏（旧 url 立即失效）
    const token = randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '')
    entry.wsBridge.token = token
    entry.wsBridge.consumed = false
    entry.wsBridge.expiresAt = Date.now() + 30_000
    if (entry.wsBridge.expiryTimer) clearTimeout(entry.wsBridge.expiryTimer)
    entry.wsBridge.expiryTimer = setTimeout(() => { if (!entry.wsBridge?.consumed && entry.wsBridge) closeWsBridge(entry.wsBridge, 1008) }, 30_000)
    return { url: `ws://127.0.0.1:${entry.wsBridge.port}/bridge?token=${token}`, token, port: entry.wsBridge.port }
  }
  const token = randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '')
  const ws: WsBridge = {
    server: null as never as net.Server,
    port: 0,
    token,
    consumed: false,
    clientBuf: Buffer.alloc(0),
    closed: false,
    rdpState: 'detect',
    rdpPendingTx: []
  }
  const clients = new Set<net.Socket>()
  ws.clients = clients
  const consumeFrames = (): void => {
    try { if (ws.clientBuf.length > 16 * 1024 * 1024 + 14) throw new Error('frame buffer exceeded'); handleClientFrames(entry, ws) }
    catch { closeWsBridge(ws, 1002) }
  }
  const server = net.createServer((client: net.Socket) => {
    if (clients.size >= 4 || ws.consumed || ws.closed) { client.destroy(); return }
    clients.add(client)
    client.setTimeout(5000, () => { if (!upgraded) client.destroy() })
    let upgraded = false
    let httpBuf = Buffer.alloc(0)
    const fail = (): void => { client.destroy() }
    client.on('data', (chunk: Buffer) => {
      if (ws.closed) return fail()
      if (!upgraded) {
        httpBuf = Buffer.concat([httpBuf, chunk])
        const headerEnd = httpBuf.indexOf('\r\n\r\n')
        if (headerEnd < 0) {
          if (httpBuf.length > 16 * 1024) fail()
          return
        }
        if (headerEnd > 16 * 1024) return fail()
        const head = httpBuf.subarray(0, headerEnd).toString('latin1')
        const rest = httpBuf.subarray(headerEnd + 4)
        httpBuf = Buffer.alloc(0)
        const lines = head.split('\r\n')
        const requestLine = lines[0] ?? ''
        if (!/^GET\s+\/bridge(\?|\s)/.test(requestLine)) return fail()
        const urlQuery = requestLine.split(' ')[1] ?? ''
        const tokenParam = new URLSearchParams(urlQuery.split('?')[1] ?? '').get('token') ?? ''
        if (!tokenMatches(ws.token, tokenParam) || ws.consumed) return fail()
        const headers = new Map<string, string>()
        for (const line of lines.slice(1)) {
          const idx = line.indexOf(':')
          if (idx > 0) headers.set(line.slice(0, idx).trim().toLowerCase(), line.slice(idx + 1).trim())
        }
        if ((headers.get('upgrade') ?? '').toLowerCase() !== 'websocket') return fail()
        if ((headers.get('sec-websocket-extensions') ?? '') !== '') return fail() // 不协商扩展
        const key = headers.get('sec-websocket-key')
        if (!key || Buffer.from(key, 'base64').length !== 16 || headers.get('sec-websocket-version') !== '13') return fail()
        // 一次性消费：并发第二连接即使 token 对也被拒
        if (!isSocketCurrent(entry) || Date.now() > (ws.expiresAt ?? 0)) return fail()
        const origin = headers.get('origin')
        const dev = pluginRegistry.get(pluginId)?.devUrl
        const expectedOrigin = dev ? new URL(dev).origin : 'enest://plugin'
        if (origin !== expectedOrigin || headers.get('host') !== `127.0.0.1:${ws.port}`) return fail()
        ws.consumed = true
        if (ws.expiryTimer) clearTimeout(ws.expiryTimer)
        upgraded = true
        client.setTimeout(0)
        ws.client = client
        client.write(handshakeResponse(key), () => { /* flush */ })
        if (rest.length > 0) {
          ws.clientBuf = Buffer.concat([ws.clientBuf, rest])
          consumeFrames()
        }
        flushRx(entry) // 桥建立后把积压数据直接走 ws
        return
      }
      ws.clientBuf = Buffer.concat([ws.clientBuf, chunk])
      consumeFrames()
    })
    client.on('error', () => fail())
    client.on('close', () => {
      clients.delete(client)
      if (ws.client === client) {
        ws.client = undefined
        closeWsBridge(ws, 1000)
      }
    })
  })
  server.on('close', () => { for (const client of clients) client.destroy(); clients.clear() })
  ws.server = server
  entry.wsBridge = ws
  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject)
    // 仅绑定 127.0.0.1；禁止对外暴露
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject)
      resolve((server.address() as net.AddressInfo).port)
    })
  })
  ws.port = port
  if (!isSocketCurrent(entry)) { closeWsBridge(ws, 1001); throw new Error('socket runtime closed') }
  ws.revokeEndpoint = allowPluginEndpoint(pluginId, `ws://127.0.0.1:${port}/bridge?token=${token}`, 'webSocket')
  ws.expiresAt = Date.now() + 30_000
  ws.expiryTimer = setTimeout(() => { if (!ws.consumed) closeWsBridge(ws, 1008) }, 30_000)
  ws.expiryTimer.unref?.()
  return { url: `ws://127.0.0.1:${port}/bridge?token=${token}`, token, port }
}

/** 插件 runtime 关闭 / 休眠时释放全部 socket 与 ws 桥（PluginHost disposer 挂载） */
export function releaseSockets(pluginId: string, generation?: number): void {
  for (const entry of [...sockets.values()]) {
    if (entry.pluginId !== pluginId) continue
    if (generation !== undefined && entry.scope.owner.generation !== generation) continue
    closeSocket(entry, 'plugin runtime released')
  }
}
