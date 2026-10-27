import { useCallback, useEffect, useLayoutEffect, useRef } from 'react'
import { useReducedMotion } from '@renderer/hooks/useReducedMotion'
import type { SplashPlayback } from '@renderer/themes/default/motion/splashMotion'

interface SplashLifecycleOptions {
  hydrated: boolean
  onDone: () => void
  preview: boolean
  ready: boolean
}

type StartSplash = (complete: () => void, ready: boolean) => SplashPlayback | undefined

/** Keep readiness updates independent from each choreography's restart inputs. */
export function useSplashLifecycle(start: StartSplash, { hydrated, onDone, preview, ready }: SplashLifecycleOptions): void {
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
    if (!hydrated || reducedMotion) return
    const playback = start(complete, readyRef.current)
    if (!playback) return
    playbackRef.current = playback
    return () => {
      playbackRef.current = null
      playback()
    }
  }, [hydrated, reducedMotion, start, complete])

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
}
