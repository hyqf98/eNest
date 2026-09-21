/**
 * marketMotion — Tactile Marketplace GSAP 编排
 * Hero cold-open / 卡片 staccato；三档读 motionTokens（性格差异，非单一系数）。
 * API 供 MarketPage、TabStrip、FeaturedCarousel、useToast/notify、PluginDetailModal 复用。
 */
import gsap from 'gsap'
import type { AnimationLevel } from '@shared/types/plugin'
import {
  getMotionTokens,
  msToSec,
  setMotionLevel,
  type MotionLevelTokens,
} from '@renderer/gsap/motionTokens'

let animLevel: AnimationLevel = 'medium'

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

function effectiveLevel(): AnimationLevel {
  return prefersReducedMotion() ? 'low' : animLevel
}

function tokens(): MotionLevelTokens {
  return getMotionTokens(effectiveLevel())
}

export function getAnimLevel(): AnimationLevel {
  return animLevel
}

export function applyLevelToDefaults(level: AnimationLevel): void {
  animLevel = level
  setMotionLevel(level)
  const t = getMotionTokens(level)
  gsap.defaults({ ease: t.ease.enter, duration: msToSec(t.duration.standard) })
}

export function initMotion(): void {
  applyLevelToDefaults(animLevel)
}

/** 按档位性格映射时长：low 收敛 0.08–0.15；medium 入标准带；high 拉长供弹簧 settle */
export function d(base: number): number {
  const t = tokens()
  const [min, max] = t.dClamp
  if (t.level === 'low') {
    return Math.min(max, Math.max(min, min + base * 0.08))
  }
  if (t.level === 'high') {
    return Math.min(max, Math.max(min, base * 1.35))
  }
  return Math.min(max, Math.max(min, base * 1.1))
}

/** 位移预算：low ≤2px；medium 真实位移；high 更深但封顶 */
export function dy(base: number): number {
  const t = tokens()
  if (t.level === 'low') return Math.sign(base) * Math.min(Math.abs(base), t.displacement.max)
  if (t.level === 'high') {
    return Math.sign(base) * Math.min(Math.abs(base) * 1.6, t.displacement.max)
  }
  return Math.sign(base) * Math.min(Math.abs(base) * 1.25, t.displacement.max)
}

/** stagger：low≈0；medium tight-grid→standard-list；high 更错落 */
export function st(base: number): number {
  const t = tokens()
  if (t.level === 'low') return t.stagger.none
  if (t.level === 'high') {
    return Math.min(t.stagger.dramatic, Math.max(t.stagger.tightGrid, base * 1.6))
  }
  return Math.min(t.stagger.standardList, Math.max(t.stagger.tightGrid, base * 1.35))
}

/** 缓动性格：low 线性；medium expo/power3；high 入场弹簧。overshoot 仅确认/表演场景回落 */
export function ease(fallback: string): string {
  const t = tokens()
  if (t.level === 'low') return t.ease.linear
  const weak = !fallback || fallback === 'power2.out' || fallback === 'power1.out' || fallback === 'power3.out'
  if (fallback.startsWith('elastic.')) {
    return t.level === 'high' ? t.ease.spring : t.level === 'medium' ? t.ease.overshoot : t.ease.linear
  }
  if (fallback.startsWith('back.')) {
    return t.level === 'high' ? t.ease.overshoot : t.level === 'medium' ? t.ease.overshoot : t.ease.linear
  }
  if (weak) {
    return t.level === 'high' ? t.ease.enter : t.ease.enter
  }
  return fallback
}

function exitDuration(enterDur: number): number {
  const t = tokens()
  return Math.max(msToSec(t.duration.fast) * t.exitRatio, enterDur * t.exitRatio)
}

