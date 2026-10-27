interface BackgroundVideoPlaybackOptions {
  enabled: boolean
  onError: () => void
}

/** Installs playback listeners; callers validate and assign sources before sync(). */
export function bindBackgroundVideoPlayback(
  video: HTMLVideoElement,
  { enabled, onError }: BackgroundVideoPlaybackOptions,
): { sync: () => void; setPaused: (paused: boolean) => void; dispose: () => void } {
  let disposed = false
  let mediaFailed = false
  let paused = false
  let focused = document.hasFocus()
  const releaseSource = () => {
    video.pause()
    video.removeAttribute('src')
    video.load()
  }
  const fail = () => {
    if (disposed || mediaFailed) return
    mediaFailed = true
    releaseSource()
    onError()
  }
  const sync = () => {
    if (disposed || mediaFailed) return
    if (paused || !enabled || document.hidden || !focused) video.pause()
    else void video.play().catch((error: unknown) => {
      // Pausing can reject an outstanding play; autoplay denial keeps the poster.
      const name = error && typeof error === 'object' && 'name' in error ? error.name : ''
      if (name !== 'AbortError' && name !== 'NotAllowedError') fail()
    })
  }
  const focus = () => { focused = true; sync() }
  const blur = () => { focused = false; sync() }
  video.addEventListener('loadeddata', sync)
  video.addEventListener('error', fail)
  document.addEventListener('visibilitychange', sync)
  window.addEventListener('focus', focus)
  window.addEventListener('blur', blur)
  const dispose = () => {
    if (disposed) return
    disposed = true
    video.removeEventListener('loadeddata', sync)
    video.removeEventListener('error', fail)
    document.removeEventListener('visibilitychange', sync)
    window.removeEventListener('focus', focus)
    window.removeEventListener('blur', blur)
    releaseSource()
  }
  return { sync, setPaused(value) { paused = value; sync() }, dispose }
}
