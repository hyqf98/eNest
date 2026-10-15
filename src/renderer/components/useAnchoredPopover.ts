import { useLayoutEffect, useState, type CSSProperties, type RefObject } from 'react'

/** Viewport portals escape scrolling cards and flip near the bottom edge. */
export function useAnchoredPopover(open: boolean, anchor: RefObject<HTMLElement>, panel: RefObject<HTMLElement>, preferredWidth?: number, preferredHeight = 288): CSSProperties {
  const [position, setPosition] = useState<CSSProperties>({ visibility: 'hidden' })
  useLayoutEffect(() => {
    if (!open) return
    let frame = 0
    const update = () => {
      frame = 0
      if (!anchor.current || !panel.current) return
      const rect = anchor.current.getBoundingClientRect()
      const margin = 12, gap = 6
      const width = Math.min(preferredWidth ?? Math.max(rect.width, 180), window.innerWidth - margin * 2)
      const below = window.innerHeight - rect.bottom - margin - gap
      const above = rect.top - margin - gap
      const desired = Math.min(preferredHeight, panel.current.scrollHeight)
      const placeAbove = below < desired && above > below
      const maxHeight = Math.max(40, Math.min(preferredHeight, placeAbove ? above : below))
      const next: CSSProperties = { position: 'fixed', top: Math.max(margin, placeAbove ? rect.top - gap - Math.min(desired, maxHeight) : rect.bottom + gap),
        left: Math.max(margin, Math.min(rect.right - width, window.innerWidth - width - margin)), width, maxHeight, visibility: 'visible' }
      setPosition(previous => previous.top === next.top && previous.left === next.left && previous.width === next.width
        && previous.maxHeight === next.maxHeight && previous.visibility === next.visibility ? previous : next)
    }
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update) }
    const onScroll = (event: Event) => {
      // Scrolling the portal's options does not move its anchor or viewport bounds.
      if (event.target instanceof Node && panel.current?.contains(event.target)) return
      schedule()
    }
    update()
    const observer = new ResizeObserver(schedule)
    if (anchor.current) observer.observe(anchor.current)
    if (panel.current) observer.observe(panel.current)
    window.addEventListener('resize', schedule)
    window.addEventListener('scroll', onScroll, { capture: true, passive: true })
    return () => {
      if (frame) cancelAnimationFrame(frame)
      observer.disconnect()
      window.removeEventListener('resize', schedule)
      window.removeEventListener('scroll', onScroll, true)
    }
  }, [open, anchor, panel, preferredWidth, preferredHeight])
  return position
}
