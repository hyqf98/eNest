import { useCallback, useEffect, useLayoutEffect, useRef, type CSSProperties } from 'react'
import type { HomeResolvedAppearance } from '@shared/types/home'
import { playPaperSplash, type SplashPlayback } from '@renderer/themes/default/motion/splashMotion'
import { useReducedMotion } from '@renderer/hooks/useReducedMotion'
import { Button } from '@renderer/components/ui/Button'

interface Props {
  appearance: HomeResolvedAppearance
  hydrated: boolean
  onDone: () => void
  preview?: boolean
  ready?: boolean
}

/** Host-rendered paper choreography; a theme supplies only semantic appearance data. */
export function PaperSplash({ appearance, hydrated, onDone, preview = false, ready = true }: Props) {
  const rootRef = useRef<HTMLDivElement>(null)
  const playbackRef = useRef<SplashPlayback | null>(null)
  const completedRef = useRef(false)
  const onDoneRef = useRef(onDone)
  const readyRef = useRef(ready)
  const reducedMotion = useReducedMotion()
  onDoneRef.current = onDone
  readyRef.current = ready
  const complete = useCallback(() => {
    if (completedRef.current) return
    completedRef.current = true
    onDoneRef.current()
  }, [])

  useLayoutEffect(() => {
    const root = rootRef.current
    const sheet = root?.querySelector<HTMLElement>('.paper-splash-sheet')
    if (!root || !sheet || !hydrated || reducedMotion) return
    const playback = playPaperSplash({
      root,
      sheet,
      tabs: Array.from(root.querySelectorAll('.paper-splash-tab')),
      strokes: Array.from(root.querySelectorAll('[data-paper-stroke]')),
      labels: Array.from(root.querySelectorAll('[data-paper-label]')),
    }, complete, readyRef.current)
    playbackRef.current = playback
    return () => { playbackRef.current = null; playback() }
  }, [hydrated, appearance.animation.effective, reducedMotion, complete])

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

  const style = {
    ...appearance.tokens,
    '--font-heading': appearance.fonts.heading,
    '--font': appearance.fonts.body,
  } as CSSProperties
  return <div ref={rootRef} className={`splash paper-splash splash--${appearance.animation.effective}`}
    style={style} data-ready={hydrated} role={preview ? 'dialog' : undefined} aria-modal={preview || undefined}
    aria-label={preview ? '启动画面预览' : undefined} aria-hidden={!preview || undefined}>
    <div className="paper-splash-wash" aria-hidden="true" />
    {preview && <Button className="splash-close" autoFocus onClick={onDone} aria-label="关闭预览">关闭预览</Button>}
    <div className="splash-stage paper-splash-stage">
      <div className="paper-splash-sheet" aria-hidden="true">
        <i className="paper-splash-tape" />
        <div className="paper-splash-tabs">
          <i className="paper-splash-tab" /><i className="paper-splash-tab" /><i className="paper-splash-tab" />
        </div>
        <svg className="paper-splash-mark" viewBox="0 0 200 180" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round">
          <path data-paper-stroke pathLength="1" strokeWidth="3.5" d="M100 25 155 57 156 121 100 154 44 122 45 57 100 25" />
          <path data-paper-stroke pathLength="1" strokeWidth="2" className="paper-splash-echo" d="m97 28 60 31-2 60-55 37-58-34 1-66" />
          <path data-paper-stroke pathLength="1" strokeWidth="4" d="m65 78 21-1 1 15 12-1m34 20-20 1-1-16-12 1" />
          <path data-paper-stroke pathLength="1" strokeWidth="4" d="m96 87 9 2 4 8-7 8-9-3-2-8 5-7" />
        </svg>
        <div className="paper-splash-word" data-paper-label>eNest</div>
        <svg className="paper-splash-underline" viewBox="0 0 150 14" fill="none" stroke="currentColor">
          <path data-paper-stroke pathLength="1" strokeWidth="3" strokeLinecap="round" d="M9 7c29-4 67-3 131-1M18 11c28-2 69-1 109-2" />
        </svg>
      </div>
      <div className="splash-sub" data-paper-label>可组合的桌面工作台</div>
    </div>
  </div>
}
