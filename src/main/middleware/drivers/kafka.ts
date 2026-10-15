/** Kafka 驱动（kafkajs 直连）。运行于 mwUtility。
 * 查询/监听共用无 autoCommit 的临时 consumer（随机 groupId，绝不污染业务消费位点）。 */
import kafkajs, { type Kafka as KafkaClient, type Admin, type Consumer, type Producer, type KafkaMessage, type SASLOptions } from 'kafkajs'
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
  MwTopicCreateInput
} from '@shared/types/mw-workbench'
import type { MwDriver, MwDriverContext, MwDriverHandle, MwTestResult } from '@main/middleware/types'
import { unsupported } from '@main/middleware/types'

// KafkaJS is CommonJS; its computed exports are not available as ESM named imports.
const { Kafka, ConfigResourceTypes } = kafkajs

const CAPS: Record<string, { state: 'available' | 'unsupported'; reason?: string }> = {
  topicCrud: { state: 'available' },
  partitions: { state: 'available' },
  exchanges: { state: 'unsupported', reason: 'Kafka 无交换机概念' },
  bindings: { state: 'unsupported', reason: 'Kafka 无绑定概念' },
  consumerGroups: { state: 'available' },
  offsetReset: { state: 'available', reason: '重置要求组内没有存活消费者' },
  clients: { state: 'unsupported', reason: 'Kafka 无客户端管理面（走消费组）' },
  clientKick: { state: 'unsupported', reason: 'Kafka 无客户端管理面' },
  messageQuery: { state: 'available' },
  tail: { state: 'available' },
  publish: { state: 'available' },
  resend: { state: 'available' },
  trace: { state: 'unsupported', reason: 'Kafka 无消息轨迹（需业务埋点）' },
  retained: { state: 'unsupported', reason: 'Kafka 无 retained 消息' },
  configMgmt: { state: 'available' },
  monitor: { state: 'available' },
  dlqBrowse: { state: 'available', reason: 'Kafka 无原生 DLQ：浏览 __/%DLQ% 内部 topic 人工重放' }
}

/** 惰性资源池：admin 常驻，producer/query consumer 按需 */
interface KafkaRuntime {
  kafka: KafkaClient
  admin: Admin
  producer?: Producer
  liveConsumers: Set<Consumer>
}

function bufToText(buf?: Buffer | null): { text: string; encoding: 'utf8' | 'base64' } {
  if (!buf || buf.length === 0) return { text: '', encoding: 'utf8' }
  // 不可打印字节占比高则按 base64 呈现
  let odd = 0
  for (const byte of buf) if (byte < 9 || (byte > 13 && byte < 32) || byte === 0xff) odd++
  if (odd / buf.length > 0.05) return { text: buf.toString('base64'), encoding: 'base64' }
  return { text: buf.toString('utf8'), encoding: 'utf8' }
}

function headersToRecord(headers?: KafkaMessage['headers']): Record<string, string> | undefined {
  if (!headers) return undefined
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(headers)) {
    out[k] = Array.isArray(v)
      ? v.map(b => (b === null || b === undefined ? '' : typeof b === 'string' ? b : b.toString('utf8'))).join(',')
      : (v === null || v === undefined ? '' : typeof v === 'string' ? v : v.toString('utf8'))
  }
  return Object.keys(out).length ? out : undefined
}

function payloadType(text: string): 'json' | 'text' {
  const t = text.trim()
  return (t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']')) ? 'json' : 'text'
}

function mapMessage(topic: string, partition: number, message: KafkaMessage): MwMessage {
  const key = message.key ? message.key.toString('utf8') : undefined
  const { text, encoding } = bufToText(message.value)
  return {
    topic,
    partition,
    offset: Number(message.offset),
    timestamp: Number(message.timestamp) || Date.now(),
    key: key || undefined,
    payload: text,
    payloadEncoding: encoding,
    payloadType: payloadType(text),
    headers: headersToRecord(message.headers),
    payloadBytes: message.value?.length ?? 0
  }
}

