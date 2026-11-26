import { NOTIFICATION_BODY_LIMIT } from '@shared/notification'
import { safeRichText } from './safeRichText'

const notificationContent = (source: string) => safeRichText(source.slice(0, NOTIFICATION_BODY_LIMIT), 1500)

export function sanitizeNotificationHtml(source: string): string {
  return notificationContent(source).innerHTML
}

export function notificationPlainText(body: string, format: 'text' | 'html' | 'markdown'): string {
  return format === 'html' ? notificationContent(body).textContent ?? '' : body
}
