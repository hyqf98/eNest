import { randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { app, clipboard } from 'electron'
import type { McpServer, CallToolResult } from '@modelcontextprotocol/server'
import type { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node'
import type { McpCatalogQuery, McpConfiguration, McpStatus } from '@shared/types/mcpSettings'
import { listMcpTools } from './mcpCatalog'
import { callMcpTool, getMcpExecutionState, setMcpAccepting } from './mcpDispatcher'
import { launchIndexEntries } from '@main/launcher/launchIndex'
import { resolveQuickOpenCommand } from '@main/launcher/commandIndex'
import { executePluginCommand } from '@main/launcher/pluginLauncher'
import { pluginRegistry } from '@main/plugin/PluginRegistry'
import { settingsStore } from '@main/settings/SettingsStore'
import { failureCode, failureResult, MCP_MAX_BYTES, McpFailure } from './mcpErrors'
import { DEFAULT_MCP_CONFIGURATION, readMcpConfiguration, validateMcpConfiguration, writeMcpConfiguration } from './mcpCredentialStore'
import { disposeMcpSchemaValidator } from './mcpSchemaValidator'

interface Session {
  server: McpServer; transport: NodeStreamableHTTPServerTransport; lastActive: number; open: number
  controller: AbortController
}
let configuration = { ...DEFAULT_MCP_CONFIGURATION }, state: McpStatus['state'] = 'disabled', error: string | undefined
let http: Server | undefined, revision = 0, pendingInitializations = 0
let shuttingDown = false
let idleTimer: ReturnType<typeof setInterval> | undefined
const sessions = new Map<string, Session>()
let operations = Promise.resolve()
let pendingOperations = 0
const MAX_PENDING_OPERATIONS = 8
function serial<T>(action: () => Promise<T>, cleanup = false): Promise<T> {
  if (!cleanup && pendingOperations >= MAX_PENDING_OPERATIONS) return Promise.reject(new Error('MCP 操作繁忙，请稍后重试'))
  pendingOperations++
  const operation = operations.then(action).finally(() => { pendingOperations-- })
  operations = operation.then(() => {}, () => {})
  return operation
}
function getStatus(): McpStatus {
  return { configuration: { ...configuration }, state, endpoint: `http://127.0.0.1:${configuration.port}/mcp`, error, ...getMcpExecutionState() }
}
function reject(res: ServerResponse, status: number, message: string): void {
  if (res.headersSent) { res.destroy(); return }
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
  res.end(JSON.stringify({ error: message }))
}
function authorized(req: IncomingMessage): boolean {
  const expectedHost = `127.0.0.1:${configuration.port}`
  // 本地回环免令牌：仅校验 Host / 路径 / Origin，服务只绑定 IPv4 loopback。
  if (req.headers.host !== expectedHost || req.url !== '/mcp' || !['GET', 'POST', 'DELETE'].includes(req.method ?? '')
    || req.headers.origin !== undefined && req.headers.origin !== `http://${expectedHost}`) return false
  return true
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
async function buildSession(serviceRevision: number): Promise<Session> {
  const [{ McpServer, fromJsonSchema }, { NodeStreamableHTTPServerTransport }] = await Promise.all([
    import('@modelcontextprotocol/server'), import('@modelcontextprotocol/node')
  ])
  const server = new McpServer({ name: 'eNest', version: app.getVersion() }, { maxToolInputElements: 50_000 })
  const controller = new AbortController()
  const transport = new NodeStreamableHTTPServerTransport({
    sessionIdGenerator: randomUUID, maxRequestBodySize: MCP_MAX_BYTES,
    onsessioninitialized: id => {
      if (shuttingDown || state !== 'running' || revision !== serviceRevision) {
        controller.abort()
        void server.close().catch(() => {})
        return
      }
      sessions.set(id, session)
    },
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

  // —— 宿主标准调度面：插件目录 / 按插件列 API / 执行插件功能 ——
  const listPluginsSchema = { type: 'object', additionalProperties: false, properties: {
    query: { type: 'string', maxLength: 256 }, limit: { type: 'integer', minimum: 1, maximum: 100 }
  } }
  server.registerTool('enest_list_plugins', { description: 'List locally installed eNest plugins with their declared feature and MCP tool counts. Optional keyword query; no plugin is started.', inputSchema: fromJsonSchema<{ query?: string; limit?: number }>(listPluginsSchema) }, async input => {
    try {
      const query = typeof input.query === 'string' ? input.query.trim().toLocaleLowerCase() : ''
      const limit = typeof input.limit === 'number' ? input.limit : 50
      const plugins = pluginRegistry.getInstalledDescriptors()
        .filter(item => !query || `${item.id} ${item.manifest.name} ${item.manifest.description ?? ''} ${item.manifest.category ?? ''}`.toLocaleLowerCase().includes(query))
        .slice(0, limit)
        .map(item => ({ pluginId: item.id, name: item.manifest.name, version: item.manifest.version,
          description: item.manifest.description ?? '', category: item.manifest.category ?? '',
          enabled: item.enabled, dev: item.dev,
          featureCount: item.manifest.features?.length ?? 0,
          mcpToolCount: item.manifest.contributes?.mcpTools?.length ?? 0 }))
      const page = { plugins, total: plugins.length }
      return protocolResult({ content: [{ type: 'text', text: JSON.stringify(page) }], structuredContent: page })
    } catch (cause) { return protocolResult(failureResult(failureCode(cause))) }
  })

  const listApisSchema = { type: 'object', additionalProperties: false, required: ['pluginId'], properties: {
    pluginId: { type: 'string', minLength: 1, maxLength: 256 }
  } }
  server.registerTool('enest_list_plugin_apis', { description: 'List one plugin\'s callable API surface: declared features (launch codes), durable launch-index entries and MCP tool ids. Launch entries carry entryId/buildRevision/indexRevision to pass back to enest_execute.', inputSchema: fromJsonSchema<{ pluginId: string }>(listApisSchema) }, async input => {
    try {
      const pluginId = String(input.pluginId ?? '')
      const descriptor = pluginRegistry.getInstalledDescriptors().find(item => item.id === pluginId)
      if (!descriptor) return protocolResult({ content: [{ type: 'text', text: `Unknown plugin: ${pluginId}` }], isError: true } as CallToolResult)
      const features = (descriptor.manifest.features ?? []).map(feature => ({ code: feature.code, explain: feature.explain ?? '',
        cmds: (feature.cmds ?? []).filter((name): name is string => typeof name === 'string').slice(0, 16),
        ...(feature.activation ? { activation: feature.activation.type } : {}) }))
      const launchEntries = launchIndexEntries().filter(item => item.pluginId === pluginId)
        .map(({ entry, buildRevision, indexRevision }) => ({ entryId: entry.id, code: entry.code, title: entry.title,
          subtitle: entry.subtitle ?? '', aliases: entry.aliases ?? [], buildRevision, indexRevision }))
      const mcpTools = (descriptor.manifest.contributes?.mcpTools ?? []).map(tool => ({ toolId: tool.id, title: tool.title ?? '' }))
      const page = { pluginId, features, launchEntries, mcpTools }
      return protocolResult({ content: [{ type: 'text', text: JSON.stringify(page) }], structuredContent: page })
    } catch (cause) { return protocolResult(failureResult(failureCode(cause))) }
  })

  const executeSchema = { type: 'object', additionalProperties: false, required: ['pluginId', 'code'], properties: {
    pluginId: { type: 'string', minLength: 1, maxLength: 256 },
    code: { type: 'string', minLength: 1, maxLength: 256 },
    entryId: { type: 'string', maxLength: 160 }, buildRevision: { type: 'string', maxLength: 128 }, indexRevision: { type: 'integer', minimum: 0 },
    query: { type: 'string', maxLength: 4096 }, target: { type: 'string', enum: ['quick', 'shell'] }
  } }
  server.registerTool('enest_execute', { description: 'Dispatch one declared plugin feature through the native launch path (same as opening it from the workspace). Pass an entryId from enest_list_plugin_apis for durable launch-index entries. Optional query text is delivered as the feature input.', inputSchema: fromJsonSchema<{ pluginId: string; code: string; entryId?: string; buildRevision?: string; indexRevision?: number; query?: string; target?: 'quick' | 'shell' }>(executeSchema) }, async (input, context) => {
    const signal = AbortSignal.any([context.mcpReq.signal, controller.signal])
    try {
      const command = resolveQuickOpenCommand({ kind: 'plugin', pluginId: input.pluginId, code: input.code,
        ...(input.entryId !== undefined ? { entryId: input.entryId } : {}),
        ...(input.buildRevision !== undefined ? { buildRevision: input.buildRevision } : {}),
        ...(input.indexRevision !== undefined ? { indexRevision: input.indexRevision } : {}) })
      if (!command) return protocolResult({ content: [{ type: 'text', text: 'Feature is not available for this plugin (unknown code, stale entry, or plugin disabled)' }], isError: true } as CallToolResult)
      const configured = settingsStore.getPluginLaunchConfig(input.pluginId)?.mode
      const result = await executePluginCommand(command, {
        source: 'workspace', signal,
        query: typeof input.query === 'string' ? input.query.slice(0, 4096) : '',
        defaultTarget: input.target ?? configured ?? 'shell',
        guard: () => !signal.aborted && !shuttingDown && state === 'running'
      })
      if (!result.ok) return protocolResult({ content: [{ type: 'text', text: result.error ?? 'Plugin dispatch failed' }], isError: true } as CallToolResult)
      const page = { dispatched: true, pluginId: input.pluginId, code: input.code, presentation: result.presentation ?? 'none' }
      return protocolResult({ content: [{ type: 'text', text: JSON.stringify(page) }], structuredContent: page })
    } catch (cause) { return protocolResult(failureResult(failureCode(cause))) }
  })
  return session
}
async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (shuttingDown || state !== 'running' || !authorized(req)) { reject(res, 401, 'Unauthorized or invalid local origin'); return }
  const requestRevision = revision
  try {
    const body = req.method === 'POST' ? await readBody(req) : undefined
    if (revision !== requestRevision || state !== 'running' || !authorized(req)) { reject(res, 401, 'Credentials retired'); return }
    const id = req.headers['mcp-session-id']
    if (id !== undefined && (typeof id !== 'string' || id.length > 128)) { reject(res, 400, 'Invalid session'); return }
    let session = typeof id === 'string' ? sessions.get(id) : undefined
    if (!session) {
      if (id) { reject(res, 404, 'Session not found'); return }
      const { isInitializeRequest } = await import('@modelcontextprotocol/server')
      if (shuttingDown || revision !== requestRevision) { reject(res, 401, 'Credentials retired'); return }
      if (req.method !== 'POST' || !isInitializeRequest(body)) { reject(res, 400, 'Initialize a session first'); return }
      if (sessions.size + pendingInitializations >= 8) { reject(res, 503, 'Session limit reached'); return }
      pendingInitializations++
      try {
        session = await buildSession(requestRevision)
        await session.server.connect(session.transport)
        const current = session
        const previousClose = current.transport.onclose
        current.transport.onclose = () => { previousClose?.(); current.controller.abort(); if (current.transport.sessionId) sessions.delete(current.transport.sessionId) }
        if (requestRevision !== revision) { await session.server.close(); reject(res, 401, 'Credentials retired'); return }
        await session.transport.handleRequest(req, res, body)
        if (!session.transport.sessionId) await session.server.close()
      } catch (cause) {
        await session?.server.close().catch(() => {})
        throw cause
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
  state = 'disabled'
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
}
async function start(): Promise<void> {
  if (shuttingDown || !configuration.enabled) { state = 'disabled'; return }
  const startingRevision = revision
  const assertCurrent = (): void => {
    if (shuttingDown || revision !== startingRevision) throw new McpFailure('unavailable')
  }
  state = 'starting'; error = undefined
  try {
    assertCurrent()
    const current = createServer((req, res) => { void route(req, res) })
    current.requestTimeout = 80_000; current.headersTimeout = 10_000; current.keepAliveTimeout = 5000
    current.maxHeadersCount = 64
    http = current
    await new Promise<void>((resolve, rejectStart) => {
      current.once('error', rejectStart)
      current.listen(configuration.port, '127.0.0.1', () => { current.removeListener('error', rejectStart); resolve() })
    })
    if (shuttingDown) { await stop(); return }
    current.once('error', () => { void serial(async () => { await stop(); state = 'error'; error = 'MCP 本地服务异常，请重新启用' }, true) })
    state = 'running'; setMcpAccepting(true)
    idleTimer = setInterval(() => {
      const cutoff = Date.now() - 15 * 60_000
      for (const session of sessions.values()) if (!session.open && session.lastActive < cutoff) void session.server.close().catch(() => {})
    }, 60_000)
    idleTimer.unref?.()
  } catch (cause) {
    if (shuttingDown || revision !== startingRevision) return
    await stop()
    state = 'error'
    error = cause && typeof cause === 'object' && Reflect.get(cause, 'code') === 'EADDRINUSE'
      ? `端口 ${configuration.port} 已被占用；MCP 未启动，未切换到其他端口`
      : 'MCP 启动失败；壳功能不受影响'
  }
}
function prepareShutdown(): void {
  shuttingDown = true
  revision++
  setMcpAccepting(false)
  for (const session of sessions.values()) session.controller.abort()
}
function assertNotShuttingDown(): void {
  if (shuttingDown) throw new McpFailure('unavailable')
}
export const mcpService = {
  getStatus,
  prepareShutdown,
  initialize: () => serial(async () => {
    if (shuttingDown) return
    try { configuration = readMcpConfiguration(); await start() }
    catch { state = 'error'; error = 'MCP 配置无法读取；请在原生设置中重新保存' }
  }),
  configure: (input: McpConfiguration) => serial(async () => {
    assertNotShuttingDown()
    validateMcpConfiguration(input)
    writeMcpConfiguration(input)
    await stop(); configuration = { ...input }; await start()
    return getStatus()
  }),
  copyConnectionConfig: () => serial(async () => {
    assertNotShuttingDown()
    if (state !== 'running') throw new Error('请先启用并成功启动 MCP 服务')
    await clipboard.writeText(JSON.stringify({ mcpServers: { enest: { type: 'http', url: getStatus().endpoint } } }, null, 2))
  }),
  shutdown: () => {
    prepareShutdown()
    return serial(async () => { await stop(); disposeMcpSchemaValidator() }, true)
  }
}
