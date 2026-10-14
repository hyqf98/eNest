/** Host-owned WebSocket connections; renderer network access stays disabled. */
import { randomUUID } from 'node:crypto'
import { isIP, type Socket } from 'node:net'
import { connect as connectTls } from 'node:tls'
import WebSocket from 'ws'
import { pluginHost } from '@main/plugin/PluginHost'
import { getRuntimeScope, type PluginRuntimeScope } from '@main/plugin/PluginRuntimeScope'
import { openHostProxy } from '@main/net/hostProxy'

const MAX_PAYLOAD = 1024 * 1024
const MAX_BUFFERED = 2 * MAX_PAYLOAD
const MAX_CONNECTIONS = 8
interface Connection {
  id: string; pluginId: string; scope: PluginRuntimeScope; ws?: WebSocket; transport?: Socket
  release: () => void; detach: () => void; abort: () => void; closed: boolean
  tokens: number; received: number; messages: number; sentMessages: number; updated: number
  timer?: ReturnType<typeof setTimeout>
  reject?: (error: Error) => void
}
const connections = new Map<string, Connection>()
function current(connection: Connection): boolean {
  return !connection.closed && connection.scope.isCurrent() && !connection.scope.signal.aborted
}
function finish(connection: Connection, code = 1000, reason = 'closed'): void {
  if (connection.closed) return
  connection.closed = true
  if (connection.timer) clearTimeout(connection.timer)
  connections.delete(connection.id)
  connection.scope.signal.removeEventListener('abort', connection.abort)
  connection.detach(); connection.release()
  connection.reject?.(new Error(reason)); connection.reject = undefined
  connection.ws?.terminate(); connection.transport?.destroy()
  if (connection.scope.isCurrent() && !connection.scope.signal.aborted) {
    pluginHost.sendEvent(connection.pluginId, { type: 'net.websocket.close', socketId: connection.id, code, reason: reason.slice(0, 200) })
  }
}
function owned(pluginId: string, id: string): Connection {
  const connection = connections.get(id)
  if (!connection || connection.pluginId !== pluginId || !current(connection)) throw new Error('WebSocket does not belong to this plugin runtime')
  return connection
}
function replenish(connection: Connection): void {
  const elapsed = Math.max(0, Date.now() - connection.updated) / 1000
  connection.updated = Date.now()
  connection.tokens = Math.min(MAX_BUFFERED, connection.tokens + elapsed * MAX_PAYLOAD)
  connection.received = Math.min(16 * MAX_PAYLOAD, connection.received + elapsed * 8 * MAX_PAYLOAD)
  connection.messages = Math.min(2000, connection.messages + elapsed * 1000)
  connection.sentMessages = Math.min(2000, connection.sentMessages + elapsed * 1000)
}

