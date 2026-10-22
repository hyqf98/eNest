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

interface AppearanceState extends AppearanceSnapshot {
  hydrated: boolean
  hydrate: () => Promise<void>
  refresh: () => Promise<void>
  applySnapshot: (snapshot: AppearanceSnapshot) => void
  updateThemeProfile: (patch: ThemeProfilePatch) => Promise<void>
  activateTheme: (identity: { source: string; id: string }) => Promise<void>
  setMode: (mode: 'light' | 'dark' | 'system') => Promise<void>
}

let readVersion = 0
let hydration: Promise<void> | null = null
const initialSettings = migrateAppearanceSettings(undefined, { theme: { mode: 'system', overrides: {} }, general: {} })

export const useAppearanceStore = create<AppearanceState>((set, get) => ({
  appearance: resolveAppearance({ settings: initialSettings, pack: BUILTIN_THEME_PACKS[0], systemDark: false }),
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

  refresh: async () => {
    const version = ++readVersion
    const snapshot = await shellApi.getAppearance()
    if (version !== readVersion) return
    get().applySnapshot(snapshot)
  },

  applySnapshot: (snapshot) => {
    if (snapshot.appearance.revision < get().appearance.revision) return
    applyAppearanceToDom(snapshot.appearance)
    set({ ...snapshot, hydrated: true })
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
