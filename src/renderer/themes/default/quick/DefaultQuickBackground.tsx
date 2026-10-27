import { useAppearanceStore } from '@renderer/hooks/useAppearance'
import { DefaultThemeBackground } from '@renderer/themes/default/DefaultThemeBackground'

/** The embedded builtin can reuse host-published media resources without exposing them to a theme iframe. */
export function DefaultQuickBackground({ active }: { active: boolean }) {
  const appearance = useAppearanceStore(state => state.presentation)
  const hydrated = useAppearanceStore(state => state.hydrated)
  if (!hydrated) return <div className="app-bg" style={{ background: 'var(--bg)' }} aria-hidden />
  return <DefaultThemeBackground appearance={appearance} paused={!active} />
}
