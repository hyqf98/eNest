/**
 * mwService — utility process only; no Electron main APIs.
 * 中间件（kafka / rabbitmq / mqtt / rocketmq）会话宿主服务
 * 职责：按 sessionKey 管理 open 会话与 tail 实时监听；分发 mw.* workbench action。
 *      连接配置/控制台会话存 enest.storage（插件 KV）；宿主只管运行态会话。
 * 被 mwUtility 消息循环调用；事件经 postMessage({ event: 'mw.data'|'mw.error' }) 透传。
 * Only validated IPC input enters this process; secrets stay in the facade (ephemeralSecret).
 */
import type {
  MwConnectionConfig,
  MwSessionInfo,
  MwTestResult,
  MwWorkbenchRequest
} from '@shared/types/mw-workbench'
import { MW_MUTATING_ACTIONS } from '@shared/types/mw-workbench'
import type { MwDriver, MwDriverContext, MwDriverHandle } from '@main/middleware/types'
import { getMwDriver, mwDriverDescriptors } from '@main/middleware/drivers'

export interface MwSession {
  sessionKey: string
  pluginId: string
  driver: MwDriver
  handle: MwDriverHandle
  controller: AbortController
  /** 进行中的实时监听：tailId → stop 句柄 */
  tails: Map<string, () => Promise<void>>
}

const sessions = new Map<string, MwSession>()
let stopped = false

/** 会话事件出口：mwUtility 消息循环识别 event 字段后透传主进程 */
function postEvent(pluginId: string, event: 'mw.data' | 'mw.error', payload: Record<string, unknown>): void {
  const port = process.parentPort
  if (!port) return
  port.postMessage({ event, pluginId, payload })
}

export function requireSession(pluginId: string, sessionKey: string): MwSession {
  const s = sessions.get(sessionKey)
  if (!s || s.handle.closed) throw new Error(`mw session not found or closed: ${sessionKey}; reconnect`)
  if (s.pluginId !== pluginId) throw new Error('session does not belong to this plugin')
  return s
}

function toSessionInfo(s: MwSession): MwSessionInfo {
  return {
    sessionKey: s.sessionKey,
    kind: s.handle.kind,
    label: s.handle.config.name || `${s.handle.kind}:${s.sessionKey}`,
    connectedAt: Date.now(),
    readOnly: !!s.handle.readOnly,
    capabilities: s.handle.capabilities,
    messageQueryModes: s.handle.messageQueryModes
  }
}

export async function mwTest(pluginId: string, config: MwConnectionConfig): Promise<MwTestResult> {
  void pluginId
  const driver = getMwDriver(config.kind)
  return driver.test(config, config.ephemeralSecret)
}

export async function mwOpen(
  pluginId: string,
  input: { sessionKey: string; config: MwConnectionConfig }
): Promise<MwSessionInfo> {
  const sessionKey = input?.sessionKey
  const config = input?.config
  if (!sessionKey || typeof sessionKey !== 'string') throw new Error('sessionKey required')
  if (!config?.kind) throw new Error('config.kind required')
  if (stopped) throw new Error('middleware service is closing')
  const driver = getMwDriver(config.kind)
  const previous = sessions.get(sessionKey)
  if (previous) await closeSession(previous)
  const controller = new AbortController()
  const ctx: MwDriverContext = {
    emit: (event, payload) => postEvent(pluginId, event === 'data' ? 'mw.data' : 'mw.error', payload),
    signal: controller.signal
  }
  let handle: MwDriverHandle
  try {
    handle = await driver.open(config, config.ephemeralSecret, ctx)
  } catch (error) {
    controller.abort(new Error('middleware open failed'))
    throw error
  }
  if (stopped) { controller.abort(new Error('middleware service is closing')); await driver.close(handle); throw new Error('middleware service is closing') }
  handle.readOnly = config.readOnly === true
  const session: MwSession = { sessionKey, pluginId, driver, handle, controller, tails: new Map() }
  sessions.set(sessionKey, session)
  return toSessionInfo(session)
}

/** 停掉全部 tail 后关闭驱动连接 */
async function closeSession(s: MwSession): Promise<void> {
  if (sessions.get(s.sessionKey) === s) sessions.delete(s.sessionKey)
  await Promise.allSettled([...s.tails.values()].map(stop => stop()))
  s.tails.clear()
  s.controller.abort(new Error('middleware session closed'))
  s.handle.closed = true
  await s.driver.close(s.handle)
}

export async function mwClose(pluginId: string, sessionKey: string): Promise<boolean> {
  const s = sessions.get(sessionKey)
  if (s && s.pluginId !== pluginId) throw new Error('session does not belong to this plugin')
  if (s) await closeSession(s)
  return true
}

export function mwListSessions(pluginId: string): MwSessionInfo[] {
  return [...sessions.values()].filter(s => s.pluginId === pluginId && !s.handle.closed).map(toSessionInfo)
}

export async function releaseMwSessions(pluginId: string): Promise<void> {
  stopped = true
  await Promise.allSettled([...sessions.values()].filter(s => s.pluginId === pluginId).map(s => mwClose(pluginId, s.sessionKey)))
  stopped = false
}

