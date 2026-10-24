import { openHostProxy } from '@main/net/hostProxy'
import { allowPluginEndpoint } from '@main/plugin/pluginSessionPolicy'
import { pluginRegistry } from '@main/plugin/PluginRegistry'
/**
 * socketBridge — 插件出站 TCP 连接宿主服务（net.socket.*）
 * 职责：以 node:net / node:tls 建立仅出站（outgoing）连接；按 socketId 隔离
 *      与插件归属；经 pluginHost.sendEvent 推送 net.data / net.close；
 *      serveWs 起 127.0.0.1 随机端口的自实现 RFC6455 WebSocket 服务，
 *      一次性 token 校验后把该 socket 的双向二进制流桥给插件页
 *      （仅透明传输，不识别或终止任何应用层协议）。
 * 被 pluginHandlers 分发调用（method 以 net.socket.* 开头）；
 * 插件关闭/休眠时经 PluginRuntimeScope disposer → releaseSockets 释放。
 * 安全：
 * - 单插件并发 socket 上限 8；
 * - 连接超时（缺省 10s）与每连接发送速率上限（1MB/s 令牌桶粗粒度背压）；
 * - serveWs 只绑 127.0.0.1，token 一次性（首个命中连接消费，其余拒绝）；
 * - 仅 outgoing，不提供 listen 能力；
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
export interface BridgeSocket {
  socketId: string
  pluginId: string
  host: string
  port: number
  tls: boolean
  /** 插件提供的不透明关联标识，仅用于诊断。 */
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
  if (entry.onScopeAbort) entry.scope.signal.removeEventListener('abort', entry.onScopeAbort)
  entry.detachScope?.()
  entry.releaseActivity()
  sockets.delete(entry.socketId)
}

function attachSocket(entry: BridgeSocket, target?: net.Socket): void {
  const socket = target ?? entry.socket
  socket.on('data', (chunk: Buffer) => {
    if (!isSocketCurrent(entry)) { socket.destroy(); return }
    scheduleRx(entry, chunk)
  })
  socket.on('error', (err: Error) => closeSocket(entry, err.message))
  socket.on('close', () => {
    closeSocket(entry, 'closed')
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
  data: string,
  encoding: 'utf8' | 'base64' = 'utf8'
): SocketSendResult {
  const entry = requireOwnedSocket(pluginId, socketId)
  if (entry.status !== 'connected') throw new Error('socket not connected')
  if (typeof data !== 'string' || data.length === 0) throw new Error('data required (base64 or utf8)')
  if (encoding !== 'utf8' && encoding !== 'base64') throw new Error('encoding must be utf8 or base64')
  // Text such as PING is also syntactically valid base64. Binary callers must opt in.
  if (encoding === 'base64' && (data.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data))) throw new Error('invalid base64 data')
  const buf = Buffer.from(data, encoding)
  if (buf.byteLength > refillSendTokens(entry)) {
    throw new Error(`send rate limited (${SEND_RATE_BYTES_PER_SEC} B/s per socket)`)
  }
  entry.sendTokens -= buf.byteLength
  entry.txBytes += buf.byteLength
  // socket.write 为异步缓冲写；失败统一走 'error' 事件 → net.close
  if (entry.socket.writableLength + buf.length > SEND_BURST_BYTES) throw new Error('socket write buffer exceeded')
  entry.socket.write(buf)
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
      writeThrough(entry, ws, payload)
    } else if (opcode === WS_OPCODE.ping) {
      try { ws.client?.write(encodeWsPong(payload)) } catch { /* 忽略 */ }
    } else if (opcode === WS_OPCODE.close) {
      closeWsBridge(ws, 1000)
      return
    }
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
  if (entry.socket.writableLength + payload.length > SEND_BURST_BYTES) { closeWsBridge(ws, 1009); return }
  entry.socket.write(payload)
}

export interface ServeWsResult {
  url: string
  token: string
  port: number
}

/**
 * 为已连接 socket 起本地 WebSocket 桥：
 * - 127.0.0.1 随机端口；路径 /bridge?token=xxx（token 一次性，32 字节随机）；
 * - 校验 Upgrade 头 + Sec-WebSocket-Key（忽略浏览器扩展 offer，不协商压缩）；
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
    if (!entry.wsBridge.port) throw new Error('socket bridge is still starting')
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
    closed: false
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
        // Chromium offers permessage-deflate by default; no response extension means no compression.
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
  server.on('error', () => closeWsBridge(ws, 1011))
  ws.server = server
  entry.wsBridge = ws
  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject)
    // 仅绑定 127.0.0.1；禁止对外暴露
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject)
      resolve((server.address() as net.AddressInfo).port)
    })
  }).catch(error => {
    closeWsBridge(ws, 1011)
    if (entry.wsBridge === ws) entry.wsBridge = undefined
    throw error
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
