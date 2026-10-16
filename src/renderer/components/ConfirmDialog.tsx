import { useCallback, useEffect, useRef } from 'react'
import gsap from 'gsap'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { useConfirmation, finishConfirmation } from '@renderer/services/confirmAction'
import { useI18n } from '@renderer/hooks/useI18n'
import { d, dy, ease } from '@renderer/gsap/marketMotion'
import { Button } from '@renderer/components/ui/Button'
import '@renderer/styles/confirmDialog.css'

/**
 * A renderer modal for the home/settings surfaces, where native plugin views are hidden.
 * 行为（焦点陷阱 / Esc / 焦点归还）来自 Radix Dialog；进出场动画保留 gsap（asChild 挂 .confirm-panel）。
 */
export function ConfirmDialog() {
  const request = useConfirmation(state => state.request)
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
    const panel = panelRef.current
    if (!request || !panel) return
    closing.current = false
    cancelRef.current?.focus({ preventScroll: true })
    gsap.fromTo(panel, { autoAlpha: 0, y: dy(10) }, {
      autoAlpha: 1, y: 0, duration: d(0.22), ease: ease('power3.out'), clearProps: 'transform',
    })
  }, [request])

  if (!request) return null
  return (
    <DialogPrimitive.Root open onOpenChange={(open) => { if (!open) finish(false) }}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="confirm-overlay" />
        <DialogPrimitive.Content asChild
          onOpenAutoFocus={(event) => { event.preventDefault(); cancelRef.current?.focus({ preventScroll: true }) }}
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            if (request.returnFocus?.isConnected) request.returnFocus.focus({ preventScroll: true })
          }}
          onEscapeKeyDown={(event) => { event.preventDefault(); finish(false) }}
          onInteractOutside={(event) => { event.preventDefault(); finish(false) }}
        >
          <section ref={panelRef} className={`confirm-panel${request.danger ? ' is-danger' : ''}`}>
            <div className="confirm-symbol" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7.5v5m0 3.5h.01"/></svg></div>
            <DialogPrimitive.Title asChild><h2>{request.title}</h2></DialogPrimitive.Title>
            <DialogPrimitive.Description asChild><p>{request.message}</p></DialogPrimitive.Description>
            <div className="confirm-actions">
              <Button ref={cancelRef} variant="ghost" onClick={() => finish(false)}>{t('common.cancel')}</Button>
              <Button variant={request.danger ? 'danger' : 'primary'} onClick={() => finish(true)}>{request.confirmLabel}</Button>
            </div>
          </section>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
