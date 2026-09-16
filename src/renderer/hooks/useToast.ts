/**
 * useToast — 全局 Toast 兼容层
 * push 包装到 notifyService；内置提示默认顶部弹出（与 notify 默认一致）。
 * 业务可逐步改用 notify.info/success/warn/error/custom；本 API 保持兼容。
 * items / bindEl 保留空实现以兼容旧调用；渲染由 NotificationHost 负责。
 * 依赖：notifyService、@shared/types/ipc（ToastKind）。
 */
import { create } from 'zustand'
import type { ToastKind } from '@shared/types/ipc'
import { notify } from '@renderer/services/notifyService'

/** 单条 Toast：id、文案、可选类型（历史形状保留） */
export interface ToastItem {
  id: number
  message: string
  /** info 默认；success/warn/error 带强调色 */
  type?: ToastKind
  el?: HTMLElement | null
}

interface ToastState {
  /** 历史队列；渲染已迁至 NotificationHost，此处恒为空以避免双渲染 */
  items: ToastItem[]
  push: (message: string, type?: ToastKind) => void
  dismiss: (id: number) => void
  bindEl: (id: number, el: HTMLElement) => void
}

/** Toast 兼容 store：push 转发 notifyService（默认顶部）；组件应改用 notify.xxx */
export const toastStore = create<ToastState>(() => ({
  items: [],
  push: (message, type) => {
    const level = type ?? 'info'
    // 内置系统提示统一走顶部
    notify.custom({ body: message, level, position: 'top' })
  },
  dismiss: () => {
    /* 由 NotificationHost / notifyStore 自动 dismiss */
  },
  bindEl: () => {
    /* 入场由 NotificationHost bindEl 驱动 */
  },
}))

/** 便捷 hook：push 已兼容 notify；新代码建议直接 import notify */
export function useToast() {
  const items = toastStore((s) => s.items)
  const bindEl = toastStore((s) => s.bindEl)
  const push = toastStore((s) => s.push)
  return { items, bindEl, push }
}
