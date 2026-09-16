/**
 * marketMotion — 壳子内 GSAP 动效工具集
 * 集中管理默认缓动、Hero 入场、卡片 stagger、页面/Tab/Toast/轮播位移动画。
 * 供 MarketPage、TabStrip、FeaturedCarousel、useToast 调用；与业务逻辑解耦。
 * 依赖：gsap。
 */
import gsap from 'gsap'

/** 设置全局 GSAP 默认缓动与时长 */
export function initMotion(): void {
  gsap.defaults({ ease: 'power2.out', duration: 0.35 })
}

/** MarketPage Hero 依次入场：统计胶囊 → 标题 → 简介 → 搜索 → 分类 → 工具栏 → 轮播 → 网格头 */
export function playHeroIn(root: HTMLElement | null): void {
  if (!root) return
  const q = gsap.utils.selector(root)
  const tl = gsap.timeline({ defaults: { ease: 'power3.out' } })
  tl.fromTo(q('.stats-pill'), { autoAlpha: 0, y: -12, scale: 0.96 }, { autoAlpha: 1, y: 0, scale: 1, duration: 0.45 })
    .fromTo(q('.hero h1'), { autoAlpha: 0, y: 22 }, { autoAlpha: 1, y: 0, duration: 0.5 }, '-=0.2')
    .fromTo(q('.hero .lead'), { autoAlpha: 0, y: 16 }, { autoAlpha: 1, y: 0, duration: 0.4 }, '-=0.28')
    .fromTo(q('.search-wrap'), { autoAlpha: 0, y: 18, scale: 0.98 }, { autoAlpha: 1, y: 0, scale: 1, duration: 0.45 }, '-=0.22')
    .fromTo(q('.chip'), { autoAlpha: 0, y: 10 }, { autoAlpha: 1, y: 0, duration: 0.3, stagger: 0.03 }, '-=0.2')
    .fromTo(q('.home-toolbar'), { autoAlpha: 0, y: 12 }, { autoAlpha: 1, y: 0, duration: 0.35 }, '-=0.15')
    .fromTo(q('.carousel-block'), { autoAlpha: 0, y: 18 }, { autoAlpha: 1, y: 0, duration: 0.4 }, '-=0.15')
    .fromTo(q('.grid-head'), { autoAlpha: 0, y: 10 }, { autoAlpha: 1, y: 0, duration: 0.3 }, '-=0.2')
}

/** 插件卡片网格 stagger 入场；clearProps 避免残留 transform 影响后续 hover */
export function animateCards(nodes: Element[]): void {
  if (!nodes.length) return
  gsap.fromTo(
    nodes,
    { autoAlpha: 0, y: 16, scale: 0.98 },
    {
      autoAlpha: 1,
      y: 0,
      scale: 1,
      duration: 0.38,
      stagger: 0.045,
      clearProps: 'transform',
      overwrite: true,
    }
  )
}

/** 整页淡入上移（视图切换时可用） */
export function animatePageIn(el: HTMLElement | null): void {
  if (!el) return
  gsap.fromTo(el, { autoAlpha: 0, y: 10 }, { autoAlpha: 1, y: 0, duration: 0.28, overwrite: true })
}

/** 新 Tab 轻微缩放淡入（TabStrip 检测到 tabs 增加时调用） */
export function animateTabIn(el: HTMLElement | null): void {
  if (!el) return
  gsap.fromTo(el, { scale: 0.92, opacity: 0.4 }, { scale: 1, opacity: 1, duration: 0.28 })
}

/** 轮播轨道横向位移；immediate 用于初始化跳转，否则带缓动过渡 */
export function setCarouselX(track: HTMLElement | null, x: number, immediate = false): void {
  if (!track) return
  if (immediate) gsap.set(track, { x })
  else gsap.to(track, { x, duration: 0.45, ease: 'power3.out' })
}

/** Toast 入场（bindEl 后调用） */
export function toastIn(el: HTMLElement): void {
  gsap.fromTo(el, { autoAlpha: 0, y: 10 }, { autoAlpha: 1, y: 0, duration: 0.25 })
}

/** Toast 退场；返回 Promise 以便 dismiss 等动画结束后再移除节点 */
export function toastOut(el: HTMLElement): Promise<void> {
  return new Promise((resolve) => {
    gsap.to(el, {
      autoAlpha: 0,
      y: 8,
      duration: 0.2,
      onComplete: () => resolve(),
    })
  })
}

/** 是否偏好减少动效（无障碍） */
function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/** 插件详情弹窗入场：遮罩模糊淡入 + 弹窗缩放淡入 + 内容 stagger */
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

  if (prefersReducedMotion()) {
    gsap.set([backdrop, modal, parts], { autoAlpha: 1, clearProps: 'transform' })
    return
  }

  const tl = gsap.timeline({ defaults: { ease: 'power3.out' } })
  tl.fromTo(backdrop, { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.28 })
    .fromTo(
      modal,
      { autoAlpha: 0, scale: 0.92, y: 18 },
      { autoAlpha: 1, scale: 1, y: 0, duration: 0.42, clearProps: 'transform' },
      0.04
    )
    .fromTo(
      parts,
      { autoAlpha: 0, y: 10 },
      { autoAlpha: 1, y: 0, duration: 0.32, stagger: 0.05, clearProps: 'transform' },
      0.12
    )
}

/** 插件详情弹窗退场；返回 Promise，父级在 onComplete 后卸载 */
export function playModalOut(root: HTMLElement | null): Promise<void> {
  return new Promise((resolve) => {
    if (!root || prefersReducedMotion()) {
      resolve()
      return
    }
    const q = gsap.utils.selector(root)
    const backdrop = q('[data-detail-backdrop]')
    const modal = q('[data-detail-modal]')
    const tl = gsap.timeline({ onComplete: () => resolve() })
    tl.to(modal, { autoAlpha: 0, scale: 0.95, y: 10, duration: 0.22, ease: 'power2.in' }, 0).to(
      backdrop,
      { autoAlpha: 0, duration: 0.2, ease: 'power1.in' },
      0.04
    )
  })
}
