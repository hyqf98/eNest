/** 中间件控制台（mw.*）工作台类型：连接配置、能力描述符、统一消息模型与 workbench action 契约。
 * 与 db-workbench.ts 同构：action 判别联合 + 每插件 UtilityProcess 内执行。 */

export type MwKind = 'kafka' | 'rabbitmq' | 'mqtt' | 'rocketmq'
export type MwFeatureState = 'available' | 'unsupported' | 'not-configured' | 'error'
export interface MwCapability {
  state: MwFeatureState
  reason?: string
}

/** EMQX 管理面适配（mqtt 连接的可选增强） */
export interface MwEmqxMgmt {
  enabled: boolean
  /** auto = 先探 v5(18083 /api/v5) 再探 v4(8081 /api/v4) */
  version: 'auto' | 'v4' | 'v5'
  apiUrl?: string
  apiKey?: string
  apiSecretRef?: string
}

export interface MwConnectionConfig {
  kind: MwKind
  name?: string
  env?: 'dev' | 'test' | 'staging' | 'prod'
  /** 连接级只读：宿主侧拦截全部变更类 action */
  readOnly?: boolean
  note?: string
  /** 凭据：vault 引用（主进程解析为 ephemeralSecret 后传入 UtilityProcess） */
  secretRef?: string
  ephemeralSecret?: string
  // —— kafka ——
  bootstrapServers?: string
  saslMechanism?: 'none' | 'plain' | 'scram-sha-256' | 'scram-sha-512' | 'oauthbearer'
  tls?: boolean
  tlsRejectUnauthorized?: boolean
  // —— rabbitmq ——
  managementUrl?: string
  vhost?: string
  username?: string
  // —— mqtt ——
  brokerUrl?: string
  clientId?: string
  emqx?: MwEmqxMgmt
  // —— rocketmq ——
  dashboardUrl?: string
  /** 透传扩展（如 kafka clientId、mqtt keepalive 等） */
  options?: Record<string, unknown>
}

export interface MwSessionInfo {
  sessionKey: string
  kind: MwKind
  label: string
  connectedAt: number
  readOnly: boolean
  /** 运行时探测后的能力覆盖（EMQX 探测 / dashboard 版本探测）；缺省用 kinds.list 静态描述符 */
  capabilities?: Record<string, MwCapability>
  messageQueryModes?: MwMessageQueryMode[]
}

export type MwMessageQueryMode = 'offset' | 'time' | 'key' | 'id'

export interface MwDriverDescriptor {
  kind: MwKind
  label: string
  transport: 'native' | 'http'
  defaultPort?: number
  /** 历史消息定位方式（UI 据此渲染过滤栏） */
  messageQueryModes: MwMessageQueryMode[]
  capabilities: Record<string, MwCapability>
}

/** 统一消息信封：四类中间件的浏览/重发/监听共用 */
export interface MwMessage {
  messageId?: string
  topic: string
  /** kafka 分区；rocketmq 队列号；rmq/mqtt 无 */
  partition?: number
  offset?: number
  timestamp: number
  key?: string
  payload: string
  payloadEncoding?: 'utf8' | 'base64'
  payloadType?: 'json' | 'text' | 'binary'
  headers?: Record<string, string>
  properties?: Record<string, string>
  redelivered?: boolean
  payloadBytes?: number
  /** 各家特有字段（rocketmq 重试次数/出生地、rmq routing_key、mqtt retain/qos…） */
  extras?: Record<string, string | number | boolean>
}

/** Topic / 队列 / 交换机 / retained 统一列表项 */
export interface MwTopic {
  name: string
  /** 实体语义（UI 列头按 kind 翻译） */
  entity: 'topic' | 'queue' | 'exchange' | 'retained' | 'subscription'
  partitions?: number
  replicas?: number
  messageCount?: number
  consumerCount?: number
  durable?: boolean
  autoDelete?: boolean
  /** rmq exchange 类型 / rocketmq topic 类型（NORMAL/FIFO/DELAY/TRANSACTION） */
  type?: string
  internal?: boolean
  totalSizeBytes?: number
  lag?: number
  extras?: Record<string, string | number | boolean>
}

export interface MwConsumerGroup {
  groupId: string
  state?: string
  members?: number
  totalLag?: number
  topics?: string[]
  extras?: Record<string, string | number | boolean>
}

export interface MwConsumerGroupDetail {
  groupId: string
  state?: string
  members: Array<{ clientId: string; host?: string; topics?: string[] }>
  offsets: Array<{
    topic: string
    partition?: number
    currentOffset: string | number
    logEndOffset: string | number
    lag: number
  }>
}

export interface MwClient {
  clientId: string
  host?: string
  connectedAt?: number
  subscriptionsCount?: number
  extras?: Record<string, string | number | boolean>
}

export interface MwOverview {
  kind: MwKind
  clusterName?: string
  brokers: Array<{ id: string; host: string; roles?: string; alive?: boolean; extras?: Record<string, string | number | boolean> }>
  metrics: Record<string, string | number>
  notes?: string[]
}

export interface MwTraceStep {
  phase: 'produced' | 'stored' | 'consume-attempt'
  timestamp: number
  status: 'success' | 'failed' | 'unknown'
  /** producer 组 / broker 节点 / consumer 组 */
  actor: string
  detail?: Record<string, string>
  costMs?: number
}

export interface MwTrace {
  key: string
  messageId?: string
  steps: MwTraceStep[]
}

// —— 各 action 的输入类型 ——

