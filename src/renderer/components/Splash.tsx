/**
 * Splash — 冷启动全屏动画
 * 职责：首次进入时展示与应用图标同构的六边形「巢」动画，结束后卸载。
 * 动画强度：low 极短淡入 / medium 默认 / high 加长描边弹簧 + 结构性环境场。
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

/** 环境场光斑 sprite 半径（大软光） */
const SPLASH_SPRITE_RADIUS = 120

/** 预渲染 accent 色径向渐变 sprite：离屏画一次，每帧 drawImage */
function makeTintSprite(tint: string, dpr: number): HTMLCanvasElement {
  const size = Math.ceil(SPLASH_SPRITE_RADIUS * 2 * dpr)
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const g = canvas.getContext('2d', { alpha: true })
  if (g) {
    const c = SPLASH_SPRITE_RADIUS * dpr
    const grad = g.createRadialGradient(c - c * 0.2, c - c * 0.2, c * 0.04, c, c, c)
    grad.addColorStop(0, `${tint}c8`)
    grad.addColorStop(0.4, `${tint}55`)
    grad.addColorStop(1, 'transparent')
    g.fillStyle = grad
    g.fillRect(0, 0, size, size)
  }
  return canvas
}

/**
 * 结构性环境场（high）：accent 软光斑 + 中心点阵 + 同心涟漪环波场。
 * 光斑缓慢漂移呼吸；点阵按极坐标铺开、相位错拍脉冲；涟漪自六边形中心周期荡开、
 * 随半径淡出，呼应「巢」意象。全部 sprite 化，无逐帧 blur。
 */