export async function websocketConnect(pluginId: string, input: { url: string; protocols?: string[] }): Promise<{ socketId: string }> {
  const scope = getRuntimeScope(pluginId)
  if (!scope || !scope.isCurrent() || scope.signal.aborted) throw new Error('plugin runtime closed')
  const url = new URL(input.url)
  if (!['ws:', 'wss:'].includes(url.protocol) || url.username || url.password || url.hash || input.url.length > 8192) throw new Error('expected a ws:// or wss:// URL without credentials or fragment')
  if (input.protocols && (!Array.isArray(input.protocols) || input.protocols.length > 16 || input.protocols.some(p => typeof p !== 'string' || p.length > 128 || !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(p)))) throw new Error('invalid WebSocket protocols')
  if ([...connections.values()].filter(item => item.pluginId === pluginId).length >= MAX_CONNECTIONS) throw new Error('WebSocket connection limit (8) reached')
  const connection: Connection = { id: `ws-${randomUUID()}`, pluginId, scope, release: scope.acquireActivity('WebSocket connection'), detach: () => {}, abort: () => {}, closed: false, tokens: MAX_BUFFERED, received: 16 * MAX_PAYLOAD, messages: 2000, sentMessages: 2000, updated: Date.now() }
  connection.abort = () => finish(connection, 1001, 'plugin runtime closed')
  connections.set(connection.id, connection)
  connection.timer = setTimeout(() => finish(connection, 1006, 'WebSocket connection timeout'), 10000)
  scope.signal.addEventListener('abort', connection.abort, { once: true })
  connection.detach = scope.addDisposer(connection.abort)
  try {
    let createConnection: WebSocket.ClientOptions['createConnection']
    const host = url.hostname.replace(/^\[|\]$/g, '')
    const transport = await openHostProxy({ host, port: Number(url.port) || (url.protocol === 'wss:' ? 443 : 80) }, {
      signal: scope.signal, timeoutMs: 10000, ownSocket: socket => { connection.transport = socket }
    })
    if (transport) createConnection = (() => url.protocol === 'wss:' ? connectTls({ socket: transport, servername: isIP(host) ? undefined : host, rejectUnauthorized: true }) : transport) as WebSocket.ClientOptions['createConnection']
    if (!current(connection)) throw new Error('plugin runtime closed')
    const ws = new WebSocket(url, input.protocols, { maxPayload: MAX_PAYLOAD, perMessageDeflate: false, followRedirects: false, handshakeTimeout: 10000, ...(createConnection ? { createConnection } : {}) })
    connection.ws = ws
    if (transport && url.protocol === 'ws:') setImmediate(() => { if (current(connection)) transport.resume() })
    return await new Promise((resolve, reject) => {
      connection.reject = reject
      ws.on('open', () => {
        if (!current(connection)) { finish(connection, 1001, 'plugin runtime closed'); return }
        connection.reject = undefined
        if (connection.timer) clearTimeout(connection.timer)
        resolve({ socketId: connection.id })
      })
      ws.on('message', (data, binary) => {
        if (!current(connection)) return
        const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data)
        replenish(connection)
        if (bytes.length > MAX_PAYLOAD || connection.received < bytes.length || --connection.messages < 0) { finish(connection, 1009, 'WebSocket receive budget exceeded'); return }
        connection.received -= bytes.length
        pluginHost.sendEvent(pluginId, { type: 'net.websocket.message', socketId: connection.id, data: bytes.toString(binary ? 'base64' : 'utf8'), binary })
      })
      ws.on('close', (code, reason) => finish(connection, code, reason.toString('utf8')))
      ws.on('error', () => finish(connection, 1011, 'WebSocket connection failed'))
    })
  } catch (error) { finish(connection, 1011, 'WebSocket connection failed'); throw error }
}
export function websocketSend(pluginId: string, id: string, data: string, binary = false): { sent: number } {
  const connection = owned(pluginId, id)
  if (typeof data !== 'string' || data.length > MAX_PAYLOAD * 2 || typeof binary !== 'boolean') throw new Error('WebSocket message must be text or base64 up to 1 MiB')
  if (binary && (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data))) throw new Error('invalid WebSocket base64 payload')
  const payload = binary ? Buffer.from(data, 'base64') : data
  if (Buffer.byteLength(payload) > MAX_PAYLOAD) throw new Error('WebSocket message exceeds 1 MiB')
  if (connection.ws?.readyState !== WebSocket.OPEN) throw new Error('WebSocket is not open')
  const bytes = Buffer.byteLength(payload)
  replenish(connection)
  if (connection.sentMessages < 1 || connection.tokens < bytes || connection.ws.bufferedAmount + bytes > MAX_BUFFERED) throw new Error('WebSocket send budget exceeded; wait before sending')
  connection.tokens -= bytes
  connection.sentMessages--
  connection.ws.send(payload, { binary })
  return { sent: bytes }
}
export function websocketClose(pluginId: string, id: string): boolean {
  finish(owned(pluginId, id))
  return true
}
