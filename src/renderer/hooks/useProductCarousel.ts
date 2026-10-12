/** 产品轮播：自动阅读计时、可中断位移与原生触屏滚动共用一个目标索引。 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { FocusEvent, KeyboardEvent, MouseEvent, PointerEvent } from 'react'
import gsap from 'gsap'
import type { PluginSummary } from '@shared/types/plugin'
import { d, ease } from '@renderer/gsap/marketMotion'
import { useReducedMotion } from '@renderer/hooks/useAnimationLevel'

export const PRODUCT_DWELL_MS = 6500

export function useProductCarousel(items: PluginSummary[], paused: boolean) {
  const rootRef = useRef<HTMLElement>(null)
  const viewportRef = useRef<HTMLDivElement>(null)
  const itemsRef = useRef(items)
  itemsRef.current = items
  const indexRef = useRef(0)
  const currentId = useRef(items[0]?.id)
  const tween = useRef<gsap.core.Tween | null>(null)
  const settling = useRef<ReturnType<typeof setTimeout>>()
  const suppressClick = useRef(false)
  const clickReset = useRef<ReturnType<typeof setTimeout>>()
  const drag = useRef<{ id: number; x: number; y: number; left: number; moved: boolean } | null>(null)
  const [index, setIndex] = useState(0)
  const [moving, setMoving] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [touching, setTouching] = useState(false)
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  const [visible, setVisible] = useState(true)
  const [windowActive, setWindowActive] = useState(!document.hidden && document.hasFocus())
  const [cycle, setCycle] = useState(0)
  const [announcement, setAnnouncement] = useState('')
  const reducedMotion = useReducedMotion()
  const itemIds = items.map((item) => item.id).join('|')

  const commit = useCallback((next: number) => {
    const count = itemsRef.current.length
    const target = count ? ((next % count) + count) % count : 0
    indexRef.current = target
    currentId.current = itemsRef.current[target]?.id
    setIndex(target)
  }, [])

  const stop = useCallback(() => {
    tween.current?.kill()
    tween.current = null
    clearTimeout(settling.current)
    const viewport = viewportRef.current
    if (viewport) {
      viewport.style.removeProperty('scroll-snap-type')
      viewport.style.removeProperty('opacity')
    }
  }, [])

  const position = (viewport: HTMLElement, next: number) => {
    const slide = viewport.querySelector<HTMLElement>(`[data-product-position="${next}"]`)
    return slide ? slide.offsetLeft - 4 : 0
  }

  const nearest = useCallback(() => {
    const viewport = viewportRef.current
    if (!viewport) return 0
    let closest = 0
    let distance = Infinity
    viewport.querySelectorAll<HTMLElement>('[data-product-position]').forEach((slide) => {
      const delta = Math.abs(slide.offsetLeft - 4 - viewport.scrollLeft)
      if (delta < distance) { closest = Number(slide.dataset.productPosition); distance = delta }
    })
    return closest
  }, [])

  const select = useCallback((next: number, automatic = false) => {
    const viewport = viewportRef.current
    const count = itemsRef.current.length
    if (!viewport || !count) return
    const target = ((next % count) + count) % count
    const direction = Math.sign(next - indexRef.current)
    stop()
    commit(target)
    setCycle((value) => value + 1)
    if (!automatic) setAnnouncement(`${target + 1} / ${count} · ${itemsRef.current[target].name}`)
    // 同一个产品可以出现在首尾镜像中；选择离当前位置最近的实例，保持跨边界方向。
    let physical = target
    let distance = Infinity
    viewport.querySelectorAll<HTMLElement>('[data-product-position]').forEach((slide) => {
      const candidate = Number(slide.dataset.productPosition)
      if (((candidate % count) + count) % count !== target) return
      const offset = slide.offsetLeft - 4 - viewport.scrollLeft
      const delta = Math.abs(offset)
      // 两项轮播的前后镜像等距，保留 Next/Previous 请求的方向。
      if (delta < distance - 1 || (Math.abs(delta - distance) <= 1 && Math.sign(offset) === direction)) {
        physical = candidate
        distance = delta
      }
    })
    const left = position(viewport, physical)
    const finish = () => {
      // 镜像与真实项的内容一致；抵达后在同一帧归位，为下一次滑动保留两侧空间。
      if (physical !== target) viewport.scrollTo({ left: position(viewport, target), behavior: 'instant' })
      tween.current = null
      viewport.style.removeProperty('scroll-snap-type')
      viewport.style.removeProperty('opacity')
      setMoving(false)
    }
    viewport.style.scrollSnapType = 'none'
    if (reducedMotion || distance < 1) {
      viewport.scrollTo({ left, behavior: 'instant' })
      finish()
      return
    }
    setMoving(true)
    const stride = Math.abs(position(viewport, 1) - position(viewport, 0))
    // 仅跳过非相邻的长距离翻页；首尾相邻项始终连续滑动。
    if (stride && distance > stride * 1.5) {
      viewport.scrollTo({ left, behavior: 'instant' })
      tween.current = gsap.fromTo(viewport, { opacity: 0.45 }, {
        opacity: 1, duration: d(0.4), ease: ease('power3.out'), onComplete: finish,
      })
    } else {
      tween.current = gsap.to(viewport, {
        scrollLeft: left, duration: d(0.5), ease: ease('power3.out'), onComplete: finish,
      })
    }
  }, [commit, reducedMotion, stop])

  const settle = useCallback(() => {
    if (tween.current || drag.current?.moved) return
    clearTimeout(settling.current)
    const physical = nearest()
    commit(physical)
    const viewport = viewportRef.current
    if (viewport && physical !== indexRef.current) {
      viewport.scrollTo({ left: position(viewport, indexRef.current), behavior: 'instant' })
    }
    setMoving(false)
    setCycle((value) => value + 1)
  }, [commit, nearest])

  useEffect(() => {
    // 阈值前尚未捕获指针；用户在区域外松开也必须释放手势状态。
    const releaseOutside = () => {
      setTouching(false)
      if (!drag.current) return
      drag.current = null
      setDragging(false)
      select(nearest())
    }
    window.addEventListener('pointerup', releaseOutside)
    window.addEventListener('pointercancel', releaseOutside)
    return () => {
      window.removeEventListener('pointerup', releaseOutside)
      window.removeEventListener('pointercancel', releaseOutside)
    }
  }, [nearest, select])

  const onScroll = () => {
    if (tween.current || drag.current) return
    setMoving(true)
    clearTimeout(settling.current)
    settling.current = setTimeout(settle, 140)
  }

  useLayoutEffect(() => {
    stop()
    const found = itemsRef.current.findIndex((item) => item.id === currentId.current)
    const next = found < 0 ? 0 : found
    commit(next)
    const viewport = viewportRef.current
    viewport?.scrollTo({ left: position(viewport, next), behavior: 'instant' })
    setMoving(false)
    setCycle((value) => value + 1)
  }, [itemIds, commit, stop])

  useEffect(() => {
    const viewport = viewportRef.current
    const root = rootRef.current
    if (!viewport || !root) return
    const resize = new ResizeObserver(() => {
      stop()
      viewport.scrollTo({ left: position(viewport, indexRef.current), behavior: 'instant' })
      setMoving(false)
    })
    const intersection = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting && entry.intersectionRatio >= 0.25), { threshold: [0, 0.25] })
    resize.observe(viewport)
    intersection.observe(root)
    return () => { resize.disconnect(); intersection.disconnect(); stop(); clearTimeout(clickReset.current) }
  }, [stop])

  useEffect(() => {
    const update = () => setWindowActive(!document.hidden && document.hasFocus())
    document.addEventListener('visibilitychange', update)
    window.addEventListener('focus', update)
    window.addEventListener('blur', update)
    return () => {
      document.removeEventListener('visibilitychange', update)
      window.removeEventListener('focus', update)
      window.removeEventListener('blur', update)
    }
  }, [])

  useEffect(() => {
    if (windowActive) return
    drag.current = null
    setDragging(false)
    setTouching(false)
    stop()
    commit(nearest())
    const viewport = viewportRef.current
    if (viewport) viewport.scrollTo({ left: position(viewport, indexRef.current), behavior: 'instant' })
    setMoving(false)
  }, [windowActive, commit, nearest, stop])

  // 系统要求减少动态效果时，立即收敛位移，不留下半页或透明度残值。
  useEffect(() => {
    if (reducedMotion) select(indexRef.current, true)
  }, [reducedMotion, select])

  const running = items.length > 1 && !reducedMotion && !paused && !hovered && !focused && visible && windowActive && !moving && !dragging && !touching
  useEffect(() => {
    if (!running) return
    const timer = setTimeout(() => select(indexRef.current + 1, true), PRODUCT_DWELL_MS)
    return () => clearTimeout(timer)
  }, [running, cycle, select])

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if ((event.target as HTMLElement).closest('[data-product-gallery], input, textarea, select')) return
    const next = event.key === 'ArrowLeft' ? indexRef.current - 1
      : event.key === 'ArrowRight' ? indexRef.current + 1
      : event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : null
    if (next == null) return
    event.preventDefault()
    select(next)
  }

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement
    if (event.pointerType !== 'mouse') {
      stop()
      settle()
      return
    }
    if (event.button !== 0 || !event.isPrimary ||
      (target.closest('button, a, input, [data-product-gallery-control]') && !target.closest('[data-product-image]'))) return
    stop()
    drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, left: event.currentTarget.scrollLeft, moved: false }
  }

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const gesture = drag.current
    if (!gesture || gesture.id !== event.pointerId) return
    const dx = event.clientX - gesture.x
    if (!gesture.moved && (Math.abs(dx) < 6 || Math.abs(dx) < Math.abs(event.clientY - gesture.y))) return
    if (!gesture.moved) {
      gesture.moved = true
      event.currentTarget.setPointerCapture(event.pointerId)
      event.currentTarget.style.scrollSnapType = 'none'
      setDragging(true)
    }
    event.preventDefault()
    event.currentTarget.scrollLeft = gesture.left - dx
  }

  const endDrag = (event: PointerEvent<HTMLDivElement>) => {
    const gesture = drag.current
    if (!gesture || gesture.id !== event.pointerId) return
    drag.current = null
    if (!gesture.moved) { settle(); return }
    const dx = event.clientX - gesture.x
    const closest = nearest()
    const next = event.type === 'pointerup' && closest === indexRef.current && Math.abs(dx) > 50
      ? indexRef.current + (dx < 0 ? 1 : -1) : closest
    suppressClick.current = true
    clearTimeout(clickReset.current)
    clickReset.current = setTimeout(() => { suppressClick.current = false }, 300)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    setDragging(false)
    select(next)
  }

  return {
    rootRef, viewportRef, index, indexRef, select, running, cycle,
    announcement, dragging, onScroll, onKeyDown, onPointerDown, onPointerMove, endDrag,
    onWheel: () => { if (tween.current) { stop(); settle() } },
    onClickCapture: (event: MouseEvent) => {
      if (suppressClick.current) { event.preventDefault(); event.stopPropagation(); suppressClick.current = false }
    },
    onPointerEnter: (event: PointerEvent) => { if (event.pointerType === 'mouse') setHovered(true) },
    onPointerLeave: () => setHovered(false),
    onPointerDownCapture: (event: PointerEvent) => {
      setFocused(false)
      if (event.pointerType !== 'mouse') setTouching(true)
    },
    onFocusCapture: (event: FocusEvent<HTMLElement>) => setFocused(event.target.matches(':focus-visible')),
    onBlurCapture: (event: FocusEvent<HTMLElement>) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(false)
    },
  }
}
