import { useCallback, useLayoutEffect, useRef, type RefObject } from 'react'
import gsap from 'gsap'
import { d, dy, ease, getAnimLevel } from '@renderer/gsap/marketMotion'

type Phase = 'opening' | 'open' | 'closing'
type Pose = { x: number; y: number; scaleX: number; scaleY: number }
const IDENTITY: Pose = { x: 0, y: 0, scaleX: 1, scaleY: 1 }
const FOCUSABLE = 'button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex]:not([tabindex="-1"])'

function sourceRect(origin: HTMLElement | null): DOMRect | null {
  if (!origin?.isConnected) return null
  const box = origin.getBoundingClientRect()
  const style = getComputedStyle(origin)
  if (style.display === 'none' || style.visibility === 'hidden' || box.width < 2 || box.height < 2 ||
    box.right <= 0 || box.bottom <= 0 || box.left >= innerWidth || box.top >= innerHeight) return null
  return box
}

/** Recover the layout box without clearing a live transform (which would jump on interruption). */
function layoutBox(modal: HTMLElement) {
  const box = modal.getBoundingClientRect()
  return {
    width: modal.offsetWidth, height: modal.offsetHeight,
    x: box.x + box.width / 2 - Number(gsap.getProperty(modal, 'x')),
    y: box.y + box.height / 2 - Number(gsap.getProperty(modal, 'y')),
  }
}

function anchorPose(modal: HTMLElement, origin: HTMLElement | null, reduced: boolean): Pose | null {
  if (reduced) return { ...IDENTITY }
  const source = sourceRect(origin)
  if (!source) return null
  const box = layoutBox(modal)
  const x = source.x + source.width / 2 - box.x
  const y = source.y + source.height / 2 - box.y
  if (getAnimLevel() === 'low') return { x: dy(x), y: dy(y), scaleX: 0.985, scaleY: 0.985 }
  // A source-to-detail transition uses measured geometry; displacement budgets apply to decorative motion.
  return { x, y, scaleX: source.width / box.width, scaleY: source.height / box.height }
}

function lockBackground(root: HTMLElement, origin: HTMLElement | null): () => void {
  const elements = new Set<HTMLElement>([document.documentElement, document.body])
  for (const start of [root.parentElement, origin?.parentElement]) {
    for (let node = start; node; node = node.parentElement) {
      if (/(auto|scroll)/.test(getComputedStyle(node).overflowY)) elements.add(node)
    }
  }
  const saved = [...elements].map(element => ({ element, overflow: element.style.overflow,
    gutter: element.style.scrollbarGutter, top: element.scrollTop, left: element.scrollLeft }))
  for (const { element } of saved) {
    // Stable gutters preserve the source card's layout when a classic scrollbar is removed.
    const style = getComputedStyle(element)
    const scrollbar = element === document.documentElement ? innerWidth - element.clientWidth :
      element.offsetWidth - element.clientWidth - parseFloat(style.borderLeftWidth) - parseFloat(style.borderRightWidth)
    if (scrollbar > 0.5) element.style.scrollbarGutter = 'stable'
    element.style.overflow = 'hidden'
  }
  return () => {
    for (const { element, overflow, gutter, top, left } of saved) {
      element.style.overflow = overflow
      element.style.scrollbarGutter = gutter
      element.scrollTop = top
      element.scrollLeft = left
    }
  }
}

