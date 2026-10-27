import type { AnimationLevel } from '@shared/types/plugin'
import { parseThemeColor } from '@shared/theme/colors'
import { BACKGROUND_FRAGMENT_SHADER, BACKGROUND_VERTEX_SHADER } from './shaders'
import type { BackgroundResource } from './backgroundLifetime'

export type BackgroundEffectPreset = 'fold' | 'aurora' | 'orbit' | 'ripple' | 'tunnel'

export interface BackgroundEffectOptions {
  preset: BackgroundEffectPreset
  level: AnimationLevel
  launch?: boolean
  reducedMotion?: boolean
  continuous?: boolean
  /** Optional declarative palette: shadow, body and highlight. No plugin code is executed. */
  colors?: readonly string[]
  speed?: number
  onError?: () => void
}

const PRESETS: Record<BackgroundEffectPreset, number> = {
  fold: 0, aurora: 1, orbit: 2, ripple: 3, tunnel: 4,
}

const QUALITY = {
  low: { fps: 12, ratio: 0.85, pixels: 360_000 },
  medium: { fps: 30, ratio: 1.25, pixels: 1_200_000 },
  high: { fps: 60, ratio: 1.5, pixels: 2_100_000 },
} as const

/**
 * Owns one canvas and its GPU resources. Mount a fresh canvas after disposal.
 * Theme values are cached and refreshed on root attribute changes, never per frame.
 */
