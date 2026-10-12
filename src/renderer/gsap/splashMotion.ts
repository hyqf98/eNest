/** A brief logo assembly, then a quiet dissolve into the workspace. */
import gsap from 'gsap'
import type { AnimationLevel } from '@shared/types/plugin'
import { d, dy, ease } from '@renderer/gsap/marketMotion'

export interface SplashHandles {
  root: HTMLElement
  hex: Element | null
  tileL: Element | null
  tileR: Element | null
  node: Element | null
  wordChars: Element[]
  sub?: Element | null
}

/** All tweens live in one context/timeline; cleanup also works during launch. */
export function playSplash(
  h: SplashHandles,
  onDone: () => void,
  level: AnimationLevel = 'medium',
): () => void {
  let timeline: gsap.core.Timeline | undefined
  const context = gsap.context(() => {
    timeline = gsap.timeline({ defaults: { ease: ease('power3.out') }, onComplete: onDone })

    if (level === 'low') {
      const tiles = [h.tileL, h.tileR, h.node].filter((el): el is Element => el !== null)
      const labels = [...h.wordChars, ...(h.sub ? [h.sub] : [])]
      // pathLength is normalized to 1; pixel rounding would erase this short stroke.
      gsap.set(h.hex, { autoAlpha: 0.5, strokeDasharray: 1, strokeDashoffset: 0.2, autoRound: false })
      gsap.set(tiles, { autoAlpha: 0.5, scale: 0.98, transformOrigin: '50% 50%' })
      gsap.set(labels, { autoAlpha: 0, y: dy(2) })
      timeline.to(h.hex, { autoAlpha: 1, strokeDashoffset: 0, autoRound: false, duration: d(0.26) }, 0)
        .to(tiles, { autoAlpha: 1, scale: 1, duration: d(0.26) }, 0)
        .to(labels, { autoAlpha: 1, y: 0, duration: d(0.24) }, d(0.08))
        .to(h.root, { autoAlpha: 0, duration: d(0.18), ease: ease('power1.out') }, `+=${d(0.04)}`)
      return
    }

    const high = level === 'high'
    const chars = h.wordChars
    const tiles = [h.tileL, h.tileR, h.node].filter((el): el is Element => el !== null)
    gsap.set(h.hex, { strokeDasharray: 1, strokeDashoffset: 1 })
    gsap.set(tiles, { autoAlpha: 0, scale: 0.94, transformOrigin: '50% 50%' })
    gsap.set(chars, { autoAlpha: 0, y: dy(6) })
    if (h.sub) gsap.set(h.sub, { autoAlpha: 0, y: dy(4) })

    timeline.to(h.hex, { strokeDashoffset: 0, autoRound: false, duration: d(high ? 0.48 : 0.38) }, 0)
      .to(tiles, {
        autoAlpha: 1, scale: 1, duration: d(0.3),
        stagger: high ? 0.065 : 0.04,
      }, d(0.12))
      .to(chars, { autoAlpha: 1, y: 0, duration: d(0.3), stagger: 0.025 }, d(0.3))
    if (h.sub) {
      timeline.to(h.sub, { autoAlpha: 1, y: 0, duration: d(0.28) }, d(0.4))
    }
    timeline.to(h.root, {
      autoAlpha: 0,
      duration: d(0.24),
      ease: ease('power2.in'),
    }, `+=${d(high ? 0.32 : 0.16)}`)
  }, h.root)

  const onVisibility = () => {
    if (document.hidden) timeline?.pause()
    else timeline?.resume()
  }
  document.addEventListener('visibilitychange', onVisibility)
  onVisibility()

  return () => {
    document.removeEventListener('visibilitychange', onVisibility)
    context.revert()
  }
}
