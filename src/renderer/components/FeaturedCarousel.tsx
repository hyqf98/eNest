/**
 * FeaturedCarousel — 精选插件 coverflow
 * 每个插件一个 DOM 节点，按相对中心的 ring 过渡位置/尺寸，切换时丝滑放大缩小。
 * 中心 data-ring=0 大卡；±1/±2 在左下/右下待选。
 * 悬停暂停轮播；点侧卡转到中心，点中心/CTA 打开或看详情。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, MouseEvent as ReactMouseEvent } from 'react'
import type { PluginSummary } from '@shared/types/plugin'
import { useAnimationLevelStore } from '@renderer/hooks/useAnimationLevel'
import { ChevronLeftIcon, ChevronRightIcon } from '@renderer/components/icons'
import { PluginIcon } from '@renderer/components/PluginIcon'
import '@renderer/styles/featured.css'

function autoplayMs(level: 'low' | 'medium' | 'high'): number | null {
  if (level === 'low') return null
  if (level === 'high') return 3200
  return 3800
}

function logicalOf(i: number, len: number): number {
  if (len <= 0) return 0
  return ((i % len) + len) % len
}

interface Props {
  items: PluginSummary[]
  onOpen: (id: string) => void
  onDetail?: (id: string) => void
}

const MAX_RING = 2

function ringStyle(ring: number, pushPx: number): CSSProperties {
  return {
    ['--ring' as string]: String(ring),
    ['--push' as string]: `${pushPx}px`,
  }
}

/**
 * 悬停放大时的水平挤让（px）——绕悬停卡向两侧手风琴展开：
 * - ring === hover：不平移，只原地放大
 * - 更左 / 更右：按相对距离对称外推，间距不塌缩
 * 例：hover=-1 时 center→+u，ring1→+2u，ring2→+3u，ring-2→-u
 */
function cardPush(hover: number | null, ring: number): number {
  if (hover == null || hover === 0 || ring === hover) return 0
  const unit = Math.abs(hover) === 1 ? 22 : 18
  return (ring - hover) * unit
}

/**
 * coverflow 槽位：以 index 为中心的线性 ring（含 ±(maxSide+1) 缓冲环）。
 * 切换 index 时同一 plugin.id 的 ring 整体 ±1，DOM 不销毁 → 像滚动条一样同向滑动；
 * 缓冲环负责从边缘滑入/滑出，避免最外侧卡片瞬间换内容。
 */
function buildScrollSlots(items: PluginSummary[], index: number, len: number) {
  if (len <= 0 || !items[index]) {
    return [] as { plugin: PluginSummary; logical: number; ring: number }[]
  }
  const maxSide = len >= 5 ? MAX_RING : len >= 3 ? 1 : 0
  const pad = 1
  const best = new Map<number, number>()
  for (let k = -(maxSide + pad); k <= maxSide + pad; k++) {
    const logical = logicalOf(index + k, len)
    const prev = best.get(logical)
    if (prev === undefined || Math.abs(k) < Math.abs(prev)) best.set(logical, k)
  }
  return [...best.entries()]
    .map(([logical, ring]) => ({ plugin: items[logical], logical, ring }))
    .sort((a, b) => a.ring - b.ring)
}

