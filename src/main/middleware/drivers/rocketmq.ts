/** RocketMQ 驱动：依赖用户已部署的 rocketmq-dashboard（经典 1.x/2.x，console-ng 同源 REST）。
 * 端点已按 apache/rocketmq-dashboard tag 2.1.0 controller 源码核实；无官方稳定性承诺，逐端点容错降级。
 * 运行于 mwUtility。 */
import type {
  MwClient,
  MwConnectionConfig,
  MwConsumerGroup,
  MwConsumerGroupDetail,
  MwMessage,
  MwMessageQueryInput,
  MwMessageSendInput,
  MwOverview,
  MwTopic,
  MwTrace,
  MwTraceStep,
  MwBindingCreateInput,
  MwTopicCreateInput
} from '@shared/types/mw-workbench'
import type { MwDriver, MwDriverContext, MwDriverHandle, MwTestResult } from '@main/middleware/types'
import { unsupported } from '@main/middleware/types'
import { mwHttp, mwHttpJson, type MwHttpOptions } from '@main/middleware/httpRequest'

const DEP_NOTE = '依赖 rocketmq-dashboard 接口，随其版本可能变化'

const CAPS: Record<string, { state: 'available' | 'unsupported' | 'not-configured'; reason?: string }> = {
  topicCrud: { state: 'available', reason: DEP_NOTE },
  partitions: { state: 'available', reason: '对应读写队列数' },
  exchanges: { state: 'unsupported', reason: 'RocketMQ 无交换机概念' },
  bindings: { state: 'unsupported', reason: 'RocketMQ 无绑定概念' },
  consumerGroups: { state: 'available', reason: DEP_NOTE },
  offsetReset: { state: 'available', reason: '要求组内无活跃连接' },
  clients: { state: 'available', reason: '消费组连接列表' },
  clientKick: { state: 'unsupported', reason: 'dashboard 未提供断开连接接口' },
  messageQuery: { state: 'available', reason: '按时间段/Key/MsgId 查询（无 offset 定位）' },
  tail: { state: 'unsupported', reason: 'dashboard 无实时流接口；用「按时间段查询」轮询代替' },
  publish: { state: 'available' },
  resend: { state: 'available', reason: 'consumeMessageDirectly（按消费组重发）' },
  trace: { state: 'available', reason: '消息轨迹（需 broker 开启 trace）' },
  retained: { state: 'unsupported', reason: 'RocketMQ 无 retained 概念' },
  configMgmt: { state: 'available', reason: 'topic 读写队列/perm 经 createOrUpdate 承载' },
  monitor: { state: 'available', reason: DEP_NOTE },
  dlqBrowse: { state: 'available', reason: '浏览 %DLQ%消费组 死信 topic 后重发' }
}

interface RmqRuntime {
  base: string
  cookie?: string
  username?: string
  password?: string
  clusterNames?: string[]
}

function rt(h: MwDriverHandle): RmqRuntime { return h.runtime as unknown as RmqRuntime }

/** dashboard 响应统一为 {status, data}（status=0 成功）；部分接口直接返回数据体 */
function unwrap<T>(body: unknown): T {
  if (body && typeof body === 'object' && 'status' in (body as Record<string, unknown>)) {
    const wrapper = body as { status?: number; data?: unknown }
    if (wrapper.status !== 0) throw new Error(`dashboard 接口返回 status=${wrapper.status}`)
    return wrapper.data as T
  }
  return body as T
}

async function call<T>(h: MwDriverHandle, method: 'GET' | 'POST', path: string, opts: Partial<MwHttpOptions> = {}): Promise<T> {
  const r = rt(h)
  const doCall = async (cookie?: string) => mwHttpJson(`${r.base}${path}`, {
    method,
    cookie,
    insecureTls: true,
    timeoutMs: 30000,
    ...opts
  })
  let raw: unknown
  try {
    raw = await doCall(r.cookie)
  } catch (error) {
    const message = String((error as Error).message ?? '')
    // 会话过期：重新登录一次
    if (message.includes('HTTP 401') || message.includes('HTTP 403')) {
      await login(h)
      raw = await doCall(rt(h).cookie)
    } else throw error
  }
  return unwrap<T>(raw)
}

