/**
 * AmbientParticles — 高动画强度下的背景气泡/粒子层
 * 仅当 root[data-anim="high"] 时挂载；轻量 canvas，随机漂浮 + 软碰撞反弹。
 * pointer-events: none；z-index 在 AppBackground 之上、内容之下由父层控制。
 * 依赖：useAnimationLevelStore。
 */
import { useEffect, useRef } from 'react'
import { useAnimationLevelStore } from '@renderer/hooks/useAnimationLevel'

interface Bubble {
  x: number
  y: number
  r: number
  vx: number
  vy: number
  hue: number
  alpha: number
}

function spawn(w: number, h: number): Bubble {
  const r = 6 + Math.random() * 28
  return {
    x: Math.random() * w,
    y: Math.random() * h,
    r,
    vx: (Math.random() - 0.5) * 0.35,
    vy: -0.12 - Math.random() * 0.28,
    hue: 200 + Math.random() * 100,
    alpha: 0.12 + Math.random() * 0.22,
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
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    let raf = 0
    let bubbles: Bubble[] = []
    let w = 0
    let h = 0
    const dpr = Math.min(window.devicePixelRatio || 1, 2)

    const resize = () => {
      w = window.innerWidth
      h = window.innerHeight
      canvas.width = Math.floor(w * dpr)
      canvas.height = Math.floor(h * dpr)
      canvas.style.width = `${w}px`
      canvas.style.height = `${h}px`
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      const count = Math.min(28, Math.max(12, Math.floor((w * h) / 48000)))
      if (bubbles.length !== count) {
        bubbles = Array.from({ length: count }, () => spawn(w, h))
      }
    }

    const step = () => {
      ctx.clearRect(0, 0, w, h)

      for (let i = 0; i < bubbles.length; i++) {
        const a = bubbles[i]
        a.x += a.vx
        a.y += a.vy

        // 软碰撞：成对推开（O(n²) 但 n≤28）
        for (let j = i + 1; j < bubbles.length; j++) {
          const b = bubbles[j]
          const dx = b.x - a.x
          const dy = b.y - a.y
          const min = a.r + b.r
          const dist2 = dx * dx + dy * dy
          if (dist2 > 0 && dist2 < min * min) {
            const dist = Math.sqrt(dist2)
            const nx = dx / dist
            const ny = dy / dist
            const overlap = (min - dist) * 0.04
            a.x -= nx * overlap
            a.y -= ny * overlap
            b.x += nx * overlap
            b.y += ny * overlap
            const dvx = a.vx - b.vx
            const dvy = a.vy - b.vy
            const impact = dvx * nx + dvy * ny
            if (impact > 0) {
              a.vx -= impact * nx * 0.5
              a.vy -= impact * ny * 0.5
              b.vx += impact * nx * 0.5
              b.vy += impact * ny * 0.5
            }
          }
        }

        // 边界反弹 / 回收上升
        if (a.x < a.r) { a.x = a.r; a.vx = Math.abs(a.vx) }
        if (a.x > w - a.r) { a.x = w - a.r; a.vx = -Math.abs(a.vx) }
        if (a.y < -a.r * 2) {
          a.y = h + a.r
          a.x = Math.random() * w
          a.vy = -0.12 - Math.random() * 0.28
        }
        if (a.y > h + a.r * 2) a.y = -a.r

        const g = ctx.createRadialGradient(a.x - a.r * 0.3, a.y - a.r * 0.3, a.r * 0.1, a.x, a.y, a.r)
        g.addColorStop(0, `hsla(${a.hue}, 80%, 72%, ${a.alpha + 0.12})`)
        g.addColorStop(0.55, `hsla(${a.hue}, 70%, 60%, ${a.alpha * 0.55})`)
        g.addColorStop(1, `hsla(${a.hue}, 60%, 50%, 0)`)
        ctx.beginPath()
        ctx.fillStyle = g
        ctx.arc(a.x, a.y, a.r, 0, Math.PI * 2)
        ctx.fill()
      }

      raf = requestAnimationFrame(step)
    }

    resize()
    window.addEventListener('resize', resize)
    raf = requestAnimationFrame(step)
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', resize)
    }
  }, [enabled])

  if (!enabled) return null

  return (
    <canvas
      ref={canvasRef}
      className="ambient-particles"
      aria-hidden
    />
  )
}
