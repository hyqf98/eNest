/** MQTT 驱动：mqtt.js 通用底座（pub/sub、retained 快照、$SYS 监控）+
 * EMQX 管理面适配（v5 18083 /api/v5 与 v4 8081 /api/v4 自动探测，Basic(apiKey:secret)）。
 * 运行于 mwUtility。MQTT 模型无 Topic 实体/历史消息：相关能力声明为不支持或待配置。 */
import mqtt, { type MqttClient } from 'mqtt'
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
  MwBindingCreateInput,
  MwTopicCreateInput,
  MwCapability
} from '@shared/types/mw-workbench'
import type { MwDriver, MwDriverContext, MwDriverHandle, MwTestResult } from '@main/middleware/types'
import { unsupported } from '@main/middleware/types'
import { mwHttpJson } from '@main/middleware/httpRequest'

const NOT_CONFIGURED = '启用连接配置中的 EMQX 管理适配后可用'

function baseCaps(): Record<string, MwCapability> {
  return {
    topicCrud: { state: 'unsupported', reason: 'MQTT 无 Topic 实体，topic 仅是路由模式' },
    partitions: { state: 'unsupported', reason: 'MQTT 无分区概念' },
    exchanges: { state: 'unsupported', reason: 'MQTT 无交换机概念' },
    bindings: { state: 'unsupported', reason: 'MQTT 无绑定概念' },
    consumerGroups: { state: 'unsupported', reason: 'MQTT 无消费组概念；EMQX 适配后按客户端聚合展示订阅' },
    offsetReset: { state: 'unsupported', reason: 'MQTT 无消费位点' },
    clients: { state: 'not-configured', reason: NOT_CONFIGURED },
    clientKick: { state: 'not-configured', reason: NOT_CONFIGURED },
    messageQuery: { state: 'not-configured', reason: '通用 MQTT 仅 retained 快照；EMQX 适配后可列出 retained 消息' },
    tail: { state: 'available' },
    publish: { state: 'available' },
    resend: { state: 'available', reason: '重新 publish' },
    trace: { state: 'unsupported', reason: 'MQTT 无消息轨迹' },
    retained: { state: 'not-configured', reason: NOT_CONFIGURED },
    configMgmt: { state: 'unsupported', reason: 'MQTT 无 topic 配置面' },
    monitor: { state: 'not-configured', reason: '$SYS 监控视 broker 而定；EMQX 适配后走管理 API' },
    dlqBrowse: { state: 'unsupported', reason: 'MQTT 无死信概念' }
  }
}

interface EmqxMgmt {
  version: 'v4' | 'v5'
  base: string
  username: string
  password: string
}

interface MqttRuntime {
  client: MqttClient
  mgmt?: EmqxMgmt
  mgmtError?: string
}

function rt(h: MwDriverHandle): MqttRuntime {
  return h.runtime as unknown as MqttRuntime
}

function connectClient(config: MwConnectionConfig, password?: string): Promise<MqttClient> {
  return new Promise((resolve, reject) => {
    if (!config.brokerUrl || !/^mqtts?:\/\/|^wss?:\/\//.test(config.brokerUrl)) {
      reject(new Error('brokerUrl 必须以 mqtt:// mqtts:// ws:// wss:// 开头'))
      return
    }
    const client = mqtt.connect(config.brokerUrl, {
      username: config.username,
      password,
      clientId: config.clientId || `enest-mw-${Math.random().toString(36).slice(2, 10)}`,
      clean: true,
      reconnectPeriod: 5000,
      connectTimeout: 8000
    })
    const timer = setTimeout(() => {
      client.end(true)
      reject(new Error('MQTT 连接超时（8s）'))
    }, 9000)
    client.once('connect', () => {
      clearTimeout(timer)
      resolve(client)
    })
    client.once('error', error => {
      clearTimeout(timer)
      client.end(true)
      reject(error instanceof Error ? error : new Error(String(error)))
    })
  })
}

