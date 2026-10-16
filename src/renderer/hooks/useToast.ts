/**
 * useToast — 全局 Toast 兼容层（历史命名保留）
 * push 包装到 notifyService；不指定位置，由设置的默认位置（中间弹框/右下角）决定。
 * 业务可逐步改用 notify.info/success/warn/error/custom；本 API 保持兼容。
 * 渲染由 App 根部的 NotificationHost 负责，此处仅保留 push 通路。
 * 依赖：notifyService、@shared/types/ipc（ToastKind）。
 */
import { create } from 'zustand'
import type { ToastKind } from '@shared/types/ipc'
import { notify } from '@renderer/services/notifyService'

/** Toast 兼容 store：push 转发 notifyService；组件应改用 notify.xxx */
export const toastStore = create<{
  push: (message: string, type?: ToastKind) => void
}>(() => ({
  push: (message, type) => {
    const level = type ?? 'info'
    // 兼容旧调用，统一由通知服务按用户设置选择原生容器位置
    notify.custom({ body: message, level })
  },
}))
