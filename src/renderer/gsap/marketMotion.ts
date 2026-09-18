/**
 * marketMotion — 壳子内 GSAP 动效工具集
 * 集中管理默认缓动、Hero 入场、卡片 stagger、页面/Tab/Toast/轮播位移动画。
 * 供 MarketPage、TabStrip、FeaturedCarousel、useToast 调用；与业务逻辑解耦。
 * 支持动画强度三档（low/medium/high）：getAnimLevel / applyLevelToDefaults。
 * 依赖：gsap。
 */
import gsap from 'gsap'
import type { AnimationLevel } from '@shared/types/plugin'

/** 当前动画强度；未 hydrate 前为 medium（与历史默认一致） */
let animLevel: AnimationLevel = 'medium'

/** 读取当前动画强度 */
export function getAnimLevel(): AnimationLevel {
  return animLevel
}

/**
 * 应用动画强度：更新模块状态与 GSAP 全局默认值。
 * low：极短时长 + 弱缓动；high：更长 + 弹性 back；
 * medium：略长于历史默认，位移/stagger 见 d/dy/st 的 medium 分支（仍明显低于 high）。
 */
export function applyLevelToDefaults(level: AnimationLevel): void {
  animLevel = level
  if (level === 'low') {
    gsap.defaults({ ease: 'power1.out', duration: 0.1 })
  } else if (level === 'high') {
    gsap.defaults({ ease: 'back.out(1.5)', duration: 0.55 })
  } else {
    gsap.defaults({ ease: 'power2.out', duration: 0.4 })
  }
}

/** 设置全局 GSAP 默认缓动与时长（按当前 level） */
export function initMotion(): void {
  applyLevelToDefaults(animLevel)
}

/** 按 level 缩放基准时长（导出供 Quick 小窗等独立表面复用同一档位规范） */
export function d(base: number): number {
  if (animLevel === 'low') return Math.min(0.08, base * 0.22)
  if (animLevel === 'high') return base * 1.4
  // medium：略拉长节奏，仍明显短于 high
  return base * 1.1
}

/** 按 level 缩放位移（low 几乎不位移；medium 略加强；high 更大） */
export function dy(base: number): number {
  if (animLevel === 'low') return Math.sign(base) * Math.min(Math.abs(base), 2)
  if (animLevel === 'high') return base * 1.5
  // medium：入场/位移略增强，保持克制
  return base * 1.15
}

/** 按 level 缩放 stagger（low 几乎齐播；medium 网格入场更可感；high 更错落） */
function st(base: number): number {
  if (animLevel === 'low') return 0.01
  if (animLevel === 'high') return base * 1.8
  // medium：市场 grid / chips  stagger 略增强（animateCards 0.045→~0.058）
  return base * 1.3
}

/** 按 level 选择缓动：low 线性近似，high 弹性，medium 略偏 power2/out 以外的传入值 */
export function ease(fallback: string): string {
  if (animLevel === 'low') return 'none'
  if (animLevel === 'high') return 'back.out(1.6)'
  // medium：保持调用方意图；仅当未指定更丰富缓动时给 power2.out（与 gsap.defaults 一致）
  return fallback || 'power2.out'
}

