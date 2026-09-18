/**
 * splashMotion — 启动动画时间轴
 * 职责：驱动 Splash 组件的六边形描边、插件块入场、节点脉冲与收尾淡出。
 * 按动画强度三档缩放时长与弹簧：low 极短淡入 / medium 默认 / high 加长更弹。
 * 被 Splash 组件在 mount 后调用；尊重 prefers-reduced-motion 由调用方处理。
 * 依赖：gsap、@shared/types/plugin（AnimationLevel）。
 */
import gsap from 'gsap'
import type { AnimationLevel } from '@shared/types/plugin'

export interface SplashHandles {
  root: HTMLElement
  hex: Element | null
  tileL: Element | null
  tileR: Element | null
  node: Element | null
  wordmark: Element | null
  ring: Element | null
  /** 副标题；high 档参与入场（可选，旧句柄兼容） */
  sub?: Element | null
  /** 标题容器；high 档整体缩放入场（可选） */
  stage?: Element | null
}

/** 档位时长缩放系数 */
function speed(level: AnimationLevel): number {
  if (level === 'high') return 1.35
  return 1
}

/** 插件块/节点弹簧：high 更明显 */
function backEase(level: AnimationLevel): string {
  return level === 'high' ? 'back.out(2.4)' : 'back.out(1.6)'
}

/** 播放完整启动序列，结束后 onDone */
export function playSplash(
  h: SplashHandles,
  onDone: () => void,
  level: AnimationLevel = 'medium',
): void {
  // low：几乎直接结束——极短淡入后立刻淡出（prefers-reduced-motion 由调用方直接 onDone）
  if (level === 'low') {
    gsap.fromTo(
      h.root,
      { autoAlpha: 0 },
      {
        autoAlpha: 1,
        duration: 0.1,
        ease: 'none',
        onComplete: () => {
          gsap.to(h.root, {
            autoAlpha: 0,
            duration: 0.12,
            ease: 'power1.in',
            onComplete: onDone,
          })
        },
      },
    )
    return
  }

  const m = speed(level)
  const easeBack = backEase(level)
  const isHigh = level === 'high'

  const tl = gsap.timeline({
    defaults: { ease: 'power3.out' },
    onComplete: () => {
      // 淡出后立刻 onDone，避免二次跳帧
      gsap.to(h.root, {
        autoAlpha: 0,
        duration: isHigh ? 0.42 : 0.32,
        ease: 'power2.inOut',
        onComplete: onDone,
      })
    },
  })

  gsap.set([h.tileL, h.tileR], { autoAlpha: 0, scale: isHigh ? 0.5 : 0.6 })
  gsap.set(h.node, { scale: 0, transformOrigin: '50% 50%' })
  gsap.set(h.wordmark, { autoAlpha: 0, y: isHigh ? 18 : 12 })
  gsap.set(h.hex, {
    strokeDasharray: 1,
    strokeDashoffset: 1,
    autoAlpha: 1,
    strokeWidth: isHigh ? 7 : 6,
  })
  gsap.set(h.ring, { autoAlpha: 0, scale: 0.92 })
  if (isHigh && h.stage) {
    gsap.set(h.stage, { scale: 0.94, transformOrigin: '50% 50%' })
    if (h.sub) gsap.set(h.sub, { autoAlpha: 0, y: 10, letterSpacing: '0.32em' })
  }

  tl.to(h.hex, { strokeDashoffset: 0, duration: 0.8 * m, ease: 'power2.inOut' }, 0.08 * m)
    .to(
      h.ring,
      {
        autoAlpha: isHigh ? 0.55 : 0.35,
        scale: isHigh ? 1.14 : 1.08,
        duration: 0.65 * m,
        transformOrigin: '50% 50%',
      },
      0.32 * m,
    )
    .to(
      h.tileL,
      { autoAlpha: 1, scale: 1, duration: 0.42 * m, ease: easeBack },
      0.5 * m,
    )
    .to(
      h.tileR,
      { autoAlpha: 1, scale: 1, duration: 0.42 * m, ease: easeBack },
      0.62 * m,
    )
    .to(h.node, { scale: 1, duration: 0.38 * m, ease: easeBack }, 0.8 * m)
    .to(
      h.node,
      {
        scale: isHigh ? 1.45 : 1.2,
        duration: 0.26 * m,
        yoyo: true,
        repeat: isHigh ? 2 : 1,
        ease: 'sine.inOut',
      },
      1.05 * m,
    )
    .to(
      h.wordmark,
      { autoAlpha: 1, y: 0, duration: 0.38 * m, ease: isHigh ? 'back.out(1.4)' : 'power3.out' },
      1.0 * m,
    )
    .to(h.ring, { autoAlpha: 0, scale: isHigh ? 1.48 : 1.22, duration: 0.45 * m }, 1.25 * m)

  if (isHigh) {
    // 高档：舞台整体回弹 + 副标题字距收束 + 二次光环
    if (h.stage) {
      tl.to(h.stage, { scale: 1, duration: 0.55 * m, ease: 'back.out(1.6)' }, 0.05 * m)
    }
    if (h.sub) {
      tl.to(
        h.sub,
        { autoAlpha: 1, y: 0, letterSpacing: '0.18em', duration: 0.45 * m, ease: 'power2.out' },
        1.15 * m,
      )
    }
    tl.fromTo(
      h.ring,
      { autoAlpha: 0, scale: 0.85 },
      { autoAlpha: 0.28, scale: 1.25, duration: 0.35 * m, ease: 'power1.out' },
      1.55 * m,
    ).to(h.ring, { autoAlpha: 0, scale: 1.55, duration: 0.4 * m }, 1.9 * m)
  }

  tl.to({}, { duration: (isHigh ? 0.28 : 0.18) * m })
}
