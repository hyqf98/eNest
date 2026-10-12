/**
 * A quiet flowing curtain: distant light trails, drifting droplets and near bokeh.
 * Sprites are painted only when the palette changes; animation reuses them.
 */
import type { AnimationLevel } from '@shared/types/plugin'

type Layer = 'trail' | 'droplet' | 'bokeh'

interface FlowParticle {
  layer: Layer
  x: number
  y: number
  width: number
  height: number
  speed: number
  opacity: number
  phase: number
  sway: number
  depth: number
}

interface AmbientFlowOptions {
  level: AnimationLevel
  launch?: boolean
}

const PROFILES = {
  low: { fps: 24, density: 0.65, speed: 0.72, parallax: 4 },
  medium: { fps: 30, density: 1, speed: 1, parallax: 7 },
  high: { fps: 30, density: 1.4, speed: 1.2, parallax: 11 },
} as const

function makeSprite(color: string, trail: boolean): HTMLCanvasElement {
  const sprite = document.createElement('canvas')
  sprite.width = 32
  sprite.height = trail ? 256 : 32
  const ctx = sprite.getContext('2d')!
  ctx.fillStyle = color
  ctx.fillRect(0, 0, sprite.width, sprite.height)
  ctx.globalCompositeOperation = 'destination-in'
  if (trail) {
    const across = ctx.createLinearGradient(0, 0, 32, 0)
    across.addColorStop(0, 'transparent')
    across.addColorStop(0.32, 'rgba(0,0,0,0.08)')
    across.addColorStop(0.48, 'rgba(0,0,0,0.9)')
    across.addColorStop(0.52, 'rgba(0,0,0,0.9)')
    across.addColorStop(0.68, 'rgba(0,0,0,0.08)')
    across.addColorStop(1, 'transparent')
    ctx.fillStyle = across
    ctx.fillRect(0, 0, 32, 256)
    const along = ctx.createLinearGradient(0, 0, 0, 256)
    along.addColorStop(0, 'transparent')
    along.addColorStop(0.38, 'rgba(0,0,0,0.35)')
    along.addColorStop(0.76, 'rgba(0,0,0,1)')
    along.addColorStop(1, 'transparent')
    ctx.fillStyle = along
  } else {
    const glow = ctx.createRadialGradient(16, 16, 0, 16, 16, 16)
    glow.addColorStop(0, 'rgba(0,0,0,1)')
    glow.addColorStop(0.24, 'rgba(0,0,0,0.9)')
    glow.addColorStop(0.58, 'rgba(0,0,0,0.25)')
    glow.addColorStop(1, 'transparent')
    ctx.fillStyle = glow
  }
  ctx.fillRect(0, 0, sprite.width, sprite.height)
  return sprite
}

