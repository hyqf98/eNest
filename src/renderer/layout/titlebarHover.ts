const COLLAPSE_DELAY = 320

/** The pointer belongs to a fixed interaction region, never the moving titlebar. */
export function createTitlebarHover(onReveal: () => void, onCollapse: () => void) {
  let pointerInside = false
  let keyboardFocus = false
  let timer: ReturnType<typeof setTimeout> | undefined

  const cancel = () => { clearTimeout(timer); timer = undefined }
  const collapseSoon = () => {
    cancel()
    if (pointerInside || keyboardFocus) return
    timer = setTimeout(() => {
      timer = undefined
      if (!pointerInside && !keyboardFocus) onCollapse()
    }, COLLAPSE_DELAY)
  }

  return {
    enter() { pointerInside = true; cancel(); onReveal() },
    leave() { pointerInside = false; collapseSoon() },
    focus(visible: boolean) { keyboardFocus ||= visible; cancel(); onReveal() },
    blur() { keyboardFocus = false; collapseSoon() },
    pointerDown() { keyboardFocus = false },
    reset() { pointerInside = false; keyboardFocus = false; cancel(); onCollapse() },
    dispose: cancel,
  }
}