/** EMQX 管理面探测：先 v5(/api/v5) 再 v4(/api/v4)，Basic(apiKey:secret) */
async function probeEmqx(config: MwConnectionConfig, password?: string): Promise<{ mgmt?: EmqxMgmt; error?: string }> {
  const emqx = config.emqx
  if (!emqx?.enabled) return {}
  const apiKey = emqx.apiKey || config.username || ''
  const apiSecret = emqx.apiSecretRef || password || ''
  const base = (emqx.apiUrl ?? '').replace(/\/$/, '')
  if (!/^https?:\/\//.test(base)) return { error: 'EMQX 管理端点必须以 http(s):// 开头' }
  const auth = { basicAuth: { username: apiKey, password: apiSecret }, insecureTls: true, timeoutMs: 8000 }
  if (emqx.version !== 'v4') {
    try {
      await mwHttpJson(`${base}/api/v5/status`, auth)
      return { mgmt: { version: 'v5', base, username: apiKey, password: apiSecret } }
    } catch { /* 落到 v4 */ }
  }
  if (emqx.version !== 'v5') {
    try {
      await mwHttpJson(`${base}/api/v4/brokers`, auth)
      return { mgmt: { version: 'v4', base, username: apiKey, password: apiSecret } }
    } catch { /* 报错 */ }
  }
  return { error: 'EMQX 管理面探测失败（v5/v5 均不可达或凭据无效）' }
}

/** 探测成功后升级能力面 */
function upgradeCaps(caps: Record<string, MwCapability>, mgmt: EmqxMgmt): void {
  const available = (reason?: string): MwCapability => ({ state: 'available', ...(reason ? { reason } : {}) })
  caps.clients = available(`EMQX ${mgmt.version} 管理面`)
  caps.clientKick = available()
  caps.retained = available()
  caps.messageQuery = available('EMQX retainer 列表 / retained 快照；无历史消息')
  caps.monitor = available(`EMQX ${mgmt.version} 管理面`)
  caps.consumerGroups = { state: 'available', reason: '按客户端聚合的订阅关系（EMQX）' }
}

function emqxAuth(mgmt: EmqxMgmt) {
  return { basicAuth: { username: mgmt.username, password: mgmt.password }, insecureTls: true }
}

function unwrap<T>(data: unknown): T {
  // v4 uses { code: 0, data }; v5 list endpoints use { data, meta }.
  if (data && typeof data === 'object' && 'code' in (data as Record<string, unknown>)) {
    const wrapper = data as { code?: number; message?: string; data?: unknown }
    if (wrapper.code !== 0 && wrapper.code !== 200 && wrapper.code !== undefined) {
      throw new Error(`EMQX API 错误 code=${wrapper.code}：${wrapper.message ?? ''}`)
    }
    return (wrapper.data ?? data) as T
  }
  if (data && typeof data === 'object' && Array.isArray((data as { data?: unknown }).data)) {
    return (data as { data: unknown }).data as T
  }
  return data as T
}

async function emqxGet<T>(mgmt: EmqxMgmt, path: string): Promise<T> {
  const versionPath = mgmt.version === 'v5' ? '/api/v5' : '/api/v4'
  return unwrap<T>(await mwHttpJson(`${mgmt.base}${versionPath}${path}`, emqxAuth(mgmt)))
}

async function emqxDelete(mgmt: EmqxMgmt, path: string): Promise<void> {
  const versionPath = mgmt.version === 'v5' ? '/api/v5' : '/api/v4'
  const { mwHttp } = await import('@main/middleware/httpRequest')
  await mwHttp(`${mgmt.base}${versionPath}${path}`, { method: 'DELETE', ...emqxAuth(mgmt) })
}

function onMessageOnce(client: MqttClient, topicFilter: string, timeoutMs: number): Promise<{ topic: string; payload: string; retain: boolean } | null> {
  return new Promise(resolve => {
    const timer = setTimeout(() => { cleanup(); resolve(null) }, timeoutMs)
    const handler = (topic: string, payload: Buffer, packet: { retain?: boolean }) => {
      cleanup()
      resolve({ topic, payload: payload.toString('utf8'), retain: !!packet.retain })
    }
    function cleanup() {
      clearTimeout(timer)
      client.off('message', handler)
      void client.unsubscribeAsync(topicFilter).catch(() => undefined)
    }
    client.on('message', handler)
    void client.subscribeAsync(topicFilter, { qos: 1 }).catch(() => { cleanup(); resolve(null) })
  })
}

function toMwMessage(topic: string, payload: string, extras: Record<string, string | number | boolean> = {}): MwMessage {
  const trimmed = payload.trim()
  return {
    topic,
    timestamp: Date.now(),
    payload,
    payloadType: trimmed.startsWith('{') || trimmed.startsWith('[') ? 'json' : 'text',
    payloadBytes: payload.length,
    extras: { retain: true, ...extras }
  }
}

export const mqttDriver: MwDriver = {
  kind: 'mqtt',
  label: 'MQTT',
  transport: 'native',
  defaultPort: 1883,
  capabilities: baseCaps(),
  messageQueryModes: [],

  async test(config, password) {
    const started = Date.now()
    try {
      const client = await connectClient(config, password)
      client.end(true)
      return { ok: true, message: '已连接 broker', latencyMs: Date.now() - started }
    } catch (error) {
      return { ok: false, message: `MQTT 连接失败：${(error as Error).message}`, latencyMs: Date.now() - started }
    }
  },

  async open(config, password, ctx) {
    const client = await connectClient(config, password)
    const runtime: MqttRuntime = { client }
    const capabilities = baseCaps()
    if (config.emqx?.enabled) {
      const probed = await probeEmqx(config, password)
      runtime.mgmt = probed.mgmt
      runtime.mgmtError = probed.error
      if (probed.mgmt) upgradeCaps(capabilities, probed.mgmt)
    }
    const handle: MwDriverHandle = {
      kind: 'mqtt', raw: null, config, readOnly: false, password,
      capabilities, messageQueryModes: runtime.mgmt ? ['key'] : [],
      runtime: runtime as unknown as Record<string, unknown>
    }
    ctx.signal.addEventListener('abort', () => { client.end(true) }, { once: true })
    return handle
  },

  async close(h) {
    if (h.closed) return
    h.closed = true
    rt(h).client.end(true)
  },

  async overview(h) {
    const r = rt(h)
    if (r.mgmt) {
      const mgmt = r.mgmt
      if (mgmt.version === 'v5') {
        const [nodes, stats] = await Promise.all([
          emqxGet<Array<Record<string, any>>>(r.mgmt, '/nodes').catch(() => []),
          emqxGet<Record<string, any>>(r.mgmt, '/stats').catch(() => ({}))
        ])
        return {
          kind: 'mqtt',
          clusterName: 'EMQX',
          brokers: nodes.map(n => ({ id: String(n.node ?? ''), host: String(n.node ?? ''), roles: String(n.role ?? 'core'), alive: true, extras: { connections: Number(n.connections ?? 0), memUsed: Number(n.memory_used ?? 0) } })),
          metrics: {
            version: String((nodes[0] as any)?.version ?? '—'),
            connections: Number((stats as any).connections?.max ?? 0),
            topics: Number((stats as any).topics?.max ?? 0),
            subscriptions: Number((stats as any).subscriptions?.max ?? 0),
            retained: Number((stats as any).retained?.max ?? 0),
            messagesReceived: Number((stats as any).messages?.received ?? (stats as any)['messages/received'] ?? 0)
          },
          notes: [`EMQX ${mgmt.version} 管理面`]
        } as MwOverview
      }
      const nodes = await emqxGet<Array<Record<string, any>>>(r.mgmt, '/nodes').catch(() => [])
      const list = Array.isArray(nodes) ? nodes : [nodes]
      return {
        kind: 'mqtt',
        clusterName: 'EMQX',
        brokers: list.map(n => ({ id: String(n.name ?? ''), host: String(n.name ?? ''), alive: true, extras: { connections: n.connections, memUsed: n.memory_used } })),
        metrics: { version: String(list[0]?.version ?? '—'), connections: list.reduce((s, n) => s + Number(n.connections ?? 0), 0) },
        notes: ['EMQX v4 管理面']
      } as MwOverview
    }
    // 通用：订阅 $SYS/# 采样 2 秒
    const metrics: Record<string, string | number> = {}
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => { cleanup(); resolve() }, 2000)
      const handler = (topic: string, payload: Buffer) => {
        const key = topic.replace(/^\$SYS\/[^/]+\//, '')
        metrics[key] = payload.toString('utf8')
      }
      function cleanup() { clearTimeout(timer); r.client.off('message', handler); void r.client.unsubscribeAsync('$SYS/#').catch(() => undefined) }
      r.client.on('message', handler)
      void r.client.subscribeAsync('$SYS/#').catch(() => { cleanup(); resolve() })
    })
    const notes = [
      r.mgmtError ? `EMQX 探测失败：${r.mgmtError}` : '深度监控需 EMQX 管理适配；当前为 $SYS 主题采样（取决于 broker 是否开放）'
    ]
    return {
      kind: 'mqtt',
      brokers: [],
      metrics,
      notes
    } as MwOverview
  },

  async topicsList(h, input) {
    const r = rt(h)
    if (!r.mgmt) unsupported('Topic 管理（MQTT 无 Topic 实体；EMQX 适配后可看订阅关系）')
    const subs = r.mgmt.version === 'v5'
      ? await emqxGet<Array<Record<string, any>>>(r.mgmt, '/subscriptions?limit=200')
      : unwrap<Array<Record<string, any>>>(await emqxGet<Record<string, any>>(r.mgmt, '/subscriptions'))
    const list = (Array.isArray(subs) ? subs : []).slice(0, 300)
    return list
      .filter(s => !input.search || String(s.topic ?? '').includes(input.search!))
      .map(s => ({
        name: String(s.topic ?? ''),
        entity: 'subscription' as const,
        extras: { clientid: String(s.clientid ?? ''), qos: Number(s.qos ?? 0) }
      })) as MwTopic[]
  },

  topicDescribe: async () => unsupported('Topic 详情'),
  topicCreate: async () => unsupported('Topic 管理'),
  topicUpdate: async () => unsupported('Topic 管理'),
  topicDelete: async () => unsupported('Topic 管理'),
  topicPurge: async () => unsupported('清空 Topic'),
  partitionsGrow: async () => unsupported('分区管理'),
  exchangesList: async () => unsupported('交换机管理'),
  exchangeCreate: async () => unsupported('交换机管理'),
  exchangeDelete: async () => unsupported('交换机管理'),
  bindingsList: async () => unsupported('绑定管理'),
  bindingCreate: async () => unsupported('绑定管理'),
  bindingDelete: async () => unsupported('绑定管理'),

  async groupsList(h, input) {
    const r = rt(h)
    if (!r.mgmt) unsupported('订阅聚合（EMQX 适配后可用）')
    const subs = r.mgmt.version === 'v5'
      ? await emqxGet<Array<Record<string, any>>>(r.mgmt, '/subscriptions?limit=500')
      : unwrap<Array<Record<string, any>>>(await emqxGet<Record<string, any>>(r.mgmt, '/subscriptions'))
    const byClient = new Map<string, string[]>()
    for (const s of (Array.isArray(subs) ? subs : [])) {
      const id = String(s.clientid ?? '')
      if (input.search && !id.includes(input.search!)) continue
      byClient.set(id, [...(byClient.get(id) ?? []), String(s.topic ?? '')])
    }
    return [...byClient.entries()].slice(0, 200).map(([clientid, topics]) => ({
      groupId: clientid,
      state: 'subscribed',
      members: 1,
      topics: [...new Set(topics)]
    })) as MwConsumerGroup[]
  },

  groupDescribe: async (): Promise<MwConsumerGroupDetail> => unsupported('消费组详情'),
  groupResetOffsets: async () => unsupported('offset 重置'),

  async clientsList(h, input) {
    const r = rt(h)
    if (!r.mgmt) unsupported('客户端管理（EMQX 适配后可用）')
    const clients = r.mgmt.version === 'v5'
      ? await emqxGet<Array<Record<string, any>>>(r.mgmt, '/clients?limit=200')
      : unwrap<Array<Record<string, any>>>(await emqxGet<Record<string, any>>(r.mgmt, '/connections'))
    return (Array.isArray(clients) ? clients : []).slice(0, 300)
      .filter(c => !input.search || String(c.clientid ?? '').includes(input.search!) || String(c.username ?? '').includes(input.search!))
      .map(c => ({
        clientId: String(c.clientid ?? ''),
        host: String(c.ip_address ?? ''),
        connectedAt: c.connected_at ? new Date(String(c.connected_at).replace(' +', ' +') || Date.now()).getTime() : undefined,
        extras: { username: String(c.username ?? ''), keepalive: Number(c.keepalive ?? 0), cleanStart: String(c.clean_start ?? ''), subscriptionsCount: Number(c.subscriptions_cnt ?? c.subscriptions_count ?? 0) }
      })) as MwClient[]
  },

  async clientKick(h, clientId) {
    const r = rt(h)
    if (!r.mgmt) unsupported('踢出客户端')
    await emqxDelete(r.mgmt, `/clients/${encodeURIComponent(clientId)}`)
  },

  async messagesQuery(h, input: MwMessageQueryInput) {
    const r = rt(h)
    // 优先 EMQX retainer 列表
    if (r.mgmt) {
      try {
        const list = r.mgmt.version === 'v5'
          ? await emqxGet<Array<Record<string, any>>>(r.mgmt, `/mqtt/retainer/messages?topic=${encodeURIComponent(input.topic)}&limit=${Math.min(Number(input.max) || 50, 200)}`)
          : unwrap<Array<Record<string, any>>>(await emqxGet<Record<string, any>>(r.mgmt, `/mqtt/retainer_messages/${encodeURIComponent(input.topic)}`))
        return (Array.isArray(list) ? list : []).map(m => toMwMessage(String(m.topic ?? input.topic), String(m.payload ?? ''), { qos: Number(m.qos ?? 0), publishAt: String(m.publish_at ?? m.publish_datetime ?? '') }))
      } catch { /* 探测失败回退订阅方式 */ }
    }
    // 通用回退：订阅收 retained 快照
    const got = await onMessageOnce(r.client, input.topic, 1500)
    return got ? [toMwMessage(got.topic, got.payload, { mode: 'retained-snapshot' })] : []
  },

  async messageGet(h, input) {
    const rows = await this.messagesQuery(h, { topic: input.topic, from: 'earliest', max: 1 })
    return rows[0] ?? null
  },

  async messageSend(h, input: MwMessageSendInput) {
    await new Promise<void>((resolve, reject) => {
      rt(h).client.publish(input.topic, input.payload, { qos: input.qos ?? 1, retain: input.retain ?? false }, error => {
        if (error) reject(error instanceof Error ? error : new Error(String(error)))
        else resolve()
      })
    })
    return { ok: true, detail: `qos=${input.qos ?? 1}${input.retain ? ' retain' : ''}` }
  },

  async messageResend(h, input) {
    return this.messageSend(h, { topic: input.targetTopic ?? input.message.topic, payload: input.message.payload, qos: 1 })
  },

  configsDescribe: async () => unsupported('配置管理'),
  configsAlter: async () => unsupported('配置管理'),
  traceMessage: async (): Promise<MwTrace> => unsupported('消息轨迹'),

  async retainedList(h, input) {
    const r = rt(h)
    if (!r.mgmt) unsupported('retained 管理（EMQX 适配后可用）')
    const list = r.mgmt.version === 'v5'
      ? await emqxGet<Array<Record<string, any>>>(r.mgmt, '/mqtt/retainer/messages?limit=500')
      : unwrap<Array<Record<string, any>>>(await emqxGet<Record<string, any>>(r.mgmt, '/mqtt/retainer/messages'))
    return (Array.isArray(list) ? list : []).slice(0, 500)
      .filter(m => !input.search || String(m.topic ?? '').includes(input.search!))
      .map(m => ({
        name: String(m.topic ?? ''),
        entity: 'retained' as const,
        messageCount: 1,
        extras: { qos: Number(m.qos ?? 0), publishAt: String(m.publish_at ?? m.publish_datetime ?? '') }
      })) as MwTopic[]
  },

  async retainedDelete(h, topic) {
    const r = rt(h)
    if (!r.mgmt) unsupported('retained 管理')
    await emqxDelete(r.mgmt, `/mqtt/retainer/message/${encodeURIComponent(topic)}`)
  },

  async tailStart(h, input, sink) {
    const client = rt(h).client
    await client.subscribeAsync(input.topic, { qos: 1 })
    const handler = (topic: string, payload: Buffer, packet: { retain?: boolean; qos?: number }) => {
      if (input.filter && !topic.includes(input.filter) && !payload.toString('utf8').includes(input.filter)) return
      sink(toMwMessage(topic, payload.toString('utf8'), { mode: 'live', qos: packet.qos ?? 0, fresh: !packet.retain }))
    }
    client.on('message', handler)
    return {
      stop: async () => {
        client.off('message', handler)
        await client.unsubscribeAsync(input.topic).catch(() => undefined)
      }
    }
  }
}
