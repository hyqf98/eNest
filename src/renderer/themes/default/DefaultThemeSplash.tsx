/** The default theme owns the original launch background and logo choreography. */
import { useCallback, useEffect, useLayoutEffect, useRef } from 'react'
import { playSplash, type SplashHandles, type SplashPlayback } from '@renderer/gsap/splashMotion'
import type { HomeResolvedAppearance } from '@shared/types/home'
import { useReducedMotion } from '@renderer/hooks/useReducedMotion'
import { BUILTIN_BACKGROUND_EFFECTS } from '@shared/backgroundEffects'
import { backgroundAtmosphereStyle } from '@renderer/components/backgroundAtmosphere'
import { DefaultThemeBackground } from '@renderer/themes/default/DefaultThemeBackground'
import { resolveMediaSrc } from '@renderer/services/themeResources'
import { Button } from '@renderer/components/ui/Button'

export function DefaultThemeSplash({ appearance, hydrated = true, onDone, preview = false, ready = true }: { appearance: HomeResolvedAppearance; hydrated?: boolean; onDone: () => void; preview?: boolean; ready?: boolean }) {
  const rootRef = useRef<HTMLDivElement>(null)
  const level = appearance.animation.effective
  const effect = BUILTIN_BACKGROUND_EFFECTS.find(item => item.id === appearance.background.effect)
  const splash = appearance.splash
  const photo = !effect && splash?.type === 'image' && splash.media?.value ? resolveMediaSrc(splash.media.value) : null
  const atmosphere = backgroundAtmosphereStyle(appearance.background.media)
  const hasUnifiedBackground = Boolean(effect || (atmosphere && !photo?.playable))
  const logoStyle = effect?.logoStyle ?? (effect?.renderer === 'preset' ? effect.preset : 'fold')
  const reducedMotion = useReducedMotion()
  const onDoneRef = useRef(onDone)
  onDoneRef.current = onDone
  const readyRef = useRef(ready)
  readyRef.current = ready
  const playbackRef = useRef<SplashPlayback | null>(null)
  const completedRef = useRef(false)

  const complete = useCallback(() => {
    if (completedRef.current) return
    completedRef.current = true
    onDoneRef.current()
  }, [])

  useLayoutEffect(() => {
    const root = rootRef.current
    if (!root || !hydrated || reducedMotion) return
    const handles: SplashHandles = {
      root,
      hex: root.querySelector('.splash-hex'),
      tileL: root.querySelector('.splash-tile-l'),
      tileR: root.querySelector('.splash-tile-r'),
      node: root.querySelector('.splash-node'),
      wordChars: Array.from(root.querySelectorAll('.splash-word-char')),
      sub: root.querySelector('.splash-sub'),
    }
    const playback = playSplash(handles, complete, level, logoStyle, readyRef.current)
    playbackRef.current = playback
    return () => {
      playbackRef.current = null
      playback()
    }
  }, [hydrated, level, reducedMotion, preview, logoStyle, complete])

  useLayoutEffect(() => {
    playbackRef.current?.setReady(ready)
    if (hydrated && reducedMotion && !preview && ready) complete()
  }, [hydrated, reducedMotion, preview, ready, complete])

  useEffect(() => {
    if (!preview) return
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') onDoneRef.current() }
    window.addEventListener('keydown', close)
    return () => window.removeEventListener('keydown', close)
  }, [preview])

  return (
    <div className={`splash splash--${level}${hasUnifiedBackground ? ' splash--effect' : ''}${splash?.type === 'none' ? ' splash--theme' : ''}${photo?.playable ? ' splash--photo' : ''}`} ref={rootRef}
      data-ready={hydrated} role={preview ? 'dialog' : undefined} aria-modal={preview || undefined}
      aria-label={preview ? '启动画面预览' : undefined} aria-hidden={!preview || undefined}>
      <div className="splash-bg" />
      {photo?.playable && <img className="splash-photo" src={photo.src} style={{ opacity: splash?.opacity ?? 0.55 }} alt="" draggable={false} />}
      {hasUnifiedBackground && <DefaultThemeBackground appearance={appearance} className="splash-field" launch />}
      {preview && <Button className="splash-close" autoFocus onClick={onDone} aria-label="关闭预览">关闭预览</Button>}
      <div className="splash-stage">
        <svg className="splash-mark" viewBox="0 0 200 200" width="132" height="132">
          {/* 开口六边形巢 */}
          <path
            className="splash-hex"
            d="M100 28 L162 64 L162 136 L100 172 L38 136 L38 64 Z"
            fill="none"
            stroke="currentColor"
            strokeWidth="6"
            strokeLinecap="round"
            strokeLinejoin="round"
            pathLength={1}
          />
          {/* 左插件块 */}
          <g className="splash-tile-l" transform="translate(52 78)">
            <rect x="0" y="0" width="36" height="28" rx="8" fill="currentColor" />
            <rect x="30" y="9" width="10" height="10" rx="3" fill="currentColor" />
          </g>
          {/* 右插件块 */}
          <g className="splash-tile-r" transform="translate(112 94)">
            <rect x="0" y="0" width="36" height="28" rx="8" fill="currentColor" />
            <rect x="-10" y="9" width="10" height="10" rx="3" fill="currentColor" />
          </g>
          {/* 中心智能节点 */}
          <circle className="splash-node" cx="100" cy="100" r="7" fill="currentColor" />
        </svg>
        <div className="splash-word">
          {'eNest'.split('').map((c, i) => (
            <span className="splash-word-char" key={i}>
              {c}
            </span>
          ))}
        </div>
        <div className="splash-sub">可组合的桌面工作台</div>
      </div>
    </div>
  )
}
