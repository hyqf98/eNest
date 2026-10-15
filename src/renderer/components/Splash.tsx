/** The selected global background and its matching part-by-part logo assembly. */
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { SplashBackgroundConfig } from '@shared/types/plugin'
import { playSplash, type SplashHandles } from '@renderer/gsap/splashMotion'
import { resolveMediaSrc, useThemeStore } from '@renderer/hooks/useTheme'
import { useAnimationLevelStore, useReducedMotion } from '@renderer/hooks/useAnimationLevel'
import { BackgroundEffect } from '@renderer/components/BackgroundEffect'
import { backgroundAtmosphereStyle } from '@renderer/components/backgroundAtmosphere'
import { useBackgroundEffect } from '@renderer/hooks/useBackgroundEffect'
import { shellApi } from '@renderer/services/shellApi'

/** 品牌兜底（与 splash.css 注释一致） */
const BRAND = {
  bg: '#122420',
  accent: '#8ec7b6',
  text: '#e8f3ed',
} as const

function readCssVar(name: string, fallback: string): string {
  if (typeof window === 'undefined') return fallback
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return raw || fallback
}

/** 将 --bg / --accent / --text 写入 splash 根的局部变量；brand 模式清除以走 CSS 兜底 */
function applySplashTokens(root: HTMLElement, mode: 'brand' | 'theme'): void {
  if (mode === 'brand') {
    root.style.removeProperty('--splash-bg')
    root.style.removeProperty('--splash-accent')
    root.style.removeProperty('--splash-text')
    return
  }
  root.style.setProperty('--splash-bg', readCssVar('--bg', BRAND.bg))
  root.style.setProperty('--splash-accent', readCssVar('--accent', BRAND.accent))
  root.style.setProperty('--splash-text', readCssVar('--text', BRAND.text))
}

export function Splash({ onDone, preview = false }: { onDone: () => void; preview?: boolean }) {
  const rootRef = useRef<HTMLDivElement>(null)
  const effect = useBackgroundEffect()
  const background = useThemeStore((state) => state.background)
  const atmosphere = backgroundAtmosphereStyle(background)
  const hasUnifiedBackground = Boolean(effect || atmosphere)
  const themeHydrated = useThemeStore((state) => state.hydrated)
  const animationHydrated = useAnimationLevelStore((state) => state.hydrated)
  const handlesRef = useRef<SplashHandles | null>(null)
  const [ready, setReady] = useState(false)
  const [settingsReady, setSettingsReady] = useState(false)
  const level = useAnimationLevelStore((s) => s.level)
  const reducedMotion = useReducedMotion()
  const onDoneRef = useRef(onDone)
  onDoneRef.current = onDone
  const [splashBg, setSplashBg] = useState<SplashBackgroundConfig>({ type: 'brand', opacity: 0.55 })

  // 抓取 DOM 句柄
  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    const handles: SplashHandles = {
      root,
      hex: root.querySelector('.splash-hex'),
      tileL: root.querySelector('.splash-tile-l'),
      tileR: root.querySelector('.splash-tile-r'),
      node: root.querySelector('.splash-node'),
      wordChars: Array.from(root.querySelectorAll('.splash-word-char')),
      sub: root.querySelector('.splash-sub'),
    }
    handlesRef.current = handles
    setReady(true)
  }, [])

  // 水合动画强度 / 主题 / 启动背景（与 App 水合并行，hydrate 幂等）
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        await useAnimationLevelStore.getState().hydrate()
        if (!useThemeStore.getState().hydrated) {
          await useThemeStore.getState().hydrate()
        }
        const settings = await shellApi.getSettings()
        if (cancelled) return
        const bg = settings.general?.splashBackground
        if (bg && typeof bg === 'object' && bg.type) {
          setSplashBg({
            type: bg.type,
            value: bg.value ?? '',
            opacity: typeof bg.opacity === 'number' ? bg.opacity : 0.55,
          })
        } else {
          setSplashBg({ type: 'brand', opacity: 0.55 })
        }
      } catch {
        if (!cancelled) {
          setSplashBg({ type: 'brand', opacity: 0.55 })
        }
      } finally {
        if (!cancelled) setSettingsReady(true)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  // 主题 Token 写入 splash 根；image 时在自定义图之上仍用品牌/主题描边
  useEffect(() => {
    const root = rootRef.current
    if (!root || !settingsReady) return
    const mode = hasUnifiedBackground || splashBg.type === 'none' ? 'theme' : 'brand'
    applySplashTokens(root, mode)
    const observer = new MutationObserver(() => applySplashTokens(root, mode))
    observer.observe(document.documentElement, {
      attributes: true, attributeFilter: ['style', 'data-theme'],
    })
    return () => observer.disconnect()
  }, [settingsReady, splashBg.type, hasUnifiedBackground])

  useLayoutEffect(() => {
    if (!themeHydrated || !animationHydrated || !ready || !settingsReady || !handlesRef.current) return
    if (reducedMotion) {
      if (!preview) onDoneRef.current()
      return
    }
    return playSplash(handlesRef.current, () => onDoneRef.current(), level, effect?.logoStyle ?? (effect?.renderer === 'preset' ? effect.preset : 'fold'))
  }, [ready, settingsReady, themeHydrated, animationHydrated, level, reducedMotion, effect, preview])

  useEffect(() => {
    if (!preview) return
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onDoneRef.current() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [preview])

  const photo =
    !hasUnifiedBackground && splashBg.type === 'image' && splashBg.value ? resolveMediaSrc(splashBg.value) : null
  const photoSrc = photo?.playable ? photo.src : ''
  const photoOpacity = typeof splashBg.opacity === 'number' ? splashBg.opacity : 0.55

  return (
    <div
      className={`splash splash--${level}${hasUnifiedBackground ? ' splash--effect' : ''}${splashBg.type === 'none' ? ' splash--theme' : ''}${!hasUnifiedBackground && splashBg.type === 'image' ? ' splash--photo' : ''}`}
      ref={rootRef}
      data-ready={settingsReady && themeHydrated && animationHydrated}
      role={preview ? 'dialog' : undefined}
      aria-modal={preview || undefined}
      aria-label={preview ? '启动画面预览' : undefined}
      aria-hidden={!preview || undefined}
    >
      <div className="splash-bg" />
      {photoSrc && (
        <div
          className="splash-photo"
          style={{
            backgroundImage: `url("${photoSrc}")`,
            opacity: photoOpacity,
          }}
        />
      )}
      {settingsReady && themeHydrated && animationHydrated && effect && <BackgroundEffect effect={effect} className="splash-field" launch />}
      {settingsReady && themeHydrated && animationHydrated && !effect && atmosphere && <div className="background-atmosphere" style={atmosphere} aria-hidden="true" />}
      {preview && <button className="splash-close" type="button" autoFocus onClick={onDone} aria-label="关闭预览">关闭预览 ×</button>}
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
