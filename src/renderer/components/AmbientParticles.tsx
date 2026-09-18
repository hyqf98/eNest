/**
 * AmbientParticles — 高动画强度下的背景粒子层
 * 仅 data-anim="high" 挂载；pointer-events: none。
 *
 * 视觉：深度分层 + 指针视差漂移 + 软弹性圆碰撞 + 两遍模糊加色发光。
 * 性能：
 *   - 粒子上限 40、dpr≤2、document.hidden 时暂停 RAF、O(n²) 碰撞可承受；
 *   - 渐变 sprite 预渲染：radial gradient 只在启动/resize 时按色相桶绘制到离屏
 *     canvas，每帧 drawImage，消除逐帧 createRadialGradient 的 GC 压力；
 *   - 粒子对象池：按最大数量预分配，resize 增减只复用/重置字段，不重建数组。
 * 依赖：useAnimationLevelStore、ambient.css。
 */
import { useEffect, useRef } from 'react'
import { useAnimationLevelStore } from '@renderer/hooks/useAnimationLevel'
import '@renderer/styles/ambient.css'

/** 硬上限：视口再大也不超过 40 个粒子 */
const MAX_PARTICLES = 40

/** 对象池固定按上限预分配 */
const POOL_SIZE = MAX_PARTICLES

/** 深度层：0 远景小而慢，2 近景大而快 */
const LAYER_COUNT = 3

/** 渐变 sprite：按色相桶缓存（离屏 canvas，绘制一次反复 drawImage） */
interface HueSprite {
  canvas: HTMLCanvasElement
  /** sprite 逻辑半径（css px），drawImage 时按粒子半径缩放 */
  radius: number
}

/** 最大气泡半径（spawn 上界：layer2 = 14 + 22 = 36，呼吸 +8%）再加安全余量 */
const SPRITE_RADIUS = 42

/** 色相桶宽：140° 色域切成 8 桶，视觉无差且 sprite 数量可控 */
const HUE_BUCKETS = 8
const HUE_MIN = 160
const HUE_SPAN = 140

/** 预渲染一个色相桶的径向渐变 sprite（中心高亮 → 边缘透明） */
function makeHueSprite(hue: number, dpr: number): HueSprite {
  const size = Math.ceil(SPRITE_RADIUS * 2 * dpr)
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const g = canvas.getContext('2d', { alpha: true })
  if (g) {
    // 与逐帧渐变同构：高光偏左上（-0.35r），三段色阶
    const cx = SPRITE_RADIUS * dpr
    const cy = SPRITE_RADIUS * dpr
    const r = SPRITE_RADIUS * dpr
    const grad = g.createRadialGradient(
      cx - r * 0.35,
      cy - r * 0.35,
      r * 0.08,
      cx,
      cy,
      r,
    )
    // alpha 峰值 1（粒子 alpha 通过 globalAlpha 控制叠加）
    grad.addColorStop(0, `hsla(${hue}, 85%, 78%, 1)`)
    grad.addColorStop(0.45, `hsla(${hue}, 72%, 62%, 0.65)`)
    grad.addColorStop(1, `hsla(${hue}, 60%, 50%, 0)`)
    g.fillStyle = grad
    g.fillRect(0, 0, size, size)
  }
  return { canvas, radius: SPRITE_RADIUS }
}

interface Particle {
  x: number
  y: number
  r: number
  vx: number
  vy: number
  hue: number
  /** 色相桶索引（sprite 查表用） */
  hueBucket: number
  alpha: number
  /** 0 | 1 | 2 */
  layer: number
  /** 相位，驱动轻微呼吸 */
  phase: number
  /** 呼吸速度 */
  pulse: number
}

function layerOf(i: number): number {
  // 按序轮询三层，保证每层约 n/3
  return i % LAYER_COUNT
}

/** 就地（重）初始化一个池内粒子 */
function initParticle(p: Particle, w: number, h: number, layer: number): void {
  // 远景更小更慢更淡；近景更大更快
  const sizeBase = layer === 0 ? 4 : layer === 1 ? 8 : 14
  const sizeSpan = layer === 0 ? 10 : layer === 1 ? 16 : 22
  const speed = layer === 0 ? 0.18 : layer === 1 ? 0.32 : 0.48
  const hue = HUE_MIN + Math.random() * HUE_SPAN
  p.x = Math.random() * w
  p.y = Math.random() * h
  p.r = sizeBase + Math.random() * sizeSpan
  p.vx = (Math.random() - 0.5) * speed
  p.vy = -speed * 0.35 - Math.random() * speed * 0.55
  p.hue = hue
  p.hueBucket = Math.min(HUE_BUCKETS - 1, Math.floor(((hue - HUE_MIN) / HUE_SPAN) * HUE_BUCKETS))
  p.alpha = (layer === 0 ? 0.1 : layer === 1 ? 0.16 : 0.22) + Math.random() * 0.12
  p.layer = layer
  p.phase = Math.random() * Math.PI * 2
  p.pulse = 0.4 + Math.random() * 0.8
}

