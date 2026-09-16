/**
 * AppBackground — 固定底层背景媒体层
 * color 直接铺色；image/video 按 opacity + object-fit 渲染；video 静音自动循环。
 * pointer-events: none；z-index: 0；内容层在 ShellLayout 中 z-index: 1。
 * 依赖：useTheme（background）、resolveMediaSrc。
 */
import { useEffect } from 'react'
import type { BackgroundConfig } from '@shared/types/plugin'
import { resolveMediaSrc, useThemeStore } from '../hooks/useTheme'

function MediaLayer({ config }: { config: BackgroundConfig }) {
  const { src, playable, placeholder } = resolveMediaSrc(config.value)

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
        className="app-bg-media"
        src={src}
        style={{ objectFit: config.fit, opacity: config.opacity }}
        autoPlay
        muted
        loop
        playsInline
        aria-hidden
      />
    )
  }

  // image（含 GIF）
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

  useEffect(() => {
    document.documentElement.classList.toggle('has-bg-media', active)
    return () => document.documentElement.classList.remove('has-bg-media')
  }, [active])

  if (!active || !background) return null

  if (background.type === 'color') {
    return (
      <div
        className="app-bg"
        aria-hidden
        style={{ background: background.value, opacity: background.opacity }}
      />
    )
  }

  return (
    <div className="app-bg" aria-hidden>
      <MediaLayer config={background} />
    </div>
  )
}
