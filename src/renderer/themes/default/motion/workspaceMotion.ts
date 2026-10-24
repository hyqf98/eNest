/** Default-theme Workspace and classic-tab choreography. */
import gsap from 'gsap'
import { d, dy, ease, getEffectiveMotionTokens as tokens } from '@renderer/gsap/marketMotion'
import { msToSec } from '@renderer/gsap/motionTokens'

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