/** 软弹性碰撞：重叠推开 + 速度交换（低恢复系数，避免弹飞）；只算激活粒子 */
function resolveCollisions(list: Particle[], count: number): void {
  for (let i = 0; i < count; i++) {
    const a = list[i]
    for (let j = i + 1; j < count; j++) {
      const b = list[j]
      // 远近层可碰撞，制造空间层次
      const dx = b.x - a.x
      const dy = b.y - a.y
      const min = a.r + b.r
      const dist2 = dx * dx + dy * dy
      if (dist2 <= 0 || dist2 >= min * min) continue
      const dist = Math.sqrt(dist2)
      const nx = dx / dist
      const ny = dy / dist
      // 软分离：按质量（半径）加权推开
      const total = a.r + b.r
      const push = (min - dist) * 0.12
      a.x -= nx * push * (b.r / total)
      a.y -= ny * push * (b.r / total)
      b.x += nx * push * (a.r / total)
      b.y += ny * push * (a.r / total)
      // 弹性速度交换：沿法线，恢复系数 ~0.72
      const dvx = a.vx - b.vx
      const dvy = a.vy - b.vy
      const impact = dvx * nx + dvy * ny
      if (impact <= 0) continue
      const ma = a.r * a.r
      const mb = b.r * b.r
      const inv = 1 / (ma + mb)
      const impulse = (2 * impact * 0.72) * inv
      a.vx -= impulse * mb * nx
      a.vy -= impulse * mb * ny
      b.vx += impulse * ma * nx
      b.vy += impulse * ma * ny
    }
  }
}

