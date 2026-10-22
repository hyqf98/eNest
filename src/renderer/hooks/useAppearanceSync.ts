/** Keep independent shell surfaces in sync without persisting settings again. */
import { useEffect } from 'react'
import { shellApi } from '@renderer/services/shellApi'
import { useAppearanceStore } from '@renderer/hooks/useAppearance'

const APPEARANCE_RESOURCES = new Set(['customFonts', 'dataRoot'])

/** Subscribe before hydration so startup cannot miss an authoritative snapshot. */
export function useAppearanceSync(): void {
  useEffect(() => {
    const off = shellApi.onEvent((payload) => {
      if (payload.type === 'appearance-changed') {
        const current = useAppearanceStore.getState()
        const identity = payload.appearance.theme
        const sameProfile = current.profile.identity.source === identity.source && current.profile.identity.id === identity.id
        useAppearanceStore.getState().applySnapshot({
          appearance: payload.appearance,
          profile: sameProfile ? current.profile : { identity: { source: identity.source, id: identity.id }, schemaVersion: 2, values: {}, colors: {}, quarantined: {} },
          packs: current.packs,
          customFonts: current.customFonts
        })
        void useAppearanceStore.getState().refresh().catch(() => undefined)
      } else if (payload.type === 'theme-changed' || payload.type === 'theme-packs-changed') {
        void useAppearanceStore.getState().refresh().catch(() => undefined)
      } else if (payload.type === 'settings-changed') {
        if (payload.generalKeys.some((key) => APPEARANCE_RESOURCES.has(key))) {
          void useAppearanceStore.getState().refresh().catch(() => undefined)
        }
      }
    })
    void useAppearanceStore.getState().hydrate().catch(() => undefined)
    return off
  }, [])
}
