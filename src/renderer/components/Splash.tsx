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

/** Splash 粒子 sprite 半径：spawn 上界（layer2 = 10 + 18 = 28）+ 呼吸 10% + 余量 */
const SPLASH_SPRITE_RADIUS = 34

/** 预渲染 accent 色径向渐变 sprite：离屏 canvas 画一次，每帧 drawImage（消除逐帧 createRadialGradient GC 压力） */
function makeTintSprite(tint: string, dpr: number): HTMLCanvasElement {
  const size = Math.ceil(SPLASH_SPRITE_RADIUS * 2 * dpr)
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const g = canvas.getContext('2d', { alpha: true })
  if (g) {
    // 与原逐帧渐变同构：高光偏左上，三段透明度（外圈 globalAlpha 控制呼吸）
    const c = SPLASH_SPRITE_RADIUS * dpr
    const grad = g.createRadialGradient(c - c * 0.35, c - c * 0.35, c * 0.08, c, c, c)
    grad.addColorStop(0, `${tint}ff`)
    grad.addColorStop(0.5, `${tint}8c`)
    grad.addColorStop(1, 'transparent')
    g.fillStyle = grad
    g.fillRect(0, 0, size, size)
  }
  return canvas
}

/** 轻量气泡/光点：仅 high 档挂载；分层 + 两遍模糊加色发光；
 *  渐变 sprite 预渲染 + 粒子池复用；document.hidden 暂停 */
function startSplashParticles(canvas: HTMLCanvasElement, accent: string): () => void {
  const ctx = canvas.getContext('2d', { alpha: true })
  if (!ctx) return () => undefined

  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  let w = 0
  let h = 0
  let raf = 0
  let alive = true
  let running = true

  type Dot = {
    x: number
    y: number
    r: number
    vx: number
    vy: number
    a: number
    layer: number
    phase: number
  }
  /** 对象池：按上限 28 预分配，resize 只改 count + 重置字段 */
  const POOL = 28
  let count = 0
  const dots: Dot[] = Array.from({ length: POOL }, () => ({
    x: 0, y: 0, r: 0, vx: 0, vy: 0, a: 0, layer: 0, phase: 0,
  }))

  const initDot = (d: Dot, layer: number): void => {
    const sizeBase = layer === 0 ? 3 : layer === 1 ? 6 : 10
    const sizeSpan = layer === 0 ? 8 : layer === 1 ? 12 : 18
    const speed = layer === 0 ? 0.16 : layer === 1 ? 0.28 : 0.42
    d.x = Math.random() * w
    d.y = Math.random() * h
    d.r = sizeBase + Math.random() * sizeSpan
    d.vx = (Math.random() - 0.5) * speed
    d.vy = -speed * 0.4 - Math.random() * speed * 0.5
    d.a = (layer === 0 ? 0.1 : layer === 1 ? 0.16 : 0.24) + Math.random() * 0.1
    d.layer = layer
    d.phase = Math.random() * Math.PI * 2
  }

  const off = document.createElement('canvas')
  const offCtx = off.getContext('2d', { alpha: true })

  // 用品牌薄荷/主题 accent 做光点；解析失败退回 hsla
  const tint = accent.startsWith('#') ? accent.slice(0, 7) : '#2dd4a8'
  const sprite = makeTintSprite(tint, dpr)

  const resize = () => {
    w = window.innerWidth
    h = window.innerHeight
    canvas.width = Math.floor(w * dpr)
    canvas.height = Math.floor(h * dpr)
    canvas.style.width = `${w}px`
    canvas.style.height = `${h}px`
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    if (offCtx) {
      off.width = Math.floor(w * dpr)
      off.height = Math.floor(h * dpr)
      offCtx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }
    // 上限约 28，启动阶段足够热闹又不抢标
    const next = Math.min(POOL, Math.max(12, Math.floor((w * h) / 52000)))
    if (next > count) {
      for (let i = count; i < next; i++) initDot(dots[i], i % 3)
    }
    count = next
  }

  /** drawImage 版绘制：sprite 缩放 + 呼吸透明度（上下文已按 dpr 缩放，尺寸用 CSS px） */
  const paintDot = (g: CanvasRenderingContext2D, d: Dot, t: number) => {
    const breath = 1 + Math.sin(t * 1.2 + d.phase) * 0.1
    const r = d.r * breath
    const alpha = d.a * (0.9 + Math.sin(t + d.phase) * 0.1)
    const s = r * 2
    g.globalAlpha = Math.min(1, alpha + 0.18)
    g.drawImage(sprite, d.x - s / 2, d.y - s / 2, s, s)
  }

  let t = 0
  const step = () => {
    if (!alive || !running) return
    t += 0.016
    for (let i = 0; i < count; i++) {
      const d = dots[i]
      d.x += d.vx
      d.y += d.vy
      if (d.x < -d.r) d.x = w + d.r
      if (d.x > w + d.r) d.x = -d.r
      if (d.y < -d.r * 2) {
        d.y = h + d.r
        d.x = Math.random() * w
      }
    }

    if (offCtx) {
      offCtx.clearRect(0, 0, w, h)
      offCtx.globalCompositeOperation = 'lighter'
      for (let i = 0; i < count; i++) paintDot(offCtx, dots[i], t)
      offCtx.globalAlpha = 1
      offCtx.globalCompositeOperation = 'source-over'

      ctx.clearRect(0, 0, w, h)
      ctx.save()
      ctx.filter = 'blur(12px)'
      ctx.globalAlpha = 0.6
      ctx.drawImage(off, 0, 0, w, h)
      ctx.restore()
      ctx.save()
      ctx.globalCompositeOperation = 'lighter'
      ctx.globalAlpha = 0.9
      ctx.filter = 'blur(0.4px)'
      ctx.drawImage(off, 0, 0, w, h)
      ctx.restore()
    } else {
      ctx.clearRect(0, 0, w, h)
      for (let i = 0; i < count; i++) paintDot(ctx, dots[i], t)
      ctx.globalAlpha = 1
    }
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
    off.width = 0
    off.height = 0
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
