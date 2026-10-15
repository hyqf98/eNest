import { useCallback, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { NotificationOverlayState } from '@shared/types/notification'
import { NotificationCard } from '@renderer/components/NotificationHost'
import { applyLevelToDefaults } from '@renderer/gsap/marketMotion'
import '@renderer/styles/tokens.css'
import '@renderer/notification-overlay.css'

const api = window.enestNotificationOverlay
function Overlay() {
  const [state, setState] = useState<NotificationOverlayState | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!api) return
    let alive = true
    const apply = (next: NotificationOverlayState) => {
      if (!alive) return
      document.documentElement.dataset.theme = next.theme.mode
      document.documentElement.dataset.anim = next.animationLevel
      for (const [key, value] of Object.entries(next.theme.tokens)) document.documentElement.style.setProperty(key.startsWith('--') ? key : `--${key}`, value)
      applyLevelToDefaults(next.animationLevel)
      setState(next)
    }
    const off = api.onState(apply)
    void api.getState().then(apply)
    return () => { alive = false; off() }
  }, [])
  useEffect(() => {
    const element = ref.current
    if (!element || !api) return
    // scrollHeight includes GSAP's transient transforms; measure layout boxes so
    // an entering card never creates a large transparent native input region.
    const measure = () => {
      const children = Array.from(element.children) as HTMLElement[]
      const style = getComputedStyle(element)
      const height = children.reduce((sum, child) => sum + child.offsetHeight, 0) +
        Math.max(0, children.length - 1) * parseFloat(style.rowGap || '0') +
        parseFloat(style.paddingTop) + parseFloat(style.paddingBottom)
      if (children.length) api.measure(height)
    }
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    for (const child of Array.from(element.children)) observer.observe(child)
    measure()
    return () => observer.disconnect()
  }, [state?.items])
  const dismiss = useCallback((id: number) => { void api?.dismiss(id) }, [])
  const openLink = useCallback((url: string) => { void api?.openLink(url) }, [])
  return <div ref={ref} className="notification-overlay-stack" role="region" aria-label="消息通知" aria-live="polite" aria-relevant="additions">
    {state?.items.map(item => <NotificationCard key={item.id} item={item} onDismiss={dismiss} onOpenLink={openLink} visible={state.visible}/>)}
  </div>
}
createRoot(document.getElementById('root')!).render(<Overlay/>)
