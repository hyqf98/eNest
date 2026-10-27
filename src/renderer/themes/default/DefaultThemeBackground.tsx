import { useEffect, useRef } from 'react'
import type { BackgroundConfig } from '@shared/types/plugin'
import type { HomeResolvedAppearance } from '@shared/types/home'
import { BUILTIN_BACKGROUND_EFFECTS } from '@shared/backgroundEffects'
import { useReducedMotion } from '@renderer/hooks/useReducedMotion'
import { backgroundAtmosphereStyle } from '@renderer/components/backgroundAtmosphere'
import { retainBackgroundResource, type BackgroundResource } from '@renderer/background/backgroundLifetime'
import { bindBackgroundVideoPlayback } from '@renderer/background/videoPlayback'
import { DefaultBackgroundEffect } from './DefaultBackgroundEffect'

function Media({ media, paused, animate, launch }: { media: BackgroundConfig; paused: boolean; animate: boolean; launch: boolean }) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const imageRef = useRef<HTMLImageElement>(null)
  const resourceRef = useRef<BackgroundResource | null>(null)
  const pausedRef = useRef(paused)
  pausedRef.current = paused
  useEffect(() => {
    const video = videoRef.current
    const image = imageRef.current
    const lifetime = retainBackgroundResource(() => {
      if (video && media.type === 'video') {
        const playback = bindBackgroundVideoPlayback(video, { enabled: animate, onError: () => undefined })
        video.src = media.value
        playback.sync()
        return playback
      }
      if (image) image.src = media.value
      return { setPaused() {}, dispose() { image?.removeAttribute('src') } }
    }, { paused: pausedRef.current, retainMs: launch ? 0 : undefined })
    resourceRef.current = lifetime
    return () => { resourceRef.current = null; lifetime.dispose() }
  }, [media.type, media.value, animate, launch])
  useEffect(() => { resourceRef.current?.setPaused(paused) }, [paused])
  const style = { objectFit: media.fit, opacity: media.opacity }
  return media.type === 'video'
    ? <video ref={videoRef} className="app-bg-media" style={style} muted loop playsInline aria-hidden />
    : <img ref={imageRef} className="app-bg-media" style={style} alt="" draggable={false} aria-hidden />
}

/** Original eNest background engine, packaged with the default theme. */
export function DefaultThemeBackground({ appearance, paused = false, launch = false, className = 'app-bg' }: {
  appearance: Pick<HomeResolvedAppearance, 'theme' | 'background' | 'animation'>
  paused?: boolean
  launch?: boolean
  className?: string
}) {
  const reducedMotion = useReducedMotion()
  const identity = `${appearance.theme.source}:${appearance.theme.id}:${appearance.theme.version}`
  const effect = BUILTIN_BACKGROUND_EFFECTS.find(item => item.id === appearance.background.effect)
  const media = appearance.background.media
  if (effect) return <DefaultBackgroundEffect key={identity} effect={{ ...effect, ...(effect.renderer === 'preset' ? { speed: appearance.background.speed } : {}) }}
    level={appearance.animation.effective} continuous={appearance.animation.continuous} background={media} launch={launch} paused={paused} className={className} />
  if (!media?.value || media.type === 'none') return null
  return <div key={identity} className={className} style={{ visibility: paused ? 'hidden' : undefined }} aria-hidden>
    {media.type === 'color' ? <div className="app-bg-fill" style={backgroundAtmosphereStyle(media) ?? undefined} />
      : <Media media={media} paused={paused} launch={launch} animate={!reducedMotion && appearance.animation.effective !== 'low' && appearance.animation.continuous} />}
  </div>
}