/** Market Hero — cold-open：stats 静场 → h1 结构展开 → search/chips/carousel 错拍 */
export function playHeroIn(root: HTMLElement | null): void {
  if (!root) return
  const t = tokens()
  const q = gsap.utils.selector(root)
  const stats = q('.stats-pill')
  const h1 = q('.hero h1')
  const lead = q('.hero .lead')
  const search = q('.search-wrap')
  const chips = q('.chip')
  const toolbar = q('.home-toolbar')
  const carousel = q('.carousel-block')
  const gridHeads = q('.grid-head')

  if (t.level === 'low') {
    const all = [...stats, ...h1, ...lead, ...search, ...chips, ...toolbar, ...carousel, ...gridHeads]
    if (!all.length) return
    gsap.fromTo(
      all,
      { autoAlpha: 0, y: 2 },
      {
        autoAlpha: 1,
        y: 0,
        duration: d(0.12),
        ease: t.ease.enter,
        stagger: t.stagger.none,
        overwrite: true,
      },
    )
    return
  }

  if (t.level === 'medium') {
    const tl = gsap.timeline({ defaults: { ease: t.ease.soft } })
    tl.fromTo(stats, { autoAlpha: 0, y: dy(-8), scale: 0.98 }, { autoAlpha: 1, y: 0, scale: 1, duration: d(0.3) }, 0)
      .fromTo(h1, { autoAlpha: 0, y: dy(28), scale: 0.97 }, { autoAlpha: 1, y: 0, scale: 1, duration: d(0.42) }, 0.12)
      .fromTo(lead, { autoAlpha: 0, y: dy(16) }, { autoAlpha: 1, y: 0, duration: d(0.34) }, 0.26)
      .fromTo(search, { autoAlpha: 0, y: dy(18), scale: 0.97 }, { autoAlpha: 1, y: 0, scale: 1, duration: d(0.36) }, 0.34)
      .fromTo(
        chips,
        { autoAlpha: 0, y: dy(10), scale: 0.96 },
        {
          autoAlpha: 1,
          y: 0,
          scale: 1,
          duration: d(0.28),
          stagger: { each: t.stagger.tightGrid, from: 'start' },
        },
        0.46,
      )
      .fromTo(toolbar, { autoAlpha: 0, y: dy(10) }, { autoAlpha: 1, y: 0, duration: d(0.3) }, 0.52)
      .fromTo(carousel, { autoAlpha: 0, y: dy(20), scale: 0.98 }, { autoAlpha: 1, y: 0, scale: 1, duration: d(0.4) }, 0.58)
      .fromTo(
        gridHeads,
        { autoAlpha: 0, y: dy(8) },
        { autoAlpha: 1, y: 0, duration: d(0.28), stagger: t.stagger.tightGrid },
        0.68,
      )
    return
  }

  const tl = gsap.timeline({ defaults: { ease: t.ease.soft } })
  tl.fromTo(
    stats,
    { autoAlpha: 0, y: dy(-10), scale: 0.94 },
    { autoAlpha: 1, y: 0, scale: 1, duration: d(0.4), ease: t.ease.enter },
    0,
  )
  if (h1.length) {
    tl.fromTo(
      h1,
      { autoAlpha: 0, y: dy(36), clipPath: 'inset(0 0 100% 0)' },
      {
        autoAlpha: 1,
        y: 0,
        clipPath: 'inset(0 0 0% 0)',
        duration: d(0.52),
        ease: t.ease.enter,
        clearProps: 'clipPath',
      },
      0.18,
    )
  }
  tl.fromTo(lead, { autoAlpha: 0, y: dy(20) }, { autoAlpha: 1, y: 0, duration: d(0.4) }, 0.42)
    .fromTo(
      search,
      { autoAlpha: 0, y: dy(24), scale: 0.94 },
      { autoAlpha: 1, y: 0, scale: 1, duration: d(0.45), ease: t.ease.overshoot },
      0.55,
    )
    .fromTo(
      chips,
      { autoAlpha: 0, y: dy(14), rotate: -t.cardRotate },
      {
        autoAlpha: 1,
        y: 0,
        rotate: 0,
        duration: d(0.35),
        ease: t.ease.enter,
        stagger: { each: t.stagger.tightGrid * 1.2, from: 'center' },
        clearProps: 'transform',
      },
      0.7,
    )
    .fromTo(toolbar, { autoAlpha: 0, y: dy(12) }, { autoAlpha: 1, y: 0, duration: d(0.32) }, 0.78)
    .fromTo(
      carousel,
      { autoAlpha: 0, y: dy(28), scale: 0.96 },
      { autoAlpha: 1, y: 0, scale: 1, duration: d(0.5), ease: t.ease.enter },
      0.86,
    )
    .fromTo(
      gridHeads,
      { autoAlpha: 0, y: dy(10) },
      {
        autoAlpha: 1,
        y: 0,
        duration: d(0.32),
        stagger: { each: t.stagger.standardList * 0.55, from: 'start' },
      },
      1.0,
    )
}

