/**
 * notifyService — 统一消息通知队列
 * 职责：内置通知（Toast 升级）队列 + 可选系统级通知（Electron Notification）。
 * API：notify.info / success / warn / error / custom({ title, body, html, position, level }).
 * position：top（顶部，默认）| bottom-right（右下角，供插件/显式指定）。
 * 内置系统提示默认顶部弹出；toastStore.push 包装亦走顶部。
 * html 字段经受控 dangerouslySetInnerHTML 渲染 —— 仅限内部可信调用；
 * 勿传入用户未消毒的 HTML（存在 XSS 风险）。
 * 依赖：zustand、@shared/types/ipc（ToastKind）、shellApi（systemNotify 可选）。
 */
import { create } from 'zustand'
import type { ToastKind } from '@shared/types/ipc'
import { notifyIn, notifyOut } from '@renderer/gsap/marketMotion'
import { shellApi } from '@renderer/services/shellApi'

/** 内置通知弹出位置 */
export type NotifyPosition = 'top' | 'bottom-right'

/** 通知级别：复用 ToastKind 强调色 */
export type NotifyLevel = ToastKind

export interface NotifyCustomOptions {
  /** 标题（可选；无标题时仅 body） */
  title?: string
  /** 纯文本正文 */
  body?: string
  /**
   * 自定义 HTML 正文。仅限内部可信内容 —— 切勿传入用户未消毒 HTML。
   * 渲染时使用受控 dangerouslySetInnerHTML，无额外 sanitize 层。
   */
  html?: string
  /** 弹出位置；默认 top */
  position?: NotifyPosition
  /** 级别强调色；默认 info */
  level?: NotifyLevel
  /** 自动消失毫秒；默认 2800，0 表示不自动关闭 */
  duration?: number
  /** 同时触发系统级通知（需 shellApi.systemNotify 可用） */
  system?: boolean
}

export interface NotifyItem extends Required<Pick<NotifyCustomOptions, 'position' | 'level'>> {
  id: number
  title?: string
  body?: string
  html?: string
  /** 入场动画绑定的 DOM 节点 */
  el?: HTMLElement | null
}

interface NotifyState {
  items: NotifyItem[]
  push: (opts: NotifyCustomOptions) => number
  dismiss: (id: number) => void
  bindEl: (id: number, el: HTMLElement) => void
}

let notifySeq = 0

function fireSystemNotify(title: string, body: string): void {
  void shellApi.systemNotify?.(title, body).catch(() => undefined)
}

/** 统一通知队列 store；NotificationHost 订阅渲染 */
export const notifyStore = create<NotifyState>((set, get) => ({
  items: [],

  push: (opts) => {
    const id = ++notifySeq
    const position: NotifyPosition = opts.position ?? 'top'
    const level: NotifyLevel = opts.level ?? 'info'
    const duration = opts.duration === undefined ? 2800 : opts.duration
    const item: NotifyItem = {
      id,
      title: opts.title,
      body: opts.body,
      html: opts.html,
      position,
      level,
    }
    set((s) => ({ items: [...s.items, item] }))

    if (opts.system) {
      fireSystemNotify(opts.title ?? 'eNest', opts.body ?? stripHtml(opts.html) ?? '')
    }

    if (duration > 0) {
      window.setTimeout(() => {
        void get().dismiss(id)
      }, duration)
    }
    return id
  },

  dismiss: async (id) => {
    const item = get().items.find((n) => n.id === id)
    if (!item) return
    if (item.el) await notifyOut(item.el)
    set((s) => ({ items: s.items.filter((n) => n.id !== id) }))
  },

  bindEl: (id, el) => {
    set((s) => ({ items: s.items.map((n) => (n.id === id ? { ...n, el } : n)) }))
    notifyIn(el, get().items.find((n) => n.id === id)?.position ?? 'top')
  },
}))

/** 从 html 中粗略提取纯文本（系统通知 fallback） */
function stripHtml(html?: string): string {
  if (!html) return ''
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
}

/** 便捷 API：业务侧优先使用 notify.xxx，旧 toastStore.push 亦包装至此 */
export const notify = {
  /** 顶部 info 通知 */
  info(body: string, opts?: Omit<NotifyCustomOptions, 'body' | 'level'>): number {
    return notifyStore.getState().push({ ...opts, body, level: 'info' })
  },
  /** 顶部 success 通知 */
  success(body: string, opts?: Omit<NotifyCustomOptions, 'body' | 'level'>): number {
    return notifyStore.getState().push({ ...opts, body, level: 'success' })
  },
  /** 顶部 warn 通知 */
  warn(body: string, opts?: Omit<NotifyCustomOptions, 'body' | 'level'>): number {
    return notifyStore.getState().push({ ...opts, body, level: 'warn' })
  },
  /** 顶部 error 通知 */
  error(body: string, opts?: Omit<NotifyCustomOptions, 'body' | 'level'>): number {
    return notifyStore.getState().push({ ...opts, body, level: 'error' })
  },
  /**
   * 完全自定义通知。html 仅限内部可信内容 —— 勿传用户未消毒 HTML。
   * system: true 时同步弹出 OS 通知。
   */
  custom(opts: NotifyCustomOptions): number {
    return notifyStore.getState().push(opts)
  },
  /** 关闭指定通知 */
  dismiss(id: number): void {
    void notifyStore.getState().dismiss(id)
  },
}
