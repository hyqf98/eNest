/**
 * AppBackground — 固定底层背景媒体层
 * color 直接铺色（含 CSS 渐变）；image/video 按 opacity + object-fit 渲染。
 * 三档动画均附加 AmbientParticles 流光层；并挂载 useFpsGuard（high 档 FPS 采样自动降级）。
 * pointer-events: none；z-index: 0；内容层在 ShellLayout 中 z-index: 1。
 * 依赖：useTheme（background）、resolveMediaSrc、AmbientParticles、useFpsGuard。
 */
import { useEffect, useRef } from 'react'
import type { BackgroundConfig } from '@shared/types/plugin'
import { resolveMediaSrc, useThemeStore } from '@renderer/hooks/useTheme'
import { AmbientParticles } from '@renderer/components/AmbientParticles'
import { useFpsGuard } from '@renderer/hooks/useFpsGuard'
import { useShellStore } from '@renderer/stores/shellStore'
import { backgroundColorStyle } from './backgroundColorStyle'

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
  const active = !!background && background.type !== 'none' && !!background.value
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
    document.documentElement.style.setProperty('--bg-media-opacity', String(opacity))
    return () => {
      document.documentElement.classList.remove('has-bg-media')
      document.documentElement.style.removeProperty('--bg-media-opacity')
    }
  }, [active, opacity])

  return (
    <>
      {active && background && (
        <div className="app-bg" aria-hidden>
          {background.type === 'color' ? (
            // 渐变/纯色直接写在满屏容器上，避免子元素无尺寸导致不生效
            <div
              className="app-bg-fill"
              style={{ ...backgroundColorStyle(background.value), opacity: background.opacity }}
            />
          ) : (
            <MediaLayer config={background} paused={covered} />
          )}
        </div>
      )}
      <AmbientParticles paused={covered} />
    </>
  )
}