/** MarketPage Hero 依次入场：统计胶囊 → 标题 → 简介 → 搜索 → 分类 → 工具栏 → 轮播 → 网格头 */
export function playHeroIn(root: HTMLElement | null): void {
  if (!root) return
  const q = gsap.utils.selector(root)
  const tl = gsap.timeline({ defaults: { ease: ease('power3.out') } })
  tl.fromTo(q('.stats-pill'), { autoAlpha: 0, y: dy(-12), scale: 0.96 }, { autoAlpha: 1, y: 0, scale: 1, duration: d(0.45) })
    .fromTo(q('.hero h1'), { autoAlpha: 0, y: dy(22) }, { autoAlpha: 1, y: 0, duration: d(0.5) }, `-=${d(0.2)}`)
    .fromTo(q('.hero .lead'), { autoAlpha: 0, y: dy(16) }, { autoAlpha: 1, y: 0, duration: d(0.4) }, `-=${d(0.28)}`)
    .fromTo(q('.search-wrap'), { autoAlpha: 0, y: dy(18), scale: 0.98 }, { autoAlpha: 1, y: 0, scale: 1, duration: d(0.45) }, `-=${d(0.22)}`)
    .fromTo(q('.chip'), { autoAlpha: 0, y: dy(10) }, { autoAlpha: 1, y: 0, duration: d(0.3), stagger: st(0.03) }, `-=${d(0.2)}`)
    .fromTo(q('.home-toolbar'), { autoAlpha: 0, y: dy(12) }, { autoAlpha: 1, y: 0, duration: d(0.35) }, `-=${d(0.15)}`)
    .fromTo(q('.carousel-block'), { autoAlpha: 0, y: dy(18) }, { autoAlpha: 1, y: 0, duration: d(0.4) }, `-=${d(0.15)}`)
    .fromTo(q('.grid-head'), { autoAlpha: 0, y: dy(10) }, { autoAlpha: 1, y: 0, duration: d(0.3) }, `-=${d(0.2)}`)
}

/** 插件卡片网格 stagger 入场；clearProps 避免残留 transform 影响后续 hover */
export function animateCards(nodes: Element[]): void {
  if (!nodes.length) return
  // medium 略加强入场缩放差；high 更明显；low 几乎不变
  const scaleFrom = animLevel === 'high' ? 0.95 : animLevel === 'medium' ? 0.96 : 0.98
  gsap.fromTo(
    nodes,
    { autoAlpha: 0, y: dy(16), scale: scaleFrom },
    {
      autoAlpha: 1,
      y: 0,
      scale: 1,
      duration: d(0.38),
      stagger: st(0.045),
      ease: ease('power2.out'),
      clearProps: 'transform',
      overwrite: true,
    }
  )
}

/** 整页淡入上移（视图切换时可用） */
export function animatePageIn(el: HTMLElement | null): void {
  if (!el) return
  gsap.fromTo(el, { autoAlpha: 0, y: dy(10) }, { autoAlpha: 1, y: 0, duration: d(0.28), ease: ease('power2.out'), overwrite: true })
}

/** 新 Tab 轻微缩放淡入（TabStrip 检测到 tabs 增加时调用） */
export function animateTabIn(el: HTMLElement | null): void {
  if (!el) return
  gsap.fromTo(el, { scale: 0.92, opacity: 0.4 }, { scale: 1, opacity: 1, duration: d(0.28), ease: ease('power2.out') })
}

/** 轮播轨道横向位移；immediate 用于初始化跳转，否则带缓动过渡 */
export function setCarouselX(track: HTMLElement | null, x: number, immediate = false): void {
  if (!track) return
  if (immediate) gsap.set(track, { x })
  else gsap.to(track, { x, duration: d(0.45), ease: ease('power3.out') })
}

/** Toast 入场（bindEl 后调用） */
export function toastIn(el: HTMLElement): void {
  gsap.fromTo(el, { autoAlpha: 0, y: dy(10) }, { autoAlpha: 1, y: 0, duration: d(0.25), ease: ease('power2.out') })
}

/** Toast 退场；返回 Promise 以便 dismiss 等动画结束后再移除节点 */
export function toastOut(el: HTMLElement): Promise<void> {
  return new Promise((resolve) => {
    gsap.to(el, {
      autoAlpha: 0,
      y: dy(8),
      duration: d(0.2),
      ease: animLevel === 'low' ? 'none' : 'power2.in',
      onComplete: () => resolve(),
    })
  })
}

/** 统一通知入场：top 自上滑入，bottom-right 自右滑入 */
export function notifyIn(el: HTMLElement, position: 'top' | 'bottom-right'): void {
  if (position === 'bottom-right') {
    gsap.fromTo(
      el,
      { autoAlpha: 0, x: dy(16), scale: 0.96 },
      { autoAlpha: 1, x: 0, scale: 1, duration: d(0.28), ease: ease('power2.out') }
    )
  } else {
    gsap.fromTo(
      el,
      { autoAlpha: 0, y: dy(-14), scale: 0.98 },
      { autoAlpha: 1, y: 0, scale: 1, duration: d(0.28), ease: ease('power2.out') }
    )
  }
}

