/**
 * motionTokens — Tactile Marketplace 动效 token（对齐 motion-web motion-tokens）
 * 三档是「性格差异」：时长带、缓动曲线、位移预算、弹簧与特性开关，而非单一 duration 系数。
 * 供 marketMotion / splashMotion / 独立表面共用。
 */
import type { AnimationLevel } from '@shared/types/plugin'

export type MotionLevel = AnimationLevel

export interface MotionDurationTokens {
  /** ms — cursor/tooltip */
  instant: number
  /** ms — hover/active */
  fast: number
  /** ms — card/panel */
  standard: number
  /** ms — section reveal */
  medium: number
  /** ms — hero/page enter */
  slow: number
}

export interface MotionEaseTokens {
  /** 入场主曲线（快入软着陆 / 弹簧） */
  enter: string
  /** 无 overshoot 的软着陆 */
  soft: string
  /** 退场（更快、无弹） */
  exit: string
  /** 确认/弹窗轻微 overshoot */
  overshoot: string
  /** 表演档弹簧（克制使用） */
  spring: string
  linear: string
}

export interface MotionStaggerTokens {
  none: number
  tightGrid: number
  standardList: number
  dramatic: number
}

export interface MotionDisplacementTokens {
  /** 基准位移单位 px（dy 映射用） */
  unit: number
  /** 单次入场位移上限 */
  max: number
}

export interface MotionSpringPreset {
  name: string
  gsap: string
  css: string
  stiffness: number
  damping: number
  mass: number
}

export interface MotionFeatureFlags {
  enable3D: boolean
  enableOvershoot: boolean
  enableAmbient: boolean
  enableBlur: boolean
  enableRotate: boolean
  enableClip: boolean
}

export interface MotionLevelTokens {
  level: MotionLevel
  duration: MotionDurationTokens
  ease: MotionEaseTokens
  stagger: MotionStaggerTokens
  displacement: MotionDisplacementTokens
  spring: {
    enter: MotionSpringPreset
    confirm: MotionSpringPreset
  }
  features: MotionFeatureFlags
  /** d() 收敛区间（秒） */
  dClamp: [number, number]
  /** 卡片/弹层入场 scale 起点 */
  scaleFrom: number
  /** 卡片交错微倾 deg */
  cardRotate: number
  /** 退场相对入场的时长比（恒 < 1） */
  exitRatio: number
}

/** GSAP ease ↔ CSS cubic-bezier（对照表，便于 CSS/JS 同手感） */
export const GSAP_EASE_CSS: Readonly<Record<string, string>> = {
  none: 'linear',
  linear: 'linear',
  'power1.out': 'cubic-bezier(0.25, 0.46, 0.45, 0.94)',
  'power2.out': 'cubic-bezier(0.22, 0.61, 0.36, 1)',
  'power3.out': 'cubic-bezier(0.16, 1, 0.3, 1)',
  'power4.out': 'cubic-bezier(0.16, 1, 0.3, 1)',
  'expo.out': 'cubic-bezier(0.16, 1, 0.3, 1)',
  'power2.in': 'cubic-bezier(0.55, 0.085, 0.68, 0.53)',
  'power1.in': 'cubic-bezier(0.55, 0.055, 0.675, 0.19)',
  'back.out(1.2)': 'cubic-bezier(0.34, 1.4, 0.64, 1)',
  'back.out(1.4)': 'cubic-bezier(0.34, 1.48, 0.64, 1)',
  'back.out(1.5)': 'cubic-bezier(0.34, 1.52, 0.64, 1)',
  'back.out(1.7)': 'cubic-bezier(0.34, 1.56, 0.64, 1)',
  'elastic.out(1,0.55)': 'cubic-bezier(0.68, -0.6, 0.32, 1.6)',
  'circ.out': 'cubic-bezier(0, 0.55, 0.45, 1)',
}

export const CSS_EASE_GSAP: Readonly<Record<string, string>> = {
  linear: 'none',
  'cubic-bezier(0.25, 0.46, 0.45, 0.94)': 'power1.out',
  'cubic-bezier(0.22, 0.61, 0.36, 1)': 'power2.out',
  'cubic-bezier(0.16, 1, 0.3, 1)': 'expo.out',
  'cubic-bezier(0.55, 0.085, 0.68, 0.53)': 'power2.in',
  'cubic-bezier(0.34, 1.56, 0.64, 1)': 'back.out(1.7)',
  'cubic-bezier(0.68, -0.6, 0.32, 1.6)': 'elastic.out(1,0.55)',
  'cubic-bezier(0, 0.55, 0.45, 1)': 'circ.out',
}

