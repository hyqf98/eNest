/**
 * PluginIcon — 插件位图图标统一渲染
 * 规范见 @shared/constants PLUGIN_ICON_*：
 * 源图 256 推荐 / 128 最小；显示 Card 48 / Featured 64 / Tab 20–24；
 * object-fit cover + 圆角 28%；失败回退 glyph。
 */
import { useEffect, useState } from 'react'
import type { CSSProperties } from 'react'
import {
  PLUGIN_ICON_OBJECT_FIT,
  PLUGIN_ICON_RADIUS_RATIO,
} from '@shared/constants'

export type PluginIconSlot = 'card' | 'featured' | 'tab'

interface Props {
  /** 图标 URL；缺省或加载失败时回退 glyph */
  src?: string
  fallbackSrc?: string
  glyph: string
  /** 色块背景（渐变/底色），img 成功时仍作底层 */
  style?: CSSProperties
  slot?: PluginIconSlot
  /** 显式边长（px）；缺省由 slot CSS 类决定 */
  size?: number
  className?: string
  alt?: string
  /**
   * 位图填充方式。默认 `cover` 适合插件方形图标；本机应用图标来自系统
   * （macOS ICNS、Windows 可执行文件、Linux 主题），常带透明留白或非方形比例，
   * `cover` 会把内容裁掉，这类场景要传 `contain`。
   */
  fit?: 'cover' | 'contain'
}

export function PluginIcon({ src, fallbackSrc, glyph, style, slot = 'card', size, className, alt, fit }: Props) {
  const [failed, setFailed] = useState(false)
  const [failedFallback, setFailedFallback] = useState<string>()
  const image = src && !failed ? src : fallbackSrc !== src && fallbackSrc !== failedFallback ? fallbackSrc : undefined

  useEffect(() => {
    setFailed(false)
    setFailedFallback(undefined)
  }, [src])

  const objectFit = fit ?? PLUGIN_ICON_OBJECT_FIT
  const classes = ['plugin-icon', `plugin-icon-${slot}`, fit === 'contain' ? 'plugin-icon-contain' : '', className].filter(Boolean).join(' ')
  const sized: CSSProperties = size
    ? {
        width: size,
        height: size,
        borderRadius: size * PLUGIN_ICON_RADIUS_RATIO,
        ...style,
      }
    : { ...style }

  return (
    <span className={classes} style={sized} aria-hidden={alt ? undefined : true}>
      {image ? (
        <img
          key={image}
          src={image}
          alt={alt ?? ''}
          loading={slot === 'tab' ? 'eager' : 'lazy'}
          draggable={false}
          onError={() => image === src ? setFailed(true) : setFailedFallback(image)}
          style={{
            width: '100%',
            height: '100%',
            objectFit,
            borderRadius: 'inherit',
          }}
        />
      ) : (
        <span className="plugin-icon-glyph">{glyph}</span>
      )}
    </span>
  )
}
