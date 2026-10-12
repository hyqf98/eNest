/** 仅保留实际消费的三档动画参数；档位状态由 useAnimationLevel 管理。 */
import type { AnimationLevel } from '@shared/types/plugin'

export interface MotionLevelTokens {
  level: AnimationLevel
  /** 毫秒 */
  duration: { instant: number; fast: number; standard: number; slow: number }
  ease: { enter: string; soft: string; exit: string; overshoot: string; spring: string; linear: string }
  /** 秒 */
  stagger: { none: number; tightGrid: number; standardList: number }
  displacement: { max: number }
  /** d() 收敛区间（秒） */
  dClamp: [number, number]
  scaleFrom: number
  exitRatio: number
}

export const LEVEL_TOKENS: Readonly<Record<AnimationLevel, MotionLevelTokens>> = {
  low: {
    level: 'low',
    duration: { instant: 110, fast: 150, standard: 190, slow: 260 },
    ease: {
      enter: 'power1.out',
      soft: 'power1.out',
      exit: 'none',
      overshoot: 'power1.out',
      spring: 'power1.out',
      linear: 'none',
    },
    stagger: { none: 0, tightGrid: 0.02, standardList: 0.028 },
    displacement: { max: 6 },
    dClamp: [0.16, 0.24],
    scaleFrom: 0.992,
    exitRatio: 0.7,
  },
  medium: {
    level: 'medium',
    duration: { instant: 80, fast: 160, standard: 320, slow: 450 },
    ease: {
      enter: 'expo.out',
      soft: 'power3.out',
      exit: 'power2.in',
      overshoot: 'back.out(1.2)',
      spring: 'power3.out',
      linear: 'none',
    },
    stagger: { none: 0, tightGrid: 0.04, standardList: 0.07 },
    displacement: { max: 18 },
    dClamp: [0.28, 0.45],
    scaleFrom: 0.985,
    exitRatio: 0.55,
  },
  high: {
    level: 'high',
    duration: { instant: 80, fast: 180, standard: 340, slow: 560 },
    ease: {
      enter: 'power3.out',
      soft: 'power3.out',
      exit: 'power2.in',
      overshoot: 'back.out(1.2)',
      spring: 'back.out(1.2)',
      linear: 'none',
    },
    stagger: { none: 0, tightGrid: 0.035, standardList: 0.055 },
    displacement: { max: 24 },
    dClamp: [0.22, 0.56],
    scaleFrom: 0.975,
    exitRatio: 0.45,
  },
}

export function getMotionTokens(level: AnimationLevel): MotionLevelTokens {
  return LEVEL_TOKENS[level]
}

export function msToSec(ms: number): number {
  return ms / 1000
}