/** 统一通知退场；Promise 供 dismiss 等动画结束后再移除 */
export function notifyOut(el: HTMLElement): Promise<void> {
  return new Promise((resolve) => {
    gsap.to(el, {
      autoAlpha: 0,
      y: dy(8),
      duration: d(0.2),
      ease: animLevel === 'low' ? 'none' : 'power2.in',
      onComplete: () => resolve(),
    })
  })
}

/** 是否偏好减少动效（无障碍） */
function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/** 插件详情弹窗入场：遮罩模糊淡入 + 弹窗缩放淡入 + 内容 stagger；high 档用 rotateX/Y 弹簧 */
export function playModalIn(root: HTMLElement | null): void {
  if (!root) return
  const q = gsap.utils.selector(root)
  const backdrop = q('[data-detail-backdrop]')
  const modal = q('[data-detail-modal]')
  const parts = [
    ...q('[data-detail-icon]'),
    ...q('[data-detail-meta]'),
    ...q('[data-detail-actions]'),
    ...q('[data-detail-body]'),
  ]

  if (prefersReducedMotion() || animLevel === 'low') {
    gsap.set([backdrop, modal, parts], { autoAlpha: 1, clearProps: 'transform' })
    return
  }

  const tl = gsap.timeline({ defaults: { ease: ease('power3.out') } })
  tl.fromTo(backdrop, { autoAlpha: 0 }, { autoAlpha: 1, duration: d(0.28) })

  if (animLevel === 'high') {
    // 高档：3D 翻转 + 弹簧入场
    tl.fromTo(
      modal,
      {
        autoAlpha: 0,
        scale: 0.82,
        y: 32,
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
        duration: 0.72,
        ease: 'back.out(1.7)',
        clearProps: 'transform',
      },
      0.04
    ).fromTo(
      parts,
      { autoAlpha: 0, y: dy(14), scale: 0.96 },
      { autoAlpha: 1, y: 0, scale: 1, duration: d(0.38), stagger: st(0.07), clearProps: 'transform' },
      0.18
    )
    return
  }

  tl.fromTo(
    modal,
    { autoAlpha: 0, scale: 0.92, y: dy(18) },
    { autoAlpha: 1, scale: 1, y: 0, duration: d(0.42), clearProps: 'transform' },
    0.04
  ).fromTo(
    parts,
    // medium：内容块略加强位移（dy/st 已按档缩放；low 自动收敛）
    { autoAlpha: 0, y: dy(12) },
    { autoAlpha: 1, y: 0, duration: d(0.32), stagger: st(0.05), clearProps: 'transform' },
    0.12
  )
}

/** 插件详情弹窗退场；返回 Promise，父级在 onComplete 后卸载 */
export function playModalOut(root: HTMLElement | null): Promise<void> {
  return new Promise((resolve) => {
    if (!root || prefersReducedMotion() || animLevel === 'low') {
      resolve()
      return
    }
    const q = gsap.utils.selector(root)
    const backdrop = q('[data-detail-backdrop]')
    const modal = q('[data-detail-modal]')
    const tl = gsap.timeline({ onComplete: () => resolve() })
    if (animLevel === 'high') {
      tl.to(
        modal,
        {
          autoAlpha: 0,
          scale: 0.9,
          y: 16,
          rotateX: 12,
          rotateY: 8,
          transformPerspective: 1000,
          duration: 0.32,
          ease: 'power2.in',
        },
        0
      ).to(backdrop, { autoAlpha: 0, duration: 0.24, ease: 'power1.in' }, 0.06)
    } else {
      tl.to(modal, { autoAlpha: 0, scale: 0.95, y: dy(10), duration: d(0.22), ease: 'power2.in' }, 0).to(
        backdrop,
        { autoAlpha: 0, duration: d(0.2), ease: 'power1.in' },
        0.04
      )
    }
  })
}