/** Interruptible geometry transition owned solely by this mounted detail instance. */
export function usePluginDetailMotion(rootRef: RefObject<HTMLDivElement | null>, pluginId: string,
  origin: HTMLElement | null, onClose: () => void): () => void {
  const closeRef = useRef<(() => void) | null>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  const requestClose = useCallback(() => closeRef.current?.(), [])

  useLayoutEffect(() => {
    const root = rootRef.current
    const modal = root?.querySelector<HTMLElement>('[data-detail-modal]')
    const backdrop = root?.querySelector<HTMLElement>('[data-detail-backdrop]')
    if (!root || !modal || !backdrop) return
    const parts = modal.querySelectorAll<HTMLElement>('[data-detail-icon],[data-detail-meta],[data-detail-actions],[data-detail-body],.detail-launch')
    const active = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const returnFocus = active && active !== document.body && !root.contains(active) ? active :
      origin?.querySelector<HTMLElement>(FOCUSABLE) ?? origin
    const unlock = lockBackground(root, origin)
    const media = window.matchMedia('(prefers-reduced-motion: reduce)')
    let phase: Phase = 'opening'
    let disposed = false
    let completed = false
    let timeline: gsap.core.Timeline | null = null
    let size = { width: modal.offsetWidth, height: modal.offsetHeight }
    const context = gsap.context(() => {}, root)
    const setPhase = (next: Phase) => { phase = next; root.dataset.detailPhase = next }
    const focusables = () => Array.from(modal.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(element =>
      element.getClientRects().length > 0 && !element.closest('[hidden],[inert]') && getComputedStyle(element).visibility !== 'hidden')
    const focusInitial = () => (modal.querySelector<HTMLElement>('[data-detail-close]') ?? modal).focus({ preventScroll: true })
    const hasTopDialog = () => document.querySelector('dialog[open]') !== null
    const stop = () => { timeline?.kill(); timeline = null }
    const done = () => {
      if (disposed || completed) return
      completed = true
      onCloseRef.current()
    }

    const enter = (initial: boolean) => context.add(() => {
      stop()
      setPhase('opening')
      if (initial) {
        const pose = anchorPose(modal, origin, media.matches) ?? { ...IDENTITY, y: media.matches ? 0 : dy(10) }
        gsap.set(modal, { ...pose, opacity: media.matches ? 0 : 0.4 })
        gsap.set([backdrop, ...parts], { opacity: 0 })
      }
      const duration = d(getAnimLevel() === 'high' ? 0.44 : 0.36)
      timeline = gsap.timeline({ onComplete: () => {
        setPhase('open')
        gsap.set(modal, { clearProps: 'transform' })
      } })
      timeline.to(modal, { ...IDENTITY, opacity: 1, duration, ease: ease('power3.out') }, 0)
        .to(backdrop, { opacity: 1, duration: d(0.22), ease: ease('power2.out') }, 0)
        .to(parts, { opacity: 1, duration: d(0.2), ease: ease('power2.out') }, initial ? duration * 0.16 : 0)
    })

    const exit = () => context.add(() => {
      stop()
      setPhase('closing')
      const target = anchorPose(modal, origin, media.matches)
      // If the source disappeared, fade at the current presentation pose instead of flying to stale coordinates.
      const pose = target ?? (media.matches ? IDENTITY : {})
      timeline = gsap.timeline({ onComplete: done })
      timeline.to(modal, { ...pose, opacity: 0, duration: d(0.26), ease: ease('power2.inOut') }, 0)
        .to(parts, { opacity: 0, duration: d(0.14), ease: ease('power2.out') }, 0)
        .to(backdrop, { opacity: 0, duration: d(0.26), ease: ease('power2.inOut') }, 0)
    })
    closeRef.current = () => { if (!disposed && phase !== 'closing') exit() }
    enter(true)
    focusInitial()

    const resize = () => {
      if (disposed) return
      if (phase === 'closing') exit()
      else if (phase === 'opening') enter(false)
      size = { width: modal.offsetWidth, height: modal.offsetHeight }
    }
    const observer = new ResizeObserver(() => {
      if (size.width !== modal.offsetWidth || size.height !== modal.offsetHeight) resize()
    })
    observer.observe(modal)
    window.addEventListener('resize', resize)
    media.addEventListener('change', resize)
    const keydown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || hasTopDialog()) return
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); requestClose() }
      else if (event.key === 'Tab') {
        const elements = focusables(), first = elements[0], last = elements.at(-1)
        if (!first) { event.preventDefault(); modal.focus({ preventScroll: true }) }
        else if (event.shiftKey && (document.activeElement === first || document.activeElement === modal)) { event.preventDefault(); last?.focus() }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
      }
    }
    const focusin = (event: FocusEvent) => {
      if (!hasTopDialog() && event.target instanceof Node && !root.contains(event.target)) focusInitial()
    }
    window.addEventListener('keydown', keydown)
    document.addEventListener('focusin', focusin)
    return () => {
      disposed = true
      closeRef.current = null
      stop()
      observer.disconnect()
      window.removeEventListener('resize', resize)
      media.removeEventListener('change', resize)
      window.removeEventListener('keydown', keydown)
      document.removeEventListener('focusin', focusin)
      context.revert()
      delete root.dataset.detailPhase
      unlock()
      if (returnFocus?.isConnected && !returnFocus.closest('[inert]')) returnFocus.focus({ preventScroll: true })
    }
  }, [rootRef, pluginId, origin, requestClose])

  return requestClose
}
