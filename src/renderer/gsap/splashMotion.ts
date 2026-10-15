/** A brief logo assembly, then a quiet dissolve into the workspace. */
import gsap from 'gsap'
import type { AnimationLevel, BackgroundEffectPreset } from '@shared/types/plugin'
import { d, dy, ease } from '@renderer/gsap/marketMotion'
import { createLogoAssembly } from '@renderer/gsap/logoAssembly'

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
  style: BackgroundEffectPreset = 'fold',
): () => void {
  let timeline: gsap.core.Timeline | undefined
  const mark = h.root.querySelector<SVGSVGElement>('.splash-mark')
  const assembly = mark ? createLogoAssembly(mark, style) : null
  const context = gsap.context(() => {
    timeline = gsap.timeline({ defaults: { ease: ease('power3.out') }, onComplete: onDone })

    const labels = [...h.wordChars, ...(h.sub ? [h.sub] : [])]
    if (level === 'low') {
      assembly?.render(2.3, true)
      gsap.set(labels, { autoAlpha: 0 })
      timeline.to(labels, { autoAlpha: 1, duration: d(0.24) }, 0)
        .to(h.root, { autoAlpha: 0, duration: d(0.18), ease: ease('power1.out') }, `+=${d(0.04)}`)
      return
    }

    // Each phase uses the shared duration budget. The scalar keeps the approved
    // nine-piece choreography intact without creating an independent RAF loop.
    const duration = d(level === 'high' ? 0.46 : 0.4) * 4
    const clock = { age: 0 }
    assembly?.render(0)
    gsap.set(h.wordChars, { autoAlpha: 0, y: dy(6) })
    if (h.sub) gsap.set(h.sub, { autoAlpha: 0, y: dy(4) })
    timeline.to(clock, { age: 2.3, duration, ease: ease('none'),
      onUpdate: () => assembly?.render(clock.age),
    }, 0)
      .to(h.wordChars, { autoAlpha: 1, y: 0, duration: d(0.3), stagger: d(0.1) / 8 }, duration * .58)
    if (h.sub) {
      timeline.to(h.sub, { autoAlpha: 1, y: 0, duration: d(0.28) }, duration * .72)
    }
    timeline.to(h.root, { autoAlpha: 0, duration: d(0.24), ease: ease('power2.in') }, `+=${d(0.15)}`)
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
    assembly?.dispose()
  }
}
