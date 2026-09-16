/**
 * splashMotion — 启动动画时间轴
 * 职责：驱动 Splash 组件的六边形描边、插件块入场、节点脉冲与收尾淡出。
 * 被 Splash 组件在 mount 后调用；尊重 prefers-reduced-motion 由调用方处理。
 */
import gsap from 'gsap'

export interface SplashHandles {
  root: HTMLElement
  hex: Element | null
  tileL: Element | null
  tileR: Element | null
  node: Element | null
  wordmark: Element | null
  ring: Element | null
}

/** 播放完整启动序列，结束后 onDone */
export function playSplash(h: SplashHandles, onDone: () => void): void {
  const tl = gsap.timeline({
    defaults: { ease: 'power3.out' },
    onComplete: () => {
      gsap.to(h.root, {
        autoAlpha: 0,
        scale: 1.06,
        duration: 0.45,
        ease: 'power2.inOut',
        onComplete: onDone
      })
    }
  })

  gsap.set([h.tileL, h.tileR], { autoAlpha: 0, scale: 0.6 })
  gsap.set(h.node, { scale: 0, transformOrigin: '50% 50%' })
  gsap.set(h.wordmark, { autoAlpha: 0, y: 12 })
  gsap.set(h.hex, {
    strokeDasharray: 1,
    strokeDashoffset: 1,
    autoAlpha: 1
  })

  tl.to(h.hex, { strokeDashoffset: 0, duration: 0.85, ease: 'power2.inOut' }, 0.1)
    .to(h.ring, { autoAlpha: 0.35, scale: 1.08, duration: 0.7, transformOrigin: '50% 50%' }, 0.35)
    .to(h.tileL, { autoAlpha: 1, scale: 1, duration: 0.45, ease: 'back.out(1.6)' }, 0.55)
    .to(h.tileR, { autoAlpha: 1, scale: 1, duration: 0.45, ease: 'back.out(1.6)' }, 0.68)
    .to(h.node, { scale: 1, duration: 0.4, ease: 'back.out(2)' }, 0.85)
    .to(
      h.node,
      {
        scale: 1.25,
        duration: 0.28,
        yoyo: true,
        repeat: 1,
        ease: 'sine.inOut'
      },
      1.1
    )
    .to(h.wordmark, { autoAlpha: 1, y: 0, duration: 0.4 }, 1.05)
    .to(h.ring, { autoAlpha: 0, scale: 1.25, duration: 0.5 }, 1.35)
    .to({}, { duration: 0.25 }) // 停顿一拍再收
}
