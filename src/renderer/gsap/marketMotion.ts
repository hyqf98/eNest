/**
 * marketMotion — 首页、卡片、Tab、通知与详情的 GSAP 编排。
 * 三档参数统一由 motionTokens 提供，尊重系统减少动态效果设置。
 */
import gsap from 'gsap'
import type { AnimationLevel } from '@shared/types/plugin'
import {
  getMotionTokens,
  msToSec,
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
  const t = getMotionTokens(level)
  gsap.defaults({ ease: t.ease.enter, duration: msToSec(t.duration.standard) })
}

export function initMotion(): void {
  applyLevelToDefaults(animLevel)
}

/** 按档位性格映射时长：low 保留 0.16–0.24 秒轻量过渡；medium 入标准带；high 细腻但不拖慢操作 */
export function d(base: number): number {
  if (prefersReducedMotion()) return 0
  const t = tokens()
  const [min, max] = t.dClamp
  if (t.level === 'low') {
    return Math.min(max, Math.max(min, min + base * 0.08))
  }
  if (t.level === 'high') {
    return Math.min(max, Math.max(min, base * 1.15))
  }
  return Math.min(max, Math.max(min, base * 1.1))
}

/** 位移预算：low ≤6px；medium 真实位移；high 更深但封顶 */
export function dy(base: number): number {
  if (prefersReducedMotion()) return 0
  const t = tokens()
  if (t.level === 'low') return Math.sign(base) * Math.min(Math.abs(base), t.displacement.max)
  if (t.level === 'high') {
    return Math.sign(base) * Math.min(Math.abs(base) * 1.1, t.displacement.max)
  }
  return Math.sign(base) * Math.min(Math.abs(base), t.displacement.max)
}

/** 缓动性格：low 轻缓出；medium expo/power3；high 入场弹簧。overshoot 仅确认/表演场景回落 */
export function ease(fallback: string): string {
  const t = tokens()
  if (t.level === 'low') return t.ease.soft
  const weak = !fallback || fallback === 'power2.out' || fallback === 'power1.out' || fallback === 'power3.out'
  if (fallback.startsWith('elastic.')) {
    return t.level === 'high' ? t.ease.spring : t.ease.overshoot
  }
  if (fallback.startsWith('back.')) {
    return t.ease.overshoot
  }
  if (weak) {
    return t.ease.enter
  }
  return fallback
}

function exitDuration(enterDur: number): number {
  const t = tokens()
  return Math.max(msToSec(t.duration.fast) * t.exitRatio, enterDur * t.exitRatio)
}

/** Reveal the marketplace in reading order without masking or rotating its content. */
export function playHeroIn(root: HTMLElement | null): void {
  if (!root) return
  const t = tokens()
  const q = gsap.utils.selector(root)
  const groups = [
    q('.search-wrap'),
    q('.carousel-block'),
    q('.home-toolbar'),
    q('.chip'),
  ].filter((group) => group.length > 0)
  const tl = gsap.timeline({ defaults: { ease: ease('power3.out') } })
  groups.forEach((nodes, index) => {
    tl.fromTo(
      nodes,
      { autoAlpha: 0, y: dy(t.level === 'high' ? 14 : 9) },
      {
        autoAlpha: 1,
        y: 0,
        duration: d(t.level === 'high' ? 0.38 : 0.28),
        stagger: t.stagger.tightGrid,
        clearProps: 'transform',
        overwrite: true,
      },
      index * t.stagger.standardList,
    )
  })
}

