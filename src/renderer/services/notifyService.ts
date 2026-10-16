/** One notification API: native surfaces in Electron, the same cards locally in browser previews. */
import { create } from 'zustand'
import { normalizeNotification, NOTIFICATION_QUEUE_LIMIT } from '@shared/notification'
import type { NotificationItem, NotificationOptions, NotificationPosition, NotificationLevel } from '@shared/types/notification'
import { shellApi } from '@renderer/services/shellApi'
import { notificationPlainText } from './notificationContent'

export type NotifyPosition = NotificationPosition
export type NotifyLevel = NotificationLevel
export type NotifyItem = NotificationItem
export interface NotifyCustomOptions extends NotificationOptions {
  /** @deprecated Use body with format: 'html'. This alias is sanitized too. */
  html?: string
  system?: boolean
}
interface NotifyState {
  items: NotificationItem[]
  push: (options: NotifyCustomOptions) => number
  dismiss: (id: number) => void
}
let sequence = 0
const nativeIds = new Map<number, Promise<number>>()
const pendingDismiss = new Set<number>()

export const notifyStore = create<NotifyState>((set) => ({
  items: [],
  push(options) {
    const id = --sequence
    const normalized = normalizeNotification({ ...options, body: options.html ?? options.body, format: options.html !== undefined ? 'html' : options.format })
    const enqueue = () => {
      if (pendingDismiss.delete(id)) return
      set(state => state.items.length >= NOTIFICATION_QUEUE_LIMIT ? state : { items: [...state.items, { ...normalized, id }] })
    }
    if (options.system) {
      void shellApi.systemNotify?.(normalized.title || 'eNest', notificationPlainText(normalized.body, normalized.format)).catch(() => undefined)
    }
    const bridge = window.enestNotifications
    if (bridge) {
      // 调用方未指定位置时不在载荷里预填，由主进程按设置的默认位置（中间弹框/右下角）补齐
      const request = bridge.show(options.position === undefined ? { ...normalized, position: undefined } : normalized)
      nativeIds.set(id, request)
      // Retain bounded handles so persistent/paused cards can still be dismissed later.
      while (nativeIds.size > 128) nativeIds.delete(nativeIds.keys().next().value!)
      void request.then(nativeId => {
        if (pendingDismiss.delete(id)) void bridge.dismiss(nativeId).catch(() => {})
      }).catch(() => { nativeIds.delete(id); enqueue() })
    } else enqueue()
    return id
  },
  dismiss(id) {
    const request = nativeIds.get(id)
    if (request) {
      nativeIds.delete(id)
      pendingDismiss.add(id)
      void request.then(nativeId => window.enestNotifications?.dismiss(nativeId)).catch(() => {}).finally(() => pendingDismiss.delete(id))
    }
    set(state => ({ items: state.items.filter(item => item.id !== id) }))
  }
}))

export const notify = {
  info(body: string, options?: Omit<NotifyCustomOptions, 'body' | 'level'>): number { return notifyStore.getState().push({ ...options, body, level: 'info' }) },
  success(body: string, options?: Omit<NotifyCustomOptions, 'body' | 'level'>): number { return notifyStore.getState().push({ ...options, body, level: 'success' }) },
  warn(body: string, options?: Omit<NotifyCustomOptions, 'body' | 'level'>): number { return notifyStore.getState().push({ ...options, body, level: 'warn' }) },
  error(body: string, options?: Omit<NotifyCustomOptions, 'body' | 'level'>): number { return notifyStore.getState().push({ ...options, body, level: 'error' }) },
  custom(options: NotifyCustomOptions): number { return notifyStore.getState().push(options) },
  dismiss(id: number): void { notifyStore.getState().dismiss(id) }
}
