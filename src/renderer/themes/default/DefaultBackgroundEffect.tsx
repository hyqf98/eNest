import { useEffect, useRef, useState } from 'react'
import type { ResolvedBackgroundEffect } from '@shared/backgroundEffects'
import { startBackgroundEffect } from '@renderer/background/backgroundEffect'
import { bindBackgroundVideoPlayback } from '@renderer/background/videoPlayback'
import { retainBackgroundResource, type BackgroundResource } from '@renderer/background/backgroundLifetime'
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
  continuous?: boolean
}

/** Each effect owns a fresh canvas, including React StrictMode's setup/cleanup cycle. */
export function DefaultBackgroundEffect({ effect, level, background, className = '', launch = false, paused = false, continuous = true }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const posterRef = useRef<HTMLImageElement>(null)
  const resourceRef = useRef<BackgroundResource | null>(null)
  const pausedRef = useRef(paused)
  pausedRef.current = paused
  const reducedMotion = useReducedMotion()
  const atmosphere = backgroundAtmosphereStyle(background)
  const [failed, setFailed] = useState(false)
  const staticVideo = reducedMotion || level === 'low' || !continuous
  const preset = effect.renderer === 'preset' ? effect.preset : undefined
  const speed = effect.renderer === 'preset' ? effect.speed : undefined
  const [color0, color1, color2] = effect.renderer === 'preset' ? effect.colors ?? [] : []
  const videoSource = effect.renderer === 'video' ? effect.video : undefined
  const videoPoster = effect.renderer === 'video' ? effect.poster : undefined
  useEffect(() => { setFailed(false) }, [videoSource, videoPoster])

  useEffect(() => {
    setFailed(false)
    const container = containerRef.current
    if (!container || !preset) return
    let started = false
    const lifetime = retainBackgroundResource(() => {
      const canvas = document.createElement('canvas')
      canvas.setAttribute('aria-hidden', 'true')
      container.appendChild(canvas)
      setFailed(false)
      const effect = startBackgroundEffect(canvas, {
        preset, level, launch: launch && !started, reducedMotion, continuous,
        colors: color0 && color1 && color2 ? [color0, color1, color2] : undefined,
        speed, onError: () => setFailed(true),
      })
      started = true
      return { setPaused: effect.setPaused, dispose() { effect.dispose(); canvas.remove() } }
    }, { paused: pausedRef.current, retainMs: launch ? 0 : undefined })
    resourceRef.current = lifetime
    return () => { resourceRef.current = null; lifetime.dispose() }
  // Registry/theme refreshes recreate descriptors; only rendering inputs own GPU lifetime.
  }, [preset, color0, color1, color2, speed, level, launch, reducedMotion, continuous])

  useEffect(() => {
    const video = videoRef.current
    if (!video || !videoSource || staticVideo) return
    setFailed(false)
    const lifetime = retainBackgroundResource(() => {
      setFailed(false)
      const playback = bindBackgroundVideoPlayback(video, {
        enabled: true,
        onError: () => setFailed(true),
      })
      if (videoPoster) video.poster = videoPoster
      video.src = videoSource
      playback.sync()
      return { setPaused: playback.setPaused, dispose() { playback.dispose(); video.removeAttribute('poster') } }
    }, { paused: pausedRef.current, retainMs: launch ? 0 : undefined })
    resourceRef.current = lifetime
    return () => { resourceRef.current = null; lifetime.dispose() }
  }, [videoSource, videoPoster, staticVideo, launch])

  useEffect(() => {
    const image = posterRef.current
    if (!image || !videoPoster || !staticVideo) return
    const lifetime = retainBackgroundResource(() => {
      image.src = videoPoster
      return { setPaused() {}, dispose() { image.removeAttribute('src') } }
    }, { paused: pausedRef.current, retainMs: launch ? 0 : undefined })
    resourceRef.current = lifetime
    return () => { resourceRef.current = null; lifetime.dispose() }
  }, [videoSource, videoPoster, staticVideo, launch])

  useEffect(() => { resourceRef.current?.setPaused(paused) }, [paused])

  return <div ref={containerRef} className={`background-effect ${className}${failed ? ' background-effect--fallback' : ''}`}
    data-background-effect={effect.id} style={{ visibility: paused ? 'hidden' : undefined }} aria-hidden>
    {effect.renderer === 'video' && (staticVideo
      ? effect.poster && <img ref={posterRef} alt="" draggable={false}
          style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block', visibility: failed ? 'hidden' : undefined }}
          onError={() => setFailed(true)} />
      : <video ref={videoRef} key={effect.video} muted loop playsInline preload="auto" />)}
    {atmosphere && <>
      <div className="background-atmosphere-wash" style={backgroundAtmosphereWashStyle(atmosphere)} />
      <div className="background-atmosphere background-atmosphere--blend" style={atmosphere} />
    </>}
  </div>
}