export interface MwTopicCreateInput {
  name: string
  partitions?: number
  replicationFactor?: number
  configs?: Record<string, string>
  durable?: boolean
  autoDelete?: boolean
  /** rmq exchange type（direct/topic/fanout/headers）或 rocketmq 类型（NORMAL/FIFO/DELAY/TRANSACTION） */
  type?: string
  /** rocketmq 队列数 */
  queueNum?: number
  arguments?: Record<string, unknown>
}

export interface MwMessageQueryInput {
  topic: string
  partition?: number
  from: 'earliest' | 'latest' | 'offset' | 'timestamp' | 'key' | 'id'
  key?: string
  messageId?: string
  offset?: number
  timestamp?: number
  max?: number
  keyContains?: string
  /** quick 模式强制上限 200 */
  surface?: 'quick' | 'shell'
}

export interface MwMessageSendInput {
  topic: string
  payload: string
  payloadEncoding?: 'utf8' | 'base64'
  key?: string
  partition?: number
  headers?: Record<string, string>
  /** rmq 发布走交换机时 topic 填 exchange，此字段为 routing key */
  routingKey?: string
  properties?: Record<string, string>
  qos?: 0 | 1 | 2
  retain?: boolean
}

export interface MwGroupResetInput {
  groupId: string
  topic: string
  partition?: number
  to: 'earliest' | 'latest' | 'timestamp' | 'offset'
  timestamp?: number
  offset?: number
}

export interface MwBindingCreateInput {
  source: string
  destination: string
  /** destinationType 仅 rmq 生效 */
  destinationType?: 'queue' | 'exchange'
  routingKey?: string
  arguments?: Record<string, unknown>
}

// —— workbench action 契约（权限映射见 main/middleware/workbench.ts）——

export type MwWorkbenchRequest =
  // mw.connect
  | { action: 'kinds.list'; input?: Record<string, never> }
  | { action: 'test'; input: { config: MwConnectionConfig } }
  | { action: 'session.open'; input: { sessionKey: string; config: MwConnectionConfig } }
  | { action: 'session.close'; input: { sessionKey: string } }
  | { action: 'session.list'; input?: Record<string, never> }
  // mw.query
  | { action: 'overview'; input: { sessionKey: string } }
  | { action: 'topics.list'; input: { sessionKey: string; search?: string; includeInternal?: boolean } }
  | { action: 'topic.describe'; input: { sessionKey: string; topic: string } }
  | { action: 'exchanges.list'; input: { sessionKey: string; search?: string } }
  | { action: 'bindings.list'; input: { sessionKey: string; source?: string; destination?: string } }
  | { action: 'groups.list'; input: { sessionKey: string; search?: string } }
  | { action: 'group.describe'; input: { sessionKey: string; groupId: string } }
  | { action: 'clients.list'; input: { sessionKey: string; search?: string } }
  | { action: 'messages.query'; input: MwMessageQueryInput & { sessionKey: string } }
  | { action: 'messages.get'; input: { sessionKey: string; topic: string; messageId?: string; partition?: number; offset?: number } }
  | { action: 'tail.start'; input: { sessionKey: string; tailId: string; topic: string; filter?: string } }
  | { action: 'tail.stop'; input: { sessionKey: string; tailId: string } }
  | { action: 'configs.describe'; input: { sessionKey: string; topic: string } }
  | { action: 'trace.message'; input: { sessionKey: string; key: string } }
  | { action: 'retained.list'; input: { sessionKey: string; search?: string } }
  // mw.admin（连接级 readOnly 时宿主直接拒绝）
  | { action: 'topic.create'; input: { sessionKey: string; topic: MwTopicCreateInput } }
  | { action: 'topic.update'; input: { sessionKey: string; name: string; attrs: Partial<MwTopicCreateInput> } }
  | { action: 'topic.delete'; input: { sessionKey: string; name: string } }
  | { action: 'topic.purge'; input: { sessionKey: string; name: string } }
  | { action: 'partitions.grow'; input: { sessionKey: string; topic: string; count: number } }
  | { action: 'exchange.create'; input: { sessionKey: string; exchange: { name: string; type: string; durable?: boolean; autoDelete?: boolean; arguments?: Record<string, unknown> } } }
  | { action: 'exchange.delete'; input: { sessionKey: string; name: string } }
  | { action: 'binding.create'; input: { sessionKey: string; binding: MwBindingCreateInput } }
  | { action: 'binding.delete'; input: { sessionKey: string; source: string; destination: string; propertiesKey: string } }
  | { action: 'group.resetOffsets'; input: { sessionKey: string } & MwGroupResetInput }
  | { action: 'client.kick'; input: { sessionKey: string; clientId: string } }
  | { action: 'messages.send'; input: MwMessageSendInput & { sessionKey: string } }
  | { action: 'messages.resend'; input: { sessionKey: string; message: MwMessage; targetTopic?: string } }
  | { action: 'configs.alter'; input: { sessionKey: string; topic: string; configs: Record<string, string> } }
  | { action: 'retained.delete'; input: { sessionKey: string; topic: string } }

/** 变更类 action 集合（连接 readOnly 时宿主拒绝；与权限映射保持同步） */
export const MW_MUTATING_ACTIONS: readonly string[] = [
  'topic.create', 'topic.update', 'topic.delete', 'topic.purge', 'partitions.grow',
  'exchange.create', 'exchange.delete', 'binding.create', 'binding.delete',
  'group.resetOffsets', 'client.kick', 'messages.send', 'messages.resend',
  'configs.alter', 'retained.delete'
]

/** Connection probe result shared by renderer declarations and utility drivers. */
export interface MwTestResult { ok: boolean; message: string; latencyMs: number }
