import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import enestIcon from '@renderer/assets/enest-mark.png'
import { Button } from '@renderer/components/ui/Button'
import { SettingsIcon } from '@renderer/components/icons'

interface Props {
  onMarket: () => void
  onSettings: () => void
  onDismiss: () => void
  /**
   * 二级面板（搜索分类）展开期间保持一级菜单可见。
   * 点击分类按钮会把焦点交还输入框，若按"焦点外移即收起"处理，
   * 一级胶囊会在二级面板出现的同时消失，只剩一块孤立浮层。
   */
  pinned?: boolean
  /** Reset transient menu state without remounting the search bar's icon and controls. */
  resetKey?: string
  children?: ReactNode
}

/** Keep every action inside the bar, above the native plugin WebContentsView. */
export function QuickAccessMenu({ onMarket, onSettings, onDismiss, pinned = false, resetKey, children }: Props) {
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
    cancelAnimationFrame(focusFrame.current)
    focusFrame.current = 0
    setOpen(false)
  }, [resetKey])
  /** 可见性与可交互性必须同源：pinned 期间胶囊保持展开，按钮也必须仍可点。 */
  const visible = open || pinned
  useLayoutEffect(() => {
    // The closing animation must not leave hidden actions in the tab order.
    if (actionsRef.current) actionsRef.current.inert = !visible
  }, [visible])

  return <div className="quick-access" data-open={visible}
    onPointerEnter={event => { if (event.pointerType !== 'touch') setOpen(true) }}
    onPointerLeave={event => { if (!pinned && !event.currentTarget.contains(document.activeElement)) close() }}
    onFocusCapture={() => setOpen(true)}
    onBlurCapture={event => { if (!pinned && !event.currentTarget.contains(event.relatedTarget)) close() }}
    onKeyDown={event => {
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopPropagation(); close(); onDismiss()
      }
    }}>
    <Button className="quick-access-trigger" aria-label="插件与设置" title="插件与设置（F6）" aria-keyshortcuts="F6"
      aria-expanded={visible} aria-controls="quick-access-actions" onClick={focusActions}
      onKeyDown={event => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowLeft') { event.preventDefault(); focusActions() }
      }}>
      <img className="quick-access-brand" src={enestIcon} alt="" draggable={false} />
      <SettingsIcon className="quick-access-gear" size={23} />
    </Button>
    <div ref={actionsRef} className="quick-access-actions" id="quick-access-actions" role="group" aria-label="快捷入口" aria-hidden={!visible}>
      <Button className="quick-access-action quick-market" tabIndex={visible ? 0 : -1} aria-label="打开插件市场" title="打开插件市场" onClick={onMarket}>插件</Button>
      <Button className="quick-access-action quick-settings" tabIndex={visible ? 0 : -1} aria-label="打开设置" title="打开设置" onClick={onSettings}>设置</Button>
      {children}
    </div>
  </div>
}
