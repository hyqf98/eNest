import type { BaseWindow, WebContentsView } from 'electron'
import { ORB_DOCK_REVEAL_W, ORB_DOCK_VIEW_H, ORB_DOCK_VIEW_W, TITLEBAR_HEIGHT } from '@shared/constants'

export function bindClassicDockReveal(win: BaseWindow, view: WebContentsView) {
  const contents = view.webContents
  let expanded = false
  let pointerInside = false
  let keyboardFocus = false
  let retract: ReturnType<typeof setTimeout> | undefined

  function layout(): void {
    if (win.isDestroyed() || contents.isDestroyed()) return
    view.setBounds({ x: 0, y: Math.max(TITLEBAR_HEIGHT, win.getContentBounds().height - ORB_DOCK_VIEW_H),
      width: expanded ? ORB_DOCK_VIEW_W : ORB_DOCK_REVEAL_W, height: ORB_DOCK_VIEW_H })
  }

  function setExpanded(value: boolean): void {
    clearTimeout(retract)
    if (expanded === value) return
    expanded = value
    layout()
  }

  function reset(): void {
    pointerInside = false
    keyboardFocus = false
    setExpanded(false)
  }

  function update(): void {
    if (pointerInside || keyboardFocus) setExpanded(true)
    else if (expanded) {
      clearTimeout(retract)
      retract = setTimeout(() => setExpanded(false), 280)
      retract.unref()
    }
  }

  contents.on('before-mouse-event', (_event, mouse) => {
    if (!view.getVisible()) return
    if (mouse.type === 'mouseLeave') pointerInside = false
    else if (mouse.type === 'mouseDown') { pointerInside = true; keyboardFocus = false }
    else if (mouse.type === 'mouseEnter' || mouse.type === 'mouseMove' && !pointerInside) pointerInside = true
    else return
    update()
  })
  contents.on('focus', () => {
    if (!view.getVisible()) return
    keyboardFocus = !pointerInside
    update()
  })
  contents.on('before-input-event', (_event, input) => {
    if (input.type !== 'keyDown' || !view.getVisible() || keyboardFocus) return
    keyboardFocus = true
    update()
  })
  contents.on('blur', () => { keyboardFocus = false; update() })
  win.on('blur', reset)
  win.on('hide', reset)
  win.on('minimize', reset)
  contents.once('destroyed', () => {
    clearTimeout(retract)
    win.removeListener('blur', reset)
    win.removeListener('hide', reset)
    win.removeListener('minimize', reset)
  })
  return { layout, reset }
}