export function AmbientParticles() {
  const level = useAnimationLevelStore((s) => s.level)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const enabled = level === 'high'

  useEffect(() => {
    if (!enabled) return
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d', { alpha: true })
    if (!ctx) return

    let raf = 0
    let running = true
    let w = 0
    let h = 0
    let last = 0
    let time = 0
    /** 当前激活粒子数（对象池前 count 个槽位生效） */
    let count = 0

    // 对象池：按硬上限一次性预分配，resize 只改 count + 重置槽位字段
    const particles: Particle[] = Array.from({ length: POOL_SIZE }, () => ({
      x: 0, y: 0, r: 0, vx: 0, vy: 0,
      hue: 0, hueBucket: 0, alpha: 0,
      layer: 0, phase: 0, pulse: 0,
    }))

    // 指针视差：目标与当前（lerp 平滑）
    let ptrX = 0.5
    let ptrY = 0.5
    let curX = 0.5
    let curY = 0.5

    const dpr = Math.min(window.devicePixelRatio || 1, 2)

    // 两遍模糊：离屏缓冲，先 blur 再 lighter 叠 sharp
    const off = document.createElement('canvas')
    const offCtx = off.getContext('2d', { alpha: true })

    // 渐变 sprite 预渲染：HUE_BUCKETS 个色相桶，绘制一次反复 drawImage
    const sprites: HueSprite[] = []
    for (let b = 0; b < HUE_BUCKETS; b++) {
      sprites.push(makeHueSprite(HUE_MIN + ((b + 0.5) / HUE_BUCKETS) * HUE_SPAN, dpr))
    }

    const resize = () => {
      w = window.innerWidth
      h = window.innerHeight
      const pw = Math.floor(w * dpr)
      const ph = Math.floor(h * dpr)
      canvas.width = pw
      canvas.height = ph
      canvas.style.width = `${w}px`
      canvas.style.height = `${h}px`
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      if (offCtx) {
        off.width = pw
        off.height = ph
        offCtx.setTransform(dpr, 0, 0, dpr, 0, 0)
      }
      // 面积启发 + 硬上限 40
      const next = Math.min(MAX_PARTICLES, Math.max(16, Math.floor((w * h) / 36000)))
      if (next > count) {
        // 扩容：只重置新启用的槽位
        for (let i = count; i < next; i++) initParticle(particles[i], w, h, layerOf(i))
      }
      count = next
    }

    /** drawImage 版粒子绘制：sprite 缩放 + 呼吸 + 透明度（代替逐帧 createRadialGradient） */
    const drawParticle = (
      g: CanvasRenderingContext2D,
      p: Particle,
      ox: number,
      oy: number,
      t: number,
    ) => {
      const breath = 1 + Math.sin(t * p.pulse + p.phase) * 0.08
      const r = p.r * breath
      const x = p.x + ox
      const y = p.y + oy
      const a = p.alpha * (0.92 + Math.sin(t * p.pulse * 0.7 + p.phase) * 0.08)
      const sprite = sprites[p.hueBucket]
      if (!sprite) return
      // 上下文已按 dpr 缩放，绘制尺寸用 CSS px：sprite 覆盖半径 sprite.radius 的圆
      const s = r * 2
      g.globalAlpha = Math.min(1, a + 0.16)
      g.drawImage(sprite.canvas, x - s / 2, y - s / 2, s, s)
    }

    const step = (ts: number) => {
      if (!running) return
      if (!last) last = ts
      // clamp dt，后台回来不会跳帧
      const dt = Math.min(32, ts - last) / 16.67
      last = ts
      time += 0.016 * dt

      // 视差 lerp
      curX += (ptrX - curX) * 0.035 * dt
      curY += (ptrY - curY) * 0.035 * dt
      const parX = (curX - 0.5) * 28
      const parY = (curY - 0.5) * 20

      for (let i = 0; i < count; i++) {
        const p = particles[i]
        // 深度层速度缩放（近景更敏感）
        const depthScale = 0.55 + p.layer * 0.25
        p.x += p.vx * depthScale * dt
        p.y += p.vy * depthScale * dt
      }

      resolveCollisions(particles, count)

      for (let i = 0; i < count; i++) {
        const p = particles[i]
        if (p.x < p.r) {
          p.x = p.r
          p.vx = Math.abs(p.vx)
        } else if (p.x > w - p.r) {
          p.x = w - p.r
          p.vx = -Math.abs(p.vx)
        }
        // 上浮回收
        if (p.y < -p.r * 2.2) {
          p.y = h + p.r
          p.x = Math.random() * w
          const speed = p.layer === 0 ? 0.18 : p.layer === 1 ? 0.32 : 0.48
          p.vy = -speed * 0.35 - Math.random() * speed * 0.55
          p.vx = (Math.random() - 0.5) * speed
        }
        if (p.y > h + p.r * 2.2) p.y = -p.r
      }

      // —— 渲染：离屏 → blur pass + additive sharp pass ——
      if (offCtx) {
        offCtx.clearRect(0, 0, w, h)
        offCtx.globalCompositeOperation = 'lighter'
        for (let i = 0; i < count; i++) {
          const p = particles[i]
          // 远景视差弱、近景强
          const k = 0.35 + p.layer * 0.35
          drawParticle(offCtx, p, parX * k, parY * k, time)
        }
        offCtx.globalAlpha = 1
        offCtx.globalCompositeOperation = 'source-over'

        ctx.clearRect(0, 0, w, h)
        // pass 1: 大半径柔光
        ctx.save()
        ctx.filter = `blur(${10 + Math.min(6, w / 400)}px)`
        ctx.globalAlpha = 0.55
        ctx.drawImage(off, 0, 0, w, h)
        ctx.restore()
        // pass 2: 加色叠清晰核
        ctx.save()
        ctx.globalCompositeOperation = 'lighter'
        ctx.globalAlpha = 0.85
        ctx.filter = 'blur(0.5px)'
        ctx.drawImage(off, 0, 0, w, h)
        ctx.restore()
      } else {
        // 回退：直接画
        ctx.clearRect(0, 0, w, h)
        for (let i = 0; i < count; i++) {
          const p = particles[i]
          const k = 0.35 + p.layer * 0.35
          drawParticle(ctx, p, parX * k, parY * k, time)
        }
        ctx.globalAlpha = 1
      }

      raf = requestAnimationFrame(step)
    }

    const onPointerMove = (e: PointerEvent) => {
      if (!w || !h) return
      ptrX = e.clientX / w
      ptrY = e.clientY / h
    }

    const onVisibility = () => {
      if (document.hidden) {
        running = false
        cancelAnimationFrame(raf)
        last = 0
      } else if (!running) {
        running = true
        last = 0
        raf = requestAnimationFrame(step)
      }
    }

    resize()
    window.addEventListener('resize', resize)
    window.addEventListener('pointermove', onPointerMove, { passive: true })
    document.addEventListener('visibilitychange', onVisibility)
    raf = requestAnimationFrame(step)

    return () => {
      running = false
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', resize)
      window.removeEventListener('pointermove', onPointerMove)
      document.removeEventListener('visibilitychange', onVisibility)
      // 释放离屏缓冲与渐变 sprite
      off.width = 0
      off.height = 0
      for (const s of sprites) {
        s.canvas.width = 0
        s.canvas.height = 0
      }
    }
  }, [enabled])

  if (!enabled) return null

  return <canvas ref={canvasRef} className="ambient-particles" aria-hidden />
}
