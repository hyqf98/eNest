import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

export interface SettingsTabItem {
  id: string
  label: string
}

interface Props {
  tabs: SettingsTabItem[]
  active: string
  moreLabel: string
  onChange: (id: string) => void
}

/** 被收进「更多」的 tab：脱流但保留占位测量（offsetWidth 可读） */
const CLIPPED_STYLE = {
  position: 'absolute',
  visibility: 'hidden',
  pointerEvents: 'none',
  left: 0,
  top: 0,
} as const

/**
 * 设置页 tab 栏：保持单行，放不下的 tab 收进「更多」下拉。
 * 容器为 fit-content，可用宽度按父元素计算，避免收纳后容器自身变窄引发测量震荡。
 */
export function SettingsTabs({ tabs, active, moreLabel, onChange }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const moreBtnRef = useRef<HTMLButtonElement | null>(null)
  const moreWrapRef = useRef<HTMLDivElement | null>(null)
  const [visibleCount, setVisibleCount] = useState(tabs.length)
  const [moreOpen, setMoreOpen] = useState(false)

  const remeasure = useCallback(() => {
    const container = containerRef.current
    if (!container) return
    const btns = Array.from(container.querySelectorAll<HTMLButtonElement>('[data-tab]'))
    if (btns.length === 0) return
    const cs = getComputedStyle(container)
    const gap = parseFloat(cs.columnGap || cs.gap || '3') || 3
    const pad = parseFloat(cs.paddingLeft || '3') + parseFloat(cs.paddingRight || '3')
    // 父元素宽度不受本栏收纳影响，作为稳定基准
    const base = container.parentElement?.clientWidth || container.clientWidth
    const avail = base - pad
    const moreW = (moreBtnRef.current?.offsetWidth || 78) + gap
    const fit = (limit: number) => {
      let used = 0
      for (let i = 0; i < btns.length; i++) {
        const w = btns[i].offsetWidth + gap
        if (used + w > limit) return i === 0 ? 1 : i
        used += w
      }
      return btns.length
    }
    let n = fit(avail)
    if (n < btns.length) n = fit(avail - moreW)
    setVisibleCount((prev) => (prev === n ? prev : n))
  }, [])

  useLayoutEffect(() => {
    remeasure()
  }, [remeasure, tabs])

  useEffect(() => {
    const container = containerRef.current
    if (!container || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => remeasure())
    ro.observe(container)
    if (container.parentElement) ro.observe(container.parentElement)
    return () => ro.disconnect()
  }, [remeasure])

  useEffect(() => {
    if (!moreOpen) return
    const onDown = (e: PointerEvent) => {
      if (!moreWrapRef.current?.contains(e.target as Node)) setMoreOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMoreOpen(false)
    }
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [moreOpen])

  const overflow = tabs.slice(visibleCount)
  const activeOverflow = overflow.find((x) => x.id === active)

  return (
    <div className="settings-tabs" ref={containerRef}>
      {tabs.map((tab, i) => {
        const clipped = i >= visibleCount
        return (
          <button
            key={tab.id}
            type="button"
            data-tab
            className={active === tab.id ? 'active' : ''}
            style={clipped ? CLIPPED_STYLE : undefined}
            tabIndex={clipped ? -1 : 0}
            onClick={() => onChange(tab.id)}
          >
            {tab.label}
          </button>
        )
      })}
      {overflow.length > 0 && (
        <div className="tabs-more" ref={moreWrapRef}>
          <button
            ref={moreBtnRef}
            type="button"
            className={activeOverflow ? 'active' : ''}
            aria-haspopup="listbox"
            aria-expanded={moreOpen}
            onClick={() => setMoreOpen((o) => !o)}
          >
            {activeOverflow ? activeOverflow.label : moreLabel}
            {overflow.length > 1 && !activeOverflow ? ` · ${overflow.length}` : ''}
            <span className="caret">▾</span>
          </button>
          {moreOpen && (
            <div className="tabs-more-pop" role="listbox">
              {overflow.map((x) => (
                <button
                  key={x.id}
                  type="button"
                  role="option"
                  aria-selected={x.id === active}
                  className={x.id === active ? 'active' : ''}
                  onClick={() => {
                    onChange(x.id)
                    setMoreOpen(false)
                  }}
                >
                  {x.label}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
