/** Global effect and color atmosphere combine; image/video backgrounds display with effects off. */
import { useEffect, useRef } from 'react'
import type { BackgroundConfig } from '@shared/types/plugin'
import { resolveMediaSrc, useThemeStore } from '@renderer/hooks/useTheme'
import { BackgroundEffect } from '@renderer/components/BackgroundEffect'
import { useBackgroundEffect } from '@renderer/hooks/useBackgroundEffect'
import { useFpsGuard } from '@renderer/hooks/useFpsGuard'
import { useShellStore } from '@renderer/stores/shellStore'
import { backgroundAtmosphereStyle, syncBackgroundAtmosphereTheme } from './backgroundAtmosphere'

function MediaLayer({ config, paused }: { config: BackgroundConfig; paused: boolean }) {
  const { src, playable, placeholder } = resolveMediaSrc(config.value)
  const videoRef = useRef<HTMLVideoElement>(null)
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
        src={src}
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

export function AppBackground() {
  const background = useThemeStore((s) => s.background)
  const effect = useBackgroundEffect()
  const hasEffect = !!effect
  const active = !!effect || (!!background && background.type !== 'none' && !!background.value)
  const opacity = background?.opacity ?? 0.85
  const covered = useShellStore((s) => {
    if (s.view !== 'plugin' || !s.pluginReady) return false
    const tab = s.tabs.find((item) => item.id === s.activeTabId)
    return !!tab && s.plugins.find((plugin) => plugin.id === tab.pluginId)?.ui?.background !== 'transparent'
  })
  // FPS 守卫：high 档采样，连续掉帧自动降 medium（App.tsx 不必接线）
  useFpsGuard(!covered)

  useEffect(() => {
    document.documentElement.classList.toggle('has-bg-media', active)
    document.documentElement.classList.toggle('has-bg-effect', hasEffect)
  }, [active, hasEffect])

  useEffect(() => {
    document.documentElement.style.setProperty('--bg-media-opacity', String(opacity))
    syncBackgroundAtmosphereTheme(document.documentElement, background)
  }, [background, opacity])

  useEffect(() => () => {
    document.documentElement.classList.remove('has-bg-media', 'has-bg-effect')
    document.documentElement.style.removeProperty('--bg-media-opacity')
    syncBackgroundAtmosphereTheme(document.documentElement, null)
  }, [])

  return (
    <>
      {effect ? <BackgroundEffect effect={effect} paused={covered} className="app-bg" /> : active && background && (
        <div className="app-bg" aria-hidden>
          {background.type === 'color' ? (
            // 渐变/纯色直接写在满屏容器上，避免子元素无尺寸导致不生效
            <div
              className="app-bg-fill"
              style={backgroundAtmosphereStyle(background) ?? undefined}
            />
          ) : (
            <MediaLayer config={background} paused={covered} />
          )}
        </div>
      )}
    </>
  )
}
