import { useAppearanceStore } from '@renderer/hooks/useAppearance'
import { DefaultThemeSplash } from '@renderer/themes/default/DefaultThemeSplash'
import { PaperSplash } from '@renderer/themes/default/PaperSplash'

/** Themes select host-rendered launch presets without taking over startup readiness. */
export function Splash(props: { onDone: () => void; preview?: boolean; ready?: boolean }) {
  const appearance = useAppearanceStore(state => state.presentation)
  const hydrated = useAppearanceStore(state => state.hydrated)
  if (!hydrated) return <div className="splash" data-ready="false" style={{ background: 'var(--bg)' }} aria-hidden />
  if (appearance.splash.type === 'paper') return <PaperSplash {...props} appearance={appearance} hydrated={hydrated} />
  return <DefaultThemeSplash {...props} appearance={appearance} hydrated={hydrated} />
}