/** 插件卡片 — staccato：系统化网格 stagger，非装饰漂浮 */
export function animateCards(nodes: Element[]): void {
  if (!nodes.length) return
  const t = tokens()

  if (t.level === 'low') {
    gsap.fromTo(
      nodes,
      { autoAlpha: 0, y: dy(6) },
      {
        autoAlpha: 1,
        y: 0,
        duration: msToSec(t.duration.standard),
        ease: t.ease.enter,
        stagger: t.stagger.tightGrid,
        overwrite: true,
        clearProps: 'transform,opacity,visibility',
      },
    )
    return
  }

  const high = t.level === 'high'
  gsap.fromTo(
    nodes,
    { autoAlpha: 0, y: dy(high ? 28 : 18), scale: t.scaleFrom },
    {
      autoAlpha: 1,
      y: 0,
      scale: 1,
      duration: d(high ? 0.45 : 0.34),
      ease: high ? t.ease.enter : t.ease.soft,
      stagger: { each: t.stagger.tightGrid, from: high ? 'start' : 'center' },
      overwrite: true,
      clearProps: 'transform,opacity,visibility',
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

/** Notification motion owns only transform/opacity and can always be interrupted. */
export function cancelNotifyMotion(el: HTMLElement): void { gsap.killTweensOf(el) }

export function notifyIn(el: HTMLElement, position: 'top' | 'center' | 'bottom-right'): void {
  gsap.killTweensOf(el)
  if (prefersReducedMotion()) { gsap.set(el, { autoAlpha: 1, clearProps: 'transform' }); return }
  const t = tokens()
  gsap.fromTo(el, {
    autoAlpha: 0,
    x: position === 'bottom-right' ? dy(18) : 0,
    y: position === 'top' ? dy(-12) : position === 'center' ? dy(12) : dy(6),
    scale: t.level === 'low' ? 1 : 0.975,
  }, {
    autoAlpha: 1, x: 0, y: 0, scale: 1, duration: d(0.27), ease: t.ease.enter,
    overwrite: true, clearProps: 'transform',
  })
}

export function notifyOut(el: HTMLElement): Promise<void> {
  gsap.killTweensOf(el)
  if (prefersReducedMotion()) { gsap.set(el, { autoAlpha: 0 }); return Promise.resolve() }
  return new Promise(resolve => {
    gsap.to(el, {
      autoAlpha: 0, y: dy(6), scale: tokens().level === 'low' ? 1 : 0.985,
      duration: d(0.16), ease: tokens().ease.exit, overwrite: true,
      onComplete: resolve, onInterrupt: resolve,
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
        scale: 0.98,
        y: dy(16),
        transformOrigin: '50% 40%',
      },
      {
        autoAlpha: 1,
        scale: 1,
        y: 0,
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
          scale: 0.985,
          y: dy(8),
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

/** 更新弹框入场（锚点 data-update-*；结构对齐 playModalIn，段落更少更轻） */
export function playUpdateDialogIn(root: HTMLElement | null): void {
  if (!root) return
  const t = tokens()
  const q = gsap.utils.selector(root)
  const backdrop = q('[data-update-backdrop]')
  const modal = q('[data-update-modal]')
  const parts = [
    ...q('[data-update-header]'),
    ...q('[data-update-body]'),
    ...q('[data-update-status]'),
    ...q('[data-update-actions]'),
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
      { autoAlpha: 0, scale: 0.98, y: dy(16), transformOrigin: '50% 40%' },
      {
        autoAlpha: 1,
        scale: 1,
        y: 0,
        duration: msToSec(t.duration.slow) * 0.95,
        ease: t.ease.overshoot,
        clearProps: 'transform',
      },
      0.04,
    ).fromTo(
      parts,
      { autoAlpha: 0, y: dy(12) },
      {
        autoAlpha: 1,
        y: 0,
        duration: d(0.34),
        stagger: { each: t.stagger.tightGrid, from: 'start' },
        clearProps: 'transform',
      },
      0.18,
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
    { autoAlpha: 0, y: dy(10) },
    {
      autoAlpha: 1,
      y: 0,
      duration: d(0.3),
      stagger: { each: t.stagger.tightGrid, from: 'start' },
      clearProps: 'transform',
    },
    0.12,
  )
}

/** 更新弹框退场；low 档直接放行 */
export function playUpdateDialogOut(root: HTMLElement | null): Promise<void> {
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
    const backdrop = q('[data-update-backdrop]')
    const modal = q('[data-update-modal]')
    const tl = gsap.timeline({ onComplete: () => resolve() })
    tl.to(
      modal,
      {
        autoAlpha: 0,
        scale: 0.96,
        y: dy(10),
        duration: msToSec(t.duration.fast) * 1.1,
        ease: t.ease.exit,
      },
      0,
    ).to(backdrop, { autoAlpha: 0, duration: msToSec(t.duration.fast), ease: 'power1.in' }, 0.04)
  })
}
