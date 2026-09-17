/**
 * Splash — 冷启动全屏动画
 * 职责：首次进入时展示与应用图标同构的六边形「巢」动画，结束后卸载。
 * 动画强度：low 极短淡入 / medium 默认 / high 加长描边弹簧 + 背景粒子。
 * 启动背景：settings.general.splashBackground（brand / none 主题色 / image 自定义图）。
 * 主题色：none 时读 CSS 变量 --bg/--accent/--text，缺失回落品牌墨绿/薄荷/琥珀。
 * 依赖：gsap、splashMotion、useTheme、useAnimationLevel、shellApi。
 */
import { useEffect, useRef, useState } from 'react'
import type { AnimationLevel, SplashBackgroundConfig } from '@shared/types/plugin'
import { playSplash, type SplashHandles } from '@renderer/gsap/splashMotion'
import { resolveMediaSrc, useThemeStore } from '@renderer/hooks/useTheme'
import { useAnimationLevelStore } from '@renderer/hooks/useAnimationLevel'
import { shellApi } from '@renderer/services/shellApi'

/** 品牌兜底（与 splash.css 注释一致） */
const BRAND = {
  bg: '#011517',
  accent: '#2dd4a8',
  text: '#e8fff6',
} as const

function isLevel(v: unknown): v is AnimationLevel {
  return v === 'low' || v === 'medium' || v === 'high'
}

function readCssVar(name: string, fallback: string): string {
  if (typeof window === 'undefined') return fallback
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return raw || fallback
}

/** 将 --bg / --accent / --text 写入 splash 根的局部变量；brand 模式清除以走 CSS 兜底 */
function applySplashTokens(root: HTMLElement, mode: 'brand' | 'theme'): void {
  if (mode === 'brand') {
    root.style.removeProperty('--splash-bg')
    root.style.removeProperty('--splash-accent')
    root.style.removeProperty('--splash-text')
    return
  }
  root.style.setProperty('--splash-bg', readCssVar('--bg', BRAND.bg))
  root.style.setProperty('--splash-accent', readCssVar('--accent', BRAND.accent))
  root.style.setProperty('--splash-text', readCssVar('--text', BRAND.text))
}

/** 轻量气泡/光点：仅 high 档挂载，约 16 帧粒子，软上浮 */
function startSplashParticles(canvas: HTMLCanvasElement, accent: string): () => void {
  const ctx = canvas.getContext('2d')
  if (!ctx) return () => undefined

  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  let w = 0
  let h = 0
  let raf = 0
  let alive = true

  type Dot = { x: number; y: number; r: number; vx: number; vy: number; a: number }
  let dots: Dot[] = []

  const spawn = (): Dot => ({
    x: Math.random() * w,
    y: Math.random() * h,
    r: 3 + Math.random() * 14,
    vx: (Math.random() - 0.5) * 0.22,
    vy: -0.08 - Math.random() * 0.18,
    a: 0.1 + Math.random() * 0.22,
  })

  const resize = () => {
    w = window.innerWidth
    h = window.innerHeight
    canvas.width = Math.floor(w * dpr)
    canvas.height = Math.floor(h * dpr)
    canvas.style.width = `${w}px`
    canvas.style.height = `${h}px`
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    const count = Math.min(18, Math.max(8, Math.floor((w * h) / 90000)))
    if (dots.length !== count) dots = Array.from({ length: count }, spawn)
  }

  // 用品牌薄荷/主题 accent 做光点；解析失败退回 hsla
  const tint = accent.startsWith('#') ? accent : '#2dd4a8'

  const step = () => {
    if (!alive) return
    ctx.clearRect(0, 0, w, h)
    for (const d of dots) {
      d.x += d.vx
      d.y += d.vy
      if (d.x < -d.r) d.x = w + d.r
      if (d.x > w + d.r) d.x = -d.r
      if (d.y < -d.r * 2) {
        d.y = h + d.r
        d.x = Math.random() * w
      }
      const g = ctx.createRadialGradient(d.x - d.r * 0.3, d.y - d.r * 0.3, d.r * 0.1, d.x, d.y, d.r)
      g.addColorStop(0, `${tint}${Math.round((d.a + 0.14) * 255).toString(16).padStart(2, '0')}`)
      g.addColorStop(0.55, `${tint}${Math.round(d.a * 0.55 * 255).toString(16).padStart(2, '0')}`)
      g.addColorStop(1, 'transparent')
      ctx.beginPath()
      ctx.fillStyle = g
      ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2)
      ctx.fill()
    }
    raf = requestAnimationFrame(step)
  }

  resize()
  window.addEventListener('resize', resize)
  raf = requestAnimationFrame(step)

  return () => {
    alive = false
    cancelAnimationFrame(raf)
    window.removeEventListener('resize', resize)
  }
}

