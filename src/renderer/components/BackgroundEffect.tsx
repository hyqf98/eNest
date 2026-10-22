import type { ResolvedBackgroundEffect } from '@shared/backgroundEffects'
import { useAppearanceStore } from '@renderer/hooks/useAppearance'
import { DefaultBackgroundEffect } from '@renderer/themes/default/DefaultBackgroundEffect'

/** Trusted shell adapter; the default theme renderer itself has no shell API. */
export function BackgroundEffect(props: { effect: ResolvedBackgroundEffect; className?: string; launch?: boolean; paused?: boolean }) {
  const appearance = useAppearanceStore(state => state.appearance)
  return <DefaultBackgroundEffect {...props} level={appearance.animation.effective} background={appearance.background.media} />
}
