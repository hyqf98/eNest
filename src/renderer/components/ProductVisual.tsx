import { useEffect, useId, useRef, useState } from 'react'
import type { KeyboardEvent, MouseEvent } from 'react'
import type { PluginSummary } from '@shared/types/plugin'
import { useI18n } from '@renderer/hooks/useI18n'
import { ChevronLeftIcon, ChevronRightIcon, XIcon } from '@renderer/components/icons'
import { PluginIcon } from '@renderer/components/PluginIcon'
import '@renderer/styles/productVisual.css'

interface Props {
  plugin: PluginSummary
  active: boolean
  onPreviewChange?: (open: boolean) => void
}

/** 真实截图图库；失效图片自动跳过，没有截图时只展示插件身份。 */
export function ProductVisual({ plugin, active, onPreviewChange }: Props) {
  const { locale } = useI18n()
  const english = locale === 'en-US'
  const sources = [...new Set(plugin.screenshots?.filter(Boolean))].slice(0, 8)
  const sourceKey = `${plugin.id}\u0000${sources.join('\u0000')}`
  const [selected, setSelected] = useState(0)
  const [failed, setFailed] = useState<Set<string>>(() => new Set())
  const [loaded, setLoaded] = useState<Set<string>>(() => new Set())
  const [previewOpen, setPreviewOpen] = useState(false)
  const dialogRef = useRef<HTMLDialogElement>(null)
  const returnFocusRef = useRef<HTMLElement | null>(null)
  const previewCallbackRef = useRef(onPreviewChange)
  const reportedPreviewRef = useRef(false)
  const headingId = useId()
  previewCallbackRef.current = onPreviewChange

  const available = sources.filter((source) => !failed.has(source))
  const position = Math.min(selected, Math.max(0, available.length - 1))
  const source = available[position]
  const ready = Boolean(source && loaded.has(source))
  const screenshotLabel = english ? `${plugin.name} screenshots` : `${plugin.name}功能截图`
  const viewLabel = english ? 'View screenshot' : '查看大图'
  const previousLabel = english ? 'Previous screenshot' : '上一张截图'
  const nextLabel = english ? 'Next screenshot' : '下一张截图'

  useEffect(() => {
    setSelected(0)
    setFailed(new Set())
    setLoaded(new Set())
    setPreviewOpen(false)
  }, [sourceKey])

  useEffect(() => {
    if (!active) {
      setSelected(0)
      setPreviewOpen(false)
    }
  }, [active])

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    if (previewOpen && active && source) {
      if (!dialog.open) dialog.showModal()
    } else {
      if (dialog.open) dialog.close()
      if (previewOpen) setPreviewOpen(false)
    }
  }, [previewOpen, active, source])

  useEffect(() => {
    if (reportedPreviewRef.current === previewOpen) return
    reportedPreviewRef.current = previewOpen
    previewCallbackRef.current?.(previewOpen)
  }, [previewOpen])

  useEffect(() => () => {
    if (reportedPreviewRef.current) previewCallbackRef.current?.(false)
  }, [])

  const move = (step: number) => {
    if (available.length > 1) setSelected((position + step + available.length) % available.length)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    event.stopPropagation()
    if (!active || available.length < 2) return
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault()
      move(event.key === 'ArrowRight' ? 1 : -1)
    }
  }

  const openPreview = (event: MouseEvent<HTMLButtonElement>) => {
    if (!active) return
    event.stopPropagation()
    if (!ready) return
    returnFocusRef.current = event.currentTarget
    setPreviewOpen(true)
  }

  const closePreview = () => {
    setPreviewOpen(false)
    if (active && returnFocusRef.current?.isConnected) returnFocusRef.current.focus({ preventScroll: true })
  }

  const markLoaded = (url: string) => setLoaded((current) => new Set(current).add(url))
  const markFailed = (url: string) => setFailed((current) => new Set(current).add(url))

  const renderImages = () => available.map((url, index) => (
    <img
      key={url}
      className={`product-gallery-image${index === position && loaded.has(url) ? ' is-visible' : ''}`}
      src={url}
      alt={index === position ? `${plugin.name}${english ? ' screenshot ' : '截图 '}${index + 1}` : ''}
      aria-hidden={index !== position}
      loading={active && index === position ? 'eager' : 'lazy'}
      decoding="async"
      referrerPolicy="no-referrer"
      draggable={false}
      onLoad={() => markLoaded(url)}
      onError={() => markFailed(url)}
    />
  ))

  const renderLoading = () => !ready && (
    <span className="product-image-loading" aria-hidden="true">
      <span /><span /><span />
    </span>
  )

  return (
    <figure
      className={`product-visual ${source ? 'product-screenshot' : 'product-identity'}`}
      data-product-gallery
      data-active={active}
      aria-label={source ? screenshotLabel : undefined}
      onKeyDown={onKeyDown}
      onClick={(event) => { if (active) event.stopPropagation() }}
    >
      {source ? (
        <>
          <button
            className="product-image-button"
            type="button"
            data-product-image
            tabIndex={active ? 0 : -1}
            aria-label={`${viewLabel} · ${plugin.name} · ${position + 1}/${available.length}`}
            aria-busy={!ready}
            aria-haspopup="dialog"
            onClick={openPreview}
          >
            {renderLoading()}
            {renderImages()}
            <span className="product-image-expand" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M8 3H3v5M16 3h5v5M3 16v5h5M21 16v5h-5" />
              </svg>
              <span>{viewLabel}</span>
            </span>
          </button>
          {available.length > 1 && (
            <figcaption
              className="product-gallery-controls"
              data-product-gallery-control
              onPointerDown={(event) => event.stopPropagation()}
            >
              <button type="button" tabIndex={active ? 0 : -1} aria-label={previousLabel} onClick={() => move(-1)}>
                <ChevronLeftIcon size={16} />
              </button>
              <button className="product-gallery-count" type="button" tabIndex={active ? 0 : -1} aria-label={`${viewLabel} · ${position + 1}/${available.length}`} onClick={openPreview}>
                <span aria-live={active ? 'polite' : 'off'} aria-atomic="true">{position + 1} <span>/ {available.length}</span></span>
              </button>
              <button type="button" tabIndex={active ? 0 : -1} aria-label={nextLabel} onClick={() => move(1)}>
                <ChevronRightIcon size={16} />
              </button>
            </figcaption>
          )}
        </>
      ) : (
        <>
          <div className="product-identity-mark" aria-hidden="true">
            <PluginIcon src={plugin.icon} glyph={plugin.glyph} size={132} />
          </div>
        </>
      )}
      <dialog
        ref={dialogRef}
        className="product-preview"
        data-product-gallery-control
        aria-labelledby={headingId}
        onClose={closePreview}
        onCancel={() => setPreviewOpen(false)}
        onPointerDown={(event) => event.stopPropagation()}
        onKeyDown={onKeyDown}
        onClick={(event) => {
          event.stopPropagation()
          if (event.target === event.currentTarget) dialogRef.current?.close()
        }}
      >
        <div className="product-preview-panel">
          <header className="product-preview-header">
            <h3 id={headingId}>{screenshotLabel}</h3>
            <button autoFocus type="button" aria-label={english ? 'Close preview' : '关闭预览'} onClick={() => dialogRef.current?.close()}><XIcon size={18} /></button>
          </header>
          <div className="product-preview-image" aria-busy={!ready}>
            {renderLoading()}
            {previewOpen && renderImages()}
          </div>
          <footer className="product-preview-footer">
            <span className="product-preview-hint">{english ? 'Esc to close' : 'Esc 关闭'}</span>
            <div className="product-preview-pagination">
              {available.length > 1 && <button type="button" aria-label={previousLabel} onClick={() => move(-1)}><ChevronLeftIcon size={18} /></button>}
              <span aria-live="polite" aria-atomic="true">{position + 1} <span>/ {available.length}</span></span>
              {available.length > 1 && <button type="button" aria-label={nextLabel} onClick={() => move(1)}><ChevronRightIcon size={18} /></button>}
            </div>
          </footer>
        </div>
      </dialog>
    </figure>
  )
}
