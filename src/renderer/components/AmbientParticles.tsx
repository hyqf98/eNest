/** Compatibility slot: Quick and shell use the same selected background. */
import { useEffect } from 'react'
import { useBackgroundEffect } from '@renderer/hooks/useBackgroundEffect'
import { useThemeStore } from '@renderer/hooks/useTheme'
import { backgroundAtmosphereStyle, syncBackgroundAtmosphereTheme } from './backgroundAtmosphere'
import { BackgroundEffect } from './BackgroundEffect'
import '@renderer/styles/ambient.css'

export function AmbientParticles({ paused = false }: { paused?: boolean }) {
  const effect = useBackgroundEffect()
  const background = useThemeStore((state) => state.background)
  const atmosphere = backgroundAtmosphereStyle(background)
  useEffect(() => { syncBackgroundAtmosphereTheme(document.documentElement, background) }, [background])
  useEffect(() => () => syncBackgroundAtmosphereTheme(document.documentElement, null), [])
  if (effect) return <BackgroundEffect effect={effect} paused={paused} className="ambient-particles ambient-flow" />
  return atmosphere ? <div className="ambient-particles ambient-flow" aria-hidden>
    <div className="background-atmosphere" style={atmosphere} />
  </div> : null
}