export function startAmbientFlow(canvas: HTMLCanvasElement, options: AmbientFlowOptions): () => void {
  const ctx = canvas.getContext('2d', { alpha: true })
  if (!ctx) return () => undefined

  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)')
  const profile = PROFILES[options.level]
  const frameInterval = 1000 / profile.fps
  const particles: FlowParticle[] = []
  let width = 0
  let height = 0
  let top = 0
  let left = 0
  let dpr = 1
  let raf = 0
  let lastFrame = 0
  let elapsed = 0
  let disposed = false
  let pointerX = 0
  let pointerY = 0
  let targetX = 0
  let targetY = 0
  let color = ''
  let trailSprite: HTMLCanvasElement
  let dotSprite: HTMLCanvasElement

  const readColor = () => {
    const nextColor = getComputedStyle(canvas).color || '#879c96'
    if (nextColor === color) return
    color = nextColor
    trailSprite = makeSprite(color, true)
    dotSprite = makeSprite(color, false)
  }

  const resize = () => {
    const rect = canvas.getBoundingClientRect()
    top = rect.top
    left = rect.left
    const nextWidth = Math.max(1, rect.width)
    const nextHeight = Math.max(1, rect.height)
    const nextDpr = Math.min(window.devicePixelRatio || 1, 1.75)
    if (width === nextWidth && height === nextHeight && dpr === nextDpr) return
    width = nextWidth
    height = nextHeight
    dpr = nextDpr
    canvas.width = Math.round(width * dpr)
    canvas.height = Math.round(height * dpr)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    const area = Math.min(1.7, Math.max(0.6, width * height / 900_000)) * profile.density
    particles.length = 0
    for (const layer of ['trail', 'droplet', 'bokeh'] as const) {
      const count = Math.round(area * (layer === 'trail' ? 20 : layer === 'droplet' ? 42 : 6))
      for (let i = 0; i < count; i++) {
        const variation = Math.random()
        const depth = layer === 'trail' ? 0.2 : layer === 'droplet' ? 0.55 : 1
        const size = layer === 'trail' ? 5 + variation * 3 : layer === 'droplet' ? 3 + variation * 2.8 : 8 + variation * 7
        particles.push({
          layer,
          x: (i + 0.15 + Math.random() * 0.7) * width / count,
          y: Math.random() * height,
          width: size,
          height: layer === 'trail' ? 48 + variation * 100 : size,
          speed: (layer === 'trail' ? 12 + variation * 10 : layer === 'droplet' ? 22 + variation * 18 : 12 + variation * 12) * profile.speed,
          opacity: layer === 'trail' ? 0.3 + variation * 0.2 : layer === 'droplet' ? 0.36 + variation * 0.22 : 0.12 + variation * 0.1,
          phase: Math.random() * Math.PI * 2,
          sway: layer === 'trail' ? 3 : layer === 'droplet' ? 8 : 13,
          depth,
        })
      }
    }
  }

  const movePointer = (event: PointerEvent) => {
    if (event.pointerType === 'touch') return
    targetX = Math.max(-1, Math.min(1, (event.clientX - left) / width * 2 - 1))
    targetY = Math.max(-1, Math.min(1, (event.clientY - top) / height * 2 - 1))
  }
  const resetPointer = () => { targetX = 0; targetY = 0 }

  const draw = (timestamp: number) => {
    if (disposed || document.hidden || reduced.matches) return
    raf = requestAnimationFrame(draw)
    if (lastFrame && timestamp - lastFrame < frameInterval) return
    const dt = lastFrame ? Math.min((timestamp - lastFrame) / 1000, 0.08) : 0
    lastFrame = timestamp
    elapsed += dt
    const follow = 1 - Math.exp(-dt * 2.2)
    pointerX += (targetX - pointerX) * follow
    pointerY += (targetY - pointerY) * follow
    ctx.clearRect(0, 0, width, height)

    for (const particle of particles) {
      particle.y += particle.speed * dt
      if (particle.y - particle.height / 2 > height + 24) particle.y = -particle.height / 2 - 24
      const parallax = particle.depth * profile.parallax
      const x = particle.x + Math.sin(elapsed * 0.16 + particle.phase) * particle.sway - pointerX * parallax
      const y = particle.y - pointerY * parallax * 0.45
      const edgeFade = Math.min(1, Math.max(0, y / 56), Math.max(0, (height - y) / 56))
      const centerFade = options.launch
        ? 0.35 + 0.65 * Math.min(1, Math.hypot((x - width / 2) / 220, (y - height / 2) / 190))
        : 1
      ctx.globalAlpha = particle.opacity * edgeFade * centerFade
      ctx.drawImage(particle.layer === 'trail' ? trailSprite : dotSprite, x - particle.width / 2, y - particle.height / 2, particle.width, particle.height)
    }
    ctx.globalAlpha = 1
  }

  const syncActivity = () => {
    cancelAnimationFrame(raf)
    lastFrame = 0
    resetPointer()
    if (reduced.matches) ctx.clearRect(0, 0, width, height)
    if (!disposed && !document.hidden && !reduced.matches) raf = requestAnimationFrame(draw)
  }

  const paletteObserver = new MutationObserver(readColor)
  paletteObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['style', 'class', 'data-theme'],
  })
  if (canvas.parentElement && canvas.parentElement !== document.documentElement) {
    paletteObserver.observe(canvas.parentElement, { attributes: true, attributeFilter: ['style', 'class'] })
  }
  const resizeObserver = new ResizeObserver(resize)
  resizeObserver.observe(canvas)
  window.addEventListener('resize', resize)
  window.addEventListener('pointermove', movePointer, { passive: true })
  window.addEventListener('blur', resetPointer)
  document.addEventListener('pointerleave', resetPointer)
  document.addEventListener('visibilitychange', syncActivity)
  reduced.addEventListener('change', syncActivity)
  readColor()
  resize()
  syncActivity()

  return () => {
    disposed = true
    cancelAnimationFrame(raf)
    paletteObserver.disconnect()
    resizeObserver.disconnect()
    window.removeEventListener('resize', resize)
    window.removeEventListener('pointermove', movePointer)
    window.removeEventListener('blur', resetPointer)
    document.removeEventListener('pointerleave', resetPointer)
    document.removeEventListener('visibilitychange', syncActivity)
    reduced.removeEventListener('change', syncActivity)
    ctx.clearRect(0, 0, width, height)
    particles.length = 0
  }
}
