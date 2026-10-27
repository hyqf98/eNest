import { randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { clipboard } from 'electron'
import { McpServer, fromJsonSchema, isInitializeRequest, type CallToolResult } from '@modelcontextprotocol/server'
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node'
import type { McpCatalogQuery, McpConfiguration, McpStatus } from '@shared/types/mcpSettings'
import { listMcpTools } from './mcpCatalog'
import { callMcpTool, getMcpExecutionState, setMcpAccepting } from './mcpDispatcher'
import { failureCode, failureResult, MCP_MAX_BYTES, McpFailure } from './mcpErrors'
import { DEFAULT_MCP_CONFIGURATION, readMcpConfiguration, readOrCreateMcpToken, replaceMcpToken, validateMcpConfiguration, writeMcpConfiguration } from './mcpCredentialStore'
import { disposeMcpSchemaValidator } from './mcpSchemaValidator'

interface Session {
  server: McpServer; transport: NodeStreamableHTTPServerTransport; lastActive: number; open: number
  controller: AbortController
}
let configuration = { ...DEFAULT_MCP_CONFIGURATION }, state: McpStatus['state'] = 'disabled', error: string | undefined
let http: Server | undefined, token: string | undefined, revision = 0, pendingInitializations = 0
let idleTimer: ReturnType<typeof setInterval> | undefined
const sessions = new Map<string, Session>()
let operations = Promise.resolve()
function serial<T>(action: () => Promise<T>): Promise<T> {
  const operation = operations.then(action)
  operations = operation.then(() => {}, () => {})
  return operation
}
function getStatus(): McpStatus {
  return { configuration: { ...configuration }, state, endpoint: `http://127.0.0.1:${configuration.port}/mcp`, sessionCount: sessions.size, error, ...getMcpExecutionState() }
}
function reject(res: ServerResponse, status: number, message: string): void {
  if (res.headersSent) { res.destroy(); return }
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
  res.end(JSON.stringify({ error: message }))
}
function authorized(req: IncomingMessage): boolean {
  const expectedHost = `127.0.0.1:${configuration.port}`
  if (req.headers.host !== expectedHost || req.url !== '/mcp' || !['GET', 'POST', 'DELETE'].includes(req.method ?? '')
    || req.headers.origin !== undefined && req.headers.origin !== `http://${expectedHost}`) return false
  const authorization = req.headers.authorization
  if (!token || typeof authorization !== 'string' || authorization.length > 256) return false
  const provided = Buffer.from(authorization), expected = Buffer.from(`Bearer ${token}`)
  return provided.length === expected.length && timingSafeEqual(provided, expected)
}
async function readBody(req: IncomingMessage): Promise<unknown> {
  if (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity') throw new McpFailure('invalid-arguments')
  const declared = req.headers['content-length']
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > MCP_MAX_BYTES)) throw new McpFailure('result-too-large')
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += buffer.length
    if (bytes > MCP_MAX_BYTES) throw new McpFailure('result-too-large')
    chunks.push(buffer)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) }
  catch { throw new McpFailure('invalid-arguments') }
}
function protocolResult(value: unknown): CallToolResult {
  const result = value as CallToolResult
  if (Buffer.byteLength(JSON.stringify(result)) > MCP_MAX_BYTES - 2048) return failureResult('result-too-large') as CallToolResult
  return result
}
function buildSession(): Session {
  const server = new McpServer({ name: 'eNest', version: '0.2.3' }, { maxToolInputElements: 50_000 })
  const controller = new AbortController()
  const transport = new NodeStreamableHTTPServerTransport({
    sessionIdGenerator: randomUUID, maxRequestBodySize: MCP_MAX_BYTES,
    onsessioninitialized: id => { sessions.set(id, session) },
    onsessionclosed: id => { controller.abort(); sessions.delete(id) }
  })
  const session: Session = { server, transport, controller, lastActive: Date.now(), open: 0 }
  const listSchema = { type: 'object', additionalProperties: false, properties: {
    pluginId: { type: 'string', maxLength: 256 }, query: { type: 'string', maxLength: 256 },
    cursor: { type: 'string', maxLength: 512 }, limit: { type: 'integer', minimum: 1, maximum: 100 }
  } }
  const callSchema = { type: 'object', additionalProperties: false, required: ['pluginId', 'toolId', 'arguments'], properties: {
    pluginId: { type: 'string', minLength: 1, maxLength: 256 }, toolId: { type: 'string', minLength: 1, maxLength: 64 }, arguments: { type: 'object' }
  } }
  server.registerTool('enest_list_tools', { description: 'List tools declared by locally installed, enabled eNest plugins. This does not start or install plugins.', inputSchema: fromJsonSchema<McpCatalogQuery>(listSchema) }, async input => {
    try {
      const page = await listMcpTools(input)
      return protocolResult({ content: [{ type: 'text', text: JSON.stringify(page) }], structuredContent: page })
    } catch (cause) { return protocolResult(failureResult(failureCode(cause))) }
  })
  server.registerTool('enest_call_tool', { description: 'Execute one declared plugin tool in eNest without foregrounding windows or requesting new consent. Unknown outcomes are never retried.', inputSchema: fromJsonSchema<{ pluginId: string; toolId: string; arguments: Record<string, unknown> }>(callSchema) }, async (input, context) => {
    const signal = AbortSignal.any([context.mcpReq.signal, controller.signal])
    return protocolResult(await callMcpTool(input, signal, `mcp:${context.sessionId ?? 'client'}`))
  })
  return session
}
async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (state !== 'running' || !authorized(req)) { reject(res, 401, 'Unauthorized or invalid local origin'); return }
  const requestRevision = revision
  try {
    const body = req.method === 'POST' ? await readBody(req) : undefined
    if (revision !== requestRevision || state !== 'running' || !authorized(req)) { reject(res, 401, 'Credentials retired'); return }
    const id = req.headers['mcp-session-id']
    if (id !== undefined && (typeof id !== 'string' || id.length > 128)) { reject(res, 400, 'Invalid session'); return }
    let session = typeof id === 'string' ? sessions.get(id) : undefined
    if (!session) {
      if (id) { reject(res, 404, 'Session not found'); return }
      if (req.method !== 'POST' || !isInitializeRequest(body)) { reject(res, 400, 'Initialize a session first'); return }
      if (sessions.size + pendingInitializations >= 8) { reject(res, 503, 'Session limit reached'); return }
      pendingInitializations++
      try {
        session = buildSession()
        await session.server.connect(session.transport)
        const current = session
        const previousClose = current.transport.onclose
        current.transport.onclose = () => { previousClose?.(); current.controller.abort(); if (current.transport.sessionId) sessions.delete(current.transport.sessionId) }
        if (requestRevision !== revision) { await session.server.close(); reject(res, 401, 'Credentials retired'); return }
        await session.transport.handleRequest(req, res, body)
        if (!session.transport.sessionId) await session.server.close()
      } finally { pendingInitializations-- }
      return
    }
    const current = session
    current.open++; current.lastActive = Date.now()
    res.once('close', () => { current.open--; current.lastActive = Date.now() })
    await current.transport.handleRequest(req, res, body)
  } catch (cause) { reject(res, failureCode(cause) === 'result-too-large' ? 413 : 400, 'Invalid or oversized MCP request') }
}
async function stop(): Promise<void> {
  revision++
  setMcpAccepting(false)
  if (idleTimer) clearInterval(idleTimer)
  idleTimer = undefined
  for (const session of sessions.values()) session.controller.abort()
  await Promise.allSettled([...sessions.values()].map(session => session.server.close()))
  sessions.clear()
  const current = http
  http = undefined
  if (current) {
    current.closeAllConnections()
    await new Promise<void>(resolve => current.close(() => resolve()))
  }
  token = undefined
  state = 'disabled'
}
async function start(): Promise<void> {
  if (!configuration.enabled) { state = 'disabled'; return }
  state = 'starting'; error = undefined
  try {
    token = readOrCreateMcpToken()
    const current = createServer((req, res) => { void route(req, res) })
    current.requestTimeout = 80_000; current.headersTimeout = 10_000; current.keepAliveTimeout = 5000
    current.maxHeadersCount = 64
    http = current
    await new Promise<void>((resolve, rejectStart) => {
      current.once('error', rejectStart)
      current.listen(configuration.port, '127.0.0.1', () => { current.removeListener('error', rejectStart); resolve() })
    })
    current.on('error', () => { void serial(async () => { await stop(); state = 'error'; error = 'MCP 本地服务异常，请重新启用' }) })
    state = 'running'; setMcpAccepting(true)
    idleTimer = setInterval(() => {
      const cutoff = Date.now() - 15 * 60_000
      for (const session of sessions.values()) if (!session.open && session.lastActive < cutoff) void session.server.close().catch(() => {})
    }, 60_000)
    idleTimer.unref?.()
  } catch (cause) {
    await stop()
    state = 'error'
    error = cause && typeof cause === 'object' && Reflect.get(cause, 'code') === 'EADDRINUSE'
      ? `端口 ${configuration.port} 已被占用；MCP 未启动，未切换到其他端口`
      : cause instanceof Error && cause.message.startsWith('MCP 凭据') || cause instanceof Error && cause.message.startsWith('系统安全存储')
        ? cause.message : 'MCP 启动失败；壳功能不受影响'
  }
}
export const mcpService = {
  getStatus,
  initialize: () => serial(async () => {
    try { configuration = readMcpConfiguration(); await start() }
    catch { state = 'error'; error = 'MCP 配置无法读取；请在原生设置中重新保存' }
  }),
  configure: (input: McpConfiguration) => serial(async () => {
    validateMcpConfiguration(input)
    writeMcpConfiguration(input)
    await stop(); configuration = { ...input }; await start()
    return getStatus()
  }),
  copyConnectionConfig: () => serial(async () => {
    if (state !== 'running' || !token) throw new Error('请先启用并成功启动 MCP 服务')
    clipboard.writeText(JSON.stringify({ mcpServers: { enest: { type: 'http', url: getStatus().endpoint, headers: { Authorization: `Bearer ${token}` } } } }, null, 2))
  }),
  rotateToken: () => serial(async () => {
    // Persist the replacement first. A secure-storage failure preserves the live token/session.
    replaceMcpToken()
    await stop(); await start()
    return getStatus()
  }),
  shutdown: () => serial(async () => { await stop(); disposeMcpSchemaValidator() })
}
