import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import type { KeyboardEvent, MouseEvent } from 'react'
import type { PluginPresentation } from './pluginPresentation'
import { useI18n } from '@renderer/hooks/useI18n'
import { ChevronLeftIcon, ChevronRightIcon, XIcon } from '@renderer/components/icons'
import { PluginIcon } from '@renderer/components/PluginIcon'
import '@renderer/themes/default/workspace/productVisual.css'

interface Props {
  plugin: PluginPresentation
  active: boolean
  mediaVisible?: boolean
  screenshot?: string
  onScreenshotChange?: (url: string) => void
  onPreviewChange?: (open: boolean) => void
}

function GalleryImage({ url, visible, requested, label, eager, onReady, onFailed, onFadeEnd }: {
  url: string; visible: boolean; requested: boolean; label: string; eager: boolean
  onReady: (url: string) => void; onFailed: (url: string) => void; onFadeEnd: (url: string) => void
}) {
  const imageRef = useRef<HTMLImageElement>(null)
  const onReadyRef = useRef(onReady)
  onReadyRef.current = onReady
  useLayoutEffect(() => {
    const image = imageRef.current!
    image.src = url
    return () => { image.removeAttribute('src') }
  }, [url])
  useLayoutEffect(() => {
    if (!requested) return
    const image = imageRef.current!
    let cancelled = false
    let decoding = false
    const decode = () => {
      if (decoding) return
      decoding = true
      void image.decode().catch(() => undefined).then(() => {
        if (!cancelled && image.naturalWidth > 0) onReadyRef.current(url)
      })
    }
    image.addEventListener('load', decode)
    if (image.complete && image.naturalWidth > 0) decode()
    return () => { cancelled = true; image.removeEventListener('load', decode) }
  }, [url, requested])
  return <img ref={imageRef} className={`product-gallery-image${visible ? ' is-visible' : ''}`}
    alt={visible ? label : ''} aria-hidden={!visible} loading={eager ? 'eager' : 'lazy'} decoding="async"
    referrerPolicy="no-referrer" draggable={false} onError={() => onFailed(url)}
    onTransitionEnd={event => { if (event.propertyName === 'opacity' && !visible) onFadeEnd(url) }} />
}

/** 真实截图图库；失效图片自动跳过，没有截图时只展示插件身份。 */
export function ProductVisual({ plugin, active, mediaVisible = true, screenshot, onScreenshotChange, onPreviewChange }: Props) {
  const sources = [...new Set(plugin.screenshots?.map(source => source.trim()).filter(Boolean))].slice(0, 8)
  // Keep slide geometry and selection in the parent, not hidden decoded images/dialogs.
  if (!mediaVisible) return <figure className={`product-visual ${sources.length ? 'product-screenshot' : 'product-identity'}`}
    data-product-gallery data-media-resident="false" aria-hidden="true" />
  return <ProductGallery key={`${plugin.id}\u0000${sources.join('\u0000')}`} plugin={plugin} active={active} sources={sources} screenshot={screenshot} onScreenshotChange={onScreenshotChange} onPreviewChange={onPreviewChange} />
}

