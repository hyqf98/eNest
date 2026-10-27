/** 首页产品横幅：空闲时自动切换，悬停与用户操作时暂停阅读计时。 */
import { memo, useState } from 'react'
import type { CSSProperties } from 'react'
import type { PluginPresentation } from './pluginPresentation'
import { useI18n } from '@renderer/hooks/useI18n'
import { PRODUCT_DWELL_MS, useProductCarousel } from '@renderer/themes/default/workspace/useProductCarousel'
import { ChevronLeftIcon, ChevronRightIcon, ICON_STROKE_WIDTH } from '@renderer/components/icons'
import { PluginIcon } from '@renderer/components/PluginIcon'
import { ProductVisual } from '@renderer/themes/default/workspace/ProductVisual'
import { formatPluginPackageSize } from './pluginPresentation'
import '@renderer/themes/default/workspace/featured.css'

interface Props {
  items: PluginPresentation[]
  onOpen: (id: string) => void
  onDetail?: (id: string, origin?: HTMLElement | null) => void
  paused?: boolean
  continuous?: boolean
  mediaVisible?: boolean
}

export const FeaturedCarousel = memo(function FeaturedCarousel({ items, onOpen, onDetail, paused = false, continuous = true, mediaVisible = true }: Props) {
  const { locale, t } = useI18n()
  const english = locale === 'en-US'
  const [previewOpen, setPreviewOpen] = useState(false)
  const [screenshots, setScreenshots] = useState<Record<string, string>>({})
  const carousel = useProductCarousel(items, paused || previewOpen, continuous)
  const { index, select } = carousel

  const openPlugin = (plugin: PluginPresentation, origin: HTMLElement | null) => {
    if (plugin.installed && plugin.enabled !== false) onOpen(plugin.id)
    else if (onDetail) onDetail(plugin.id, origin)
    else onOpen(plugin.id)
  }

  if (!items.length) return null

  // 尾部的第二项给首项镜像保留下一张预览，避免回环时露出空白。
  const positions = items.length > 1
    ? [-1, ...items.map((_, itemIndex) => itemIndex), items.length, items.length + 1]
    : [0]

  return (
    <section
      ref={carousel.rootRef}
      className="carousel-block product-carousel"
      role="region"
      aria-roledescription="carousel"
      aria-label={english ? 'Featured plugins' : '精选插件'}
      data-single={items.length === 1 || undefined}
      data-autoplay={carousel.running || undefined}
      style={{ '--product-dwell': `${PRODUCT_DWELL_MS}ms` } as CSSProperties}
      onKeyDown={carousel.onKeyDown}
      onPointerEnter={carousel.onPointerEnter}
      onPointerLeave={carousel.onPointerLeave}
      onFocusCapture={carousel.onFocusCapture}
      onBlurCapture={carousel.onBlurCapture}
      onPointerDownCapture={carousel.onPointerDownCapture}
    >
      <div
        className={`product-viewport${carousel.dragging ? ' is-dragging' : ''}`}
        ref={carousel.viewportRef}
        onScroll={carousel.onScroll}
        onWheel={carousel.onWheel}
        onPointerDown={carousel.onPointerDown}
        onPointerMove={carousel.onPointerMove}
        onPointerUp={carousel.endDrag}
        onPointerCancel={carousel.endDrag}
        onLostPointerCapture={carousel.endDrag}
        onClickCapture={carousel.onClickCapture}
        tabIndex={0}
        aria-label={english ? 'Browse plugins with arrow keys, Home or End; drag to swipe' : '使用左右方向键、Home、End 或拖动浏览插件'}
      >
        {positions.map((physicalIndex) => {
          const itemIndex = ((physicalIndex % items.length) + items.length) % items.length
          const plugin = items[itemIndex]
          const clone = physicalIndex < 0 || physicalIndex >= items.length
          const active = index === itemIndex
          const interactive = active && !clone
          const distance = Math.abs(itemIndex - index)
          // A direct swipe can cross several slides before the target commits.
          const retainMedia = mediaVisible && carousel.mediaVisible && (carousel.mediaInteracting || Math.min(distance, items.length - distance) <= 1)
          const cta = plugin.installed
            ? plugin.enabled === false ? t('plugin.detail') : t('plugin.open')
            : t('plugin.install')
          const packageSize = formatPluginPackageSize(plugin.packageSize)
          return (
            <article
              key={clone ? `loop-${physicalIndex}-${plugin.id}` : plugin.id}
              className={`product-slide${active ? clone ? ' is-loop-current' : ' is-current' : ''}`}
              data-product-index={clone ? undefined : itemIndex}
              data-plugin-id={plugin.id}
              data-product-position={physicalIndex}
              data-product-clone={clone || undefined}
              role={clone ? undefined : 'group'}
              aria-roledescription={clone ? undefined : 'slide'}
              aria-label={clone ? undefined : `${itemIndex + 1} / ${items.length}: ${plugin.name}`}
              aria-hidden={clone || undefined}
              onClickCapture={clone ? (event) => {
                event.preventDefault()
                event.stopPropagation()
                select(physicalIndex)
              } : undefined}
              onClick={() => { if (!active) select(itemIndex) }}
            >
              <div className="product-peek" aria-hidden="true">
                <PluginIcon src={plugin.icon} glyph={plugin.glyph} slot="featured" className="product-icon" />
                <strong>{plugin.name}</strong>
                <p className="product-peek-description">{plugin.description}</p>
                <span>{english ? 'View plugin' : '查看插件'} <ChevronRightIcon size={13} /></span>
              </div>
              <div className="product-copy" onClick={(event) => {
                // The title button supplies keyboard access; the surrounding copy shares its action.
                if (!interactive || (event.target as HTMLElement).closest('button, a, input, select, textarea')) return
                openPlugin(plugin, event.currentTarget.closest<HTMLElement>('.product-slide'))
              }}>
                <div className="product-heading">
                  <PluginIcon src={plugin.icon} glyph={plugin.glyph} slot="featured" className="product-icon" />
                  <div className="product-title-group">
                    <h2 className="product-title">
                      {!clone ? (
                        <button type="button" title={plugin.name} tabIndex={interactive ? 0 : -1}
                          onClick={(event) => { if (interactive) openPlugin(plugin, event.currentTarget.closest<HTMLElement>('.product-slide')) }}>{plugin.name}</button>
                      ) : plugin.name}
                    </h2>
                    {plugin.author && <span className="product-author" title={plugin.author}>{plugin.author}</span>}
                  </div>
                </div>
                <p className="product-description" title={plugin.description}>{plugin.description}</p>
                <div className="product-actions">
                  {clone ? <span className="product-cta">{cta}</span> : (
                    <button type="button" className="product-cta" tabIndex={interactive ? 0 : -1}
                      onClick={(event) => { if (interactive) openPlugin(plugin, event.currentTarget.closest<HTMLElement>('.product-slide')) }}>{cta}</button>
                  )}
                  <div className="product-stats">
                    <span>v{plugin.version}</span>
                    <span title={t('plugin.packageSize', { size: packageSize ?? t('plugin.unknownSize') })}>
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                        strokeWidth={ICON_STROKE_WIDTH} strokeLinecap="round" strokeLinejoin="round"
                        aria-hidden="true" focusable="false" style={{ verticalAlign: 'text-bottom', marginRight: 4 }}>
                        <path d="M12 3 3 7.5v9L12 21l9-4.5v-9L12 3Z" />
                        <path d="m3 7.5 9 4.5 9-4.5M12 12v9M7.5 5.25l9 4.5" />
                      </svg>
                      {packageSize ?? '—'}
                    </span>
                  </div>
                </div>
                <div className="product-labels">
                  <span className="product-category">{plugin.category}</span>
                  {plugin.tags?.filter((tag) => tag !== plugin.category).slice(0, 2).map((tag) => <span className="product-tag" key={tag}>{tag}</span>)}
                  {plugin.installed && <span className="product-state">{plugin.enabled === false ? t('plugin.disabled') : t('plugin.installed')}</span>}
                </div>
              </div>
              <ProductVisual plugin={plugin} active={interactive} mediaVisible={retainMedia} screenshot={screenshots[plugin.id]}
                onScreenshotChange={clone ? undefined : (source) => setScreenshots(current =>
                  current[plugin.id] === source ? current : { ...current, [plugin.id]: source })}
                onPreviewChange={clone ? undefined : setPreviewOpen} />
            </article>
          )
        })}
      </div>
      {items.length > 1 && (
        <>
          <button className="product-nav product-nav-prev" type="button"
            aria-label={english ? 'Previous plugin' : '上一个插件'}
            onClick={() => select(carousel.indexRef.current - 1)}><ChevronLeftIcon size={20} /></button>
          <button className="product-nav product-nav-next" type="button"
            aria-label={english ? 'Next plugin' : '下一个插件'}
            onClick={() => select(carousel.indexRef.current + 1)}><ChevronRightIcon size={20} /></button>
          <div className="product-controls">
            <div className="product-pagination" role="group" aria-label={english ? 'Featured plugin pages' : '精选插件分页'}>
              {items.map((plugin, itemIndex) => (
                <button key={plugin.id} type="button"
                  className={`product-page${index === itemIndex ? ' is-current' : ''}`}
                  aria-label={`${english ? 'Show' : '查看'} ${plugin.name}`}
                  aria-current={index === itemIndex ? 'true' : undefined}
                  title={plugin.name} onClick={() => select(itemIndex)}>
                  {index === itemIndex && carousel.running && <span key={`${index}-${carousel.cycle}`} className="product-page-progress" />}
                </button>
              ))}
            </div>
          </div>
        </>
      )}
      <span className="sr-only" aria-live={carousel.running ? 'off' : 'polite'} aria-atomic="true">{carousel.announcement}</span>
    </section>
  )
})