/** 变更类 action 在连接 readOnly 时统一拒绝（驱动不必重复检查） */
function assertNotReadOnly(s: MwSession, action: string): void {
  if (s.handle.readOnly && MW_MUTATING_ACTIONS.includes(action)) {
    throw new Error('Read-only connections cannot mutate middleware state')
  }
}

async function startTail(s: MwSession, input: { tailId: string; topic: string; filter?: string }): Promise<void> {
  if (s.tails.has(input.tailId)) throw new Error(`tail already started: ${input.tailId}`)
  const stopHandle = await s.driver.tailStart(s.handle, { tailId: input.tailId, topic: input.topic, filter: input.filter }, message => {
    s.controller.signal.throwIfAborted()
    ctxEmit(s, 'data', { sessionKey: s.sessionKey, tailId: input.tailId, message })
  })
  if (s.handle.closed || sessions.get(s.sessionKey) !== s) { await stopHandle.stop(); throw new Error('mw session closed during tail start') }
  s.tails.set(input.tailId, () => stopHandle.stop())
}

/** 会话存活期内复用 open 注入的 emit 通道 */
function ctxEmit(s: MwSession, event: 'data' | 'error', payload: Record<string, unknown>): void {
  postEvent(s.pluginId, event === 'data' ? 'mw.data' : 'mw.error', payload)
}

export async function mwWorkbenchService(pluginId: string, request: MwWorkbenchRequest): Promise<unknown> {
  if (!request || typeof request !== 'object') throw new Error('Invalid mw workbench request')
  const action = request.action
  const input = (request.input ?? {}) as Record<string, never> & { sessionKey?: string }
  // —— 无需会话的 action ——
  switch (action) {
    case 'kinds.list': return mwDriverDescriptors()
    case 'test': return mwTest(pluginId, request.input.config)
    case 'session.open': return mwOpen(pluginId, request.input)
    case 'session.close': return mwClose(pluginId, request.input.sessionKey)
    case 'session.list': return mwListSessions(pluginId)
  }
  // —— 会话内 action ——
  if (!('sessionKey' in input) || typeof input.sessionKey !== 'string') throw new Error('sessionKey required')
  const s = requireSession(pluginId, input.sessionKey)
  assertNotReadOnly(s, action)
  const h = s.handle
  switch (action) {
    // mw.query
    case 'overview': return s.driver.overview(h)
    case 'topics.list': return s.driver.topicsList(h, { search: request.input.search, includeInternal: request.input.includeInternal })
    case 'topic.describe': return s.driver.topicDescribe(h, request.input.topic)
    case 'exchanges.list': return s.driver.exchangesList(h, { search: request.input.search })
    case 'bindings.list': return s.driver.bindingsList(h, { source: request.input.source, destination: request.input.destination })
    case 'groups.list': return s.driver.groupsList(h, { search: request.input.search })
    case 'group.describe': return s.driver.groupDescribe(h, request.input.groupId)
    case 'clients.list': return s.driver.clientsList(h, { search: request.input.search })
    case 'messages.query': return s.driver.messagesQuery(h, request.input)
    case 'messages.get': return s.driver.messageGet(h, { topic: request.input.topic, messageId: request.input.messageId, partition: request.input.partition, offset: request.input.offset })
    case 'tail.start': return startTail(s, { tailId: request.input.tailId, topic: request.input.topic, filter: request.input.filter })
    case 'tail.stop': {
      const stop = s.tails.get(request.input.tailId)
      if (!stop) return true
      s.tails.delete(request.input.tailId)
      await stop()
      return true
    }
    case 'configs.describe': return s.driver.configsDescribe(h, { topic: request.input.topic })
    case 'trace.message': return s.driver.traceMessage(h, { key: request.input.key })
    case 'retained.list': return s.driver.retainedList(h, { search: request.input.search })
    // mw.admin
    case 'topic.create': return s.driver.topicCreate(h, request.input.topic)
    case 'topic.update': return s.driver.topicUpdate(h, request.input.name, request.input.attrs)
    case 'topic.delete': return s.driver.topicDelete(h, request.input.name)
    case 'topic.purge': return s.driver.topicPurge(h, request.input.name)
    case 'partitions.grow': return s.driver.partitionsGrow(h, { topic: request.input.topic, count: request.input.count })
    case 'exchange.create': return s.driver.exchangeCreate(h, request.input.exchange)
    case 'exchange.delete': return s.driver.exchangeDelete(h, request.input.name)
    case 'binding.create': return s.driver.bindingCreate(h, request.input.binding)
    case 'binding.delete': return s.driver.bindingDelete(h, { source: request.input.source, destination: request.input.destination, propertiesKey: request.input.propertiesKey })
    case 'group.resetOffsets': return s.driver.groupResetOffsets(h, request.input)
    case 'client.kick': return s.driver.clientKick(h, request.input.clientId)
    case 'messages.send': return s.driver.messageSend(h, request.input)
    case 'messages.resend': return s.driver.messageResend(h, { message: request.input.message, targetTopic: request.input.targetTopic })
    case 'configs.alter': return s.driver.configsAlter(h, { topic: request.input.topic, configs: request.input.configs })
    case 'retained.delete': return s.driver.retainedDelete(h, request.input.topic)
    default: throw new Error(`Unknown middleware workbench action: ${String(action)}`)
  }
}
