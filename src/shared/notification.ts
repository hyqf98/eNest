import type { NotificationItem, PluginToastOptions } from '@shared/types/notification'

export const NOTIFICATION_TITLE_LIMIT = 120
export const NOTIFICATION_BODY_LIMIT = 16000
export const NOTIFICATION_QUEUE_LIMIT = 8

/** Shared wire validation; rich content is still sanitized at the rendering boundary. */
export function normalizeNotification(raw: unknown): Omit<NotificationItem, 'id' | 'source'> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('invalid notification')
  const input = raw as PluginToastOptions
  const title = input.title ?? ''
  const body = input.body ?? input.message ?? ''
  if (typeof title !== 'string' || typeof body !== 'string') throw new Error('notification title and body must be strings')
  if (!title.trim() && !body.trim()) throw new Error('toast message required')
  if (title.length > NOTIFICATION_TITLE_LIMIT || body.length > NOTIFICATION_BODY_LIMIT) throw new Error('notification content too long')
  const format = input.format ?? 'text'
  const position = input.position ?? 'bottom-right'
  const level = input.level ?? (['info', 'success', 'warn', 'error'].includes(input.type ?? '') ? input.type! : 'info')
  if (!['text', 'html', 'markdown'].includes(format)) throw new Error('invalid notification format')
  if (!['top', 'center', 'bottom-right'].includes(position)) throw new Error('invalid notification position')
  if (!['info', 'success', 'warn', 'error'].includes(level)) throw new Error('invalid notification level')
  const duration = input.duration ?? (body.length > 500 ? 0 : format === 'text' ? 4200 : 6500)
  if (typeof duration !== 'number' || !Number.isFinite(duration) || (duration !== 0 && (duration < 1500 || duration > 60000))) {
    throw new Error('notification duration must be 0 or 1500–60000 ms')
  }
  return { title: title.trim(), body, format, position, level, duration }
}

/** Only absolute web/mail links. Never accept credentials, control characters or custom protocols. */
export function safeNotificationLink(raw: string): string | undefined {
  if (/[\u0000-\u0020\u007f]/.test(raw) || !/^(https?:\/\/|mailto:)/i.test(raw)) return undefined
  try {
    const url = new URL(raw)
    if (url.username || url.password || !['https:', 'http:', 'mailto:'].includes(url.protocol)) return undefined
    return url.href
  } catch { return undefined }
}