function buildClient(config: MwConnectionConfig, password?: string, suffix = ''): KafkaClient {
  const mechanism = config.saslMechanism ?? 'none'
  const sasl = (mechanism === 'none' ? undefined : mechanism === 'oauthbearer'
    ? (() => { throw new Error('oauthbearer 暂不支持，请使用 SCRAM/PLAIN 或提交需求') })()
    : { mechanism, username: config.username ?? '', password: password ?? '' }) as SASLOptions | undefined
  return new Kafka({
    clientId: `enest-mw${suffix}-${Math.random().toString(36).slice(2, 8)}`,
    brokers: (config.bootstrapServers ?? '').split(',').map(s => s.trim()).filter(Boolean),
    ssl: config.tls ? { rejectUnauthorized: config.tlsRejectUnauthorized !== false } : undefined,
    sasl,
    requestTimeout: 20000,
    connectionTimeout: 10000,
    logLevel: 0
  })
}

function runtimeOf(h: MwDriverHandle): KafkaRuntime {
  return h.runtime as unknown as KafkaRuntime
}

async function queryConsumer(
  h: MwDriverHandle,
  input: MwMessageQueryInput
): Promise<MwMessage[]> {
  const rt = runtimeOf(h)
  const max = Math.max(1, Math.min(Number(input.max) || 50, 500))
  const consumer = rt.kafka.consumer({ groupId: `enest-mw-query-${Math.random().toString(36).slice(2, 10)}` })
  const messages: MwMessage[] = []
  try {
    await consumer.connect()
    await consumer.subscribe({ topic: input.topic, fromBeginning: input.from === 'earliest' })
    // 计算每个分区的起点 offset
    const admin = rt.admin
    const offsets = await admin.fetchTopicOffsets(input.topic) // [{partition, offset(latest), low, high}]
    const targets = new Map<number, number>()
    for (const p of offsets) {
      const high = Number(p.high ?? p.offset ?? 0)
      const low = Number(p.low ?? 0)
      let start: number
      if (input.from === 'earliest') start = low
      else if (input.from === 'latest') start = Math.max(low, high - max)
      else if (input.from === 'offset') start = Number(input.offset ?? 0)
      else if (input.from === 'timestamp') {
        const byTime = await admin.fetchTopicOffsetsByTimestamp(input.topic, Number(input.timestamp ?? Date.now() - 3600_000))
        start = Number(byTime.find(x => x.partition === p.partition)?.offset ?? low)
      } else start = low
      targets.set(p.partition, Math.max(low, start))
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    let idle: ReturnType<typeof setTimeout> | undefined
    let seekTimer: ReturnType<typeof setTimeout> | undefined
    const clearTimers = () => { clearTimeout(timer); clearTimeout(idle); clearTimeout(seekTimer) }
    await new Promise<void>((resolve, reject) => {
      let settled = false
      const finish = (error?: unknown) => {
        if (settled) return
        settled = true
        clearTimers()
        if (error !== undefined) reject(error)
        else resolve()
      }
      timer = setTimeout(finish, 20000)
      idle = setTimeout(finish, 4000)
      // 每条消息都替换空闲截止时间；不能遗留旧 timer 提前结束活跃查询。
      const markIdle = () => { clearTimeout(idle); idle = setTimeout(finish, 2500) }
      consumer.run({
        autoCommit: false,
        eachMessage: async ({ topic, partition, message }) => {
          if (settled) return
          if (input.partition !== undefined && partition !== input.partition) return
          if (input.keyContains && !(message.key?.toString('utf8') ?? '').includes(input.keyContains)) { markIdle(); return }
          messages.push(mapMessage(topic, partition, message))
          markIdle()
          if (messages.length >= max) finish()
        }
      }).catch(finish)
      // seek 必须在 run 之后；对未分配分区 kafkajs 会排队应用
      seekTimer = setTimeout(() => {
        if (settled) return
        for (const [partition, offset] of targets) {
          try { consumer.seek({ topic: input.topic, partition, offset: String(offset) }) } catch { /* 分区可能未分配，忽略 */ }
        }
      }, 80)
    }).finally(clearTimers)
    if (input.keyContains && messages.length < max && !input.partition) {
      // key 过滤导致不足时不再补拉：Kafka 无 key 索引，完整扫描代价过高
    }
    messages.sort((a, b) => (a.timestamp - b.timestamp) || ((a.partition ?? 0) - (b.partition ?? 0)))
    return messages.slice(0, max)
  } finally {
    await consumer.disconnect().catch(() => undefined)
  }
}

export const kafkaDriver: MwDriver = {
  kind: 'kafka',
  label: 'Apache Kafka',
  transport: 'native',
  defaultPort: 9092,
  capabilities: CAPS,
  messageQueryModes: ['offset', 'time', 'key'],

  async test(config, password) {
    const started = Date.now()
    const kafka = buildClient(config, password, '-test')
    const admin = kafka.admin()
    try {
      await admin.connect()
      await admin.describeCluster()
      return { ok: true, message: '已连接', latencyMs: Date.now() - started }
    } catch (error) {
      return { ok: false, message: `Kafka 连接失败：${(error as Error).message}`, latencyMs: Date.now() - started }
    } finally {
      await admin.disconnect().catch(() => undefined)
    }
  },

  async open(config, password, ctx) {
    if (!config.bootstrapServers) throw new Error('bootstrapServers 必填')
    const kafka = buildClient(config, password)
    const admin = kafka.admin()
    await admin.connect()
    const handle: MwDriverHandle = {
      kind: 'kafka', raw: null, config, readOnly: false, password,
      capabilities: { ...CAPS }, messageQueryModes: ['offset', 'time', 'key'],
      runtime: { kafka, admin, liveConsumers: new Set() } satisfies KafkaRuntime
    }
    handle.raw = handle.runtime
    ctx.signal.addEventListener('abort', () => { void closeQuiet(handle) }, { once: true })
    return handle
  },

  async close(h) {
    if (h.closed) return
    h.closed = true
    await closeQuiet(h)
  },

  async overview(h) {
    const admin = runtimeOf(h).admin
    const cluster = await admin.describeCluster()
    const topics = await admin.listTopics()
    const overview: MwOverview = {
      kind: 'kafka',
      clusterName: cluster.clusterId ?? undefined,
      brokers: cluster.brokers.map(b => ({ id: String(b.nodeId), host: `${b.host}:${b.port}`, roles: b.nodeId === cluster.controller ? 'controller' : 'broker', alive: true })),
      metrics: {
        brokers: cluster.brokers.length,
        topics: topics.length
      },
      notes: ['深度指标（吞吐/请求延迟）需 JMX/Prometheus 导出器，此处仅集群拓扑']
    }
    return overview
  },

  async topicsList(h, input) {
    const rt = runtimeOf(h)
    const names = (await rt.admin.listTopics())
      .filter(n => (input.includeInternal ? true : !n.startsWith('__') && !n.startsWith('%')))
      .filter(n => !input.search || n.toLowerCase().includes(input.search.toLowerCase()))
      .sort()
    const limited = names.slice(0, 120)
    const metadatas = limited.length ? await rt.admin.fetchTopicMetadata({ topics: limited }).catch(() => ({ topics: [] })) : { topics: [] }
    const topics: MwTopic[] = []
    for (const name of names) {
      const meta = metadatas.topics.find(t => t.name === name)
      topics.push({
        name,
        entity: 'topic',
        partitions: meta?.partitions.length,
        replicas: meta?.partitions[0]?.replicas?.length,
        internal: name.startsWith('__'),
        type: name.startsWith('__') || name.startsWith('%DLQ') || name.startsWith('%RETRY') ? 'internal' : 'normal'
      })
    }
    // 消息量只对前 60 个 topic 计算（逐 topic 拉Offsets 代价高）
    for (const t of topics.slice(0, 60)) {
      try {
        const offsets = await rt.admin.fetchTopicOffsets(t.name)
        const total = offsets.reduce((sum, p) => sum + Math.max(0, Number(p.offset ?? p.high ?? 0) - Number(p.low ?? 0)), 0)
        t.messageCount = total
      } catch { /* 单 topic 失败不阻断列表 */ }
    }
    return topics
  },

  async topicDescribe(h, topic) {
    const rt = runtimeOf(h)
    const offsets = await rt.admin.fetchTopicOffsets(topic)
    return {
      partitions: offsets.map(p => ({ partition: p.partition, latest: Number(p.offset ?? p.high ?? 0), earliest: Number(p.low ?? 0) }))
    }
  },

  async topicCreate(h, input: MwTopicCreateInput) {
    const rt = runtimeOf(h)
    const ok = await rt.admin.createTopics({
      topics: [{
        topic: input.name,
        numPartitions: input.partitions ?? 3,
        replicationFactor: input.replicationFactor ?? 1,
        configEntries: Object.entries(input.configs ?? {}).map(([name, value]) => ({ name, value: String(value) }))
      }]
    })
    if (!ok) throw new Error('Topic 创建被拒绝（可能已存在或副本数超过可用 broker）')
  },

  async topicUpdate(h, name, attrs) {
    const rt = runtimeOf(h)
    if (attrs.configs && Object.keys(attrs.configs).length) {
      await rt.admin.alterConfigs({
        validateOnly: false,
        resources: [{
          type: ConfigResourceTypes.TOPIC, name,
          configEntries: Object.entries(attrs.configs).map(([k, v]) => ({ name: k, value: String(v) }))
        }]
      })
    }
    if (attrs.partitions !== undefined) {
      throw new Error('分区数不可缩减；扩容请使用「扩容分区」操作')
    }
  },

  async topicDelete(h, name) {
    await runtimeOf(h).admin.deleteTopics({ topics: [name] })
  },

  async topicPurge(h, name) {
    const rt = runtimeOf(h)
    const offsets = await rt.admin.fetchTopicOffsets(name)
    // '-1' = 删除到各分区最新位点（kafkajs 哨兵语义）
    await rt.admin.deleteTopicRecords({ topic: name, partitions: offsets.map(p => ({ partition: p.partition, offset: '-1' as unknown as number })) } as never)
  },

  async partitionsGrow(h, input) {
    await runtimeOf(h).admin.createPartitions({ topicPartitions: [{ topic: input.topic, count: input.count }] })
  },

  exchangesList: async () => unsupported('交换机管理'),
  exchangeCreate: async () => unsupported('交换机管理'),
  exchangeDelete: async () => unsupported('交换机管理'),
  bindingsList: async () => unsupported('绑定管理'),
  bindingCreate: async () => unsupported('绑定管理'),
  bindingDelete: async () => unsupported('绑定管理'),

  async groupsList(h, input) {
    const rt = runtimeOf(h)
    const { groups } = await rt.admin.listGroups()
    const filtered = groups
      .filter(g => !input.search || g.groupId.toLowerCase().includes(input.search.toLowerCase()))
      .slice(0, 100)
    const out: MwConsumerGroup[] = []
    if (filtered.length) {
      const described = await rt.admin.describeGroups(filtered.map(g => g.groupId)).catch(() => ({ groups: [] as Array<{ groupId: string; state: string; members?: unknown[] }> }))
      for (const g of filtered) {
        const d = described.groups.find(x => x.groupId === g.groupId)
        out.push({ groupId: g.groupId, state: d?.state, members: d?.members?.length ?? 0, extras: { protocolType: g.protocolType } })
      }
    }
    return out
  },

  async groupDescribe(h, groupId) {
    const rt = runtimeOf(h)
    const described = await rt.admin.describeGroups([groupId])
    const group = described.groups[0]
    if (!group) throw new Error(`消费组不存在：${groupId}`)
    const endCache = new Map<string, { partition: number; end: number }[]>()
    const detail: MwConsumerGroupDetail = {
      groupId,
      state: group.state,
      members: (group.members ?? []).map(m => ({ clientId: m.memberId?.slice(0, 18) ?? 'unknown', host: m.clientHost, topics: [] })),
      offsets: []
    }
    // fetchOffsets 返回 [{topic, partitions: [{partition, offset, metadata}]}]，offset 为 -1/-2 表示未提交
    const committed = await rt.admin.fetchOffsets({ groupId, topics: [] }).catch(() => [])
    for (const topicEntry of committed) {
      const key = topicEntry.topic
      let ends = endCache.get(key)
      if (!ends) {
        try {
          const list = await rt.admin.fetchTopicOffsets(key)
          ends = list.map(p => ({ partition: p.partition, end: Number(p.offset ?? p.high ?? 0) }))
        } catch { ends = [] }
        endCache.set(key, ends)
      }
      for (const p of topicEntry.partitions) {
        const committedOffset = Number(p.offset)
        const end = ends.find(e => e.partition === p.partition)?.end
        detail.offsets.push({
          topic: key,
          partition: p.partition,
          currentOffset: committedOffset < 0 ? '未提交' : committedOffset,
          logEndOffset: end ?? '—',
          lag: committedOffset < 0 ? (end ?? 0) : Math.max(0, (end ?? 0) - committedOffset)
        })
      }
    }
    return detail
  },

  async groupResetOffsets(h, input) {
    const admin = runtimeOf(h).admin
    if (input.to === 'earliest' || input.to === 'latest') {
      await admin.resetOffsets({ groupId: input.groupId, topic: input.topic, earliest: input.to === 'earliest' })
      return
    }
    // timestamp / offset 精确重置：先换算每分区目标位
    let partitions: Array<{ partition: number; offset: string }>
    if (input.to === 'timestamp') {
      const byTime = await admin.fetchTopicOffsetsByTimestamp(input.topic, Number(input.timestamp ?? Date.now()))
      partitions = byTime.map(p => ({ partition: p.partition, offset: String(p.offset) }))
    } else {
      if (input.partition === undefined || input.offset === undefined) throw new Error('按 offset 重置需指定 partition 与 offset')
      partitions = [{ partition: input.partition, offset: String(input.offset) }]
    }
    await admin.setOffsets({ groupId: input.groupId, topic: input.topic, partitions })
  },

  clientsList: async () => unsupported('客户端管理'),
  clientKick: async () => unsupported('客户端管理'),

  async messagesQuery(h, input) {
    return queryConsumer(h, input)
  },

  async messageGet(h, input) {
    if (input.partition === undefined || input.offset === undefined) {
      if (input.messageId) throw new Error('Kafka 不支持按 messageId 定位；请使用 分区+offset')
      throw new Error('需要 partition 与 offset')
    }
    const rows = await queryConsumer(h, { topic: input.topic, partition: input.partition, from: 'offset', offset: input.offset, max: 1 })
    return rows[0] ?? null
  },

  async messageSend(h, input: MwMessageSendInput) {
    const rt = runtimeOf(h)
    rt.producer ??= rt.kafka.producer()
    if (!rt.producer) throw new Error('producer init failed')
    await rt.producer.connect()
    const body = input.payloadEncoding === 'base64' ? Buffer.from(input.payload, 'base64') : input.payload
    await rt.producer.send({
      topic: input.topic,
      messages: [{
        key: input.key ?? input.routingKey,
        value: body,
        ...(input.partition !== undefined ? { partition: input.partition } : {}),
        headers: input.headers
      }]
    })
    return { ok: true }
  },

  async messageResend(h, input) {
    const target = input.targetTopic ?? input.message.topic
    return this.messageSend!(h, {
      topic: target,
      payload: input.message.payload,
      payloadEncoding: input.message.payloadEncoding,
      key: input.message.key,
      headers: input.message.headers
    } as MwMessageSendInput)
  },

  async configsDescribe(h, input) {
    const rt = runtimeOf(h)
    const result = await rt.admin.describeConfigs({ resources: [{ type: ConfigResourceTypes.TOPIC, name: input.topic }], includeSynonyms: false })
    const entries = result.resources[0]?.configEntries ?? []
    return entries.map(e => ({ name: e.configName, value: e.configValue ?? '' }))
  },

  async configsAlter(h, input) {
    const rt = runtimeOf(h)
    await rt.admin.alterConfigs({
      validateOnly: false,
      resources: [{
        type: ConfigResourceTypes.TOPIC, name: input.topic,
        configEntries: Object.entries(input.configs).map(([name, value]) => ({ name, value: String(value) }))
      }]
    })
  },

  traceMessage: async (): Promise<MwTrace> => unsupported('消息轨迹'),
  retainedList: async () => unsupported('retained 管理'),
  retainedDelete: async () => unsupported('retained 管理'),

  async tailStart(h, input, sink) {
    const rt = runtimeOf(h)
    const consumer = rt.kafka.consumer({ groupId: `enest-mw-tail-${Math.random().toString(36).slice(2, 10)}` })
    rt.liveConsumers.add(consumer)
    await consumer.connect()
    await consumer.subscribe({ topic: input.topic, fromBeginning: false })
    let paused = false
    await consumer.run({
      autoCommit: false,
      eachMessage: async ({ topic, partition, message }) => {
        if (paused) return
        if (input.filter && !topic.includes(input.filter) && !(message.key?.toString('utf8') ?? '').includes(input.filter)) return
        sink(mapMessage(topic, partition, message))
      }
    })
    return {
      stop: async () => {
        paused = true
        rt.liveConsumers.delete(consumer)
        await consumer.disconnect().catch(() => undefined)
      }
    }
  }
}

async function closeQuiet(h: MwDriverHandle): Promise<void> {
  const rt = h.runtime as KafkaRuntime | undefined
  if (!rt) return
  await Promise.allSettled([
    rt.producer?.disconnect(),
    ...[...rt.liveConsumers].map(c => c.disconnect()),
    rt.admin.disconnect()
  ])
}