/** 插件卡片 — staccato：系统化网格 stagger，非装饰漂浮 */
export function animateCards(nodes: Element[]): void {
  if (!nodes.length) return
  const t = tokens()

  if (t.level === 'low') {
    gsap.fromTo(
      nodes,
      { autoAlpha: 0 },
      {
        autoAlpha: 1,
        duration: msToSec(t.duration.standard),
        ease: t.ease.enter,
        stagger: t.stagger.none,
        overwrite: true,
        clearProps: 'opacity,visibility',
      },
    )
    return
  }

  if (t.level === 'medium') {
    const rot = t.cardRotate
    gsap.fromTo(
      nodes,
      (i: number) => ({
        autoAlpha: 0,
        y: dy(18),
        scale: t.scaleFrom,
        rotate: i % 2 === 0 ? -rot : rot,
      }),
      {
        autoAlpha: 1,
        y: 0,
        scale: 1,
        rotate: 0,
        duration: d(0.34),
        ease: t.ease.soft,
        stagger: { each: t.stagger.tightGrid, from: 'center' },
        overwrite: true,
        clearProps: 'transform',
      },
    )
    return
  }

  const rot = t.cardRotate
  gsap.fromTo(
    nodes,
    (i: number) => ({
      autoAlpha: 0,
      y: dy(28),
      scale: t.scaleFrom,
      rotate: i % 2 === 0 ? -rot : rot,
      filter: 'blur(4px)',
    }),
    {
      autoAlpha: 1,
      y: 0,
      scale: 1,
      rotate: 0,
      filter: 'blur(0px)',
      duration: d(0.45),
      ease: t.ease.enter,
      stagger: { each: 0.07, from: 'edges' },
      overwrite: true,
      clearProps: 'transform,filter',
    },
  )
}

export function animatePageIn(el: HTMLElement | null): void {
  if (!el) return
  const t = tokens()
  gsap.fromTo(
    el,
    { autoAlpha: 0, y: dy(10) },
    {
      autoAlpha: 1,
      y: 0,
      duration: d(0.28),
      ease: t.level === 'low' ? t.ease.enter : t.ease.soft,
      overwrite: true,
    },
  )
}

export function animateTabIn(el: HTMLElement | null): void {
  if (!el) return
  const t = tokens()
  if (t.level === 'low') {
    gsap.fromTo(el, { autoAlpha: 0.4 }, { autoAlpha: 1, duration: d(0.12), ease: t.ease.enter })
    return
  }
  if (t.level === 'high') {
    gsap.fromTo(
      el,
      { scale: 0.88, y: dy(6), opacity: 0, rotate: -2 },
      {
        scale: 1,
        y: 0,
        opacity: 1,
        rotate: 0,
        duration: d(0.32),
        ease: t.ease.overshoot,
        clearProps: 'transform',
      },
    )
    return
  }
  gsap.fromTo(
    el,
    { scale: 0.94, opacity: 0 },
    { scale: 1, opacity: 1, duration: d(0.28), ease: t.ease.enter, clearProps: 'transform' },
  )
}

export function setCarouselX(track: HTMLElement | null, x: number, immediate = false): void {
  if (!track) return
  if (immediate) {
    gsap.set(track, { x })
    return
  }
  const t = tokens()
  const dur =
    t.level === 'low'
      ? msToSec(t.duration.fast)
      : t.level === 'high'
        ? msToSec(t.duration.medium)
        : msToSec(t.duration.standard)
  gsap.to(track, {
    x,
    duration: dur,
    ease: t.level === 'low' ? t.ease.linear : t.level === 'high' ? t.ease.enter : t.ease.soft,
  })
}

export function toastIn(el: HTMLElement): void {
  const t = tokens()
  if (t.level === 'low') {
    gsap.fromTo(el, { autoAlpha: 0 }, { autoAlpha: 1, duration: msToSec(t.duration.instant), ease: t.ease.enter })
    return
  }
  if (t.level === 'high') {
    gsap.fromTo(
      el,
      { autoAlpha: 0, y: dy(16), scale: 0.94 },
      { autoAlpha: 1, y: 0, scale: 1, duration: d(0.3), ease: t.ease.overshoot },
    )
    return
  }
  gsap.fromTo(
    el,
    { autoAlpha: 0, y: dy(12) },
    { autoAlpha: 1, y: 0, duration: d(0.28), ease: t.ease.enter },
  )
}

export function toastOut(el: HTMLElement): Promise<void> {
  return new Promise((resolve) => {
    const t = tokens()
    const enterGuess = t.level === 'low' ? msToSec(t.duration.instant) : t.level === 'high' ? d(0.3) : d(0.28)
    gsap.to(el, {
      autoAlpha: 0,
      y: t.level === 'low' ? 0 : dy(8),
      duration: exitDuration(enterGuess),
      ease: t.ease.exit,
      overwrite: true,
      onComplete: () => resolve(),
    })
  })
}

