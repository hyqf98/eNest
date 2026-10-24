import { useEffect, useRef, useState } from 'react'
import type { BackgroundConfig } from '@shared/types/plugin'
import type { HomeResolvedAppearance } from '@shared/types/home'
import { BUILTIN_BACKGROUND_EFFECTS } from '@shared/backgroundEffects'
import { useReducedMotion } from '@renderer/hooks/useReducedMotion'
import { backgroundAtmosphereStyle } from '@renderer/components/backgroundAtmosphere'
import { DefaultBackgroundEffect } from './DefaultBackgroundEffect'

function Media({ media, paused }: { media: BackgroundConfig; paused: boolean }) {
  const videoRef = useRef<HTMLVideoElement>(null)
  useEffect(() => {
    const video = videoRef.current
    if (!video || media.type !== 'video') return
    video.src = media.value
    return () => { video.pause(); video.removeAttribute('src'); video.load() }
  }, [media.type, media.value])
  useEffect(() => {
    const video = videoRef.current
    if (!video || media.type !== 'video') return
    let focused = document.hasFocus()
    const sync = () => {
      if (paused || document.hidden || !focused) video.pause()
      else void video.play().catch(() => undefined)
    }
    const focus = () => { focused = true; sync() }
    const blur = () => { focused = false; sync() }
    sync()
    video.addEventListener('loadeddata', sync)
    document.addEventListener('visibilitychange', sync)
    window.addEventListener('focus', focus)
    window.addEventListener('blur', blur)
    return () => {
      video.removeEventListener('loadeddata', sync)
      document.removeEventListener('visibilitychange', sync)
      window.removeEventListener('focus', focus)
      window.removeEventListener('blur', blur)
      video.pause()
    }
  }, [media.type, media.value, paused])
  const style = { objectFit: media.fit, opacity: media.opacity }
  return media.type === 'video'
    ? <video ref={videoRef} className="app-bg-media" style={style} muted loop playsInline aria-hidden />
    : <img className="app-bg-media" src={media.value} style={style} alt="" draggable={false} aria-hidden />
}

/** Original eNest background engine, packaged with the default theme. */
export function DefaultThemeBackground({ appearance, paused = false, launch = false, className = 'app-bg' }: {
  appearance: HomeResolvedAppearance
  paused?: boolean
  launch?: boolean
  className?: string
}) {
  const reducedMotion = useReducedMotion()
  const [documentVisible, setDocumentVisible] = useState(!document.hidden)
  useEffect(() => {
    const sync = () => setDocumentVisible(!document.hidden)
    document.addEventListener('visibilitychange', sync)
    return () => document.removeEventListener('visibilitychange', sync)
  }, [])
  if (paused || !documentVisible) return null
  const effect = BUILTIN_BACKGROUND_EFFECTS.find(item => item.id === appearance.background.effect)
  const media = appearance.background.media
  if (effect) return <DefaultBackgroundEffect effect={{ ...effect, ...(effect.renderer === 'preset' ? { speed: appearance.background.speed } : {}) }}
    level={appearance.animation.effective} continuous={appearance.animation.continuous} background={media} launch={launch} className={className} />
  if (!media?.value || media.type === 'none') return null
  return <div className={className} aria-hidden>
    {media.type === 'color' ? <div className="app-bg-fill" style={backgroundAtmosphereStyle(media) ?? undefined} />
      : <Media media={media} paused={reducedMotion || appearance.animation.effective === 'low' || !appearance.animation.continuous} />}
  </div>
}