export function FeaturedCarousel({ items, onOpen, onDetail }: Props) {
  const [index, setIndex] = useState(0)
  const [dragging, setDragging] = useState(false)
  /** 悬停中的 ring：用于邻卡挤让，避免放大盖住中心 */
  const [hoverRing, setHoverRing] = useState<number | null>(null)
  const pausedRef = useRef(false)
  /** 用户点过箭头/圆点/拖拽后：不再自动轮播 */
  const manualNavRef = useRef(false)
  const timerRef = useRef<number | null>(null)
  const level = useAnimationLevelStore((s) => s.level)
  const len = items.length
  const rootRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef({ active: false, id: -1, startX: 0, lastX: 0, moved: false })
  const suppressClickRef = useRef(false)
  const wheelAccRef = useRef(0)
  const wheelTimerRef = useRef<number | null>(null)

  const stop = useCallback(() => {
    if (timerRef.current != null) {
      window.clearInterval(timerRef.current)
      timerRef.current = null
    }
  }, [])

  const start = useCallback(() => {
    stop()
    // 手动切换过（箭头/圆点/拖拽）后不再自动播；悬停 pause 仍可临时停
    if (manualNavRef.current || pausedRef.current || len < 2) return
    const ms = autoplayMs(level)
    if (ms == null) return
    timerRef.current = window.setInterval(() => {
      setIndex((i) => logicalOf(i + 1, len))
    }, ms)
  }, [len, level, stop])

  /** 标记手动导航并停掉自动播 */
  const markManualNav = useCallback(() => {
    manualNavRef.current = true
    stop()
  }, [stop])

  useEffect(() => {
    // 数据重载时恢复自动播
    manualNavRef.current = false
    setIndex(0)
    start()
    return stop
  }, [items, len, start, stop])

  useEffect(() => () => stop(), [stop])

  const pause = useCallback(() => {
    pausedRef.current = true
    stop()
  }, [stop])

  const resume = useCallback(() => {
    pausedRef.current = false
    setHoverRing(null)
    if (!dragRef.current.active) start()
  }, [start])

  const go = useCallback(
    (delta: number) => {
      if (len <= 0) return
      markManualNav()
      setIndex((i) => logicalOf(i + delta, len))
    },
    [len, markManualNav]
  )

  useEffect(() => {
    if (!manualNavRef.current && !pausedRef.current) start()
  }, [index, start])

  const openLogical = useCallback(
    (logical: number) => {
      const p = items[logical]
      if (!p) return
      if (p.installed && p.enabled !== false) {
        onOpen(p.id)
        return
      }
      if (onDetail) onDetail(p.id)
      else onOpen(p.id)
    },
    [items, onDetail, onOpen]
  )

  const onItemClick = (e: ReactMouseEvent<HTMLElement>, logical: number, ring: number) => {
    if (suppressClickRef.current) {
      e.preventDefault()
      e.stopPropagation()
      return
    }
    e.preventDefault()
    e.stopPropagation()
    if (!items[logical]) return
    if (ring !== 0) {
      markManualNav()
      setIndex(logical)
      return
    }
    openLogical(logical)
  }

  const onCtaClick = (e: ReactMouseEvent<HTMLElement>, logical: number) => {
    e.preventDefault()
    e.stopPropagation()
    if (suppressClickRef.current) return
    openLogical(logical)
  }

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || len < 2) return
    dragRef.current = { active: true, id: e.pointerId, startX: e.clientX, lastX: e.clientX, moved: false }
    suppressClickRef.current = false
    stop()
    setDragging(true)
  }

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current
    if (!d.active || e.pointerId !== d.id) return
    const dx = e.clientX - d.startX
    if (!d.moved && Math.abs(dx) > 6) d.moved = true
    if (!d.moved) return
    d.lastX = e.clientX
    const root = rootRef.current
    if (root) root.style.setProperty('--drag-x', `${dx * 0.3}px`)
  }

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current
    if (!d.active || e.pointerId !== d.id) return
    d.active = false
    setDragging(false)
    const root = rootRef.current
    if (root) root.style.removeProperty('--drag-x')
    if (!d.moved) {
      if (!pausedRef.current) start()
      return
    }
    suppressClickRef.current = true
    window.setTimeout(() => {
      suppressClickRef.current = false
    }, 0)
    const dx = d.lastX - d.startX
    if (dx <= -48) go(1)
    else if (dx >= 48) go(-1)
  }

  useEffect(() => {
    const el = rootRef.current
    if (!el || len < 2) return
    const onWheel = (e: WheelEvent) => {
      const absX = Math.abs(e.deltaX)
      const absY = Math.abs(e.deltaY)
      const dx = absX >= absY ? e.deltaX : e.shiftKey ? e.deltaY : 0
      if (!dx) return
      e.preventDefault()
      wheelAccRef.current += dx
      if (wheelTimerRef.current != null) window.clearTimeout(wheelTimerRef.current)
      wheelTimerRef.current = window.setTimeout(() => {
        wheelAccRef.current = 0
      }, 180)
      if (wheelAccRef.current <= -40) {
        wheelAccRef.current = 0
        go(1)
      } else if (wheelAccRef.current >= 40) {
        wheelAccRef.current = 0
        go(-1)
      }
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [go, len])

  /** 对称槽位 + 按 plugin.id 复用节点，切换时同一卡 transform 过渡（同向滑动） */
  const laidOut = useMemo(() => buildScrollSlots(items, index, len), [index, items, len])

  const iconStyle = (p: PluginSummary): CSSProperties => ({
    background: `linear-gradient(160deg, color-mix(in srgb, ${p.color} 90%, #fff) 0%, ${p.color} 48%, color-mix(in srgb, ${p.color} 70%, #000) 100%)`,
  })

  return (
    <div
      className="carousel-block featured-coverflow"
      ref={rootRef}
      onMouseEnter={pause}
      onMouseLeave={resume}
    >
      <div className="section-head">
        <h2>精选插件</h2>
        {len > 1 && (
          <div className="carousel-ctrls">
            <button className="carousel-btn" type="button" aria-label="上一张" onClick={() => go(-1)}>
              <ChevronLeftIcon size={17} />
            </button>
            <button className="carousel-btn" type="button" aria-label="下一张" onClick={() => go(1)}>
              <ChevronRightIcon size={17} />
            </button>
          </div>
        )}
      </div>

      <div
        className={`carousel-viewport${dragging ? ' is-dragging' : ''}`}
        role="region"
        aria-roledescription="carousel"
        aria-label="精选插件"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <div className="carousel-track">
          {laidOut.map(({ plugin: p, logical, ring }) => {
            const isActive = ring === 0
            const push = cardPush(hoverRing, ring)
            const cta = p.installed ? (p.enabled === false ? '已禁用' : '打开') : '安装'
            return (
              <div
                key={p.id}
                className={`carousel-item${isActive ? ' is-active' : ''}${Math.abs(ring) === 1 ? ' is-near' : ''}${Math.abs(ring) >= 3 ? ' is-buffer' : ''}${hoverRing === ring && ring !== 0 ? ' is-hover-side' : ''}`}
                data-ring={ring}
                data-logical={logical}
                aria-label={p.name}
                aria-current={isActive ? 'true' : undefined}
                style={ringStyle(ring, push)}
                onClick={(e) => onItemClick(e, logical, ring)}
                onMouseEnter={() => setHoverRing(ring)}
                onMouseLeave={() => setHoverRing((cur) => (cur === ring ? null : cur))}
              >
                <div className="featured-tile" style={{ ['--pc' as string]: p.color }}>
                  <div className="featured-glow" aria-hidden />
                  <div className="featured-particles" aria-hidden>
                    <i /><i /><i /><i /><i /><i />
                  </div>
                  <div className="featured-edge" aria-hidden />
                  <PluginIcon
                    className="featured-icon"
                    src={p.icon}
                    glyph={p.glyph}
                    slot="featured"
                    style={iconStyle(p)}
                  />
                  <div className="featured-meta">
                    <div className="featured-name" title={p.name}>
                      {p.name}
                    </div>
                    <div className="featured-desc" title={p.description}>
                      {p.description}
                    </div>
                    <div className="featured-foot">
                      <span className="featured-cat">{p.category}</span>
                      <button
                        type="button"
                        className="featured-cta"
                        tabIndex={isActive ? 0 : -1}
                        onClick={(e) => onCtaClick(e, logical)}
                      >
                        {cta}
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {len > 1 && (
        <div className="featured-dots" role="group" aria-label="精选插件分页">
          {items.map((p, i) => (
            <button
              key={p.id}
              type="button"
              className={`featured-dot${i === index ? ' is-active' : ''}`}
              aria-label={`转到第 ${i + 1} 张：${p.name}`}
              aria-current={i === index ? 'true' : undefined}
              onClick={() => {
                markManualNav()
                setIndex(i)
              }}
            />
          ))}
        </div>
      )}
    </div>
  )
}