function ProductGallery({ plugin, active, sources, screenshot, onScreenshotChange, onPreviewChange }: Props & { sources: string[] }) {
  const { locale } = useI18n()
  const english = locale === 'en-US'
  const [selected, setSelected] = useState<string | undefined>(sources[0])
  const [failed, setFailed] = useState<Set<string>>(() => new Set())
  const [frames, setFrames] = useState<{ displayed?: string; outgoing?: string; pendingReady?: string }>({})
  const [previewOpen, setPreviewOpen] = useState(false)
  const dialogRef = useRef<HTMLDialogElement>(null)
  const figureRef = useRef<HTMLElement>(null)
  const returnFocusRef = useRef<HTMLElement | null>(null)
  const previewCallbackRef = useRef(onPreviewChange)
  const reportedPreviewRef = useRef(false)
  const headingId = useId()
  previewCallbackRef.current = onPreviewChange

  const available = sources.filter((source) => !failed.has(source))
  const requested = screenshot ?? selected
  const source = requested && available.includes(requested) ? requested :
    available.find(url => sources.indexOf(url) > sources.indexOf(requested ?? '')) ?? available[0]
  const sourceRef = useRef(source)
  sourceRef.current = source
  const position = Math.max(0, available.indexOf(source))
  const displayed = frames.displayed && available.includes(frames.displayed) ? frames.displayed : undefined
  const ready = Boolean(source && source === displayed)
  // Only the displayed frame, its outgoing crossfade and the newest decode stay
  // resident. Retired decode promises cannot commit after a later selection.
  const slots = [...new Set([frames.outgoing, displayed, source].filter((url): url is string => Boolean(url && available.includes(url))))]
  const screenshotLabel = english ? `${plugin.name} screenshots` : `${plugin.name}功能截图`
  const viewLabel = english ? 'View screenshot' : '查看大图'
  const previousLabel = english ? 'Previous screenshot' : '上一张截图'
  const nextLabel = english ? 'Next screenshot' : '下一张截图'

  useLayoutEffect(() => {
    setFrames(current => current.pendingReady && current.pendingReady !== source
      ? { displayed: current.displayed, outgoing: current.outgoing } : current)
  }, [source])

  const finishFade = useCallback((outgoing: string) => {
    setFrames(current => {
      if (current.outgoing !== outgoing) return current
      const next = current.pendingReady === sourceRef.current ? current.pendingReady : undefined
      return next && next !== current.displayed
        ? { displayed: next, outgoing: current.displayed }
        : { displayed: current.displayed }
    })
  }, [])

  useEffect(() => {
    if (!frames.outgoing) return
    const rawDuration = figureRef.current ? getComputedStyle(figureRef.current).getPropertyValue('--gallery-duration').trim() : '420ms'
    const duration = parseFloat(rawDuration) * (rawDuration.endsWith('ms') ? 1 : 1000)
    const outgoing = frames.outgoing
    const timer = setTimeout(() => finishFade(outgoing), duration === 0 ? 0 : (Number.isFinite(duration) ? duration : 420) + 50)
    return () => clearTimeout(timer)
  }, [frames.outgoing, frames.displayed, finishFade])

  useEffect(() => {
    if (!active) setPreviewOpen(false)
  }, [active])

  useEffect(() => {
    if (active && screenshot && source && screenshot !== source) onScreenshotChange?.(source)
  }, [active, screenshot, source, onScreenshotChange])

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

  const chooseScreenshot = (url: string) => {
    if (!active) return
    setSelected(url)
    onScreenshotChange?.(url)
  }

  const move = (step: number) => {
    if (available.length > 1) chooseScreenshot(available[(position + step + available.length) % available.length])
  }

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    event.stopPropagation()
    if (!active || available.length < 2 || event.altKey || event.ctrlKey || event.metaKey || event.nativeEvent.isComposing) return
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault()
      move(event.key === 'ArrowRight' ? 1 : -1)
    }
  }

  const onDotKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (!active || event.altKey || event.ctrlKey || event.metaKey || event.nativeEvent.isComposing) return
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? available.length - 1 :
      event.key === 'ArrowRight' ? (index + 1) % available.length :
        event.key === 'ArrowLeft' ? (index - 1 + available.length) % available.length : null
    if (next === null) return
    event.preventDefault()
    event.stopPropagation()
    chooseScreenshot(available[next])
    event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('.product-gallery-dot')[next]?.focus({ preventScroll: true })
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

  const markLoaded = (url: string) => {
    if (url !== source) return
    setFrames(current => {
      if (current.displayed === url || current.pendingReady === url) return current
      // A reversal can reuse both live layers and their current opacity.
      if (current.outgoing === url) return { displayed: url, outgoing: current.displayed }
      // Finish the current crossfade before handing off to the newest decoded
      // choice; dropping a still-visible outgoing image would expose the backdrop.
      return current.outgoing ? { ...current, pendingReady: url } : { displayed: url, outgoing: current.displayed }
    })
  }
  const markFailed = (url: string) => setFailed(current => current.has(url) ? current : new Set(current).add(url))

  const renderImages = () => slots.map((url) => (
    <GalleryImage
      key={url}
      url={url} visible={url === displayed} requested={url === source} eager={active && url === source}
      label={`${plugin.name}${english ? ' screenshot ' : '截图 '}${available.indexOf(url) + 1}`}
      onReady={markLoaded} onFailed={markFailed}
      onFadeEnd={finishFade}
    />
  ))

  const renderLoading = () => !displayed && (
    <span className="product-image-loading" aria-hidden="true">
      <span /><span /><span />
    </span>
  )

  return (
    <figure
      ref={figureRef}
      className={`product-visual ${source ? 'product-screenshot' : 'product-identity'}`}
      data-product-gallery
      data-media-resident="true"
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
              role="group"
              aria-label={english ? 'Choose screenshot' : '切换功能截图'}
              onPointerDown={(event) => event.stopPropagation()}
            >
              {available.map((url, index) => <button key={url} className="product-gallery-dot" type="button"
                tabIndex={active && index === position ? 0 : -1} disabled={!active}
                aria-label={english ? `Show screenshot ${index + 1} of ${available.length}` : `查看第 ${index + 1} 张截图，共 ${available.length} 张`}
                aria-current={index === position ? 'true' : undefined}
                onKeyDown={event => onDotKeyDown(event, index)}
                onClick={() => chooseScreenshot(url)}><span aria-hidden="true" /></button>)}
              <span className="product-gallery-position" aria-live={active ? 'polite' : 'off'} aria-atomic="true">
                {english ? `Screenshot ${position + 1} of ${available.length}` : `第 ${position + 1} 张，共 ${available.length} 张`}
              </span>
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
