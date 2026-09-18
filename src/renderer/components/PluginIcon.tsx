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
  glyph: string
  /** 色块背景（渐变/底色），img 成功时仍作底层 */
  style?: CSSProperties
  slot?: PluginIconSlot
  /** 显式边长（px）；缺省由 slot CSS 类决定 */
  size?: number
  className?: string
  alt?: string
}

export function PluginIcon({ src, glyph, style, slot = 'card', size, className, alt }: Props) {
  const [failed, setFailed] = useState(false)
  const showImg = Boolean(src) && !failed

  useEffect(() => {
    setFailed(false)
  }, [src])

  const classes = ['plugin-icon', `plugin-icon-${slot}`, className].filter(Boolean).join(' ')
  const sized: CSSProperties = size
    ? {
        width: size,
        height: size,
        borderRadius: size * PLUGIN_ICON_RADIUS_RATIO,
        ...style,
      }
    : { ...style }

  return (
    <div className={classes} style={sized} aria-hidden={alt ? undefined : true}>
      {showImg && src ? (
        <img
          src={src}
          alt={alt ?? ''}
          loading="lazy"
          draggable={false}
          onError={() => setFailed(true)}
          style={{
            width: '100%',
            height: '100%',
            objectFit: PLUGIN_ICON_OBJECT_FIT,
            borderRadius: 'inherit',
          }}
        />
      ) : (
        <span className="plugin-icon-glyph">{glyph}</span>
      )}
    </div>
  )
}
