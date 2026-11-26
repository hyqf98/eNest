/** 原生子视图在标题栏下面，展开状态与内容起点由 ShellLayout 同步。 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import gsap from 'gsap'
import { TabStrip } from '@renderer/themes/default/chrome/TabStrip'
import { PluginIcon } from '@renderer/components/PluginIcon'
import { WindowControls } from '@renderer/components/WindowControls'
import { shellApi } from '@renderer/services/shellApi'
import { useAnimationLevel, useReducedMotion } from '@renderer/hooks/useAnimationLevel'
import { useAppearanceStore } from '@renderer/hooks/useAppearance'
import { useShellStore } from '@renderer/stores/shellStore'
import type { WindowControl } from '@shared/windowFrame'
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

function controlWindow(control: WindowControl): void {
  if (control === 'close') shellApi.closeWindow?.()
  else if (control === 'minimize') shellApi.minimizeWindow?.()
  else shellApi.maximizeWindow?.()
}

export function TitleBar({ autoHide = false, revealed = false, onReveal, onCollapse, onMotionStart, onMotionComplete }: TitleBarProps) {
  const headerRef = useRef<HTMLElement>(null)
  const defaultTabsRef = useRef<HTMLDivElement>(null)
  const [customClassicReady, setCustomClassicReady] = useState(false)
  const tabStyle = useAppearanceStore((state) => state.appearance.layout.tabStyle)
  const activeTab = useShellStore((state) => state.view === 'plugin'
    ? state.tabs.find(tab => tab.id === state.activeTabId)
    : undefined)
  const { level } = useAnimationLevel()
  const reducedMotion = useReducedMotion()
  const callbacks = useRef({ onReveal, onCollapse, onMotionStart, onMotionComplete })
  callbacks.current = { onReveal, onCollapse, onMotionStart, onMotionComplete }
  const hover = useRef<ReturnType<typeof createTitlebarHover>>()
  hover.current ??= createTitlebarHover(() => callbacks.current.onReveal?.(), () => callbacks.current.onCollapse?.())
  const interaction = hover.current
  const focusOnReveal = useRef(false)
  const focusTitlebar = () => {
    const header = headerRef.current
    focusOnReveal.current = header?.inert === true
    interaction.focus(true)
    if (header && !header.inert) header.focus({ preventScroll: true })
  }
  const shown = !autoHide || revealed
  const motion = useRef<gsap.core.Tween>()
  const motionContext = useRef<gsap.Context>()

  useLayoutEffect(() => {
    const header = headerRef.current
    if (!header) return
    header.inert = !shown
    if (shown && focusOnReveal.current) {
      focusOnReveal.current = false
      header.focus({ preventScroll: true })
    }
  }, [shown])

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
    const blur = () => { focusOnReveal.current = false; interaction.reset() }
    window.addEventListener('blur', blur)
    return () => {
      interaction.dispose()
      window.removeEventListener('blur', blur)
    }
  }, [interaction])

  useEffect(() => { if (!autoHide) interaction.reset() }, [autoHide, interaction])
  useEffect(() => shellApi.onEvent(event => {
    if (!autoHide || event.type !== 'titlebar-native-hover') return
    if (event.inside) interaction.enter()
    else interaction.leave()
  }), [autoHide, interaction])
  useEffect(() => shellApi.onEvent(event => {
    if (event.type === 'theme-chrome-status' && event.surface === 'classic') setCustomClassicReady(event.ready)
  }), [])
  useLayoutEffect(() => {
    // Keep the fallback mounted for instant recovery, but never leave hidden focus targets.
    defaultTabsRef.current?.toggleAttribute('inert', customClassicReady)
  }, [customClassicReady, tabStyle])

  const className = [
    'titlebar',
    autoHide ? 'titlebar-autohide' : '',
    autoHide && revealed ? 'is-revealed' : '',
  ].filter(Boolean).join(' ')
  const pluginLabel = activeTab?.title && (
    <span className={`titlebar-plugin-label${tabStyle === 'orb' ? ' is-centered' : ''}`} title={activeTab.title}>
      <PluginIcon className="titlebar-plugin-label-icon" src={activeTab.icon ?? undefined} glyph={activeTab.glyph ?? ''}
        slot="tab" size={16} alt="" style={activeTab.color ? { background: activeTab.color } : undefined} />
      <span className="titlebar-plugin-label-text">{activeTab.title}</span>
    </span>
  )

  return (
    <div className="titlebar-region"
      onPointerEnter={autoHide ? () => interaction.enter() : undefined}
      onPointerLeave={autoHide ? () => interaction.leave() : undefined}
      onPointerDownCapture={autoHide ? () => interaction.pointerDown() : undefined}
      onFocusCapture={autoHide ? event => interaction.focus(event.target.matches(':focus-visible')) : undefined}
      onBlurCapture={autoHide ? event => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) { focusOnReveal.current = false; interaction.blur() }
      } : undefined}>
      <header
        ref={headerRef}
        className={className}
        aria-label="窗口标题栏"
        tabIndex={-1}
        data-autohide={autoHide ? 'true' : undefined}
      >
        <WindowControls onControl={controlWindow} />
        {tabStyle === 'orb' ? <>
          <div className="titlebar-spacer" aria-hidden="true" />
          {pluginLabel}
        </> : <div ref={defaultTabsRef} className={`titlebar-default-tabs${customClassicReady ? ' is-replaced' : ''}`}
          aria-hidden={customClassicReady || undefined}>
          <TabStrip />
          {pluginLabel}
        </div>}
      </header>
      {autoHide && (
        <div className="titlebar-hotzone" aria-label="显示窗口标题栏" role="button" tabIndex={revealed ? -1 : 0}
          onClick={focusTitlebar} onFocus={focusTitlebar}
          onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); focusTitlebar() } }} />
      )}
      {customClassicReady && tabStyle === 'classic' && (
        <div className="titlebar-custom-chrome-hit-region" aria-hidden="true" />
      )}
    </div>
  )
}