async function login(h: MwDriverHandle): Promise<void> {
  const r = rt(h)
  if (!r.username) throw new Error('dashboard 需要登录，请在连接配置中填写账号密码')
  const res = await mwHttp(`${r.base}/login/login.do`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: `username=${encodeURIComponent(r.username)}&password=${encodeURIComponent(r.password ?? '')}`,
    insecureTls: true
  })
  if (res.status !== 200) throw new Error(`dashboard 登录失败（HTTP ${res.status}）：${res.body.slice(0, 160)}`)
  const setCookie = res.headers['set-cookie'] ?? ''
  if (setCookie) r.cookie = setCookie.split(';')[0]
}

async function ensureLogin(h: MwDriverHandle): Promise<void> {
  const r = rt(h)
  try {
    const check = await call<{ loginRequired?: boolean; logined?: boolean }>(h, 'GET', '/login/check.query')
    if (check?.loginRequired && !check?.logined && !r.cookie) await login(h)
  } catch (error) {
    // 老版本可能没有 check.query；有凭据就直接尝试登录
    if (r.username) await login(h).catch(() => { throw error })
  }
}

async function clusterNames(h: MwDriverHandle): Promise<string[]> {
  const r = rt(h)
  if (r.clusterNames?.length) return r.clusterNames
  const data = await call<{ clusterAddrTable?: Record<string, string[]> }>(h, 'GET', '/cluster/list.query')
  const names = Object.keys(data?.clusterAddrTable ?? {})
  if (names.length) r.clusterNames = names
  return names
}

function tsToMs(value: unknown): number {
  const n = Number(value)
  return Number.isFinite(n) ? (n < 1e12 ? n : n) : Date.now()
}

function mapMessageView(view: Record<string, any>): MwMessage {
  const body = String(view.messageBody ?? view.body ?? '')
  const properties: Record<string, string> = {}
  if (typeof view.properties === 'string') {
    // rocketmq properties 形如 "KEY\u0001VALUE\u0002..." 容错解析
    for (const pair of view.properties.split('\u0002')) {
      const [k, v] = pair.split('\u0001')
      if (k) properties[k] = v ?? ''
    }
  } else if (view.properties && typeof view.properties === 'object') {
    for (const [k, v] of Object.entries(view.properties as Record<string, unknown>)) properties[k] = String(v)
  }
  const trimmed = body.trim()
  return {
    messageId: String(view.messageId ?? view.msgId ?? ''),
    topic: String(view.topic ?? ''),
    partition: Number(view.queueId ?? 0),
    offset: Number(view.commitLogOffset ?? view.offset ?? 0) || undefined,
    timestamp: tsToMs(view.storeTimeTimestamp ?? view.storeTimestamp ?? view.bornTimestamp),
    key: String(view.keys ?? '') || undefined,
    payload: body,
    payloadType: trimmed.startsWith('{') || trimmed.startsWith('[') ? 'json' : 'text',
    properties,
    payloadBytes: body.length,
    extras: {
      bornTimestamp: tsToMs(view.bornTimestamp),
      storeHost: String(view.storeHost ?? ''),
      bornHost: String(view.bornHost ?? ''),
      reconsumeTimes: Number(view.reconsumeTimes ?? 0),
      qId: Number(view.queueId ?? 0)
    }
  }
}

