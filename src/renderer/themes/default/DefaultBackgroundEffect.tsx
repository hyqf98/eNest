import { useEffect, useRef, useState } from 'react'
import type { ResolvedBackgroundEffect } from '@shared/backgroundEffects'
import { startBackgroundEffect } from '@renderer/background/backgroundEffect'
import type { AnimationLevel, BackgroundConfig } from '@shared/types/plugin'
import { useReducedMotion } from '@renderer/hooks/useReducedMotion'
import { backgroundAtmosphereStyle, backgroundAtmosphereWashStyle } from '@renderer/components/backgroundAtmosphere'
import '@renderer/styles/backgroundEffect.css'

interface Props {
  level: AnimationLevel
  background?: BackgroundConfig | null
  effect: ResolvedBackgroundEffect
  className?: string
  launch?: boolean
  paused?: boolean
}

/** Each effect owns a fresh canvas, including React StrictMode's setup/cleanup cycle. */
export function DefaultBackgroundEffect({ effect, level, background, className = '', launch = false, paused = false }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const reducedMotion = useReducedMotion()
  const atmosphere = backgroundAtmosphereStyle(background)
  const [failed, setFailed] = useState(false)
  const staticVideo = paused || reducedMotion || level === 'low'
  const preset = effect.renderer === 'preset' ? effect.preset : undefined
  const speed = effect.renderer === 'preset' ? effect.speed : undefined
  const [color0, color1, color2] = effect.renderer === 'preset' ? effect.colors ?? [] : []
  const videoSource = effect.renderer === 'video' ? effect.video : undefined
  const videoPoster = effect.renderer === 'video' ? effect.poster : undefined
  useEffect(() => { setFailed(false) }, [videoSource, videoPoster])

  useEffect(() => {
    setFailed(false)
    const container = containerRef.current
    if (!container || !preset || paused) return
    const canvas = document.createElement('canvas')
    canvas.setAttribute('aria-hidden', 'true')
    container.appendChild(canvas)
    const stop = startBackgroundEffect(canvas, {
      preset, level, launch, reducedMotion,
      colors: color0 && color1 && color2 ? [color0, color1, color2] : undefined,
      speed, onError: () => setFailed(true),
    })
    return () => { stop(); canvas.remove() }
  // Registry/theme refreshes recreate descriptors; only rendering inputs own GPU lifetime.
  }, [preset, color0, color1, color2, speed, level, launch, reducedMotion, paused])

  useEffect(() => {
    const video = videoRef.current
    if (!video || !videoSource || staticVideo) return
    setFailed(false)
    let disposed = false
    let mediaFailed = false
    let focused = document.hasFocus()
    const releaseSource = () => {
      video.pause()
      video.removeAttribute('src')
      video.load()
    }
    const fail = () => {
      if (disposed || mediaFailed) return
      mediaFailed = true
      releaseSource()
      setFailed(true)
    }
    const sync = () => {
      if (disposed || mediaFailed) return
      if (document.hidden || !focused) video.pause()
      else void video.play().catch((error: unknown) => {
        // Pausing can reject an outstanding play; autoplay denial keeps the poster.
        const name = error && typeof error === 'object' && 'name' in error ? error.name : ''
        if (name !== 'AbortError' && name !== 'NotAllowedError') fail()
      })
    }
    const focus = () => { focused = true; sync() }
    const blur = () => { focused = false; sync() }
    video.addEventListener('loadeddata', sync)
    video.addEventListener('error', fail)
    document.addEventListener('visibilitychange', sync)
    window.addEventListener('focus', focus)
    window.addEventListener('blur', blur)
    video.src = videoSource
    sync()
    return () => {
      disposed = true
      video.removeEventListener('loadeddata', sync)
      video.removeEventListener('error', fail)
      document.removeEventListener('visibilitychange', sync)
      window.removeEventListener('focus', focus)
      window.removeEventListener('blur', blur)
      releaseSource()
    }
  }, [videoSource, videoPoster, staticVideo])

  return <div ref={containerRef} className={`background-effect ${className}${failed ? ' background-effect--fallback' : ''}`}
    data-background-effect={effect.id} aria-hidden>
    {effect.renderer === 'video' && (staticVideo
      ? effect.poster && <img src={effect.poster} alt="" draggable={false}
          style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block', visibility: failed ? 'hidden' : undefined }}
          onError={() => setFailed(true)} />
      : <video ref={videoRef} key={effect.video} poster={effect.poster} muted loop playsInline preload="auto" />)}
    {atmosphere && <>
      <div className="background-atmosphere-wash" style={backgroundAtmosphereWashStyle(atmosphere)} />
      <div className="background-atmosphere background-atmosphere--blend" style={atmosphere} />
    </>}
  </div>
}