function startSplashField(canvas: HTMLCanvasElement, accent: string): () => void {
  const ctx = canvas.getContext('2d', { alpha: true })
  if (!ctx) return () => undefined

  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  let w = 0
  let h = 0
  let raf = 0
  let alive = true
  let running = true
  let t = 0

  const tint = accent.startsWith('#') ? accent.slice(0, 7) : '#2dd4a8'
  const sprite = makeTintSprite(tint, dpr)

  type Orb = { ox: number; oy: number; r: number; phase: number; amp: number }
  const orbs: Orb[] = [
    { ox: 0.28, oy: 0.32, r: 0.42, phase: 0.0, amp: 18 },
    { ox: 0.72, oy: 0.58, r: 0.36, phase: 1.7, amp: 22 },
    { ox: 0.5, oy: 0.72, r: 0.28, phase: 3.1, amp: 14 },
  ]

  type Ripple = { born: number; dur: number }
  const RIPPLE_INTERVAL = 2.2
  const RIPPLE_COUNT = 3 // 同时在场环数
  const ripples: Ripple[] = []
  const spawnRipples = () => {
    // 三道错拍涟漪：出生点在时间轴上均匀分布
    ripples.length = 0
    for (let i = 0; i < RIPPLE_COUNT; i++) {
      ripples.push({ born: (i / RIPPLE_COUNT) * RIPPLE_INTERVAL, dur: 3.4 })
    }
  }
  spawnRipples()

  type Lattice = { x: number; y: number; a: number; phase: number; size: number; ringK: number; ang: number }
  let lattice: Lattice[] = []

  const buildLattice = () => {
    const cx = w * 0.5
    const cy = h * 0.45
    const maxR = Math.min(w, h) * 0.48
    const pts: Lattice[] = []
    const rings = 7
    for (let ring = 1; ring <= rings; ring++) {
      const rr = (ring / rings) * maxR
      const count = 6 + ring * 6
      for (let i = 0; i < count; i++) {
        const ang = (i / count) * Math.PI * 2 + ring * 0.18
        const fade = 1 - ring / (rings + 1)
        pts.push({
          x: cx + Math.cos(ang) * rr,
          y: cy + Math.sin(ang) * rr * 0.86,
          a: 0.08 + fade * 0.22,
          phase: ring * 0.45 + i * 0.12,
          size: 1.2 + fade * 2.4,
          ringK: ring / rings,
          ang,
        })
      }
    }
    lattice = pts
  }

  const resize = () => {
    w = window.innerWidth
    h = window.innerHeight
    canvas.width = Math.floor(w * dpr)
    canvas.height = Math.floor(h * dpr)
    canvas.style.width = `${w}px`
    canvas.style.height = `${h}px`
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    buildLattice()
  }

  const step = () => {
    if (!alive || !running) return
    t += 0.016
    ctx.clearRect(0, 0, w, h)

    const cx = w * 0.5
    const cy = h * 0.45
    const maxR = Math.min(w, h) * 0.48

    ctx.globalCompositeOperation = 'lighter'

    // 软光斑
    for (const o of orbs) {
      const driftX = Math.sin(t * 0.35 + o.phase) * o.amp
      const driftY = Math.cos(t * 0.28 + o.phase * 0.7) * o.amp * 0.6
      const breath = 0.72 + Math.sin(t * 0.9 + o.phase) * 0.18
      const radius = Math.min(w, h) * o.r
      const s = radius * 2
      ctx.globalAlpha = 0.22 * breath
      ctx.drawImage(sprite, w * o.ox + driftX - s / 2, h * o.oy + driftY - s / 2, s, s)
    }

    // 涟漪环：自中心周期荡开的细环，随半径淡出（描边而非 sprite，半径连续）
    for (const rp of ripples) {
      const local = ((t - rp.born) % RIPPLE_INTERVAL + RIPPLE_INTERVAL) % RIPPLE_INTERVAL
      const p = local / rp.dur
      if (p >= 1) continue
      const rr = p * maxR * 1.06
      const fade = (1 - p) * (1 - p)
      ctx.globalAlpha = 0.16 * fade
      ctx.strokeStyle = tint
      ctx.lineWidth = 1 + (1 - p) * 1.2
      ctx.beginPath()
      // 与点阵一致的椭圆压扁，视觉同构
      ctx.ellipse(cx, cy, rr, rr * 0.86, 0, 0, Math.PI * 2)
      ctx.stroke()
    }

    // 点阵：脉冲 + 受最近涟漪波前轻微加亮（波前经过时呼吸更明显）
    for (const p of lattice) {
      const pulse = 0.65 + Math.sin(t * 1.4 + p.phase) * 0.35
      let waveGlow = 0
      for (const rp of ripples) {
        const local = ((t - rp.born) % RIPPLE_INTERVAL + RIPPLE_INTERVAL) % RIPPLE_INTERVAL
        const pr = local / rp.dur
        if (pr >= 1) continue
        const front = pr * maxR * 1.06
        const dist = Math.abs(Math.hypot(p.x - cx, (p.y - cy) / 0.86) - front)
        if (dist < 46) waveGlow = Math.max(waveGlow, (1 - dist / 46) * 0.3)
      }
      ctx.globalAlpha = Math.min(0.9, p.a * pulse + waveGlow)
      ctx.fillStyle = tint
      ctx.beginPath()
      ctx.arc(p.x, p.y, p.size * (0.85 + pulse * 0.2) + waveGlow * 1.6, 0, Math.PI * 2)
      ctx.fill()
    }
    ctx.globalAlpha = 1
    ctx.globalCompositeOperation = 'source-over'
    raf = requestAnimationFrame(step)
  }

  const onVisibility = () => {
    if (document.hidden) {
      running = false
      cancelAnimationFrame(raf)
    } else if (alive && !running) {
      running = true
      raf = requestAnimationFrame(step)
    }
  }

  resize()
  window.addEventListener('resize', resize)
  document.addEventListener('visibilitychange', onVisibility)
  raf = requestAnimationFrame(step)

  return () => {
    alive = false
    running = false
    cancelAnimationFrame(raf)
    window.removeEventListener('resize', resize)
    document.removeEventListener('visibilitychange', onVisibility)
    lattice = []
    ripples.length = 0
    sprite.width = 0
    sprite.height = 0
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
      wordChars: Array.from(root.querySelectorAll('.splash-word-char')),
      mark: root.querySelector('.splash-mark'),
      ring: root.querySelector('.splash-ring'),
      sub: root.querySelector('.splash-sub'),
      stage: root.querySelector('.splash-stage'),
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

  // high 档：结构性环境场（仅 splash 阶段）
  useEffect(() => {
    if (!settingsReady || level !== 'high') return
    const canvas = canvasRef.current
    if (!canvas) return
    const accent =
      splashBg.type === 'none' ? readCssVar('--accent', BRAND.accent) : BRAND.accent
    return startSplashField(canvas, accent)
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
      <canvas ref={canvasRef} className="splash-field" aria-hidden />
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
        <div className="splash-word">
          {'eNest'.split('').map((c, i) => (
            <span className="splash-word-char" key={i}>
              {c}
            </span>
          ))}
        </div>
        <div className="splash-sub">可组合的桌面工作台</div>
      </div>
    </div>
  )
}
