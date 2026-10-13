/**
 * useToast — 全局 Toast 兼容层（历史命名保留）
 * push 包装到 notifyService；内置提示默认顶部弹出（与 notify 默认一致）。
 * 业务可逐步改用 notify.info/success/warn/error/custom；本 API 保持兼容。
 * 渲染由 App 根部的 NotificationHost 负责，此处仅保留 push 通路。
 * 依赖：notifyService、@shared/types/ipc（ToastKind）。
 */
import { create } from 'zustand'
import type { ToastKind } from '@shared/types/ipc'
import { notify } from '@renderer/services/notifyService'

/** Toast 兼容 store：push 转发 notifyService（默认顶部）；组件应改用 notify.xxx */
export const toastStore = create<{
  push: (message: string, type?: ToastKind) => void
}>(() => ({
  push: (message, type) => {
    const level = type ?? 'info'
    // 内置系统提示统一走顶部
    notify.custom({ body: message, level, position: 'top' })
  },
}))
