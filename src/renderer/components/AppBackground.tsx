/** Global effect and color atmosphere combine; image/video backgrounds display with effects off. */
import { useEffect, useRef, useState } from 'react'
import type { BackgroundConfig } from '@shared/types/plugin'
import { resolveMediaSrc } from '@renderer/services/themeResources'
import { useFpsGuard } from '@renderer/hooks/useFpsGuard'
import { useShellStore } from '@renderer/stores/shellStore'
import { useAppearanceStore } from '@renderer/hooks/useAppearance'
import { useReducedMotion } from '@renderer/hooks/useAnimationLevel'
import { DefaultThemeBackground } from '@renderer/themes/default/DefaultThemeBackground'
import { BUILTIN_BACKGROUND_EFFECTS } from '@shared/backgroundEffects'

function MediaLayer({ config, paused }: { config: BackgroundConfig; paused: boolean }) {
  const { src, playable, placeholder } = resolveMediaSrc(config.value)
  const videoRef = useRef<HTMLVideoElement>(null)
  useEffect(() => {
    const video = videoRef.current
    if (!video || !playable || config.type !== 'video') return
    video.src = src
    return () => { video.pause(); video.removeAttribute('src'); video.load() }
  }, [src, playable, config.type])
  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    const syncPlayback = () => {
      if (paused || document.hidden) video.pause()
      else void video.play().catch(() => undefined)
    }
    syncPlayback()
    document.addEventListener('visibilitychange', syncPlayback)
    return () => {
      document.removeEventListener('visibilitychange', syncPlayback)
      video.pause()
    }
  }, [paused, src, playable, config.type])

  if (!playable) {
    return (
      <div className="app-bg-placeholder" aria-hidden>
        <span>
          {config.type === 'video' ? '视频' : '图片'}背景待加载
          {placeholder ? `：${placeholder.split(/[/\\]/).pop() ?? placeholder}` : ''}
        </span>
      </div>
    )
  }

  if (config.type === 'video') {
    return (
      <video
        ref={videoRef}
        className="app-bg-media"
        style={{ objectFit: config.fit, opacity: config.opacity }}
        muted
        loop
        playsInline
        aria-hidden
      />
    )
  }

  return (
    <img
      className="app-bg-media"
      src={src}
      alt=""
      style={{ objectFit: config.fit, opacity: config.opacity }}
      aria-hidden
      draggable={false}
    />
  )
}

export function AppBackground({ paused: externallyPaused = false }: { paused?: boolean }) {
  const appearance = useAppearanceStore(state => state.presentation)
  const hydrated = useAppearanceStore(state => state.hydrated)
  const reducedMotion = useReducedMotion()
  const covered = useShellStore(state => {
    if (state.view !== 'plugin' || !state.pluginReady) return false
    const tab = state.tabs.find(item => item.id === state.activeTabId)
    return !!tab && state.plugins.find(plugin => plugin.id === tab.pluginId)?.ui?.background !== 'transparent'
  })
  useFpsGuard(hydrated && !covered && !externallyPaused && appearance.animation.continuous)
  const [visible, setVisible] = useState(!document.hidden)
  useEffect(() => {
    const sync = () => setVisible(!document.hidden)
    document.addEventListener('visibilitychange', sync)
    return () => document.removeEventListener('visibilitychange', sync)
  }, [])
  const paused = externallyPaused || covered || !visible || reducedMotion || appearance.animation.effective === 'low' || !appearance.animation.continuous
  const media = appearance.background.media
  if (!hydrated) return <div className="app-bg" style={{ background: 'var(--bg)' }} aria-hidden />
  if (appearance.background.kind !== undefined || BUILTIN_BACKGROUND_EFFECTS.some(effect => effect.id === appearance.background.effect)) {
    return <DefaultThemeBackground appearance={appearance} paused={externallyPaused || covered || !visible} />
  }
  if (externallyPaused || covered || !visible) return null
  return <div className="appearance-backdrop" data-texture={appearance.background.texture}
    data-animate={!paused && appearance.background.effect !== 'none'} aria-hidden>
    {media?.type === 'color' && <div className="app-bg-fill" style={{ background: media.value, opacity: media.opacity }} />}
    {media?.value && media.type !== 'none' && media.type !== 'color' && <>
      <MediaLayer config={media} paused={paused} />
      <div className="appearance-media-veil" />
    </>}
  </div>
}
