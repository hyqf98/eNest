/**
 * 壳统一通知（ShellNotice）— 壳软件关键节点事件的标准信封。
 *
 * 设计目标：壳的所有关键节点（更新、保存、退出、外观……）按同一 JSON 结构广播，
 * 插件按 topic 订阅自己关心的通知；未来新增节点只在 ShellNoticeDataMap 上扩展，
 * 不改变信封字段。插件收到未知 topic / 未知版本时应忽略。
 *
 * 通道：主进程 → 插件 webContents（plugin:event，payload.type === 'shell-notice'）。
 * 消费：enest.onNotice(cb) / enest.onNotice(topic, cb) / enest.on('shell-notice', cb)。
 */

/** 通知触发保存的原因 */
export type ShellSaveReason = 'update' | 'app-quit' | 'manual'

/** 外观关键节点类型（appearance.changed 的 kind） */
export type ShellAppearanceKind = 'theme' | 'font' | 'animation'

/**
 * v1 已注册 topic → data 类型映射。
 * 扩展约定：topic 命名 `<域>.<节点>`；新增关键节点在此追加条目，
 * 并同步 docs/site/plugin/api.md 的「壳通知」topic 表。
 */
export interface ShellNoticeDataMap {
  /** 检查到新版本（尚未下载） */
  'update.available': { currentVersion: string; latestVersion: string }
  /** 更新包下载完成，可安装 */
  'update.downloaded': { version: string }
  /** 即将退出并安装（最后保存机会；随后 before-quit / beforeClose 还会各来一次） */
  'update.installing': { version: string }
  /** 检查 / 下载 / 安装出错 */
  'update.error': { message: string }
  /**
   * 壳请求插件立即保存数据（更新重启 / 退出前 / 手触发）。
   * 插件在 enest.onSaveRequested 回调里持久化并返回 Promise；
   * Promise settle 后 preload 自动 ack，主进程等待（超时兜底）。
   */
  'save.requested': { reason: ShellSaveReason; operationId: string; deadlineMs: number }
  /** 应用即将退出（before-quit；插件随后还会收到 beforeClose(app-quit)） */
  'app.before-quit': { reason: string }
  /** 主题 / 字体 / 动画档变更（theme 细节另见 theme-change 事件） */
  'appearance.changed': { kind: ShellAppearanceKind }
}

/** topic 字面量联合（新增 DataMap 条目后自动收窄） */
export type ShellNoticeTopic = keyof ShellNoticeDataMap

/** 壳统一通知信封（v1） */
export interface ShellNotice<T extends ShellNoticeTopic = ShellNoticeTopic> {
  /** 信封结构版本；插件遇到不认识的版本应忽略该通知 */
  v: 1
  /** 会话内单调递增序号（主进程内存计数器，重启归零；仅用于排序/去重诊断） */
  seq: number
  /** 事件产生时间（ISO 8601） */
  ts: string
  /** 来源标识；v1 恒为 'shell'，预留给未来非壳来源 */
  source: 'shell'
  /** 通知主题（点分命名空间，如 'update.available'） */
  topic: T
  /** 按 topic 约定的负载；未知 topic 时插件应忽略 */
  data: ShellNoticeDataMap[T]
}

/** save.requested 通知的 data */
export type SaveRequestedData = ShellNoticeDataMap['save.requested']

/** enest.onSaveRequested 回调参数 */
export interface SaveRequestedEvent {
  reason: ShellSaveReason
  /** 建议完成保存的时限（ms，与主进程等待窗口一致） */
  deadlineMs: number
  /** 本次保存请求的唯一标识（诊断用） */
  operationId: string
}