export const rocketmqDriver: MwDriver = {
  kind: 'rocketmq',
  label: 'Apache RocketMQ',
  transport: 'http',
  defaultPort: 8080,
  capabilities: CAPS,
  messageQueryModes: ['time', 'key', 'id'],

  async test(config, password) {
    const started = Date.now()
    try {
      const base = (config.dashboardUrl ?? '').replace(/\/$/, '')
      if (!/^https?:\/\//.test(base)) throw new Error('dashboard 地址必须以 http(s):// 开头')
      const res = await mwHttp(`${base}/cluster/list.query`, { insecureTls: true, timeoutMs: 10000 })
      if (res.status === 401 || res.status === 403) {
        if (!config.username) throw new Error(`dashboard 需要登录（HTTP ${res.status}），请填写账号`)
      }
      return { ok: true, message: 'dashboard 可达', latencyMs: Date.now() - started }
    } catch (error) {
      return { ok: false, message: `rocketmq-dashboard 连接失败：${(error as Error).message}`, latencyMs: Date.now() - started }
    }
  },

  async open(config, password, ctx) {
    const base = (config.dashboardUrl ?? '').replace(/\/$/, '')
    if (!/^https?:\/\//.test(base)) throw new Error('dashboard 地址必须以 http(s):// 开头')
    const handle: MwDriverHandle = {
      kind: 'rocketmq', raw: null, config, readOnly: false, password,
      capabilities: { ...CAPS }, messageQueryModes: ['time', 'key', 'id'],
      runtime: { base, username: config.username, password } satisfies RmqRuntime
    }
    await ensureLogin(handle)
    await call(handle, 'GET', '/cluster/list.query') // 探活
    ctx.signal.addEventListener('abort', () => { rt(handle).cookie = undefined }, { once: true })
    return handle
  },

  async close() { /* 无长连接，cookie 随句柄丢弃 */ },

  async overview(h) {
    const data = await call<{ clusterAddrTable?: Record<string, string[]>; brokerAddrTable?: Record<string, { cluster?: string; brokerAddrs?: Record<string, string> }> }>(h, 'GET', '/cluster/list.query')
    const brokers: MwOverview['brokers'] = []
    for (const [brokerName, info] of Object.entries(data?.brokerAddrTable ?? {})) {
      for (const [id, addr] of Object.entries(info?.brokerAddrs ?? {})) {
        brokers.push({ id: `${brokerName}-${id}`, host: String(addr), roles: info?.cluster ?? brokerName, alive: true })
      }
    }
    let topicCount = 0
    try {
      const topics = await call<{ topicList?: unknown[] }>(h, 'GET', '/topic/list.query?skipSysProcess=true&skipRetryAndDlq=false')
      topicCount = topics?.topicList?.length ?? 0
    } catch { /* 非关键 */ }
    return {
      kind: 'rocketmq',
      clusterName: Object.keys(data?.clusterAddrTable ?? {})[0],
      brokers,
      metrics: { brokers: brokers.length, topics: topicCount },
      notes: [DEP_NOTE, '消息收发与查询均经 dashboard 转发']
    }
  },

  async topicsList(h, input) {
    const data = await call<{ topicList?: Array<Record<string, any>> }>(h, 'GET', '/topic/list.query?skipSysProcess=true&skipRetryAndDlq=false')
    const list = data?.topicList ?? []
    return list
      .filter(t => !input.search || String(t.topic ?? '').includes(input.search!))
      .filter(t => input.includeInternal ? true : !String(t.topic ?? '').startsWith('%'))
      .map(t => {
        const name = String(t.topic ?? '')
        const sys = name.startsWith('%')
        return {
          name,
          entity: 'topic' as const,
          type: sys ? (name.startsWith('%DLQ') ? 'dlq' : 'retry') : (t.order === true || t.orderFlag === true ? 'fifo' : 'normal'),
          internal: sys,
          extras: {
            perm: t.perm,
            readQueueNums: t.readQueueNums,
            writeQueueNums: t.writeQueueNums,
            delayFlag: t.delayFlag === true,
            transactionFlag: t.transactionFlag === true
          }
        } as MwTopic
      })
  },

  async topicDescribe(h, topic) {
    const data = await call<{ offsetTable?: Record<string, { queueId?: number; minOffset?: number; maxOffset?: number; lastUpdateTimestamp?: number }> }>(h, 'GET', `/topic/stats.query?topic=${encodeURIComponent(topic)}`)
    const partitions = Object.entries(data?.offsetTable ?? {}).map(([key, v]) => ({
      queue: key, partition: v.queueId, earliest: v.minOffset, latest: v.maxOffset, lastUpdate: v.lastUpdateTimestamp
    }))
    return { partitions, configs: {}, extras: {} }
  },

  async topicCreate(h, input: MwTopicCreateInput) {
    const clusters = await clusterNames(h)
    const queueNum = input.queueNum ?? input.partitions ?? 8
    await call(h, 'POST', '/topic/createOrUpdate.do', {
      body: JSON.stringify({
        topicName: input.name,
        clusterNameList: clusters,
        writeQueueNums: queueNum,
        readQueueNums: queueNum,
        perm: 6,
        order: input.type === 'fifo',
        messageType: input.type === 'transaction' ? 'TRANSACTION' : input.type === 'delay' ? 'DELAY' : 'NORMAL'
      })
    })
  },

  async topicUpdate(h, name, attrs) {
    const clusters = await clusterNames(h)
    const queueNum = attrs.queueNum ?? attrs.partitions
    if (queueNum === undefined) throw new Error('RocketMQ 更新需指定 queueNum')
    await call(h, 'POST', '/topic/createOrUpdate.do', {
      body: JSON.stringify({
        topicName: name,
        clusterNameList: clusters,
        writeQueueNums: queueNum,
        readQueueNums: queueNum,
        perm: 6,
        order: attrs.type === 'fifo'
      })
    })
  },

  async topicDelete(h, name) {
    await call(h, 'POST', `/topic/deleteTopic.do?topic=${encodeURIComponent(name)}`)
  },

  topicPurge: async () => unsupported('清空（dashboard 无 purge 接口，请删除重建）'),
  partitionsGrow: async (h, input) => {
    await rocketmqDriver.topicUpdate(h, input.topic, { queueNum: input.count })
  },

  exchangesList: async () => unsupported('交换机管理'),
  exchangeCreate: async () => unsupported('交换机管理'),
  exchangeDelete: async () => unsupported('交换机管理'),
  bindingsList: async () => unsupported('绑定管理'),
  bindingCreate: async () => unsupported('绑定管理'),
  bindingDelete: async () => unsupported('绑定管理'),

  async groupsList(h, input) {
    const data = await call<{ data?: Array<Record<string, any>> } & Record<string, any>>(h, 'GET', '/consumer/groupList.query?skipSysGroup=false')
    const raw = (Array.isArray(data) ? data : (data?.data ?? [])) as Array<Record<string, any>>
    return raw
      .filter(g => !input.search || String(g.group ?? '').includes(input.search!))
      .map(g => ({
        groupId: String(g.group ?? ''),
        state: String(g.consumeType ?? ''),
        members: Number(g.count ?? 0),
        totalLag: Number(g.diffTotal ?? 0),
        extras: { consumeTps: g.consumeTps, version: g.version, messageModel: g.messageModel }
      })) as MwConsumerGroup[]
  },

  async groupDescribe(h, groupId) {
    const [stats, connection] = await Promise.all([
      call<{ offsetTable?: Record<string, { brokerOffset?: number; consumerOffset?: number; diff?: number }>; consumeTps?: number }>(h, 'GET', `/consumer/group.query?consumerGroup=${encodeURIComponent(groupId)}`).catch(() => null),
      call<{ connectionSet?: Array<Record<string, any>> }>(h, 'GET', `/consumer/consumerConnection.query?consumerGroup=${encodeURIComponent(groupId)}`).catch(() => null)
    ])
    if (!stats) throw new Error(`消费组不存在或查询失败：${groupId}`)
    const offsets: MwConsumerGroupDetail['offsets'] = []
    for (const [key, v] of Object.entries(stats.offsetTable ?? {})) {
      const topic = key.split('@')[0]
      offsets.push({
        topic,
        currentOffset: v.consumerOffset ?? 0,
        logEndOffset: v.brokerOffset ?? 0,
        lag: v.diff ?? Math.max(0, Number(v.brokerOffset ?? 0) - Number(v.consumerOffset ?? 0))
      })
    }
    // 同 topic 聚合 lag（dashboard 按 broker 队列返回）
    const byTopic = new Map<string, MwConsumerGroupDetail['offsets'][number]>()
    for (const o of offsets) {
      const prev = byTopic.get(o.topic)
      if (!prev) byTopic.set(o.topic, { ...o })
      else { prev.logEndOffset = Number(prev.logEndOffset) + Number(o.logEndOffset); prev.currentOffset = Number(prev.currentOffset) + Number(o.currentOffset); prev.lag += o.lag }
    }
    return {
      groupId,
      state: connection ? 'running' : 'idle',
      members: (connection?.connectionSet ?? []).map(c => ({ clientId: String(c.clientId ?? ''), host: String(c.clientAddr ?? '') })),
      offsets: [...byTopic.values()],
      extras: undefined
    } as MwConsumerGroupDetail
  },

  async groupResetOffsets(h, input) {
    // ResetOffsetRequest：{consumerGroup, topic, resetTime}
    let resetTime: string
    if (input.to === 'earliest') resetTime = 'earliest'
    else if (input.to === 'latest') resetTime = 'latest'
    else if (input.to === 'timestamp') resetTime = String(input.timestamp ?? Date.now())
    else throw new Error('RocketMQ 仅支持 earliest/latest/按时间重置')
    await call(h, 'POST', '/consumer/resetOffset.do', {
      body: JSON.stringify({ consumerGroup: input.groupId, topic: input.topic, resetTime })
    })
  },

  async clientsList(h, input) {
    const groups = await this.groupsList(h, { search: input.search })
    const out: MwClient[] = []
    for (const group of groups.slice(0, 50)) {
      const conn = await call<{ connectionSet?: Array<Record<string, any>> }>(h, 'GET', `/consumer/consumerConnection.query?consumerGroup=${encodeURIComponent(group.groupId)}`).catch(() => null)
      for (const c of conn?.connectionSet ?? []) {
        out.push({
          clientId: String(c.clientId ?? ''),
          host: String(c.clientAddr ?? ''),
          extras: { consumerGroup: group.groupId, version: c.version }
        })
      }
    }
    return out
  },

  clientKick: async () => unsupported('踢出客户端'),

  async messagesQuery(h, input: MwMessageQueryInput) {
    const max = Math.max(1, Math.min(Number(input.max) || 20, 200))
    // key 定位
    if (input.from === 'offset') throw new Error('RocketMQ 不支持按 offset 定位（用时间/Key/MsgId）')
    if (input.keyContains || input.from === 'key') {
      const key = input.key ?? input.keyContains ?? ''
      if (!key) throw new Error('按 Key 查询需要 key')
      const data = await call<{ msgList?: Array<Record<string, any>> }>(h, 'GET', `/message/queryMessageByTopicAndKey.query?topic=${encodeURIComponent(input.topic)}&key=${encodeURIComponent(key)}`)
      return (data?.msgList ?? []).slice(0, max).map(m => mapMessageView(m))
    }
    // id 定位（viewMessage 单条）
    if (input.from === 'id') {
      if (!input.messageId) throw new Error('按 MsgId 查询需要 messageId')
      const message = await this.messageGet(h, { topic: input.topic, messageId: input.messageId })
      return message ? [message] : []
    }
    // 时间段分页查询
    const begin = input.from === 'timestamp' ? Number(input.timestamp ?? Date.now() - 3600_000) : Date.now() - 3600_000
    const data = await call<{ msgPage?: { content?: Array<Record<string, any>> }; msgList?: Array<Record<string, any>> }>(h, 'POST', '/message/queryMessagePageByTopic.query', {
      body: JSON.stringify({ topic: input.topic, begin, end: Date.now(), pageNum: 1, pageSize: max, taskId: null })
    })
    const rows = data?.msgPage?.content ?? data?.msgList ?? []
    return rows.slice(0, max).map(m => mapMessageView(m))
  },

  async messageGet(h, input) {
    if (!input.messageId) throw new Error('需要 messageId')
    const data = await call<{ messageView?: Record<string, any> }>(h, 'GET', `/message/viewMessage.query?msgId=${encodeURIComponent(input.messageId)}`)
    return data?.messageView ? mapMessageView(data.messageView) : null
  },

  async messageSend(h, input: MwMessageSendInput) {
    await call(h, 'POST', '/topic/sendTopicMessage.do', {
      body: JSON.stringify({
        topic: input.topic,
        tag: input.properties?.tag ?? '',
        key: input.key ?? '',
        body: input.payload,
        traceEnabled: false
      })
    })
    return { ok: true }
  },

  async messageResend(h, input) {
    const message = input.message
    const group = String(message.extras?.consumerGroup ?? '')
    // 优先 dashboard 的「按消费组直接重发」；无组上下文则回退为发送到目标 topic
    if (!input.targetTopic && group && message.messageId) {
      try {
        await call(h, 'POST', `/message/consumeMessageDirectly.do?topic=${encodeURIComponent(message.topic)}&consumerGroup=${encodeURIComponent(group)}&msgId=${encodeURIComponent(message.messageId)}`)
        return { ok: true, detail: `已按消费组 ${group} 直接消费重试` }
      } catch { /* 回退 */ }
    }
    return this.messageSend(h, {
      topic: input.targetTopic ?? message.topic,
      payload: message.payload,
      key: message.key,
      properties: message.properties
    })
  },

  async configsDescribe(h, input) {
    const detail = await this.topicDescribe(h, input.topic)
    return [{ name: 'readQueueNums', value: String((detail.extras as Record<string, unknown>)?.readQueueNums ?? '—') }]
  },

  async configsAlter(h, input) {
    const queueNum = Number(input.configs.queueNum ?? input.configs.readQueueNums)
    if (!Number.isFinite(queueNum) || queueNum <= 0) throw new Error('仅支持修改 queueNum')
    await this.topicUpdate(h, input.topic, { queueNum })
  },

  async traceMessage(h, input) {
    // 先按 msgId 找消息本体，再取轨迹明细
    const view = await call<{ messageView?: Record<string, any>; messageTrackList?: Array<Record<string, any>> }>(h, 'GET', `/messageTrace/viewMessage.query?msgId=${encodeURIComponent(input.key)}`).catch(() => null)
    const traceRows = await call<Array<Record<string, any>>>(h, 'GET', `/messageTrace/viewMessageTraceDetail.query?msgId=${encodeURIComponent(input.key)}`)
    const steps: MwTraceStep[] = []
    for (const row of (Array.isArray(traceRows) ? traceRows : [])) {
      const producerGroup = String(row.producerGroup ?? '')
      if (producerGroup) {
        steps.push({
          phase: 'produced',
          timestamp: tsToMs(row.bornTimestamp ?? row.beginTimestamp),
          status: 'unknown',
          actor: producerGroup,
          detail: { clientHost: String(row.clientHost ?? ''), retryTimes: String(row.retryTimes ?? 0), status: String(row.status ?? '') }
        })
        steps.push({
          phase: 'stored',
          timestamp: tsToMs(row.storeTime ?? row.storeTimestamp),
          status: 'success',
          actor: String(row.storeHost ?? 'broker'),
          detail: { costTime: String(row.costTime ?? ''), msgType: String(row.msgType ?? '') }
        })
      }
    }
    // 消费侧：viewMessage 的 messageTrackList（每消费组的消费状态）
    for (const track of view?.messageTrackList ?? []) {
      const trackType = String(track.trackType ?? '')
      steps.push({
        phase: 'consume-attempt',
        timestamp: Date.now(),
        status: trackType === 'CONSUMED' ? 'success' : trackType === 'NOT_CONSUMED' ? 'failed' : 'unknown',
        actor: String(track.consumerGroup ?? ''),
        detail: {
          trackType,
          exception: String(track.exceptionDesc ?? '').slice(0, 200),
          diff: String(track.diff ?? '')
        }
      })
    }
    if (!steps.length && view?.messageView) {
      steps.push({ phase: 'produced', timestamp: tsToMs(view.messageView.bornTimestamp), status: 'unknown', actor: String(view.messageView.producerGroup ?? ''), detail: {} })
    }
    return { key: input.key, messageId: view?.messageView?.messageId ? String(view.messageView.messageId) : input.key, steps }
  },

  retainedList: async () => unsupported('retained 管理'),
  retainedDelete: async () => unsupported('retained 管理'),

  tailStart: async () => unsupported('实时监听（dashboard 无流式接口，请用时间段轮询）')
}
