/**
 * splashMotion — 启动时间轴（Tactile Marketplace 三档叙事）
 * low 闪现 / medium 六边形描边→双 tile→node 脉冲→wordmark 逐字 / high 舞台缩放+字距收束+二次光环
 * 保持阶段 mark 轻呼吸（medium/high）；退出为结构化收束：hex 回描 + 舞台升格淡出 + 底色渐隐。
 * 时长与 ease 来自 motionTokens；Splash.tsx 句柄契约保持不变（新增 wordChars/mark 可选项）。
 */
import gsap from 'gsap'
import type { AnimationLevel } from '@shared/types/plugin'
import { getMotionTokens, msToSec, type MotionLevelTokens } from '@renderer/gsap/motionTokens'

export interface SplashHandles {
  root: HTMLElement
  hex: Element | null
  tileL: Element | null
  tileR: Element | null
  node: Element | null
  wordmark: Element | null
  /** wordmark 逐字 span（新增；缺省回落整词动画） */
  wordChars?: Element[] | null
  /** svg mark 整体（新增；用于保持阶段呼吸） */
  mark?: Element | null
  ring: Element | null
  sub?: Element | null
  stage?: Element | null
}

function sec(t: MotionLevelTokens, key: keyof MotionLevelTokens['duration']): number {
  return msToSec(t.duration[key])
}

