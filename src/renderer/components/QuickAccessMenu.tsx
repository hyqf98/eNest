import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import enestIcon from '@renderer/assets/enest-mark.png'
import { Button } from '@renderer/components/ui/Button'
import { SettingsIcon } from './icons'

interface Props {
  onMarket: () => void
  onSettings: () => void
  onDismiss: () => void
  children?: ReactNode
}

/** Keep every action inside the bar, above the native plugin WebContentsView. */
export function QuickAccessMenu({ onMarket, onSettings, onDismiss, children }: Props) {
  const [open, setOpen] = useState(false)
  const actionsRef = useRef<HTMLDivElement>(null)
  const focusFrame = useRef(0)
  const close = () => {
    cancelAnimationFrame(focusFrame.current)
    focusFrame.current = 0
    setOpen(false)
  }
  const focusActions = () => {
    setOpen(true)
    cancelAnimationFrame(focusFrame.current)
    focusFrame.current = requestAnimationFrame(() => {
      focusFrame.current = 0
      actionsRef.current?.querySelector<HTMLButtonElement>('button')?.focus()
    })
  }
  useEffect(() => () => cancelAnimationFrame(focusFrame.current), [])
  useLayoutEffect(() => {
    // The closing animation must not leave hidden actions in the tab order.
    if (actionsRef.current) actionsRef.current.inert = !open
  }, [open])

  return <div className="quick-access" data-open={open}
    onPointerEnter={event => { if (event.pointerType !== 'touch') setOpen(true) }}
    onPointerLeave={event => { if (!event.currentTarget.contains(document.activeElement)) close() }}
    onFocusCapture={() => setOpen(true)}
    onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget)) close() }}
    onKeyDown={event => {
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopPropagation(); close(); onDismiss()
      }
    }}>
    <Button className="quick-access-trigger" aria-label="插件与设置" title="插件与设置（F6）" aria-keyshortcuts="F6"
      aria-expanded={open} aria-controls="quick-access-actions" onClick={focusActions}
      onKeyDown={event => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowLeft') { event.preventDefault(); focusActions() }
      }}>
      <img className="quick-access-brand" src={enestIcon} alt="" draggable={false} />
      <SettingsIcon className="quick-access-gear" size={23} />
    </Button>
    <div ref={actionsRef} className="quick-access-actions" id="quick-access-actions" role="group" aria-label="快捷入口" aria-hidden={!open}>
      <Button className="quick-access-action quick-market" tabIndex={open ? 0 : -1} aria-label="打开插件市场" onClick={onMarket}>插件</Button>
      <Button className="quick-access-action quick-settings" tabIndex={open ? 0 : -1} aria-label="打开设置" onClick={onSettings}>设置</Button>
      {children}
    </div>
  </div>
}
