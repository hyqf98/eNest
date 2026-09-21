/**
 * AmbientParticles — AmbientField 环境场层（文件名保留以免破坏 import）
 * 结构性空间感：极光色带 + 三层深度星尘 + 稀疏流星 + 指针星座联动，颜色跟随主题 token。
 * 分档：high = canvas 环境场；medium = ambient.css 极轻 CSS 结构光（尘埃漂移 + 光带）；low = 无。
 * 性能：sprite 预渲染（无逐帧渐变/blur）、分层对象池 / dpr≤2 / document.hidden 暂停；pointer-events: none。
 * 依赖：useAnimationLevelStore、useThemeStore（token 变化热更新调色板）、ambient.css。
 */
import { useEffect, useRef } from 'react'
import { useAnimationLevelStore } from '@renderer/hooks/useAnimationLevel'
import { useThemeStore } from '@renderer/hooks/useTheme'
import '@renderer/styles/ambient.css'

/** 极光带 sprite 尺寸（逻辑 px，绘制时再缩放） */
const AURORA_W = 520
const AURORA_H = 260
/** 光斑/光晕 sprite 半径 */
const HALO_R = 150
/** 流星尾迹 sprite */
const METEOR_LEN = 220
const METEOR_H = 3

interface RGB {
  r: number
  g: number
  b: number
}

interface Palette {
  accent: RGB
  link: RGB
  ok: RGB
}

const FALLBACK_PALETTE: Palette = {
  accent: { r: 94, g: 106, b: 210 },
  link: { r: 123, g: 134, b: 212 },
  ok: { r: 42, g: 157, b: 118 },
}

interface Star {
  x: number
  y: number
  /** 0 远 … 1 近 */
  z: number
  r: number
  /** 闪烁相位 / 速度 */
  tw: number
  tws: number
  /** 漂移速度 px/s */
  vx: number
  vy: number
  /** 少数亮星带尺寸脉冲 */
  sparkle: boolean
}

interface Meteor {
  x: number
  y: number
  vx: number
  vy: number
  born: number
  life: number
}

function hexToRgb(hex: string): RGB | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return null
  const n = parseInt(m[1], 16)
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 }
}

function cssVarRgb(name: string, fallback: RGB): RGB {
  if (typeof window === 'undefined') return fallback
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name)
  return hexToRgb(raw) ?? fallback
}

function rgba(c: RGB, a: number): string {
  return `rgba(${c.r},${c.g},${c.b},${a})`
}

function mixTint(a: RGB, b: RGB, k: number): RGB {
  return {
    r: Math.round(a.r + (b.r - a.r) * k),
    g: Math.round(a.g + (b.g - a.g) * k),
    b: Math.round(a.b + (b.b - a.b) * k),
  }
}

/** 预渲染椭圆软光带 sprite（极光用；一次离屏，逐帧仅 drawImage） */
function makeAuroraSprite(tint: RGB, dpr: number): HTMLCanvasElement {
  const w = Math.ceil(AURORA_W * dpr)
  const h = Math.ceil(AURORA_H * dpr)
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const g = canvas.getContext('2d', { alpha: true })
  if (g) {
    g.scale(dpr, dpr)
    const cx = AURORA_W / 2
    const cy = AURORA_H / 2
    const grad = g.createRadialGradient(cx, cy, AURORA_H * 0.06, cx, cy, AURORA_H / 2)
    grad.addColorStop(0, rgba(tint, 0.5))
    grad.addColorStop(0.42, rgba(tint, 0.22))
    grad.addColorStop(1, rgba(tint, 0))
    g.fillStyle = grad
    g.save()
    g.translate(cx, cy)
    g.scale(1, AURORA_H / AURORA_W)
    g.beginPath()
    g.arc(0, 0, AURORA_W / 2, 0, Math.PI * 2)
    g.fill()
    g.restore()
  }
  return canvas
}

