/**
 * shellNotices — 壳统一通知（ShellNotice）广播驱动。
 * 壳关键节点（更新 / 外观 / 退出……）统一经 broadcastNotice 广播给所有运行中插件；
 * 信封结构与 topic 清单见 @shared/types/notice（扩展点：ShellNoticeDataMap）。
 * save.requested 的定向发送与 ack 等待在 PluginHost.requestSaveAll（operationId 逐插件唯一）。
 */
import { pluginHost } from '@main/plugin/PluginHost'
import { createShellNotice } from '@shared/notice'
import type { ShellNoticeDataMap, ShellNoticeTopic } from '@shared/types/notice'
import type { PluginEventPayload } from '@shared/types/ipc'

/** 向所有运行中插件广播一条壳通知（fire-and-forget；插件经 enest.onNotice 订阅） */
export function broadcastNotice<T extends ShellNoticeTopic>(
  topic: T,
  data: ShellNoticeDataMap[T]
): void {
  const notice = createShellNotice(topic, data)
  pluginHost.broadcastEvent({ type: 'shell-notice', notice } satisfies PluginEventPayload)
}
