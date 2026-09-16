/**
 * NotificationHost — 统一通知渲染层
 * 挂在 App 根部，按 position 分组渲染 notifyStore 队列（top / bottom-right）。
 * 每条 bindEl 后触发 GSAP 入场；html 字段经受控 dangerouslySetInnerHTML 渲染。
 * 安全：html 仅信任内部 notify.custom 调用，勿传用户未消毒 HTML。
 * 依赖：notifyService、marketMotion（notifyIn/notifyOut）。
 */
import { useEffect, useMemo, useRef } from 'react'
import { notifyStore, type NotifyItem, type NotifyPosition } from '@renderer/services/notifyService'

export function NotificationHost() {
  const items = notifyStore((s) => s.items)
  const bindEl = notifyStore((s) => s.bindEl)

  const topItems = useMemo(() => items.filter((n) => n.position === 'top'), [items])
  const brItems = useMemo(
    () => items.filter((n) => n.position === 'bottom-right'),
    [items],
  )

  return (
    <>
      <div className="notify-host notify-host-top" role="region" aria-live="polite">
        {topItems.map((n) => (
          <NotifyCard key={n.id} item={n} onMount={bindEl} />
        ))}
      </div>
      <div className="notify-host notify-host-br" role="region" aria-live="polite">
        {brItems.map((n) => (
          <NotifyCard key={n.id} item={n} onMount={bindEl} />
        ))}
      </div>
    </>
  )
}

function NotifyCard({
  item,
  onMount,
}: {
  item: NotifyItem
  onMount: (id: number, el: HTMLElement) => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (ref.current) onMount(item.id, ref.current)
  }, [item.id, onMount])

  const levelCls = item.level !== 'info' ? ` notify-${item.level}` : ''
  return (
    <div
      ref={ref}
      className={`notify-card${levelCls}`}
      data-level={item.level}
      data-position={item.position}
    >
      {item.title ? <div className="notify-title">{item.title}</div> : null}
      {item.body ? <div className="notify-body">{item.body}</div> : null}
      {item.html ? (
        // 安全约定：html 仅内部可信内容；禁止用户未消毒 HTML
        <div
          className="notify-html"
          dangerouslySetInnerHTML={{ __html: item.html }}
        />
      ) : null}
    </div>
  )
}

export type { NotifyPosition }
