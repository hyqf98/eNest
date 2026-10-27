/**
 * useAppearance — revisioned appearance authority for shell renderer surfaces.
 * The store never recomputes the winning theme; it applies snapshots from main.
 */
import { create } from 'zustand'
import type { AppearanceSnapshot, ThemeProfilePatch } from '@shared/types/appearance'
import { shellApi } from '@renderer/services/shellApi'
import { notify } from '@renderer/services/notifyService'
import { applyAppearanceToDom } from '@renderer/services/appearanceDom'
import { migrateAppearanceSettings, resolveAppearance, themeProfileKey } from '@shared/theme/appearance'
import { BUILTIN_THEME_PACKS } from '@shared/theme/builtinThemes'

type AppearancePresentation = Readonly<Omit<AppearanceSnapshot['appearance'], 'revision' | 'diagnostics'>>

interface AppearanceState extends AppearanceSnapshot {
  readonly presentation: AppearancePresentation
  hydrated: boolean
  hydrate: () => Promise<void>
  refresh: () => Promise<void>
  applySnapshot: (snapshot: AppearanceSnapshot) => void
  updateThemeProfile: (patch: ThemeProfilePatch) => Promise<void>
  activateTheme: (identity: { source: string; id: string }) => Promise<void>
  setMode: (mode: 'light' | 'dark' | 'system') => Promise<void>
}

let hydration: Promise<void> | null = null
let refreshFlight: Promise<void> | null = null
let refreshRequested = false
const initialSettings = migrateAppearanceSettings(undefined, { theme: { mode: 'system', overrides: {} }, general: {} })
const initialAppearance = resolveAppearance({ settings: initialSettings, pack: BUILTIN_THEME_PACKS[0], systemDark: false })

function presentationOf(appearance: AppearanceSnapshot['appearance']): AppearancePresentation {
  const { revision: _revision, diagnostics: _diagnostics, ...presentation } = appearance
  return Object.freeze(presentation)
}

function retainSnapshotValue<T>(current: T, incoming: T): T {
  return current === incoming || JSON.stringify(current) === JSON.stringify(incoming) ? current : incoming
}

export const useAppearanceStore = create<AppearanceState>((set, get) => ({
  appearance: initialAppearance,
  presentation: presentationOf(initialAppearance),
  profile: initialSettings.profiles[themeProfileKey(initialSettings.active)],
  packs: [],
  customFonts: [],
  hydrated: false,

  hydrate: () => {
    if (hydration) return hydration
    if (get().hydrated) return Promise.resolve()
    hydration = get().refresh().finally(() => { hydration = null })
    return hydration
  },

  refresh: () => {
    refreshRequested = true
    if (refreshFlight) return refreshFlight
    const flight: Promise<void> = Promise.resolve().then(async () => {
      do {
        refreshRequested = false
        try {
          const snapshot = await shellApi.getAppearance()
          if (!refreshRequested) get().applySnapshot(snapshot)
        } catch (error) {
          if (!refreshRequested) throw error
        }
      } while (refreshRequested)
    }).finally(() => {
      if (refreshFlight !== flight) return
      refreshFlight = null
      // An event can arrive between the loop settling and this promise cleanup.
      if (refreshRequested) return get().refresh()
    })
    refreshFlight = flight
    return flight
  },

  applySnapshot: (snapshot) => {
    const current = get()
    if (snapshot.appearance.revision < current.appearance.revision) return
    // Same-revision replies may still complete profile/catalog metadata after an event.
    const appearance = retainSnapshotValue(current.appearance, snapshot.appearance)
    // Keep the complete revisioned DTO authoritative while visual consumers ignore metadata churn.
    const presentation = retainSnapshotValue(current.presentation, presentationOf(appearance))
    const profile = retainSnapshotValue(current.profile, snapshot.profile)
    const packs = retainSnapshotValue(current.packs, snapshot.packs)
    const customFonts = retainSnapshotValue(current.customFonts, snapshot.customFonts)
    if (!current.hydrated || presentation !== current.presentation) applyAppearanceToDom(appearance)
    if (!current.hydrated || appearance !== current.appearance || profile !== current.profile || packs !== current.packs || customFonts !== current.customFonts) {
      set({ appearance, presentation, profile, packs, customFonts, hydrated: true })
    }
  },

  updateThemeProfile: async (patch) => {
    try {
      const snapshot = await shellApi.updateThemeProfile(patch)
      get().applySnapshot(snapshot)
    } catch (error) {
      await get().refresh().catch(() => undefined)
      notify.error('主题设置未保存，请重试')
      throw error
    }
  },

  activateTheme: async (identity) => {
    try {
      get().applySnapshot(await shellApi.activateTheme(identity))
    } catch (error) {
      await get().refresh().catch(() => undefined)
      notify.error('主题切换未保存，请重试')
      throw error
    }
  },

  setMode: async (mode) => {
    try {
      get().applySnapshot(await shellApi.setAppearanceMode(mode))
    } catch (error) {
      await get().refresh().catch(() => undefined)
      notify.error('深浅模式未保存，请重试')
      throw error
    }
  }
}))
