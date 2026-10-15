import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react'
import type { NotificationItem, NotificationPosition } from '@shared/types/notification'
import { safeNotificationLink } from '@shared/notification'
import { notifyStore } from '@renderer/services/notifyService'
import { sanitizeNotificationHtml } from '@renderer/services/notificationContent'
import { notifyIn, notifyOut, cancelNotifyMotion } from '@renderer/gsap/marketMotion'
import { MarkdownView } from './MarkdownView'
import '@renderer/styles/notification.css'

const LABELS = { info: '提示', success: '成功', warn: '注意', error: '错误' }

/** Shared by the native overlay and browser fallback; each card has its own pauseable clock. */
export function NotificationCard({ item, onDismiss, visible = true, onOpenLink }: {
  item: NotificationItem
  onDismiss: (id: number) => void
  visible?: boolean
  onOpenLink?: (url: string) => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  const [documentVisible, setDocumentVisible] = useState(!document.hidden)
  const remaining = useRef(item.duration)
  const closing = useRef(false)
  const html = useMemo(() => item.format === 'html' ? sanitizeNotificationHtml(item.body) : '', [item.body, item.format])
  const dismiss = useCallback(() => {
    if (closing.current) return
    closing.current = true
    if (ref.current) void notifyOut(ref.current).then(() => onDismiss(item.id))
    else onDismiss(item.id)
  }, [item.id, onDismiss])

  useEffect(() => {
    const element = ref.current
    if (element) notifyIn(element, item.position)
    return () => { if (element) cancelNotifyMotion(element) }
  }, [item.id, item.position])
  useEffect(() => {
    const changed = () => setDocumentVisible(!document.hidden)
    document.addEventListener('visibilitychange', changed)
    return () => document.removeEventListener('visibilitychange', changed)
  }, [])
  useEffect(() => {
    if (!item.duration || hovered || focused || !visible || !documentVisible || closing.current) return
    const started = performance.now()
    const timer = window.setTimeout(dismiss, Math.max(0, remaining.current))
    return () => { window.clearTimeout(timer); remaining.current = Math.max(0, remaining.current - (performance.now() - started)) }
  }, [dismiss, item.duration, hovered, focused, visible, documentVisible])

  const openLink = (event: MouseEvent<HTMLDivElement>) => {
    const anchor = (event.target as Element).closest('a')
    if (!anchor) return
    const url = safeNotificationLink(anchor.getAttribute('href') ?? '')
    if (!url || onOpenLink) event.preventDefault()
    if (url) onOpenLink?.(url)
  }
  return <div ref={ref} className={`notify-card notify-${item.level}`} data-level={item.level} data-position={item.position}
    onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}
    onFocusCapture={() => setFocused(true)} onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false) }}
    onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); dismiss() } }}>
    <div className="notify-symbol" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      {item.level === 'success' ? <><circle cx="12" cy="12" r="9"/><path d="m8 12 2.5 2.5L16 9"/></> : item.level === 'warn' ? <><path d="m12 3 10 18H2L12 3Z"/><path d="M12 9v5m0 3h.01"/></> : <><circle cx="12" cy="12" r="9"/><path d={item.level === 'error' ? 'm9 9 6 6m0-6-6 6' : 'M12 11v6m0-10h.01'}/></>}
    </svg></div>
    <div className="notify-content">
      <div className="notify-heading"><span className="notify-title">{item.title || LABELS[item.level]}</span>{item.source && <span className="notify-source">{item.source}</span>}</div>
      <div className="notify-body" tabIndex={item.body.length > 300 ? 0 : undefined} onClick={openLink}>
        {item.format === 'markdown' ? <MarkdownView source={item.body}/> : item.format === 'html' ? <div className="notify-rich" dangerouslySetInnerHTML={{ __html: html }}/> : <div className="notify-text">{item.body}</div>}
      </div>
      {item.duration === 0 && <div className="notify-hint">阅读后可关闭</div>}
    </div>
    <button className="notify-close" type="button" aria-label="关闭通知" title="关闭通知（Esc）" onClick={dismiss}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="m7 7 10 10m0-10L7 17"/></svg></button>
  </div>
}

export function NotificationHost() {
  const items = notifyStore(state => state.items)
  const dismiss = notifyStore(state => state.dismiss)
  return <>{(['top', 'center', 'bottom-right'] as NotificationPosition[]).map(position => {
    const current = items.filter(item => item.position === position).slice(0, position === 'bottom-right' ? 3 : 1)
    return <div key={position} className={`notify-host notify-host-${position}`} role="region" aria-label="消息通知" aria-live="polite" aria-relevant="additions">
      {current.map(item => <NotificationCard key={item.id} item={item} onDismiss={dismiss}/>) }
    </div>
  })}</>
}
export type { NotificationPosition as NotifyPosition }
