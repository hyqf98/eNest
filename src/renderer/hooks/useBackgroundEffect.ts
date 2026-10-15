import { useMemo } from 'react'
import { resolveBackgroundEffect } from '@shared/backgroundEffects'
import { useThemeStore } from '@renderer/hooks/useTheme'

/** Resolve the selected ID against the current registry, including plugin removal. */
export function useBackgroundEffect() {
  const selection = useThemeStore((state) => state.backgroundEffect)
  const packs = useThemeStore((state) => state.packs)
  return useMemo(() => resolveBackgroundEffect(selection, packs), [selection, packs])
}
