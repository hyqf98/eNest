/**
 * Splash — 冷启动全屏动画
 * 职责：首次进入时展示与应用图标同构的六边形「巢」动画，结束后卸载。
 * 视觉：深墨绿底 + 薄荷绿描边/插件块 + 琥珀中心点，GSAP 描边与错落入场。
 * 依赖：gsap、splashMotion。
 */
import { useEffect, useRef, useState } from 'react'
import { playSplash, type SplashHandles } from '../gsap/splashMotion'

export function Splash({ onDone }: { onDone: () => void }) {
  const rootRef = useRef<HTMLDivElement>(null)
  const handlesRef = useRef<SplashHandles | null>(null)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    const handles: SplashHandles = {
      root,
      hex: root.querySelector('.splash-hex'),
      tileL: root.querySelector('.splash-tile-l'),
      tileR: root.querySelector('.splash-tile-r'),
      node: root.querySelector('.splash-node'),
      wordmark: root.querySelector('.splash-word'),
      ring: root.querySelector('.splash-ring')
    }
    handlesRef.current = handles
    setReady(true)
  }, [])

  useEffect(() => {
    if (!ready || !handlesRef.current) return
    const reduced =
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (reduced) {
      onDone()
      return
    }
    playSplash(handlesRef.current, onDone)
  }, [ready, onDone])

  return (
    <div className="splash" ref={rootRef} aria-hidden>
      <div className="splash-bg" />
      <div className="splash-stage">
        <svg className="splash-mark" viewBox="0 0 200 200" width="168" height="168">
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
          {/* 光环扩散 */}
          <circle className="splash-ring" cx="100" cy="100" r="78" fill="none" stroke="currentColor" strokeWidth="1.5" opacity="0" />
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
          <circle className="splash-node" cx="100" cy="100" r="7" fill="#F5A524" />
        </svg>
        <div className="splash-word">eNest</div>
        <div className="splash-sub">Plugin Shell</div>
      </div>
    </div>
  )
}