export function notifyIn(el: HTMLElement, position: 'top' | 'bottom-right'): void {
  const t = tokens()
  if (t.level === 'low') {
    gsap.fromTo(el, { autoAlpha: 0 }, { autoAlpha: 1, duration: msToSec(t.duration.instant), ease: t.ease.linear })
    return
  }
  if (position === 'bottom-right') {
    gsap.fromTo(
      el,
      { autoAlpha: 0, x: dy(t.level === 'high' ? 22 : 16), scale: t.level === 'high' ? 0.92 : 0.96 },
      {
        autoAlpha: 1,
        x: 0,
        scale: 1,
        duration: d(0.28),
        ease: t.level === 'high' ? t.ease.overshoot : t.ease.enter,
      },
    )
    return
  }
  gsap.fromTo(
    el,
    { autoAlpha: 0, y: dy(t.level === 'high' ? -18 : -14), scale: t.level === 'high' ? 0.94 : 0.98 },
    {
      autoAlpha: 1,
      y: 0,
      scale: 1,
      duration: d(0.28),
      ease: t.level === 'high' ? t.ease.overshoot : t.ease.enter,
    },
  )
}

export function notifyOut(el: HTMLElement): Promise<void> {
  return new Promise((resolve) => {
    const t = tokens()
    const enterGuess = t.level === 'low' ? msToSec(t.duration.instant) : d(0.28)
    gsap.to(el, {
      autoAlpha: 0,
      y: t.level === 'low' ? 0 : dy(8),
      duration: exitDuration(enterGuess),
      ease: t.ease.exit,
      overwrite: true,
      onComplete: () => resolve(),
    })
  })
}

export function playModalIn(root: HTMLElement | null): void {
  if (!root) return
  const t = tokens()
  const q = gsap.utils.selector(root)
  const backdrop = q('[data-detail-backdrop]')
  const modal = q('[data-detail-modal]')
  const parts = [
    ...q('[data-detail-icon]'),
    ...q('[data-detail-meta]'),
    ...q('[data-detail-actions]'),
    ...q('[data-detail-body]'),
  ]

  if (t.level === 'low') {
    gsap.set([backdrop, modal, parts], { autoAlpha: 1, clearProps: 'transform' })
    return
  }

  const tl = gsap.timeline({ defaults: { ease: t.ease.soft } })
  tl.fromTo(backdrop, { autoAlpha: 0 }, { autoAlpha: 1, duration: msToSec(t.duration.standard) })

  if (t.level === 'high') {
    tl.fromTo(
      modal,
      {
        autoAlpha: 0,
        scale: 0.82,
        y: dy(32),
        rotateX: 22,
        rotateY: -14,
        transformPerspective: 1000,
        transformOrigin: '50% 40%',
      },
      {
        autoAlpha: 1,
        scale: 1,
        y: 0,
        rotateX: 0,
        rotateY: 0,
        duration: msToSec(t.duration.slow) * 0.95,
        ease: t.ease.overshoot,
        clearProps: 'transform',
      },
      0.04,
    ).fromTo(
      parts,
      { autoAlpha: 0, y: dy(14), scale: 0.96 },
      {
        autoAlpha: 1,
        y: 0,
        scale: 1,
        duration: d(0.38),
        stagger: { each: t.stagger.standardList, from: 'start' },
        clearProps: 'transform',
      },
      0.2,
    )
    return
  }

  tl.fromTo(
    modal,
    { autoAlpha: 0, scale: t.scaleFrom, y: dy(18) },
    { autoAlpha: 1, scale: 1, y: 0, duration: d(0.4), clearProps: 'transform' },
    0.04,
  ).fromTo(
    parts,
    { autoAlpha: 0, y: dy(12) },
    {
      autoAlpha: 1,
      y: 0,
      duration: d(0.32),
      stagger: { each: t.stagger.tightGrid * 1.25, from: 'start' },
      clearProps: 'transform',
    },
    0.14,
  )
}

export function playModalOut(root: HTMLElement | null): Promise<void> {
  return new Promise((resolve) => {
    if (!root) {
      resolve()
      return
    }
    const t = tokens()
    if (t.level === 'low') {
      resolve()
      return
    }
    const q = gsap.utils.selector(root)
    const backdrop = q('[data-detail-backdrop]')
    const modal = q('[data-detail-modal]')
    const tl = gsap.timeline({ onComplete: () => resolve() })

    if (t.level === 'high') {
      tl.to(
        modal,
        {
          autoAlpha: 0,
          scale: 0.9,
          y: dy(16),
          rotateX: 12,
          rotateY: 8,
          transformPerspective: 1000,
          duration: msToSec(t.duration.fast) * 1.3,
          ease: t.ease.exit,
        },
        0,
      ).to(backdrop, { autoAlpha: 0, duration: msToSec(t.duration.fast), ease: 'power1.in' }, 0.05)
      return
    }

    tl.to(
      modal,
      {
        autoAlpha: 0,
        scale: 0.95,
        y: dy(10),
        duration: msToSec(t.duration.fast) * 1.05,
        ease: t.ease.exit,
      },
      0,
    ).to(backdrop, { autoAlpha: 0, duration: msToSec(t.duration.fast), ease: 'power1.in' }, 0.04)
  })
}