export const EASE_PAIRS = {
  outExpo: { gsap: 'expo.out', css: 'cubic-bezier(0.16, 1, 0.3, 1)' },
  outBack: { gsap: 'back.out(1.7)', css: 'cubic-bezier(0.34, 1.56, 0.64, 1)' },
  outBackSoft: { gsap: 'back.out(1.2)', css: 'cubic-bezier(0.34, 1.4, 0.64, 1)' },
  spring: { gsap: 'elastic.out(1,0.55)', css: 'cubic-bezier(0.68, -0.6, 0.32, 1.6)' },
  outPower3: { gsap: 'power3.out', css: 'cubic-bezier(0.16, 1, 0.3, 1)' },
  outCirc: { gsap: 'circ.out', css: 'cubic-bezier(0, 0.55, 0.45, 1)' },
} as const

function spring(
  name: string,
  gsapEase: string,
  stiffness: number,
  damping: number,
  mass: number,
): MotionSpringPreset {
  return {
    name,
    gsap: gsapEase,
    css: GSAP_EASE_CSS[gsapEase] ?? EASE_PAIRS.outBack.css,
    stiffness,
    damping,
    mass,
  }
}

export const LEVEL_TOKENS: Readonly<Record<MotionLevel, MotionLevelTokens>> = {
  low: {
    level: 'low',
    duration: { instant: 80, fast: 100, standard: 120, medium: 140, slow: 150 },
    ease: {
      enter: 'power1.out',
      soft: 'power1.out',
      exit: 'none',
      overshoot: 'power1.out',
      spring: 'power1.out',
      linear: 'none',
    },
    stagger: { none: 0, tightGrid: 0, standardList: 0, dramatic: 0 },
    displacement: { unit: 2, max: 2 },
    spring: {
      enter: spring('spring-gentle-low', 'power1.out', 100, 35, 1),
      confirm: spring('spring-gentle-low', 'power1.out', 100, 35, 1),
    },
    features: {
      enable3D: false,
      enableOvershoot: false,
      enableAmbient: false,
      enableBlur: false,
      enableRotate: false,
      enableClip: false,
    },
    dClamp: [0.08, 0.15],
    scaleFrom: 1,
    cardRotate: 0,
    exitRatio: 0.7,
  },
  medium: {
    level: 'medium',
    duration: { instant: 80, fast: 160, standard: 320, medium: 400, slow: 450 },
    ease: {
      enter: 'expo.out',
      soft: 'power3.out',
      exit: 'power2.in',
      overshoot: 'back.out(1.2)',
      spring: 'power3.out',
      linear: 'none',
    },
    stagger: { none: 0, tightGrid: 0.04, standardList: 0.07, dramatic: 0.12 },
    displacement: { unit: 14, max: 28 },
    spring: {
      enter: spring('spring-default', 'expo.out', 200, 22, 1),
      confirm: spring('spring-bouncy-soft', 'back.out(1.2)', 200, 14, 1),
    },
    features: {
      enable3D: false,
      enableOvershoot: true,
      enableAmbient: false,
      enableBlur: false,
      enableRotate: true,
      enableClip: false,
    },
    dClamp: [0.28, 0.45],
    scaleFrom: 0.96,
    cardRotate: 0.6,
    exitRatio: 0.55,
  },
  high: {
    level: 'high',
    duration: { instant: 80, fast: 180, standard: 400, medium: 520, slow: 700 },
    ease: {
      enter: 'back.out(1.5)',
      soft: 'expo.out',
      exit: 'power2.in',
      overshoot: 'back.out(1.7)',
      spring: 'elastic.out(1,0.55)',
      linear: 'none',
    },
    stagger: { none: 0, tightGrid: 0.05, standardList: 0.08, dramatic: 0.14 },
    displacement: { unit: 24, max: 40 },
    spring: {
      enter: spring('spring-bouncy', 'back.out(1.5)', 200, 10, 1),
      confirm: spring('spring-playful', 'elastic.out(1,0.55)', 200, 8, 1),
    },
    features: {
      enable3D: true,
      enableOvershoot: true,
      enableAmbient: true,
      enableBlur: true,
      enableRotate: true,
      enableClip: true,
    },
    dClamp: [0.4, 0.8],
    scaleFrom: 0.94,
    cardRotate: 1.2,
    exitRatio: 0.45,
  },
}

let currentLevel: MotionLevel = 'medium'

export function setMotionLevel(level: MotionLevel): void {
  currentLevel = level
}

export function getMotionLevel(): MotionLevel {
  return currentLevel
}

/** 省略 level 时读当前 animLevel（由 marketMotion.applyLevelToDefaults 同步） */
export function getMotionTokens(level?: MotionLevel): MotionLevelTokens {
  return LEVEL_TOKENS[level ?? currentLevel]
}

export function msToSec(ms: number): number {
  return ms / 1000
}

export function gsapEaseToCss(ease: string): string {
  return GSAP_EASE_CSS[ease] ?? GSAP_EASE_CSS.none
}

export function cssEaseToGsap(css: string): string {
  return CSS_EASE_GSAP[css] ?? 'none'
}