export function playSplash(
  h: SplashHandles,
  onDone: () => void,
  level: AnimationLevel = 'medium',
): void {
  const t = getMotionTokens(level)

  if (level === 'low') {
    gsap.fromTo(
      h.root,
      { autoAlpha: 0 },
      {
        autoAlpha: 1,
        duration: sec(t, 'instant'),
        ease: t.ease.enter,
        onComplete: () => {
          gsap.to(h.root, {
            autoAlpha: 0,
            duration: sec(t, 'fast'),
            ease: t.ease.exit,
            onComplete: onDone,
          })
        },
      },
    )
    return
  }

  const isHigh = level === 'high'
  const tileEase = t.spring.confirm.gsap
  const enterEase = t.ease.enter
  const softEase = t.ease.soft
  const hexDur = isHigh ? sec(t, 'slow') : sec(t, 'medium') * 1.2
  const tileDur = isHigh ? sec(t, 'medium') : sec(t, 'standard') * 1.1
  const nodeDur = isHigh ? sec(t, 'standard') * 0.95 : sec(t, 'standard')
  const wordDur = isHigh ? sec(t, 'medium') : sec(t, 'standard') * 1.1
  const ringDur = isHigh ? sec(t, 'medium') : sec(t, 'standard') * 1.3
  const pulseDur = isHigh ? 0.28 : 0.24
  const pulseRepeat = isHigh ? 2 : 1
  const pulseScale = isHigh ? 1.45 : 1.2
  const ringPeak = isHigh ? 0.55 : 0.35
  const ringScale = isHigh ? 1.14 : 1.08
  const hold = isHigh ? 0.34 : 0.22

  // 结构化退出：hex 回描收束 + 舞台升格淡出 + 整层渐隐（呼吸随之杀死）
  const exitDur = isHigh ? sec(t, 'medium') * 0.6 : sec(t, 'standard') * 0.66
  const breathers: gsap.core.Tween[] = []
  const exitTl = gsap.timeline({
    paused: true,
    onComplete: () => {
      breathers.forEach((tw) => tw.kill())
      onDone()
    },
  })
  exitTl.to(h.hex, { strokeDashoffset: 1, duration: exitDur * 1.15, ease: 'power2.in' }, 0)
  if (h.stage) {
    exitTl.to(
      h.stage,
      { autoAlpha: 0, scale: isHigh ? 1.045 : 1.03, duration: exitDur, ease: 'power2.in' },
      0,
    )
  }
  exitTl.to(h.root, { autoAlpha: 0, duration: exitDur, ease: 'power1.inOut' }, exitDur * 0.3)

  const tl = gsap.timeline({
    defaults: { ease: softEase },
    onComplete: () => {
      // 保持阶段的轻呼吸（wordmark 已就位后启动；退出时 kill 防泄漏）
      if (h.mark) {
        breathers.push(
          gsap.to(h.mark, {
            scale: 1.02,
            transformOrigin: '50% 50%',
            duration: isHigh ? 1.1 : 0.9,
            yoyo: true,
            repeat: -1,
            ease: 'sine.inOut',
          }),
          gsap.to(h.mark, {
            opacity: 0.88,
            duration: isHigh ? 1.1 : 0.9,
            yoyo: true,
            repeat: -1,
            ease: 'sine.inOut',
          }),
        )
      }
      window.setTimeout(() => exitTl.play(), isHigh ? 620 : 380)
    },
  })

  gsap.set([h.tileL, h.tileR], { autoAlpha: 0, scale: isHigh ? 0.5 : 0.6 })
  gsap.set(h.node, { scale: 0, transformOrigin: '50% 50%' })
  const chars = h.wordChars?.length ? h.wordChars : null
  if (chars) {
    gsap.set(chars, { autoAlpha: 0, y: isHigh ? 16 : 11 })
    gsap.set(h.wordmark, { autoAlpha: 1 })
  } else {
    gsap.set(h.wordmark, { autoAlpha: 0, y: isHigh ? 18 : 12 })
  }
  gsap.set(h.hex, {
    strokeDasharray: 1,
    strokeDashoffset: 1,
    autoAlpha: 1,
    strokeWidth: isHigh ? 7 : 6,
  })
  gsap.set(h.ring, { autoAlpha: 0, scale: 0.92 })
  if (isHigh && h.stage) {
    gsap.set(h.stage, { scale: 0.94, transformOrigin: '50% 50%' })
  }
  if (isHigh && h.sub) {
    gsap.set(h.sub, { autoAlpha: 0, y: 10, letterSpacing: '0.32em' })
  }

  const t0 = isHigh ? 0.08 : 0.06
  tl.to(h.hex, { strokeDashoffset: 0, duration: hexDur, ease: 'power2.inOut' }, t0)
    .to(
      h.ring,
      {
        autoAlpha: ringPeak,
        scale: ringScale,
        duration: ringDur * 0.85,
        transformOrigin: '50% 50%',
      },
      t0 + hexDur * 0.35,
    )
    .to(
      h.tileL,
      { autoAlpha: 1, scale: 1, duration: tileDur, ease: tileEase },
      t0 + hexDur * 0.55,
    )
    .to(
      h.tileR,
      { autoAlpha: 1, scale: 1, duration: tileDur, ease: tileEase },
      t0 + hexDur * 0.7,
    )
    .to(
      h.node,
      { scale: 1, duration: nodeDur, ease: tileEase },
      t0 + hexDur * 0.95,
    )
    .to(
      h.node,
      {
        scale: pulseScale,
        duration: pulseDur,
        yoyo: true,
        repeat: pulseRepeat,
        ease: 'sine.inOut',
      },
      t0 + hexDur + nodeDur * 0.45,
    )

  // wordmark：逐字升格（无 chars 时回落整词）
  const wordStart = t0 + hexDur + nodeDur * 0.35
  if (chars) {
    tl.to(
      chars,
      {
        autoAlpha: 1,
        y: 0,
        duration: wordDur * 0.8,
        ease: isHigh ? enterEase : softEase,
        stagger: isHigh ? 0.055 : 0.04,
      },
      wordStart,
    )
  } else {
    tl.to(
      h.wordmark,
      { autoAlpha: 1, y: 0, duration: wordDur, ease: isHigh ? enterEase : softEase },
      wordStart,
    )
  }

  tl.to(
    h.ring,
    { autoAlpha: 0, scale: isHigh ? 1.48 : 1.22, duration: ringDur },
    t0 + hexDur + nodeDur + pulseDur * (pulseRepeat + 1) * 0.4,
  )

  if (isHigh) {
    if (h.stage) {
      tl.to(h.stage, { scale: 1, duration: sec(t, 'medium'), ease: enterEase }, t0)
    }
    if (h.sub) {
      const subStart = t0 + hexDur + nodeDur * 0.7
      tl.to(
        h.sub,
        {
          autoAlpha: 1,
          y: 0,
          letterSpacing: '0.18em',
          duration: wordDur,
          ease: softEase,
        },
        subStart,
      )
      tl.fromTo(
        h.ring,
        { autoAlpha: 0, scale: 0.85 },
        {
          autoAlpha: 0.28,
          scale: 1.25,
          duration: sec(t, 'standard') * 0.9,
          ease: 'power1.out',
        },
        subStart + wordDur * 0.35,
      ).to(
        h.ring,
        { autoAlpha: 0, scale: 1.55, duration: sec(t, 'medium') * 0.8 },
        subStart + wordDur * 0.35 + sec(t, 'standard'),
      )
    }
  } else if (h.sub) {
    // medium：sub 也轻淡入，不再整场静止（先 set 0 再 tl 内 to）
    gsap.set(h.sub, { autoAlpha: 0 })
    tl.to(
      h.sub,
      { autoAlpha: 1, duration: sec(t, 'standard') * 0.9, ease: softEase },
      wordStart + wordDur * 0.5,
    )
  }

  tl.to({}, { duration: hold })
}