export function startBackgroundEffect(
  canvas: HTMLCanvasElement,
  options: BackgroundEffectOptions,
): BackgroundResource {
  const quality = QUALITY[options.level]
  const animate = quality.fps > 0 && !options.reducedMotion
    && (options.launch || (options.level !== 'low' && options.continuous !== false))
  const requestedSpeed = Number.isFinite(options.speed) ? Math.max(0.2, Math.min(2.5, options.speed!)) : 1
  // Steady low is static; the finite launch reveal keeps the requested speed.
  const speed = requestedSpeed
  // 低档开屏生命周期约 1.1s（splashMotion），揭示必须在这个窗口内走完；其它场景保持 2.1s 从容展开。
  const revealDuration = options.launch && options.level === 'low' ? 0.88 : 2.1
  const root = document.documentElement
  let gl: WebGLRenderingContext | null = null
  let program: WebGLProgram | null = null
  let buffer: WebGLBuffer | null = null
  const shaders: WebGLShader[] = []
  let resizeObserver: ResizeObserver | null = null
  let themeObserver: MutationObserver | null = null
  let disposed = false
  let paused = false
  let initialized = false
  let initializing = false
  let initializationFrame = 0
  let compilationTimer: ReturnType<typeof setTimeout> | undefined
  let compilationTimeout: ReturnType<typeof setTimeout> | undefined
  let compilationDeadline = 0
  let pollCompilation: (() => void) | undefined
  let frame = 0
  let focused = document.hasFocus()
  let rect = canvas.getBoundingClientRect()
  let width = 1
  let height = 1
  let maxDimension = 4096
  let drawable = false
  let lastFrame = 0
  let nextFrame = 0
  let elapsed = options.launch && animate ? 0 : 2.5
  let age = options.launch && animate ? 0 : 3
  let pointerX = 0
  let pointerY = 0
  let targetX = 0
  let targetY = 0
  let uniforms: Record<string, WebGLUniformLocation | null> = {}

  const stop = (): void => {
    if (frame) cancelAnimationFrame(frame)
    frame = 0
    lastFrame = 0
    nextFrame = 0
  }

  const dispose = (): void => {
    if (disposed) return
    disposed = true
    stop()
    cancelAnimationFrame(initializationFrame)
    clearTimeout(compilationTimer)
    clearTimeout(compilationTimeout)
    pollCompilation = undefined
    resizeObserver?.disconnect()
    themeObserver?.disconnect()
    document.removeEventListener('visibilitychange', syncActivity)
    window.removeEventListener('focus', onFocus)
    window.removeEventListener('blur', onBlur)
    window.removeEventListener('pointermove', onPointerMove)
    window.removeEventListener('pointerout', onPointerOut)
    canvas.removeEventListener('webglcontextlost', onContextLost)
    if (gl) {
      gl.useProgram(null)
      gl.bindBuffer(gl.ARRAY_BUFFER, null)
      if (buffer) gl.deleteBuffer(buffer)
      if (program) gl.deleteProgram(program)
      for (const shader of shaders) gl.deleteShader(shader)
      if (!gl.isContextLost()) gl.getExtension('WEBGL_lose_context')?.loseContext()
    }
    uniforms = {}
    buffer = null
    program = null
    gl = null
  }

  const fail = (): void => {
    if (disposed) return
    dispose()
    options.onError?.()
  }

  function onContextLost(): void {
    // A lost context hands control to the component's static fallback.
    fail()
  }

  function draw(): void {
    if (disposed || paused || document.hidden || !initialized || !gl || !drawable) return
    const reveal = Math.max(0, Math.min(1, (age - 0.12) / revealDuration))
    gl.uniform2f(uniforms.pointer, pointerX, pointerY)
    gl.uniform1f(uniforms.time, elapsed)
    gl.uniform1f(uniforms.opening, 1 - Math.pow(1 - reveal, 3))
    gl.drawArrays(gl.TRIANGLES, 0, 6)
  }

  function tick(now: number): void {
    frame = 0
    if (disposed || paused || document.hidden || !focused || !drawable) return
    const interval = 1000 / quality.fps
    if (!lastFrame || now + 0.5 >= nextFrame) {
      // Suspend elapsed time while hidden; a restored window never jumps ahead.
      const dt = Math.min((lastFrame ? now - lastFrame : interval) / 1000, 0.1)
      lastFrame = now
      nextFrame = now + interval - (nextFrame ? Math.max(0, now - nextFrame) % interval : 0)
      elapsed += dt * speed
      age += dt
      const approach = 1 - Math.exp(-dt * 5)
      pointerX += (targetX - pointerX) * approach
      pointerY += (targetY - pointerY) * approach
      draw()
    }
    if (!disposed) frame = requestAnimationFrame(tick)
  }

  function syncActivity(): void {
    if (disposed) return
    if (paused || document.hidden || !focused || !drawable || !initialized) {
      stop()
      return
    }
    if (!frame && animate) frame = requestAnimationFrame(tick)
    else if (!animate) draw()
  }

  function onFocus(): void {
    focused = true
    syncActivity()
  }

  function onBlur(): void {
    focused = false
    stop()
  }

  function onPointerMove(event: PointerEvent): void {
    if (paused || !drawable || document.hidden || !focused) return
    targetX = Math.max(-0.5, Math.min(0.5, (event.clientX - rect.left) / rect.width - 0.5))
    targetY = Math.max(-0.5, Math.min(0.5, 0.5 - (event.clientY - rect.top) / rect.height))
  }

  function onPointerOut(event: PointerEvent): void {
    if (event.relatedTarget !== null) return
    targetX = targetY = 0
  }

  function resize(): void {
    if (disposed || !gl) return
    rect = canvas.getBoundingClientRect()
    drawable = rect.width > 0 && rect.height > 0
    if (!drawable) {
      stop()
      return
    }
    const ratio = Math.min(
      window.devicePixelRatio || 1,
      quality.ratio,
      Math.sqrt(quality.pixels / (rect.width * rect.height)),
      maxDimension / rect.width,
      maxDimension / rect.height,
    )
    width = Math.max(1, Math.floor(rect.width * ratio))
    height = Math.max(1, Math.floor(rect.height * ratio))
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width
      canvas.height = height
      gl.viewport(0, 0, width, height)
    }
    gl.uniform2f(uniforms.resolution, width, height)
    if (!document.hidden) draw()
    syncActivity()
  }

  function refreshTheme(): void {
    if (disposed || !gl) return
    const raw = getComputedStyle(root).getPropertyValue('--bg')
    const fallback = root.dataset.theme === 'dark' ? '#17191b' : '#f6f6f4'
    const parsed = parseThemeColor(raw) ?? parseThemeColor(fallback)!
    const rgb = parsed.slice(0, 3).map((channel) => channel / 255)
    const luminance = rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722
    gl.uniform3f(uniforms.baseColor, rgb[0], rgb[1], rgb[2])
    gl.uniform1f(uniforms.lightTheme, luminance >= 0.5 ? 1 : 0)
    if (!document.hidden) draw()
  }

  function completeInitialization(): void {
    if (disposed || !gl || !program) return
    clearTimeout(compilationTimeout)
    pollCompilation = undefined
    try {
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error('Background program linking failed')
      gl.useProgram(program)
      buffer = gl.createBuffer()
      if (!buffer) throw new Error('Background buffer allocation failed')
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW)
      const position = gl.getAttribLocation(program, 'position')
      if (position < 0) throw new Error('Background vertex attribute unavailable')
      gl.enableVertexAttribArray(position)
      gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0)
      uniforms = Object.fromEntries([
        'resolution', 'pointer', 'time', 'opening', 'baseColor',
        'palette0', 'palette1', 'palette2', 'customPalette', 'lightTheme',
      ].map((key) => [key, gl!.getUniformLocation(program!, key)]))
      const palette = options.colors?.slice(0, 3).map(parseThemeColor)
      const validPalette = palette?.length === 3 && palette.every(Boolean)
      gl.uniform1f(uniforms.customPalette, validPalette ? 1 : 0)
      if (validPalette) {
        palette.forEach((color, index) => {
          gl!.uniform3f(uniforms[`palette${index}`], color![0] / 255, color![1] / 255, color![2] / 255)
        })
      }
      initialized = true
      focused = document.hasFocus()
      refreshTheme()
      resize()
      canvas.style.visibility = ''
      resizeObserver = new ResizeObserver(resize)
      resizeObserver.observe(canvas)
      themeObserver = new MutationObserver(refreshTheme)
      themeObserver.observe(root, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] })
      document.addEventListener('visibilitychange', syncActivity)
      window.addEventListener('focus', onFocus)
      window.addEventListener('blur', onBlur)
      if (animate && options.level !== 'low') {
        window.addEventListener('pointermove', onPointerMove, { passive: true })
        window.addEventListener('pointerout', onPointerOut, { passive: true })
      }
    } catch { fail() }
  }

  function initialize(): void {
    initializationFrame = 0
    if (disposed || paused || document.hidden || initializing) return
    initializing = true
    try {
      gl = canvas.getContext('webgl', {
        alpha: false,
        antialias: false,
        depth: false,
        stencil: false,
        preserveDrawingBuffer: false,
        powerPreference: 'low-power',
      })
      if (!gl || gl.isContextLost()) throw new Error('Background WebGL unavailable')
      maxDimension = Math.min(4096, gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) as number)
      const parallel = gl.getExtension('KHR_parallel_shader_compile')
      canvas.addEventListener('webglcontextlost', onContextLost)
      const compile = (type: number, source: string): WebGLShader => {
        const shader = gl!.createShader(type)
        if (!shader) throw new Error('Background shader allocation failed')
        shaders.push(shader)
        gl!.shaderSource(shader, source)
        gl!.compileShader(shader)
        return shader
      }
      // Constant mode lets the driver prune the four unused material functions.
      const fragment = BACKGROUND_FRAGMENT_SHADER.replace(
        'uniform float time,opening;',
        `uniform float time,opening; const float mode=${PRESETS[options.preset]}.0;`,
      )
      const vertexShader = compile(gl.VERTEX_SHADER, BACKGROUND_VERTEX_SHADER)
      const fragmentShader = compile(gl.FRAGMENT_SHADER, fragment)
      program = gl.createProgram()
      if (!program) throw new Error('Background program allocation failed')
      gl.attachShader(program, vertexShader)
      gl.attachShader(program, fragmentShader)
      gl.linkProgram(program)
      // Submit both shaders and linking before any status query. Completion polling
      // avoids waiting on the driver where KHR_parallel_shader_compile is available.
      if (parallel) {
        // Hidden surfaces stop polling, but cannot keep an unfinished program
        // alive beyond the same bounded initialization window.
        compilationDeadline = performance.now() + 5_000
        compilationTimeout = setTimeout(fail, 5_000)
        pollCompilation = () => {
          compilationTimer = undefined
          if (disposed || !gl || !program) return
          if (paused || document.hidden) return
          if (performance.now() >= compilationDeadline) { fail(); return }
          if (gl.isContextLost()) { fail(); return }
          if (gl.getProgramParameter(program, parallel.COMPLETION_STATUS_KHR)) completeInitialization()
          else compilationTimer = setTimeout(pollCompilation!, 16)
        }
        compilationTimer = setTimeout(pollCompilation, 0)
      } else {
        // This status read may still block without the extension; static paint has
        // already happened, and background readiness never gates the Home handshake.
        completeInitialization()
      }
    } catch { fail() }
  }

  function scheduleInitialization(): void {
    if (disposed || initializing || initializationFrame || paused || document.hidden) return
    // A full paint opportunity also lets StrictMode clean up its discarded setup
    // before it creates a WebGL context.
    initializationFrame = requestAnimationFrame(() => {
      initializationFrame = requestAnimationFrame(initialize)
    })
  }
  canvas.style.visibility = 'hidden'
  scheduleInitialization()
  return {
    setPaused(value) {
      if (disposed) return
      paused = value
      if (paused) {
        cancelAnimationFrame(initializationFrame); initializationFrame = 0
        clearTimeout(compilationTimer); compilationTimer = undefined
        stop()
      } else {
        scheduleInitialization()
        if (pollCompilation && compilationTimer === undefined) {
          compilationTimer = setTimeout(pollCompilation, 0)
        }
        syncActivity()
      }
    },
    dispose,
  }
}