/** 预渲染径向光 sprite（指针光晕 / 光斑用） */
function makeHaloSprite(tint: RGB, dpr: number): HTMLCanvasElement {
  const size = Math.ceil(HALO_R * 2 * dpr)
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const g = canvas.getContext('2d', { alpha: true })
  if (g) {
    const c = HALO_R * dpr
    const grad = g.createRadialGradient(c, c, c * 0.05, c, c, c)
    grad.addColorStop(0, rgba(tint, 0.4))
    grad.addColorStop(0.4, rgba(tint, 0.14))
    grad.addColorStop(1, rgba(tint, 0))
    g.fillStyle = grad
    g.fillRect(0, 0, size, size)
  }
  return canvas
}

/** 预渲染流星尾迹 sprite（线性渐变横条，绘制时旋转） */
function makeMeteorSprite(tint: RGB, dpr: number): HTMLCanvasElement {
  const w = Math.ceil(METEOR_LEN * dpr)
  const h = Math.ceil(METEOR_H * dpr)
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const g = canvas.getContext('2d', { alpha: true })
  if (g) {
    const bright = mixTint(tint, { r: 235, g: 242, b: 255 }, 0.7)
    const grad = g.createLinearGradient(0, 0, w, 0)
    grad.addColorStop(0, rgba(bright, 0))
    grad.addColorStop(0.72, rgba(bright, 0.35))
    grad.addColorStop(1, rgba(bright, 0.95))
    g.fillStyle = grad
    g.fillRect(0, 0, w, h)
  }
  return canvas
}

function rand(min: number, max: number): number {
  return min + Math.random() * (max - min)
}

