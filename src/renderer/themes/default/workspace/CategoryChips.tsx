/** 单行分类筛选；分类较多时局部滚动，保持首页工具栏高度。 */
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react'
import gsap from 'gsap'
import { useAnimationLevel, useReducedMotion } from '@renderer/hooks/useAnimationLevel'
import { useI18n } from '@renderer/hooks/useI18n'
import { d, ease } from '@renderer/gsap/marketMotion'
import '@renderer/themes/default/workspace/categoryChips.css'

interface Props {
  categories: readonly string[]
  value: string
  onChange: (c: string) => void
}

export function CategoryChips({ categories, value, onChange }: Props) {
  const rootRef = useRef<HTMLDivElement>(null)
  const viewportRef = useRef<HTMLDivElement>(null)
  const rowRef = useRef<HTMLDivElement>(null)
  const [edges, setEdges] = useState({ overflow: false, left: false, right: false })
  const { level } = useAnimationLevel()
  const reducedMotion = useReducedMotion()
  const { locale } = useI18n()
  const english = locale === 'en-US'

  const updateEdges = useCallback(() => {
    const root = rootRef.current
    const viewport = viewportRef.current
    const row = rowRef.current
    if (!root || !viewport || !row) return
    const next = {
      // Measure without arrow widths so controls disappear as soon as all chips fit.
      overflow: row.scrollWidth > root.clientWidth + 1,
      left: viewport.scrollLeft > 1,
      right: viewport.scrollWidth - viewport.clientWidth - viewport.scrollLeft > 1,
    }
    setEdges((previous) => previous.overflow === next.overflow && previous.left === next.left && previous.right === next.right ? previous : next)
  }, [])

  const scrollTo = useCallback((left: number, animate = true) => {
    const viewport = viewportRef.current
    if (!viewport) return
    gsap.killTweensOf(viewport)
    const target = Math.max(0, Math.min(left, viewport.scrollWidth - viewport.clientWidth))
    if (!animate || reducedMotion) {
      viewport.scrollLeft = target
      updateEdges()
      return
    }
    gsap.to(viewport, { scrollLeft: target, duration: d(0.24), ease: ease('power2.out'), onUpdate: updateEdges })
  }, [level, reducedMotion, updateEdges])

  const reveal = useCallback((button: HTMLButtonElement, animate = true) => {
    const viewport = viewportRef.current
    if (!viewport) return
    const bounds = viewport.getBoundingClientRect()
    const item = button.getBoundingClientRect()
    const inset = 6
    if (item.left < bounds.left + inset) scrollTo(viewport.scrollLeft + item.left - bounds.left - inset, animate)
    else if (item.right > bounds.right - inset) scrollTo(viewport.scrollLeft + item.right - bounds.right + inset, animate)
  }, [scrollTo])

  useEffect(() => {
    const root = rootRef.current
    const viewport = viewportRef.current
    const row = rowRef.current
    if (!root || !viewport || !row) return
    let frame = 0
    let rootWidth = root.clientWidth
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        updateEdges()
        if (rootWidth !== root.clientWidth) {
          rootWidth = root.clientWidth
          const active = row.querySelector<HTMLButtonElement>('[aria-pressed="true"]')
          if (active) reveal(active, false)
        }
      })
    })
    observer.observe(root)
    observer.observe(viewport)
    observer.observe(row)

    const onWheel = (event: WheelEvent) => {
      if (event.ctrlKey) return
      gsap.killTweensOf(viewport)
      if (Math.abs(event.deltaX) > Math.abs(event.deltaY)) return // Keep native trackpad scrolling.
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport.clientWidth : 1)
      const canScroll = delta > 0
        ? viewport.scrollLeft < viewport.scrollWidth - viewport.clientWidth - 1
        : viewport.scrollLeft > 1
      if (!delta || !canScroll) return // Page scrolling resumes at either end.
      event.preventDefault()
      viewport.scrollLeft += delta
      updateEdges()
    }
    viewport.addEventListener('wheel', onWheel, { passive: false })
    updateEdges()
    return () => {
      observer.disconnect()
      cancelAnimationFrame(frame)
      viewport.removeEventListener('wheel', onWheel)
      gsap.killTweensOf(viewport)
    }
  }, [reveal, updateEdges])

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      updateEdges()
      const active = rowRef.current?.querySelector<HTMLButtonElement>('[aria-pressed="true"]')
      if (active) reveal(active)
    })
    return () => cancelAnimationFrame(frame)
  }, [categories, value, edges.overflow, reveal, updateEdges])

  const moveFocus = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    const buttons = Array.from(rowRef.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])
    const current = buttons.indexOf(event.target as HTMLButtonElement)
    if (current < 0) return
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
      : Math.max(0, Math.min(buttons.length - 1, current + (event.key === 'ArrowRight' ? 1 : -1)))
    event.preventDefault()
    buttons[next]?.focus({ preventScroll: true })
  }

  const movePage = (direction: number) => {
    const viewport = viewportRef.current
    if (viewport) scrollTo(viewport.scrollLeft + direction * viewport.clientWidth * 0.75)
  }

  return (
    <div ref={rootRef} className="category-filter" data-overflow={edges.overflow} role="group" aria-label={english ? 'Plugin categories' : '插件分类'}>
      {edges.overflow && (
        <button type="button" className="category-scroll" aria-label={english ? 'Scroll categories left' : '向左滚动分类'} disabled={!edges.left} onClick={() => movePage(-1)}>
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m10 4-4 4 4 4" /></svg>
        </button>
      )}
      <div ref={viewportRef} className="category-viewport" data-left={edges.left} data-right={edges.right} onScroll={updateEdges} onPointerDown={() => { if (viewportRef.current) gsap.killTweensOf(viewportRef.current) }}>
        <div ref={rowRef} className="chip-row" onKeyDown={moveFocus}>
          {categories.map((c) => (
            <button
              key={c}
              type="button"
              className={`chip${c === value ? ' active' : ''}`}
              aria-pressed={c === value}
              title={c}
              onFocus={(event) => reveal(event.currentTarget)}
              onClick={() => onChange(c)}
            >
              {c}
            </button>
          ))}
        </div>
      </div>
      {edges.overflow && (
        <button type="button" className="category-scroll" aria-label={english ? 'Scroll categories right' : '向右滚动分类'} disabled={!edges.right} onClick={() => movePage(1)}>
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m6 4 4 4-4 4" /></svg>
        </button>
      )}
    </div>
  )
}
