/**
 * AppBackground — 固定底层背景媒体层
 * color 直接铺色（含 CSS 渐变）；image/video 按 opacity + object-fit 渲染。
 * 高动画档附加 AmbientParticles 气泡层。
 * pointer-events: none；z-index: 0；内容层在 ShellLayout 中 z-index: 1。
 * 依赖：useTheme（background）、resolveMediaSrc、AmbientParticles。
 */
import { useEffect } from 'react'
import type { BackgroundConfig } from '@shared/types/plugin'
import { resolveMediaSrc, useThemeStore } from '@renderer/hooks/useTheme'
import { AmbientParticles } from '@renderer/components/AmbientParticles'

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

  return (
    <>
      {active && background && (
        <div className="app-bg" aria-hidden>
          {background.type === 'color' ? (
            // 渐变/纯色直接写在满屏容器上，避免子元素无尺寸导致不生效
            <div
              className="app-bg-fill"
              style={{ background: background.value, opacity: background.opacity }}
            />
          ) : (
            <MediaLayer config={background} />
          )}
        </div>
      )}
      <AmbientParticles />
    </>
  )
}