export function AmbientParticles() {
  const level = useAnimationLevelStore((s) => s.level)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const showCanvas = level === 'high'
  const showCss = level === 'medium'

  useEffect(() => {
    if (!showCanvas) return
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

    const dpr = Math.min(window.devicePixelRatio || 1, 2)

    // —— 调色板：初始读取 + 订阅主题 store 热更新（不重建循环） ——
    let palette: Palette = { ...FALLBACK_PALETTE }
    const readPalette = (): Palette => {
      palette = {
        accent: cssVarRgb('--accent', FALLBACK_PALETTE.accent),
        link: cssVarRgb('--link', FALLBACK_PALETTE.link),
        ok: cssVarRgb('--ok', FALLBACK_PALETTE.ok),
      }
      return palette
    }
    readPalette()

    let auroraA = makeAuroraSprite(palette.accent, dpr)
    let auroraB = makeAuroraSprite(mixTint(palette.link, palette.ok, 0.4), dpr)
    let halo = makeHaloSprite(palette.accent, dpr)
    let meteorSprite = makeMeteorSprite(palette.accent, dpr)
    const disposeSprites = () => {
      for (const s of [auroraA, auroraB, halo, meteorSprite]) {
        s.width = 0
        s.height = 0
      }
    }
    const rebuildSprites = () => {
      disposeSprites()
      auroraA = makeAuroraSprite(palette.accent, dpr)
      auroraB = makeAuroraSprite(mixTint(palette.link, palette.ok, 0.4), dpr)
      halo = makeHaloSprite(palette.accent, dpr)
      meteorSprite = makeMeteorSprite(palette.accent, dpr)
    }

    // —— 星尘：三层深度场（远密小 / 中 / 近疏大），个体漂移 + 独立相位闪烁 ——
    const stars: Star[] = []
    const buildStars = () => {
      stars.length = 0
      const area = (w * h) / 1_000_000
      const layers: { count: number; zBase: number; rMin: number; rMax: number; vMax: number }[] = [
        { count: Math.round(rand(78, 104) * Math.min(1.4, Math.max(0.7, area))), zBase: 0.12, rMin: 0.5, rMax: 1.05, vMax: 2.2 },
        { count: Math.round(rand(38, 54) * Math.min(1.4, Math.max(0.7, area))), zBase: 0.5, rMin: 0.85, rMax: 1.7, vMax: 5 },
        { count: Math.round(rand(16, 24) * Math.min(1.4, Math.max(0.7, area))), zBase: 0.88, rMin: 1.3, rMax: 2.3, vMax: 9 },
      ]
      for (const L of layers) {
        for (let i = 0; i < L.count; i++) {
          stars.push({
            x: Math.random() * w,
            y: Math.random() * h,
            z: L.zBase + rand(-0.08, 0.1),
            r: rand(L.rMin, L.rMax),
            tw: Math.random() * Math.PI * 2,
            tws: rand(0.4, 1.7),
            vx: rand(-L.vMax, L.vMax),
            vy: rand(-L.vMax * 0.6, L.vMax * 0.6),
            sparkle: Math.random() < 0.07,
          })
        }
      }
    }

    // —— 流星：稀疏随机 ——
    const meteors: Meteor[] = []
    let nextMeteorAt = rand(3, 8)
    const spawnMeteor = (now: number) => {
      const fromLeft = Math.random() < 0.5
      const speed = rand(680, 980)
      const ang = rand(0.38, 0.62) // 与水平夹角（rad）
      meteors.push({
        x: fromLeft ? rand(-0.1, 0.35) * w : rand(0.65, 1.1) * w,
        y: rand(0.02, 0.3) * h,
        vx: (fromLeft ? 1 : -1) * speed * Math.cos(ang),
        vy: speed * Math.sin(ang),
        born: now,
        life: rand(0.75, 1.05),
      })
    }

    // —— 指针：平滑跟随（帧率无关）+ 近邻星座连线 ——
    let ptrX = -1
    let ptrY = -1
    let curX = -1
    let curY = -1
    const POINTER_R = 150
    const LINK_R = 96
    const MAX_LINKS = 26

    const layout = () => {
      const prevW = w
      const prevH = h
      w = window.innerWidth
      h = window.innerHeight
      canvas.width = Math.floor(w * dpr)
      canvas.height = Math.floor(h * dpr)
      canvas.style.width = `${w}px`
      canvas.style.height = `${h}px`
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      if (prevW !== w || prevH !== h) buildStars()
    }

    // —— 星尘绘制缓冲（按星数分配，帧间复用避免 GC） ——
    let pxArr = new Float32Array(0)
    let pyArr = new Float32Array(0)
    let alphaArr = new Float32Array(0)
    let radiusArr = new Float32Array(0)
    const ensureBuffers = () => {
      if (pxArr.length !== stars.length) {
        pxArr = new Float32Array(stars.length)
        pyArr = new Float32Array(stars.length)
        alphaArr = new Float32Array(stars.length)
        radiusArr = new Float32Array(stars.length)
      }
    }

    const step = (ts: number) => {
      if (!running) return
      if (!last) last = ts
      const dt = Math.min(48, ts - last) / 1000
      last = ts
      time += dt

      ctx.clearRect(0, 0, w, h)

      // —— 极光带：两条斜置软光带，缓慢漂移 + 呼吸（lighter 叠加） ——
      ctx.globalCompositeOperation = 'lighter'
      const bandA = {
        x: w * 0.42 + Math.sin(time * 0.05) * w * 0.16,
        y: h * 0.3 + Math.cos(time * 0.041) * h * 0.08,
        rot: -0.3 + Math.sin(time * 0.03) * 0.05,
        a: 0.075 + Math.sin(time * 0.11) * 0.028,
      }
      const bandB = {
        x: w * 0.6 + Math.cos(time * 0.037 + 2) * w * 0.15,
        y: h * 0.66 + Math.sin(time * 0.048 + 1) * h * 0.09,
        rot: 0.24 + Math.cos(time * 0.026 + 1) * 0.05,
        a: 0.062 + Math.sin(time * 0.09 + 2.4) * 0.024,
      }
      const drawBand = (
        b: { x: number; y: number; rot: number; a: number },
        sprite: HTMLCanvasElement,
        scale: number,
      ) => {
        ctx.save()
        ctx.translate(b.x, b.y)
        ctx.rotate(b.rot)
        const bw = w * scale
        const bh = bw * (AURORA_H / AURORA_W)
        ctx.globalAlpha = b.a
        ctx.drawImage(sprite, -bw / 2, -bh / 2, bw, bh)
        ctx.restore()
      }
      drawBand(bandA, auroraA, 1.15)
      drawBand(bandB, auroraB, 0.95)

      // —— 指针光晕（平滑趋近，稳态滞后可接受） ——
      if (ptrX >= 0) {
        if (curX < 0) {
          curX = ptrX
          curY = ptrY
        } else {
          const k = 1 - Math.exp(-6 * dt)
          curX += (ptrX - curX) * k
          curY += (ptrY - curY) * k
        }
        const haloSize = HALO_R * 2 * (0.94 + Math.sin(time * 1.3) * 0.06)
        ctx.globalAlpha = 0.1
        ctx.drawImage(halo, curX - haloSize / 2, curY - haloSize / 2, haloSize, haloSize)
      }

      // —— 星尘：漂移 + 独立闪烁 + 深度视差 + 指针抬升 ——
      ensureBuffers()
      const parX = ptrX >= 0 ? (curX / w - 0.5) : 0
      const parY = ptrY >= 0 ? (curY / h - 0.5) : 0
      // 按色相分组暂存索引，减少 fillStyle 切换
      const groups: number[][] = [[], [], []]
      for (let i = 0; i < stars.length; i++) {
        const s = stars[i]
        s.x += s.vx * dt
        s.y += s.vy * dt
        if (s.x < -8) s.x += w + 16
        else if (s.x > w + 8) s.x -= w + 16
        if (s.y < -8) s.y += h + 16
        else if (s.y > h + 8) s.y -= h + 16

        const twk = 0.55 + 0.45 * Math.sin(time * s.tws + s.tw)
        const px = s.x + parX * 18 * s.z
        let py = s.y + parY * 12 * s.z

        let bright = 0
        if (ptrX >= 0) {
          const dx = curX - px
          const dyy = curY - py
          const d2 = dx * dx + dyy * dyy
          if (d2 < POINTER_R * POINTER_R) {
            const sq = 1 - d2 / (POINTER_R * POINTER_R)
            bright = sq * sq * 0.5
            py -= sq * sq * 10
          }
        }
        const lift = s.sparkle ? 1 + 0.5 * twk : 1
        pxArr[i] = px
        pyArr[i] = py
        alphaArr[i] = Math.min(0.85, (0.1 + s.z * 0.3) * twk + bright)
        radiusArr[i] = (s.r + bright * 1.3) * lift
        groups[i % 3].push(i)
      }
      const tints: RGB[] = [palette.accent, palette.link, palette.ok]
      for (let gi = 0; gi < 3; gi++) {
        ctx.fillStyle = rgba(tints[gi], 1)
        for (const idx of groups[gi]) {
          ctx.globalAlpha = alphaArr[idx]
          ctx.beginPath()
          ctx.arc(pxArr[idx], pyArr[idx], radiusArr[idx], 0, Math.PI * 2)
          ctx.fill()
        }
      }

      // —— 指针星座连线：光晕内的星彼此稀疏连线 ——
      if (ptrX >= 0) {
        const near: number[] = []
        for (let i = 0; i < stars.length && near.length < 40; i++) {
          const dx = curX - pxArr[i]
          const dy2 = curY - pyArr[i]
          if (dx * dx + dy2 * dy2 < POINTER_R * POINTER_R) near.push(i)
        }
        ctx.strokeStyle = rgba(palette.link, 1)
        ctx.lineWidth = 0.6
        let links = 0
        for (let a = 0; a < near.length && links < MAX_LINKS; a++) {
          for (let b = a + 1; b < near.length && links < MAX_LINKS; b++) {
            const dx = pxArr[near[b]] - pxArr[near[a]]
            const dy3 = pyArr[near[b]] - pyArr[near[a]]
            const d2 = dx * dx + dy3 * dy3
            if (d2 > LINK_R * LINK_R) continue
            const t = 1 - Math.sqrt(d2) / LINK_R
            ctx.globalAlpha = t * 0.2
            ctx.beginPath()
            ctx.moveTo(pxArr[near[a]], pyArr[near[a]])
            ctx.lineTo(pxArr[near[b]], pyArr[near[b]])
            ctx.stroke()
            links++
          }
        }
      }

      // —— 流星：稀疏划过，正弦包络淡入淡出 ——
      if (time >= nextMeteorAt) {
        spawnMeteor(time)
        nextMeteorAt = time + rand(7, 15)
      }
      for (let i = meteors.length - 1; i >= 0; i--) {
        const m = meteors[i]
        const age = time - m.born
        if (age > m.life) {
          meteors.splice(i, 1)
          continue
        }
        m.x += m.vx * dt
        m.y += m.vy * dt
        const p = age / m.life
        const envelope = Math.sin(Math.PI * Math.min(1, p))
        const ang = Math.atan2(m.vy, m.vx)
        ctx.save()
        ctx.translate(m.x, m.y)
        ctx.rotate(ang)
        ctx.globalAlpha = 0.55 * envelope
        const mw = METEOR_LEN * (0.7 + 0.3 * envelope)
        ctx.drawImage(meteorSprite, -mw, -METEOR_H / 2, mw, METEOR_H)
        ctx.restore()
      }

      ctx.globalAlpha = 1
      ctx.globalCompositeOperation = 'source-over'
      raf = requestAnimationFrame(step)
    }

    const onPointerMove = (e: PointerEvent) => {
      ptrX = e.clientX
      ptrY = e.clientY
    }
    const onPointerLeave = () => {
      ptrX = -1
      ptrY = -1
      curX = -1
      curY = -1
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

    // 主题 token 变化：仅热更新调色板与 sprite，不打断循环
    let unsubTheme: (() => void) | undefined
    try {
      unsubTheme = useThemeStore.subscribe(() => {
        const prev = palette
        const next = readPalette()
        const changed =
          next.accent.r !== prev.accent.r || next.accent.g !== prev.accent.g || next.accent.b !== prev.accent.b ||
          next.link.r !== prev.link.r || next.link.g !== prev.link.g || next.link.b !== prev.link.b ||
          next.ok.r !== prev.ok.r || next.ok.g !== prev.ok.g || next.ok.b !== prev.ok.b
        if (changed) rebuildSprites()
      })
    } catch {
      /* store 未就绪时跳过热更新 */
    }

    layout()
    window.addEventListener('resize', layout)
    window.addEventListener('pointermove', onPointerMove, { passive: true })
    document.addEventListener('pointerleave', onPointerLeave)
    document.addEventListener('visibilitychange', onVisibility)
    raf = requestAnimationFrame(step)

    return () => {
      running = false
      cancelAnimationFrame(raf)
      unsubTheme?.()
      window.removeEventListener('resize', layout)
      window.removeEventListener('pointermove', onPointerMove)
      document.removeEventListener('pointerleave', onPointerLeave)
      document.removeEventListener('visibilitychange', onVisibility)
      disposeSprites()
    }
  }, [showCanvas])

  if (showCanvas) {
    return <canvas ref={canvasRef} className="ambient-particles ambient-field-canvas" aria-hidden />
  }

  if (showCss) {
    return (
      <div className="ambient-particles ambient-field-css" aria-hidden>
        <span className="ambient-ribbon ambient-ribbon-a" />
        <span className="ambient-ribbon ambient-ribbon-b" />
        <span className="ambient-dust" />
        <span className="ambient-field-orb ambient-field-orb-a" />
        <span className="ambient-field-orb ambient-field-orb-b" />
        <span className="ambient-field-orb ambient-field-orb-c" />
      </div>
    )
  }

  return null
}
