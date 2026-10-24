/** A brief logo assembly, then a quiet dissolve into the workspace. */
import gsap from 'gsap'
import type { AnimationLevel, BackgroundEffectPreset } from '@shared/types/plugin'
import { d, dy, ease } from '@renderer/gsap/marketMotion'
import { createLogoAssembly } from '@renderer/themes/default/motion/logoAssembly'

export interface SplashHandles {
  root: HTMLElement
  hex: Element | null
  tileL: Element | null
  tileR: Element | null
  node: Element | null
  wordChars: Element[]
  sub?: Element | null
}

export interface SplashPlayback {
  (): void
  setReady(ready: boolean): void
}

/** All tweens live in one context/timeline; cleanup also works during launch. */
export function playSplash(
  h: SplashHandles,
  onDone: () => void,
  level: AnimationLevel = 'medium',
  style: BackgroundEffectPreset = 'fold',
  ready = true,
): SplashPlayback {
  let timeline: gsap.core.Timeline | undefined
  let waitingForReady = false
  let disposed = false
  const release = () => {
    if (disposed || !waitingForReady || !ready || document.hidden) return
    waitingForReady = false
    timeline?.resume()
  }
  const waitForReady = () => {
    waitingForReady = true
    release()
  }
  const mark = h.root.querySelector<SVGSVGElement>('.splash-mark')
  const assembly = mark ? createLogoAssembly(mark, style) : null
  const context = gsap.context(() => {
    timeline = gsap.timeline({ defaults: { ease: ease('power3.out') }, onComplete: () => {
      if (!disposed) onDone()
    } })

    const labels = [...h.wordChars, ...(h.sub ? [h.sub] : [])]
    if (level === 'low') {
      // 低档不再静态跳过：完整 Logo 编排照播，只由 low tokens 把时长压到约 1 秒、位移收到 ≤6px。
      // "低" 的语义是轻量快速过渡，不是没有动画（系统减少动态效果才会整段跳过）。
      const duration = d(0.4) * 4
      const clock = { age: 0 }
      assembly?.render(0)
      gsap.set(labels, { autoAlpha: 0, y: dy(4) })
      timeline.to(clock, { age: 2.3, duration, ease: ease('none'),
        onUpdate: () => assembly?.render(clock.age),
      }, 0)
        .to(labels, { autoAlpha: 1, y: 0, duration: d(0.24), stagger: d(0.1) / 8 }, duration * 0.6)
        .addPause(`+=${d(0.04)}`, waitForReady)
        .to(h.root, { autoAlpha: 0, duration: d(0.18), ease: ease('power1.out') })
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
    // The original completed logo remains visible until the workspace can take over.
    timeline.addPause(`+=${d(0.15)}`, waitForReady)
      .to(h.root, { autoAlpha: 0, duration: d(0.24), ease: ease('power2.in') })
  }, h.root)

  const onVisibility = () => {
    if (disposed) return
    if (document.hidden) timeline?.pause()
    else if (waitingForReady) release()
    else timeline?.resume()
  }
  document.addEventListener('visibilitychange', onVisibility)
  onVisibility()

  const dispose = () => {
    if (disposed) return
    disposed = true
    document.removeEventListener('visibilitychange', onVisibility)
    context.revert()
    assembly?.dispose()
  }
  return Object.assign(dispose, { setReady(value: boolean) {
    ready = value
    release()
  } })
}

export interface PaperSplashHandles {
  root: HTMLElement
  sheet: HTMLElement
  tabs: Element[]
  strokes: Element[]
  labels: Element[]
}

/** A declarative paper preset shares the same ready gate as the brand launch. */
export function playPaperSplash(h: PaperSplashHandles, onDone: () => void, ready = true): SplashPlayback {
  let timeline: gsap.core.Timeline | undefined
  let waitingForReady = false
  let disposed = false
  const release = () => {
    if (disposed || !waitingForReady || !ready || document.hidden) return
    waitingForReady = false
    timeline?.resume()
  }
  const context = gsap.context(() => {
    gsap.set(h.sheet, { autoAlpha: 0, y: dy(12), rotation: -1.5 })
    gsap.set(h.tabs, { autoAlpha: 0, x: dy(-10) })
    gsap.set(h.strokes, { strokeDasharray: 1, strokeDashoffset: 1 })
    gsap.set(h.labels, { autoAlpha: 0, y: dy(5) })
    timeline = gsap.timeline({ onComplete: () => { if (!disposed) onDone() } })
      .to(h.sheet, { autoAlpha: 1, y: 0, rotation: 0, duration: d(0.4), ease: ease('power3.out') })
      .to(h.tabs, { autoAlpha: 1, x: 0, duration: d(0.26), stagger: d(0.18) / 3, ease: ease('power2.out') }, '<')
      .to(h.strokes, { strokeDashoffset: 0, duration: d(0.4) * 2, stagger: d(0.2) / 3, ease: ease('none') }, `-=${d(0.12)}`)
      .to(h.labels, { autoAlpha: 1, y: 0, duration: d(0.28), stagger: d(0.16) / 6, ease: ease('power2.out') }, `-=${d(0.24)}`)
      .addPause(`+=${d(0.15)}`, () => { waitingForReady = true; release() })
      .to(h.root, { autoAlpha: 0, duration: d(0.24), ease: ease('power1.out') })
  }, h.root)
  const onVisibility = () => {
    if (disposed) return
    if (document.hidden) timeline?.pause()
    else if (waitingForReady) release()
    else timeline?.resume()
  }
  document.addEventListener('visibilitychange', onVisibility)
  onVisibility()
  const dispose = () => {
    if (disposed) return
    disposed = true
    document.removeEventListener('visibilitychange', onVisibility)
    context.revert()
  }
  return Object.assign(dispose, { setReady(value: boolean) { ready = value; release() } })
}
