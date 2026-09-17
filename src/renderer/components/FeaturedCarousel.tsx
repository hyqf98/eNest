/**
 * FeaturedCarousel — 精选插件自动轮播
 * 横向轨道 + 左右按钮 + 悬停暂停；位移由 marketMotion.setCarouselX（GSAP）驱动。
 * 由 MarketPage 提供 items（按安装量 Top N 或已安装列表）。
 * 依赖：PluginSlide、setCarouselX。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { PluginSummary } from '@shared/types/plugin'
import { PluginSlide } from '@renderer/components/PluginSlide'
import { setCarouselX } from '@renderer/gsap/marketMotion'
import { useAnimationLevelStore } from '@renderer/hooks/useAnimationLevel'

/** 自动播间隔：low 关闭；medium 3800；high 略快。null = 不自动播 */
function autoplayMs(level: 'low' | 'medium' | 'high'): number | null {
  if (level === 'low') return null
  if (level === 'high') return 3200
  return 3800
}

interface Props {
  items: PluginSummary[]
  onOpen: (id: string) => void
  onDetail?: (id: string) => void
}

export function FeaturedCarousel({ items, onOpen, onDetail }: Props) {
  const trackRef = useRef<HTMLDivElement>(null)
  const viewportRef = useRef<HTMLDivElement>(null)
  const [index, setIndex] = useState(0)
  const timerRef = useRef<number | null>(null)
  const level = useAnimationLevelStore((s) => s.level)

  // 用第一张 slide 实测宽度（含 gap）换算 index → translateX，保证与 CSS 布局一致
  const slideWidth = useCallback(() => {
    const first = trackRef.current?.querySelector('.slide') as HTMLElement | null
    if (!first) return 340
    return first.getBoundingClientRect().width + 16
  }, [])

  const apply = useCallback(
    (i: number, immediate = false) => {
      setCarouselX(trackRef.current, -i * slideWidth(), immediate)
    },
    [slideWidth]
  )

  const stop = useCallback(() => {
    if (timerRef.current != null) {
      window.clearInterval(timerRef.current)
      timerRef.current = null
    }
  }, [])

  const start = useCallback(() => {
    stop()
    if (items.length < 2) return
    const ms = autoplayMs(level)
    if (ms == null) return // low：不自动播，仅手动切页
    timerRef.current = window.setInterval(() => {
      setIndex((i) => {
        const next = (i + 1) % items.length
        apply(next)
        return next
      })
    }, ms)
  }, [apply, items.length, level, stop])

  useEffect(() => {
    setIndex(0)
    apply(0, true)
    start()
    return stop
  }, [apply, items, start, stop])

  const go = (delta: number) => {
    if (!items.length) return
    const next = (index + delta + items.length) % items.length
    setIndex(next)
    apply(next)
    start()
  }

  return (
    <div className="carousel-block">
      <div className="section-head">
        <h2>精选插件</h2>
        <div className="carousel-ctrls">
          <button className="carousel-btn" type="button" aria-label="上一张" onClick={() => go(-1)}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="m15 6-6 6 6 6" />
            </svg>
          </button>
          <button className="carousel-btn" type="button" aria-label="下一张" onClick={() => go(1)}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="m9 6 6 6-6 6" />
            </svg>
          </button>
        </div>
      </div>
      <div
        className="carousel-viewport"
        ref={viewportRef}
        onMouseEnter={stop}
        onMouseLeave={start}
      >
        <div className="carousel-track" ref={trackRef}>
          {items.map((p) => (
            <PluginSlide key={p.id} plugin={p} onOpen={onOpen} onDetail={onDetail} />
          ))}
        </div>
      </div>
    </div>
  )
}
