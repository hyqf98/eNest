import { useCallback, useEffect, useRef } from 'react'
import gsap from 'gsap'
import { useConfirmation, finishConfirmation } from '@renderer/services/confirmAction'
import { useI18n } from '@renderer/hooks/useI18n'
import { d, dy, ease } from '@renderer/gsap/marketMotion'
import '@renderer/styles/confirmDialog.css'

/** A renderer modal for the home/settings surfaces, where native plugin views are hidden. */
export function ConfirmDialog() {
  const request = useConfirmation(state => state.request)
  const dialogRef = useRef<HTMLDialogElement>(null)
  const panelRef = useRef<HTMLElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const closing = useRef(false)
  const { t } = useI18n()

  const finish = useCallback((confirmed: boolean) => {
    if (!request || closing.current) return
    closing.current = true
    const panel = panelRef.current
    if (!panel) { finishConfirmation(request.id, confirmed); return }
    gsap.to(panel, {
      autoAlpha: 0, y: dy(5), duration: d(0.12), ease: ease('power2.in'), overwrite: true,
      onComplete: () => finishConfirmation(request.id, confirmed),
    })
  }, [request])

  useEffect(() => () => {
    const active = useConfirmation.getState().request
    if (active) finishConfirmation(active.id, false)
  }, [])

  useEffect(() => {
    const dialog = dialogRef.current, panel = panelRef.current
    if (!request || !dialog || !panel) return
    closing.current = false
    dialog.showModal()
    cancelRef.current?.focus({ preventScroll: true })
    gsap.fromTo(panel, { autoAlpha: 0, y: dy(10) }, {
      autoAlpha: 1, y: 0, duration: d(0.22), ease: ease('power3.out'), clearProps: 'transform',
    })
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopImmediatePropagation()
        finish(false)
      } else if (event.key === 'Tab') {
        const buttons = Array.from(dialog.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'))
        const first = buttons[0], last = buttons.at(-1)
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
      }
    }
    window.addEventListener('keydown', keydown, true)
    return () => {
      window.removeEventListener('keydown', keydown, true)
      gsap.killTweensOf(panel)
      dialog.close()
      if (request.returnFocus?.isConnected) request.returnFocus.focus({ preventScroll: true })
    }
  }, [request, finish])

  if (!request) return null
  return <dialog ref={dialogRef} className="confirm-overlay" aria-labelledby="confirm-title" aria-describedby="confirm-message"
    onCancel={event => { event.preventDefault(); finish(false) }}
    onClick={event => { if (event.target === event.currentTarget) finish(false) }}>
    <section ref={panelRef} className={`confirm-panel${request.danger ? ' is-danger' : ''}`}>
      <div className="confirm-symbol" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7.5v5m0 3.5h.01"/></svg></div>
      <h2 id="confirm-title">{request.title}</h2>
      <p id="confirm-message">{request.message}</p>
      <div className="confirm-actions">
        <button ref={cancelRef} type="button" className="btn btn-ghost" onClick={() => finish(false)}>{t('common.cancel')}</button>
        <button type="button" className={`btn ${request.danger ? 'btn-danger' : 'btn-primary'}`} onClick={() => finish(true)}>{request.confirmLabel}</button>
      </div>
    </section>
  </dialog>
}
