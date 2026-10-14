/** 中间件驱动契约。仅运行于 mwUtility（UtilityProcess），与 database/drivers.ts 同构。
 * 变更类 action 的 readOnly 拦截在 mwService 层做，驱动不必重复检查；
 * 驱动对不适用的能力直接 throw（UI 已按 capabilities 降级，此处兜底）。 */
import type {
  MwTestResult,
  MwCapability,
  MwClient,
  MwConnectionConfig,
  MwConsumerGroup,
  MwConsumerGroupDetail,
  MwMessage,
  MwMessageQueryInput,
  MwMessageQueryMode,
  MwMessageSendInput,
  MwOverview,
  MwTopic,
  MwTrace,
  MwBindingCreateInput,
  MwTopicCreateInput
} from '@shared/types/mw-workbench'

/** open() 注入的运行时上下文 */
export interface MwDriverContext {
  /** 推送事件到插件（'data' → mw.data / 'error' → mw.error） */
  emit(event: 'data' | 'error', payload: Record<string, unknown>): void
  /** 连接所属插件运行域终止信号（宿主关闭/休眠时中止长连接） */
  signal: AbortSignal
}

export interface MwDriverHandle {
  kind: MwConnectionConfig['kind']
  raw: unknown
  config: MwConnectionConfig
  readOnly: boolean
  password?: string
  /** open() 运行时探测后的能力（EMQX/dashboard 版本），回填进 MwSessionInfo */
  capabilities: Record<string, MwCapability>
  messageQueryModes?: MwMessageQueryMode[]
  closed?: boolean
  runtime?: Record<string, unknown>
}

export type { MwTestResult } from '@shared/types/mw-workbench'

export interface MwDriver {
  kind: MwConnectionConfig['kind']
  label: string
  transport: 'native' | 'http'
  defaultPort?: number
  /** 静态能力声明（kinds.list 描述符来源） */
  capabilities: Record<string, MwCapability>
  messageQueryModes: MwMessageQueryMode[]
  test(config: MwConnectionConfig, password?: string): Promise<MwTestResult>
  open(config: MwConnectionConfig, password: string | undefined, ctx: MwDriverContext): Promise<MwDriverHandle>
  close(h: MwDriverHandle): Promise<void>
  overview(h: MwDriverHandle): Promise<MwOverview>
  topicsList(h: MwDriverHandle, input: { search?: string; includeInternal?: boolean }): Promise<MwTopic[]>
  topicDescribe(h: MwDriverHandle, topic: string): Promise<{ partitions?: unknown[]; configs?: Record<string, string>; extras?: Record<string, unknown> }>
  topicCreate(h: MwDriverHandle, input: MwTopicCreateInput): Promise<void>
  topicUpdate(h: MwDriverHandle, name: string, attrs: Partial<MwTopicCreateInput>): Promise<void>
  topicDelete(h: MwDriverHandle, name: string): Promise<void>
  /** 清空：rmq purge 队列内容；kafka deleteTopicRecords 至各分区最新 offset；rocketmq/mqtt 不支持 */
  topicPurge(h: MwDriverHandle, name: string): Promise<void>
  partitionsGrow(h: MwDriverHandle, input: { topic: string; count: number }): Promise<void>
  exchangesList(h: MwDriverHandle, input: { search?: string }): Promise<MwTopic[]>
  exchangeCreate(h: MwDriverHandle, input: { name: string; type: string; durable?: boolean; autoDelete?: boolean; arguments?: Record<string, unknown> }): Promise<void>
  exchangeDelete(h: MwDriverHandle, name: string): Promise<void>
  bindingsList(h: MwDriverHandle, input: { source?: string; destination?: string }): Promise<Array<Record<string, unknown>>>
  bindingCreate(h: MwDriverHandle, input: MwBindingCreateInput): Promise<void>
  bindingDelete(h: MwDriverHandle, input: { source: string; destination: string; propertiesKey: string }): Promise<void>
  groupsList(h: MwDriverHandle, input: { search?: string }): Promise<MwConsumerGroup[]>
  groupDescribe(h: MwDriverHandle, groupId: string): Promise<MwConsumerGroupDetail>
  groupResetOffsets(h: MwDriverHandle, input: { groupId: string; topic: string; partition?: number; to: 'earliest' | 'latest' | 'timestamp' | 'offset'; timestamp?: number; offset?: number }): Promise<void>
  clientsList(h: MwDriverHandle, input: { search?: string }): Promise<MwClient[]>
  clientKick(h: MwDriverHandle, clientId: string): Promise<void>
  messagesQuery(h: MwDriverHandle, input: MwMessageQueryInput): Promise<MwMessage[]>
  messageGet(h: MwDriverHandle, input: { topic: string; messageId?: string; partition?: number; offset?: number }): Promise<MwMessage | null>
  messageSend(h: MwDriverHandle, input: MwMessageSendInput): Promise<{ ok: boolean; detail?: string }>
  messageResend(h: MwDriverHandle, input: { message: MwMessage; targetTopic?: string }): Promise<{ ok: boolean; detail?: string }>
  configsDescribe(h: MwDriverHandle, input: { topic: string }): Promise<Array<{ name: string; value: string }>>
  configsAlter(h: MwDriverHandle, input: { topic: string; configs: Record<string, string> }): Promise<void>
  traceMessage(h: MwDriverHandle, input: { key: string }): Promise<MwTrace>
  retainedList(h: MwDriverHandle, input: { search?: string }): Promise<MwTopic[]>
  retainedDelete(h: MwDriverHandle, topic: string): Promise<void>
  /** 实时监听：驱动内部常驻订阅，消息经 sink 推给 service；返回 stop 由 service 在 tail.stop/会话关闭时调用 */
  tailStart(h: MwDriverHandle, input: { tailId: string; topic: string; filter?: string }, sink: (message: MwMessage) => void): Promise<{ stop(): Promise<void> }>
}

export function unsupported(what: string): never {
  throw new Error(`${what} is not supported by this middleware kind`)
}
