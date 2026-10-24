import { useCallback, useId, useLayoutEffect, useRef, useState } from 'react'
import { Button } from '@renderer/components/ui/Button'

export interface SettingsTabItem {
  id: string
  label: string
}

interface Props {
  tabs: SettingsTabItem[]
  active: string
  moreLabel: string
  collapseLabel?: string
  onChange: (id: string) => void
}

/** 默认单行；「更多」在原位展开。独立的非交互测量行始终按折叠布局计算。 */
export function SettingsTabs({ tabs, active, moreLabel, collapseLabel = '收起', onChange }: Props) {
  const tabsId = useId()
  const containerRef = useRef<HTMLDivElement | null>(null)
  const measureRef = useRef<HTMLDivElement | null>(null)
  const moreBtnRef = useRef<HTMLButtonElement | null>(null)
  const collapsedForActive = useRef<string | null>(null)
  const previousActive = useRef(active)
  const [visibleCount, setVisibleCount] = useState(tabs.length)
  const [expanded, setExpanded] = useState(false)

  const remeasure = useCallback(() => {
    const container = containerRef.current
    const measure = measureRef.current
    const parent = container?.parentElement
    if (!container || !measure || !parent) return
    const cs = getComputedStyle(container)
    const ps = getComputedStyle(parent)
    const px = (value: string) => parseFloat(value) || 0
    // clientWidth 包含父级 padding；不能把这部分和本栏的边框/内边距算作可用空间。
    const available = Math.max(0, Math.floor(parent.clientWidth
      - px(ps.paddingLeft) - px(ps.paddingRight)
      - px(cs.paddingLeft) - px(cs.paddingRight)
      - px(cs.borderLeftWidth) - px(cs.borderRightWidth)))
    const gap = px(cs.columnGap)
    const widths = Array.from(measure.querySelectorAll<HTMLElement>('[data-measure-tab]'))
      .map(element => element.getBoundingClientRect().width)
    const total = widths.reduce((sum, width) => sum + width, 0) + gap * Math.max(0, widths.length - 1)
    let count = widths.length
    if (total > available) {
      // 用总数量的文案预留保守宽度，避免「更多 9」变「更多 10」后再次挤出。
      const moreWidth = measure.querySelector<HTMLElement>('[data-measure-more]')?.getBoundingClientRect().width ?? 0
      let used = Math.min(moreWidth, available)
      count = 0
      for (const width of widths) {
        if (used + gap + width > available) break
        used += gap + width
        count++
      }
    }
    setVisibleCount(previous => previous === count ? previous : count)
  }, [])

  useLayoutEffect(() => {
    remeasure()
    const container = containerRef.current
    const measure = measureRef.current
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(remeasure)
    if (container) {
      observer?.observe(container)
      if (container.parentElement) observer?.observe(container.parentElement)
    }
    // 观察自然宽度，而非被截断后的按钮，响应字体缩放和字体加载。
    if (measure) Array.from(measure.children).forEach(element => observer?.observe(element))
    window.addEventListener('resize', remeasure)
    document.fonts.addEventListener('loadingdone', remeasure)
    let disposed = false
    void document.fonts.ready.then(() => { if (!disposed) remeasure() })
    return () => {
      disposed = true
      observer?.disconnect()
      window.removeEventListener('resize', remeasure)
      document.fonts.removeEventListener('loadingdone', remeasure)
    }
  }, [remeasure, tabs, moreLabel])

  const count = Math.min(visibleCount, tabs.length)
  const hiddenCount = tabs.length - count
  const activeOverflow = tabs.slice(count).find(tab => tab.id === active)

  useLayoutEffect(() => {
    if (previousActive.current !== active) collapsedForActive.current = null
    previousActive.current = active
    const buttons = containerRef.current?.querySelectorAll<HTMLButtonElement>('[data-tab]')
    if (hiddenCount === 0) {
      setExpanded(false)
      if (document.activeElement === moreBtnRef.current) {
        const target = Array.from(buttons ?? []).find(button => button.dataset.tab === active) ?? buttons?.[0]
        target?.focus()
      }
    } else if (activeOverflow && collapsedForActive.current !== active) {
      // 外部导航或缩窄窗口时展示选中项；用户主动收起后不立即反弹。
      setExpanded(true)
    } else if (!expanded && Array.from(buttons ?? []).some(button => button.hidden && button === document.activeElement)) {
      moreBtnRef.current?.focus()
    }
  }, [active, activeOverflow, hiddenCount, expanded])

  const moreText = `${moreLabel} ${hiddenCount}`
  return (
    <div className={`settings-tabs${expanded ? ' is-expanded' : ''}`} ref={containerRef}>
      <div id={tabsId} className="settings-tabs-items">
        {tabs.map((tab, index) => {
          const hidden = !expanded && index >= count
          return (
            <button
              key={tab.id}
              type="button"
              data-tab={tab.id}
              className={`settings-tab${active === tab.id ? ' active' : ''}`}
              hidden={hidden}
              tabIndex={hidden ? -1 : 0}
              aria-pressed={active === tab.id}
              title={tab.label}
              onClick={() => onChange(tab.id)}
            >
              {tab.label}
            </button>
          )
        })}
      </div>
      <Button
        ref={moreBtnRef}
        size="sm"
        className={`tabs-more-toggle${!expanded && activeOverflow ? ' active' : ''}`}
        hidden={hiddenCount === 0}
        aria-expanded={expanded}
        aria-controls={tabsId}
        aria-label={expanded ? collapseLabel : `${moreText}${activeOverflow ? ` · ${activeOverflow.label}` : ''}`}
        title={!expanded && activeOverflow ? `${moreText} · ${activeOverflow.label}` : undefined}
        onClick={() => {
          collapsedForActive.current = expanded ? active : null
          moreBtnRef.current?.focus()
          setExpanded(value => !value)
        }}
      >
        <span className="tabs-more-label">{expanded ? collapseLabel : moreText}</span>
        <span className="caret" aria-hidden="true">{expanded ? '▴' : '▾'}</span>
      </Button>
      <div className="settings-tabs-measure" ref={measureRef} aria-hidden="true">
        {tabs.map(tab => <span key={tab.id} className="settings-tab" data-measure-tab>{tab.label}</span>)}
        <span className="btn btn-sm tabs-more-toggle" data-measure-more>
          <span className="tabs-more-label">{moreLabel} {tabs.length}</span>
          <span className="caret">▾</span>
        </span>
      </div>
    </div>
  )
}
