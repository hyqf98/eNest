/**
 * marketMotion — 共用动画预算与宿主通知、更新弹窗的 GSAP 编排。
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

export function getEffectiveMotionTokens(): MotionLevelTokens {
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
  const t = getEffectiveMotionTokens()
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
  const t = getEffectiveMotionTokens()
  if (t.level === 'low') return Math.sign(base) * Math.min(Math.abs(base), t.displacement.max)
  if (t.level === 'high') {
    return Math.sign(base) * Math.min(Math.abs(base) * 1.1, t.displacement.max)
  }
  return Math.sign(base) * Math.min(Math.abs(base), t.displacement.max)
}

/** 缓动性格：low 轻缓出；medium expo/power3；high 入场弹簧。overshoot 仅确认/表演场景回落 */
export function ease(fallback: string): string {
  const t = getEffectiveMotionTokens()
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

/** Notification motion owns only transform/opacity and can always be interrupted. */
export function cancelNotifyMotion(el: HTMLElement): void { gsap.killTweensOf(el) }

export function notifyIn(el: HTMLElement, position: 'top' | 'center' | 'bottom-right'): void {
  gsap.killTweensOf(el)
  if (prefersReducedMotion()) { gsap.set(el, { autoAlpha: 1, clearProps: 'transform' }); return }
  const t = getEffectiveMotionTokens()
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
      autoAlpha: 0, y: dy(6), scale: getEffectiveMotionTokens().level === 'low' ? 1 : 0.985,
      duration: d(0.16), ease: getEffectiveMotionTokens().ease.exit, overwrite: true,
      onComplete: resolve, onInterrupt: resolve,
    })
  })
}

/** 更新弹框入场（锚点 data-update-*） */
export function playUpdateDialogIn(root: HTMLElement | null): void {
  if (!root) return
  const t = getEffectiveMotionTokens()
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
    const t = getEffectiveMotionTokens()
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
