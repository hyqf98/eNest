import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react'
import type { NotificationItem, NotificationPosition } from '@shared/types/notification'
import { safeNotificationLink } from '@shared/notification'
import { notifyStore } from '@renderer/services/notifyService'
import { notificationPlainText, sanitizeNotificationHtml } from '@renderer/services/notificationContent'
import { notifyIn, notifyOut, cancelNotifyMotion } from '@renderer/gsap/marketMotion'
import { MarkdownView } from './MarkdownView'
import '@renderer/styles/notification.css'

const LABELS = { info: '提示', success: '成功', warn: '注意', error: '错误' }

/** Async clipboard can be denied by policy; the selection path still runs inside the click gesture. */
async function copyPlainText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch { /* fall through to the legacy selection copy */ }
  try {
    const area = document.createElement('textarea')
    area.value = text
    area.setAttribute('readonly', '')
    area.setAttribute('aria-hidden', 'true')
    area.style.cssText = 'position:fixed;top:0;left:-9999px;opacity:0'
    document.body.append(area)
    area.select()
    const copied = document.execCommand('copy')
    area.remove()
    return copied
  } catch { return false }
}

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
  const [copied, setCopied] = useState(false)
  const [documentVisible, setDocumentVisible] = useState(!document.hidden)
  const remaining = useRef(item.duration)
  const closing = useRef(false)
  const copyTimer = useRef(0)
  const html = useMemo(() => item.format === 'html' ? sanitizeNotificationHtml(item.body) : '', [item.body, item.format])
  const dismiss = useCallback(() => {
    if (closing.current) return
    closing.current = true
    if (ref.current) void notifyOut(ref.current).then(() => onDismiss(item.id))
    else onDismiss(item.id)
  }, [item.id, onDismiss])
  const copy = useCallback(async () => {
    const title = item.title || LABELS[item.level]
    const text = notificationPlainText(item.body, item.format)
    if (!await copyPlainText(text ? `${title}\n${text}` : title)) return
    // Inline feedback only: pushing a new notification would recurse into this surface.
    setCopied(true)
    window.clearTimeout(copyTimer.current)
    copyTimer.current = window.setTimeout(() => setCopied(false), 1200)
  }, [item.body, item.format, item.level, item.title])

  useEffect(() => {
    const element = ref.current
    if (element) notifyIn(element, item.position)
    return () => { if (element) cancelNotifyMotion(element) }
  }, [item.id, item.position])
  useEffect(() => () => window.clearTimeout(copyTimer.current), [])
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
      <div className="notify-body" tabIndex={item.body ? 0 : undefined} role="region" aria-label="通知内容" onClick={openLink}>
        {item.format === 'markdown' ? <MarkdownView source={item.body}/> : item.format === 'html' ? <div className="notify-rich" dangerouslySetInnerHTML={{ __html: html }}/> : <div className="notify-text">{item.body}</div>}
      </div>
      {item.duration === 0 && <div className="notify-hint">阅读后可关闭</div>}
    </div>
    {item.level === 'error'
      ? <div className="notify-actions">
        <button className="notify-action" type="button" aria-label={copied ? '已复制' : '复制错误'} title={copied ? '已复制' : '复制错误'} data-copied={copied || undefined} onClick={() => void copy()}>
          <span className="notify-action-icon" aria-hidden="true">
            {copied
              ? <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m5 12.5 4.5 4.5L19 7"/></svg>
              : <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="11" height="11" rx="2.4"/><path d="M15 5.6A1.6 1.6 0 0 0 13.4 4H5.6A1.6 1.6 0 0 0 4 5.6v7.8A1.6 1.6 0 0 0 5.6 15"/></svg>}
          </span>
        </button>
        <button className="notify-close" type="button" aria-label="关闭通知" title="关闭通知（Esc）" onClick={dismiss}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="m7 7 10 10m0-10L7 17"/></svg></button>
      </div>
      : <button className="notify-close" type="button" aria-label="关闭通知" title="关闭通知（Esc）" onClick={dismiss}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="m7 7 10 10m0-10L7 17"/></svg></button>}
  </div>
}

export function NotificationHost() {
  const items = notifyStore(state => state.items)
  const dismiss = notifyStore(state => state.dismiss)
  return <>{(['top', 'center', 'bottom-right'] as NotificationPosition[]).map(position => {
    const current = items.filter(item => item.position === position).slice(0, position === 'bottom-right' ? 3 : 1)
    return <div key={position} className={`notify-host notify-host-${position}`} role="region" aria-label="消息通知" aria-live="polite" aria-relevant="additions" tabIndex={current.length ? 0 : undefined}>
      {current.map(item => <NotificationCard key={item.id} item={item} onDismiss={dismiss}/>) }
    </div>
  })}</>
}
export type { NotificationPosition as NotifyPosition }
