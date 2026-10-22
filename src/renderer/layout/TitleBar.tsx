/** 原生子视图在标题栏下面，展开状态与内容起点由 ShellLayout 同步。 */
import { useEffect, useLayoutEffect, useRef } from 'react'
import gsap from 'gsap'
import { TabStrip } from '@renderer/layout/TabStrip'
import { shellApi } from '@renderer/services/shellApi'
import { useAnimationLevel, useReducedMotion } from '@renderer/hooks/useAnimationLevel'
import { d, dy, ease } from '@renderer/gsap/marketMotion'
import { createTitlebarHover } from './titlebarHover'

interface TitleBarProps {
  /** 自动隐藏已开启 */
  autoHide?: boolean
  /** 当前是否展开（仅自动隐藏时有效） */
  revealed?: boolean
  onReveal?: () => void
  onCollapse?: () => void
  onMotionStart?: () => void
  onMotionComplete?: (shown: boolean) => void
}

export function TitleBar({ autoHide = false, revealed = false, onReveal, onCollapse, onMotionStart, onMotionComplete }: TitleBarProps) {
  const headerRef = useRef<HTMLElement>(null)
  const { level } = useAnimationLevel()
  const reducedMotion = useReducedMotion()
  const callbacks = useRef({ onReveal, onCollapse, onMotionStart, onMotionComplete })
  callbacks.current = { onReveal, onCollapse, onMotionStart, onMotionComplete }
  const hover = useRef<ReturnType<typeof createTitlebarHover>>()
  hover.current ??= createTitlebarHover(() => callbacks.current.onReveal?.(), () => callbacks.current.onCollapse?.())
  const interaction = hover.current
  const focusFrame = useRef<number>()
  const focusTitlebar = () => {
    interaction.focus(true)
    cancelAnimationFrame(focusFrame.current ?? 0)
    focusFrame.current = requestAnimationFrame(() => headerRef.current?.focus({ preventScroll: true }))
  }
  const shown = !autoHide || revealed
  const motion = useRef<gsap.core.Tween>()
  const motionContext = useRef<gsap.Context>()

  useLayoutEffect(() => {
    const node = headerRef.current
    if (!node) return
    const ctx = gsap.context(() => {
      gsap.set(node, { opacity: shown ? 1 : 0, y: shown || reducedMotion || level === 'low' ? 0 : -dy(12) })
    }, node)
    motionContext.current = ctx
    return () => { motion.current?.kill(); ctx.revert(); motionContext.current = undefined }
  }, [])

  useLayoutEffect(() => {
    const node = headerRef.current
    if (!node || !motionContext.current) return
    motion.current?.kill()
    callbacks.current.onMotionStart?.()
    motionContext.current.add(() => {
      motion.current = gsap.to(node, {
        opacity: shown ? 1 : 0,
        y: shown || reducedMotion || level === 'low' ? 0 : -dy(12),
        duration: reducedMotion || level === 'low' ? 0 : d(shown ? 0.23 : 0.18),
        ease: ease(shown ? 'power3.out' : 'power2.inOut'),
        overwrite: true,
        onComplete: () => callbacks.current.onMotionComplete?.(shown),
      })
    })
    return () => { motion.current?.kill() }
  }, [shown, level, reducedMotion])

  useEffect(() => {
    const blur = () => interaction.reset()
    window.addEventListener('blur', blur)
    return () => {
      interaction.dispose()
      cancelAnimationFrame(focusFrame.current ?? 0)
      window.removeEventListener('blur', blur)
    }
  }, [interaction])

  useEffect(() => { if (!autoHide) interaction.reset() }, [autoHide, interaction])

  const className = [
    'titlebar',
    autoHide ? 'titlebar-autohide' : '',
    autoHide && revealed ? 'is-revealed' : '',
  ].filter(Boolean).join(' ')

  return (
    <div className="titlebar-region"
      onPointerEnter={autoHide ? () => interaction.enter() : undefined}
      onPointerLeave={autoHide ? () => interaction.leave() : undefined}
      onPointerDownCapture={autoHide ? () => interaction.pointerDown() : undefined}
      onFocusCapture={autoHide ? event => interaction.focus(event.target.matches(':focus-visible')) : undefined}
      onBlurCapture={autoHide ? event => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) interaction.blur()
      } : undefined}>
      <header
        ref={headerRef}
        className={className}
        aria-label="窗口标题栏"
        tabIndex={-1}
        data-autohide={autoHide ? 'true' : undefined}
      >
        <div className="traffic" role="group" aria-label="窗口控制">
          <button
            type="button"
            className="traffic-btn r"
            aria-label="关闭"
            onClick={() => shellApi.closeWindow?.()}
          >
            <svg viewBox="0 0 12 12" width="8" height="8" aria-hidden>
              <path d="M3.2 3.2l5.6 5.6M8.8 3.2L3.2 8.8" stroke="var(--titlebar-icon-stroke)" strokeWidth="1.4" strokeLinecap="round" />
            </svg>
          </button>
          <button
            type="button"
            className="traffic-btn y"
            aria-label="最小化"
            onClick={() => shellApi.minimizeWindow?.()}
          >
            <svg viewBox="0 0 12 12" width="8" height="8" aria-hidden>
              <path d="M3 6h6" stroke="var(--titlebar-icon-stroke)" strokeWidth="1.4" strokeLinecap="round" />
            </svg>
          </button>
          <button
            type="button"
            className="traffic-btn g"
            aria-label="最大化"
            onClick={() => shellApi.maximizeWindow?.()}
          >
            <svg viewBox="0 0 12 12" width="8" height="8" aria-hidden>
              <path d="M4 8V4h4" stroke="var(--titlebar-icon-stroke)" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" fill="none" />
            </svg>
          </button>
        </div>
        {/* Session navigation belongs to the host; orb is an additional entry, never a replacement. */}
        <TabStrip />
      </header>
      {autoHide && (
        <div className="titlebar-hotzone" aria-label="显示窗口标题栏" role="button" tabIndex={revealed ? -1 : 0}
          onClick={focusTitlebar} onFocus={focusTitlebar}
          onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); focusTitlebar() } }} />
      )}
    </div>
  )
}
