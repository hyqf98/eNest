/**
 * 壳统一通知（ShellNotice）信封构造 — 纯函数 + 会话内序号。
 * 类型定义见 types/notice.ts；广播驱动见 @main/plugin/shellNotices。
 * 放在 shared 的原因：主进程 PluginHost（逐插件定向发送）与 shellNotices（全量广播）
 * 共用同一序号源，且不引入任何运行时依赖。
 */
import type { ShellNotice, ShellNoticeDataMap, ShellNoticeTopic } from './types/notice'

/** 会话内单调递增；进程重启归零 */
let seq = 0

/** 构造 v1 信封；seq 全局递增保证同会话内通知可排序 */
export function createShellNotice<T extends ShellNoticeTopic>(
  topic: T,
  data: ShellNoticeDataMap[T]
): ShellNotice<T> {
  seq += 1
  return { v: 1, seq, ts: new Date().toISOString(), source: 'shell', topic, data }
}
