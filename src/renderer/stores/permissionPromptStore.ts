/**
 * permissionPromptStore — 权限弹窗队列（zustand 单例）
 * 职责：useShellEvents 收到 permission-request 事件时入队；
 *       PermissionPromptModal 消费队首渲染弹窗，respond 后出队。
 * 队列语义与主进程 PermissionService 对齐：同插件串行，跨插件 FIFO。
 */
import { create } from 'zustand'
import type { PluginPermission } from '@shared/types/plugin'

export interface PermissionPromptItem {
  requestId: string
  pluginId: string
  permission: PluginPermission
  summary: string
  osHint?: 'system-pending' | 'denied'
}

interface PermissionPromptState {
  queue: PermissionPromptItem[]
  enqueue(item: PermissionPromptItem): void
  /** 用户已回应（或超时）：移除队首并返回被移除项 */
  dequeue(): PermissionPromptItem | null
}

export const usePermissionPromptStore = create<PermissionPromptState>((set, get) => ({
  queue: [],
  enqueue: (item) => {
    // 同 requestId 去重（主进程不会重发，防御性保留）
    if (get().queue.some((q) => q.requestId === item.requestId)) return
    set((s) => ({ queue: [...s.queue, item] }))
  },
  dequeue: () => {
    const head = get().queue[0] ?? null
    if (head) set((s) => ({ queue: s.queue.slice(1) }))
    return head
  }
}))