export function Splash({ onDone }: { onDone: () => void }) {
  const rootRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const handlesRef = useRef<SplashHandles | null>(null)
  const [ready, setReady] = useState(false)
  const [settingsReady, setSettingsReady] = useState(false)
  const [level, setLevel] = useState<AnimationLevel>('medium')
  const [splashBg, setSplashBg] = useState<SplashBackgroundConfig>({ type: 'brand', opacity: 0.55 })

  // 抓取 DOM 句柄
  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    const handles: SplashHandles = {
      root,
      hex: root.querySelector('.splash-hex'),
      tileL: root.querySelector('.splash-tile-l'),
      tileR: root.querySelector('.splash-tile-r'),
      node: root.querySelector('.splash-node'),
      wordmark: root.querySelector('.splash-word'),
      ring: root.querySelector('.splash-ring'),
    }
    handlesRef.current = handles
    setReady(true)
  }, [])

  // 水合动画强度 / 主题 / 启动背景（与 App 水合并行，hydrate 幂等）
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        await useAnimationLevelStore.getState().hydrate()
        if (!useThemeStore.getState().hydrated) {
          await useThemeStore.getState().hydrate()
        }
        const settings = await shellApi.getSettings()
        if (cancelled) return
        const raw = settings.general?.animationLevel
        setLevel(isLevel(raw) ? raw : useAnimationLevelStore.getState().level)
        const bg = settings.general?.splashBackground
        if (bg && typeof bg === 'object' && bg.type) {
          setSplashBg({
            type: bg.type,
            value: bg.value ?? '',
            opacity: typeof bg.opacity === 'number' ? bg.opacity : 0.55,
          })
        } else {
          setSplashBg({ type: 'brand', opacity: 0.55 })
        }
      } catch {
        if (!cancelled) {
          setLevel('medium')
          setSplashBg({ type: 'brand', opacity: 0.55 })
        }
      } finally {
        if (!cancelled) setSettingsReady(true)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  // 主题 Token 写入 splash 根；image 时在自定义图之上仍用品牌/主题描边
  useEffect(() => {
    const root = rootRef.current
    if (!root || !settingsReady) return
    const mode = splashBg.type === 'none' ? 'theme' : 'brand'
    applySplashTokens(root, mode)
  }, [settingsReady, splashBg.type])

  // high 档：背景粒子（仅 splash 阶段）
  useEffect(() => {
    if (!settingsReady || level !== 'high') return
    const canvas = canvasRef.current
    if (!canvas) return
    // 主题模式用 --accent；品牌/图片模式固定薄荷，避免被主题 accent 染色
    const accent =
      splashBg.type === 'none' ? readCssVar('--accent', BRAND.accent) : BRAND.accent
    return startSplashParticles(canvas, accent)
  }, [settingsReady, level, splashBg.type])

  // 播放时间轴
  useEffect(() => {
    if (!ready || !settingsReady || !handlesRef.current) return
    const reduced =
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (reduced) {
      onDone()
      return
    }
    playSplash(handlesRef.current, onDone, level)
  }, [ready, settingsReady, level, onDone])

  const photo =
    splashBg.type === 'image' && splashBg.value ? resolveMediaSrc(splashBg.value) : null
  const photoSrc = photo?.playable ? photo.src : ''
  const photoOpacity = typeof splashBg.opacity === 'number' ? splashBg.opacity : 0.55

  return (
    <div
      className={`splash splash--${level}${splashBg.type === 'none' ? ' splash--theme' : ''}${splashBg.type === 'image' ? ' splash--photo' : ''}`}
      ref={rootRef}
      aria-hidden
    >
      <div className="splash-bg" />
      {photoSrc && (
        <div
          className="splash-photo"
          style={{
            backgroundImage: `url("${photoSrc}")`,
            opacity: photoOpacity,
          }}
        />
      )}
      <canvas ref={canvasRef} className="splash-particles" aria-hidden />
      <div className="splash-stage">
        <svg className="splash-mark" viewBox="0 0 200 200" width="168" height="168">
          {/* 开口六边形巢 */}
          <path
            className="splash-hex"
            d="M100 28 L162 64 L162 136 L100 172 L38 136 L38 64 Z"
            fill="none"
            stroke="currentColor"
            strokeWidth="6"
            strokeLinecap="round"
            strokeLinejoin="round"
            pathLength={1}
          />
          {/* 光环扩散 */}
          <circle
            className="splash-ring"
            cx="100"
            cy="100"
            r="78"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            opacity="0"
          />
          {/* 左插件块 */}
          <g className="splash-tile-l" transform="translate(52 78)">
            <rect x="0" y="0" width="36" height="28" rx="8" fill="currentColor" />
            <rect x="30" y="9" width="10" height="10" rx="3" fill="currentColor" />
          </g>
          {/* 右插件块 */}
          <g className="splash-tile-r" transform="translate(112 94)">
            <rect x="0" y="0" width="36" height="28" rx="8" fill="currentColor" />
            <rect x="-10" y="9" width="10" height="10" rx="3" fill="currentColor" />
          </g>
          {/* 中心智能节点 */}
          <circle className="splash-node" cx="100" cy="100" r="7" fill="#F5A524" />
        </svg>
        <div className="splash-word">eNest</div>
        <div className="splash-sub">可组合的桌面工作台</div>
      </div>
    </div>
  )
}
