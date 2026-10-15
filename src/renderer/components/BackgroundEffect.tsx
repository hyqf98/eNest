import { useEffect, useRef, useState } from 'react'
import type { ResolvedBackgroundEffect } from '@shared/backgroundEffects'
import { startBackgroundEffect } from '@renderer/background/backgroundEffect'
import { useAnimationLevelStore, useReducedMotion } from '@renderer/hooks/useAnimationLevel'
import { useThemeStore } from '@renderer/hooks/useTheme'
import { backgroundAtmosphereStyle } from './backgroundAtmosphere'
import '@renderer/styles/backgroundEffect.css'

interface Props {
  effect: ResolvedBackgroundEffect
  className?: string
  launch?: boolean
  paused?: boolean
}

/** Each effect owns a fresh canvas, including React StrictMode's setup/cleanup cycle. */
export function BackgroundEffect({ effect, className = '', launch = false, paused = false }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const level = useAnimationLevelStore((state) => state.level)
  const reducedMotion = useReducedMotion()
  const background = useThemeStore((state) => state.background)
  const atmosphere = backgroundAtmosphereStyle(background)
  const [failed, setFailed] = useState(false)
  const staticVideo = paused || reducedMotion || level === 'low'

  useEffect(() => {
    setFailed(false)
    const container = containerRef.current
    if (!container || effect.renderer !== 'preset' || paused) return
    const canvas = document.createElement('canvas')
    canvas.setAttribute('aria-hidden', 'true')
    container.appendChild(canvas)
    const stop = startBackgroundEffect(canvas, {
      preset: effect.preset, level, launch, reducedMotion,
      colors: effect.colors, speed: effect.speed, onError: () => setFailed(true),
    })
    return () => { stop(); canvas.remove() }
  }, [effect, level, launch, reducedMotion, paused])

  useEffect(() => {
    const video = videoRef.current
    if (!video || effect.renderer !== 'video' || staticVideo) return
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
    video.src = effect.video
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
  }, [effect, staticVideo])

  return <div ref={containerRef} className={`background-effect ${className}${failed ? ' background-effect--fallback' : ''}`}
    data-background-effect={effect.id} aria-hidden>
    {effect.renderer === 'video' && (staticVideo
      ? effect.poster && <img src={effect.poster} alt="" draggable={false}
          style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block', visibility: failed ? 'hidden' : undefined }}
          onError={() => setFailed(true)} />
      : <video ref={videoRef} key={effect.video} poster={effect.poster} muted loop playsInline preload="auto" />)}
    {atmosphere && <div className="background-atmosphere background-atmosphere--blend" style={atmosphere} />}
  </div>
}
