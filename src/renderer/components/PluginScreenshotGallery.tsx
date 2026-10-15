import { useEffect, useId, useRef, useState } from 'react'
import type { KeyboardEvent, MouseEvent } from 'react'
import { useI18n } from '@renderer/hooks/useI18n'
import { ChevronLeftIcon, ChevronRightIcon, XIcon } from '@renderer/components/icons'

interface Props {
  name: string
  screenshots?: string[]
}

type ImageStatus = 'loading' | 'loaded' | 'error'

/** A source-list change creates a fresh gallery, including its image/error state. */
export function PluginScreenshotGallery({ name, screenshots }: Props) {
  const sources = [...new Set(screenshots?.map(source => source.trim()).filter(Boolean))].slice(0, 8)
  return <ScreenshotGallery key={JSON.stringify([name, sources])} name={name} sources={sources} />
}

function ScreenshotGallery({ name, sources }: { name: string; sources: string[] }) {
  const { t } = useI18n()
  const headingId = useId()
  const previewHeadingId = useId()
  const [selected, setSelected] = useState(0)
  const [statuses, setStatuses] = useState<Record<string, ImageStatus>>({})
  const [attempts, setAttempts] = useState<Record<string, number>>({})
  const [previewOpen, setPreviewOpen] = useState(false)
  const dialogRef = useRef<HTMLDialogElement>(null)
  const galleryRef = useRef<HTMLElement>(null)
  const thumbnailsRef = useRef<HTMLDivElement>(null)
  const previewThumbnailsRef = useRef<HTMLDivElement>(null)
  const returnFocusRef = useRef<HTMLButtonElement | null>(null)
  const source = sources[selected]
  const status = statuses[source] ?? 'loading'
  const multiple = sources.length > 1
  const imageLabel = t('plugin.screenshots.image', { name, index: selected + 1 })
  const pageLabel = t('plugin.screenshots.position', { current: selected + 1, total: sources.length })

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    if (previewOpen && !dialog.open) dialog.showModal()
    if (!previewOpen && dialog.open) dialog.close()
  }, [previewOpen])

  useEffect(() => {
    for (const container of [thumbnailsRef.current, previewThumbnailsRef.current]) {
      const thumbnail = container?.children[selected] as HTMLElement | undefined
      if (container?.clientWidth && thumbnail) {
        container.scrollLeft = thumbnail.offsetLeft - (container.clientWidth - thumbnail.offsetWidth) / 2
      }
    }
  }, [selected, previewOpen])

  const markStatus = (url: string, next: ImageStatus) => {
    setStatuses(current => current[url] === next ? current : { ...current, [url]: next })
  }

  const move = (direction: number) => {
    if (multiple) setSelected(current => (current + direction + sources.length) % sources.length)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    // The detail modal listens on window. Escape must close only the top preview.
    if (previewOpen && event.key === 'Escape') {
      event.stopPropagation()
      return
    }
    if (!multiple || event.altKey || event.ctrlKey || event.metaKey || event.nativeEvent.isComposing) return
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault()
      event.stopPropagation()
      move(event.key === 'ArrowRight' ? 1 : -1)
    }
  }

  const openPreview = (event: MouseEvent<HTMLButtonElement>) => {
    if (status !== 'loaded') return
    returnFocusRef.current = event.currentTarget
    setPreviewOpen(true)
  }

  const closePreview = () => {
    setPreviewOpen(false)
    const trigger = returnFocusRef.current
    if (trigger?.isConnected && !trigger.disabled) trigger.focus({ preventScroll: true })
    else galleryRef.current?.focus({ preventScroll: true })
  }

  const retry = () => {
    markStatus(source, 'loading')
    // Remount the image without altering signed or enest:// resource URLs.
    setAttempts(current => ({ ...current, [source]: (current[source] ?? 0) + 1 }))
  }

  const renderImage = () => (
    <img
      key={`${source}:${attempts[source] ?? 0}`}
      className={`detail-gallery-image${status === 'loaded' ? ' is-loaded' : ''}`}
      src={source}
      alt={imageLabel}
      decoding="async"
      referrerPolicy="no-referrer"
      draggable={false}
      onLoad={() => markStatus(source, 'loaded')}
      onError={() => markStatus(source, 'error')}
    />
  )

  const renderImageState = () => status !== 'loaded' && (
    <div className="detail-gallery-state" role="status">
      <span>{t(status === 'error' ? 'plugin.screenshots.failed' : 'plugin.screenshots.loading')}</span>
      {status === 'error' && <button type="button" className="btn btn-ghost" onClick={retry}>{t('plugin.screenshots.retry')}</button>}
    </div>
  )

  const renderNavigation = () => (
    <div className="detail-gallery-navigation">
      {multiple && <button type="button" className="detail-gallery-arrow" aria-label={t('plugin.screenshots.previous')} title={t('plugin.screenshots.previous')} onClick={() => move(-1)}><ChevronLeftIcon size={20} /></button>}
      <span className="detail-gallery-position" aria-live="polite" aria-atomic="true" aria-label={pageLabel}>{selected + 1} <span>/ {sources.length}</span></span>
      {multiple && <button type="button" className="detail-gallery-arrow" aria-label={t('plugin.screenshots.next')} title={t('plugin.screenshots.next')} onClick={() => move(1)}><ChevronRightIcon size={20} /></button>}
    </div>
  )

  const renderThumbnails = (preview = false) => multiple && (
    <div ref={preview ? previewThumbnailsRef : thumbnailsRef} className="detail-gallery-thumbnails" aria-label={t('plugin.screenshots.choose')}>
      {sources.map((url, index) => (
        <button
          key={`${url}:${attempts[url] ?? 0}`}
          type="button"
          className="detail-gallery-thumbnail"
          aria-label={t('plugin.screenshots.select', { index: index + 1 })}
          aria-pressed={index === selected}
          onClick={() => setSelected(index)}
        >
          {statuses[url] !== 'error' && <img src={url} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" draggable={false} onError={() => markStatus(url, 'error')} />}
          <span className="detail-gallery-thumbnail-number" aria-hidden="true">{index + 1}</span>
          {statuses[url] === 'error' && <span className="detail-gallery-thumbnail-error" aria-hidden="true">!</span>}
        </button>
      ))}
    </div>
  )

  return (
    <section ref={galleryRef} tabIndex={-1} className="detail-gallery" aria-labelledby={headingId} onKeyDown={onKeyDown}>
      <header className="detail-gallery-header">
        <h3 id={headingId}>{t('plugin.screenshots.title')}</h3>
        {source && renderNavigation()}
      </header>
      {source ? (
        <>
          <div className="detail-gallery-stage" aria-busy={status === 'loading'}>
            {status !== 'error' && <button type="button" className="detail-gallery-open" disabled={status !== 'loaded'} aria-label={`${t('plugin.screenshots.expand')} · ${imageLabel}`} aria-haspopup="dialog" onClick={openPreview}>
              {renderImage()}
              {status === 'loaded' && <span className="detail-gallery-expand" aria-hidden="true">{t('plugin.screenshots.expand')} ↗</span>}
            </button>}
            {renderImageState()}
          </div>
          {renderThumbnails()}
          {multiple && <p className="detail-gallery-hint">{t('plugin.screenshots.keyboard')}</p>}
          <dialog
            ref={dialogRef}
            className="detail-gallery-preview"
            aria-labelledby={previewHeadingId}
            onClose={closePreview}
            onCancel={event => { event.stopPropagation(); setPreviewOpen(false) }}
            onClick={event => {
              if (event.target !== event.currentTarget) return
              const rect = event.currentTarget.getBoundingClientRect()
              if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) event.currentTarget.close()
            }}
          >
            <header className="detail-gallery-preview-header">
              <h3 id={previewHeadingId}>{t('plugin.screenshots.previewTitle', { name })}</h3>
              <button type="button" className="detail-gallery-arrow" autoFocus aria-label={t('plugin.screenshots.closePreview')} onClick={() => dialogRef.current?.close()}><XIcon size={20} /></button>
            </header>
            <div className="detail-gallery-preview-stage" aria-busy={status === 'loading'}>
              {previewOpen && status !== 'error' && renderImage()}
              {renderImageState()}
            </div>
            <footer className="detail-gallery-preview-footer">
              <span>{t('plugin.screenshots.previewHint')}</span>
              {renderNavigation()}
            </footer>
            {previewOpen && renderThumbnails(true)}
          </dialog>
        </>
      ) : <p className="detail-gallery-empty">{t('plugin.screenshots.empty')}</p>}
    </section>
  )
}
