import { nativeTheme, systemPreferences } from 'electron'
import type { PluginPreferredColorScheme, ThemePack } from '@shared/types/plugin'
import type {
  AppearanceSettings,
  AppearanceSnapshot,
  ResolvedAppearance,
  ThemeIdentity,
  ThemePackV2,
  ThemeProfilePatch
} from '@shared/types/appearance'
import { completeLegacyPackBackground, declaredPalettePaints, patchThemeProfile, reconcileThemeProfile, resolveAppearance, themeProfileKey } from '@shared/theme/appearance'
import { DEFAULT_THEME_IDENTITY } from '@shared/theme/builtinThemes'
import { settingsStore } from '@main/settings/SettingsStore'
import { pluginRegistry } from '@main/plugin/PluginRegistry'
import { getAppPathsRoot } from '@main/paths/pathsService'
import type { HomeTransaction } from '@main/home/HomeSurfaceManager'
import { themePackRegistry } from '@main/theme/themePacks'
import { publicAppearanceFonts, publicAppearanceMedia } from './appearanceResources'

export interface AppearanceChange { revision: number; appearance: ResolvedAppearance }
type AppearanceListener = (change: AppearanceChange) => void

interface AppearanceInput {
  settings: AppearanceSettings
  packs: ThemePackV2[]
  pack: ThemePackV2 | null
  customFonts: AppearanceSnapshot['customFonts']
  systemDark: boolean
  reducedMotion: boolean
  performanceLimited: boolean
  appearanceInput: string
}

function isVersionTwo(pack: ThemePack): pack is ThemePackV2 {
  return (pack as Partial<ThemePackV2>).schemaVersion === 2
}

function findV2Pack(identity: ThemeIdentity, packs?: readonly ThemePack[]): ThemePackV2 | null {
  const pack = packs
    ? packs.find(pack => pack.source === identity.source && pack.id === identity.id)
    : themePackRegistry.getByIdentity(identity)
  return pack && isVersionTwo(pack) ? pack : null
}

function freezeTree<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const child of Object.values(value)) freezeTree(child)
  return value
}

function detached<T>(value: T): T {
  return freezeTree(structuredClone(value))
}

class AppearanceService {
  private revision = 0
  private publishedRevision = 0
  private contentKey = ''
  private cache = new Map<PluginPreferredColorScheme, ResolvedAppearance>()
  private inputKey = ''
  private inputCache: AppearanceInput | null = null
  private snapshotCache: AppearanceSnapshot | null = null
  private listeners = new Set<AppearanceListener>()
  private nativeThemeWatcherStarted = false
  private prepareHome: ((candidate: ResolvedAppearance) => Promise<HomeTransaction>) | null = null
  private activationQueue: Promise<unknown> = Promise.resolve()
  private activationGeneration = 0
  private performanceLimited = false

  setHomeCoordinator(prepare: (candidate: ResolvedAppearance) => Promise<HomeTransaction>): void {
    this.prepareHome = prepare
  }

  private startNativeThemeWatcher(): void {
    if (this.nativeThemeWatcherStarted) return
    this.nativeThemeWatcherStarted = true
    nativeTheme.on('updated', () => { this.refreshAppearance() })
  }

  private read(): AppearanceInput {
    const systemDark = nativeTheme.shouldUseDarkColors
    let reducedMotion = false
    try { reducedMotion = systemPreferences.getAnimationSettings().prefersReducedMotion } catch { /* Unsupported platform. */ }
    const performanceLimited = this.performanceLimited
    const installedRevision = pluginRegistry.getInstalledRevision()
    const dataRoot = getAppPathsRoot()
    const key = () => JSON.stringify([settingsStore.getAppearanceInputRevision(), themePackRegistry.getRevision(), installedRevision,
      dataRoot, systemDark, reducedMotion, performanceLimited])
    const inputKey = key()
    if (this.inputCache && this.inputKey === inputKey) return this.inputCache
    const stored = settingsStore.getAppearanceSettings()
    const allPacks = themePackRegistry.list()
    const settings = completeLegacyPackBackground(stored, allPacks)
    if (settings !== stored) settingsStore.commitAppearanceSettings(settings)
    const packs = allPacks.filter(isVersionTwo)
    const activeIdentity: ThemeIdentity = settings.active
    const pack = findV2Pack(activeIdentity, packs)
    const customFonts = settingsStore.getPluginAppearance().customFonts ?? []
    const appearanceInput = JSON.stringify({ settings, packs, customFonts, installedRevision, dataRoot, systemDark, reducedMotion, performanceLimited })
    // Legacy completion can commit settings while constructing this input.
    this.inputKey = key()
    this.inputCache = freezeTree({ settings, packs, pack, customFonts, systemDark, reducedMotion, performanceLimited, appearanceInput })
    return this.inputCache
  }

  getAppearance(preferred: PluginPreferredColorScheme = 'auto'): ResolvedAppearance {
    this.startNativeThemeWatcher()
    return detached(this.resolveInput(this.read(), preferred))
  }

  // Cache values stay private; each public getter detaches only its final DTO.
  private resolveInput(input: AppearanceInput, preferred: PluginPreferredColorScheme = 'auto'): ResolvedAppearance {
    const key = input.appearanceInput
    if (key !== this.contentKey) {
      this.contentKey = key
      this.revision++
      this.cache.clear()
      this.snapshotCache = null
    }
    const mode = preferred === 'light' || preferred === 'dark' ? preferred : 'auto'
    const cached = this.cache.get(mode)
    if (cached) return cached
    const settings: AppearanceSettings = mode === 'auto' ? input.settings : { ...input.settings, mode }
    const appearance = resolveAppearance({ ...input, settings })
    if (settings.recovery) appearance.diagnostics.push({ path: 'appearance.recovery', code: 'home.recovery', message: '配套主题或首页不可用，已回退到默认主题；原配置保留，可手动重试。' })
    // 只有当渲染结果确实来自该 pack 时，才放行它自己声明的配色画法；回退到内置主题时集合为空。
    const declaredPaints = appearance.theme.source === input.pack?.source && appearance.theme.id === input.pack?.id
      ? declaredPalettePaints(input.pack)
      : undefined
    const resolved = {
      ...appearance, revision: this.revision,
      background: { ...appearance.background, media: publicAppearanceMedia(appearance.background.media, declaredPaints) },
      splash: appearance.splash ? { ...appearance.splash, media: publicAppearanceMedia(appearance.splash.media, declaredPaints) } : { type: 'brand' as const, media: null, opacity: 0.55 },
      resources: { fonts: publicAppearanceFonts(appearance.fonts) },
    }
    this.cache.set(mode, freezeTree(resolved))
    return resolved
  }

  getAppearanceSnapshot(): AppearanceSnapshot {
    this.startNativeThemeWatcher()
    const input = this.read()
    const appearance = this.resolveInput(input)
    if (this.snapshotCache?.appearance === appearance) return detached(this.snapshotCache)
    const { settings, packs, customFonts } = input
    const identity = { source: appearance.theme.source, id: appearance.theme.id }
    const storedProfile = settings.profiles[themeProfileKey(identity)] ?? {
      identity, schemaVersion: 1, values: {}, colors: {}, quarantined: {}
    }
    const profile = reconcileThemeProfile(findV2Pack(identity, packs), storedProfile)
    this.snapshotCache = freezeTree({
      appearance,
      profile,
      packs,
      customFonts
    })
    return detached(this.snapshotCache)
  }

  async activateTheme(identity: ThemeIdentity, recovery?: AppearanceSettings['recovery'], canCommit?: () => boolean): Promise<AppearanceSnapshot> {
    const generation = ++this.activationGeneration
    const run = async (): Promise<AppearanceSnapshot> => {
      if (generation !== this.activationGeneration) return this.getAppearanceSnapshot()
      if (canCommit && !canCommit()) throw new Error('Theme activation owner is no longer active')
      return this.activateThemeUnserialized(identity, generation, recovery, canCommit)
    }
    const activation = this.activationQueue.catch(() => undefined).then(run)
    this.activationQueue = activation
    return activation
  }

  private async activateThemeUnserialized(identity: ThemeIdentity, generation: number, recovery?: AppearanceSettings['recovery'], canCommit?: () => boolean): Promise<AppearanceSnapshot> {
    const pack = findV2Pack(identity)
    if (!pack) throw new Error('Theme is unavailable')
    const settings = settingsStore.getAppearanceSettings()
    const input = this.read()
    const next: AppearanceSettings = { ...settings, active: { source: identity.source, id: identity.id } }
    const candidate = { ...resolveAppearance({
      settings: { ...next, mode: settings.mode },
      pack,
      systemDark: nativeTheme.shouldUseDarkColors,
      reducedMotion: input.reducedMotion,
      performanceLimited: input.performanceLimited
    }), revision: this.revision + 1 }
    const fallbackPack = findV2Pack(DEFAULT_THEME_IDENTITY)
    let selected = { next, candidate }
    let transaction: HomeTransaction | null = null
    let fault = recovery
    try {
      transaction = await this.prepareHome?.(candidate) ?? null
    } catch (error) {
      if (generation !== this.activationGeneration) return this.getAppearanceSnapshot()
      if (identity.source === fallbackPack?.source && identity.id === fallbackPack.id) throw error
      fault = { theme: identity, reason: (error instanceof Error ? error.message : '配套首页不可用').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 240) }
    }
    if (!transaction && identity.source === fallbackPack?.source && identity.id === fallbackPack.id) {
      throw new Error('Built-in fallback home is unavailable')
    }
    if (!transaction && fallbackPack) {
      selected = {
        next: { ...settings, active: { source: fallbackPack.source, id: fallbackPack.id } },
        candidate: {
          ...resolveAppearance({
            settings: { ...settings, active: { source: fallbackPack.source, id: fallbackPack.id }, mode: settings.mode },
            pack: fallbackPack,
            systemDark: nativeTheme.shouldUseDarkColors,
            reducedMotion: input.reducedMotion,
            performanceLimited: input.performanceLimited
          }),
          revision: this.revision + 1
        }
      }
      try {
        transaction = await this.prepareHome?.(selected.candidate) ?? null
      } catch (error) {
        throw new Error(`Theme and fallback home are unavailable: ${(error as Error).message}`)
      }
    }
    if (!transaction) throw new Error('Theme and fallback home are unavailable')
    if (generation !== this.activationGeneration || !findV2Pack(selected.next.active)) {
      transaction.rollback()
      return this.getAppearanceSnapshot()
    }
    if (canCommit && !canCommit()) {
      transaction.rollback()
      throw new Error('Theme activation owner is no longer active')
    }
    try {
      // Loading another provider may span concurrent mode/profile edits.
      const latest = settingsStore.getAppearanceSettings()
      settingsStore.commitAppearanceSettings({ ...latest, active: selected.next.active, recovery: fault })
    } catch (error) {
      transaction.rollback()
      throw error
    }
    transaction.commit()
    this.refreshAppearance()
    return this.getAppearanceSnapshot()
  }

  recoverToBuiltin(reason: string): Promise<AppearanceSnapshot> {
    const settings = settingsStore.getAppearanceSettings()
    const recovery = settings.recovery ?? { theme: settings.active, reason: reason.slice(0, 240) }
    return this.activateTheme(DEFAULT_THEME_IDENTITY, recovery)
  }

  retryRecovery(): Promise<AppearanceSnapshot> {
    const settings = settingsStore.getAppearanceSettings()
    return this.activateTheme(settings.recovery?.theme ?? settings.active)
  }

  hasRecovery(): boolean { return !!settingsStore.getAppearanceSettings().recovery }

  isActiveThemeAvailable(): boolean {
    const active = settingsStore.getAppearanceSettings().active
    return !!findV2Pack(active)
  }

  setPerformanceLimited(limited: boolean): AppearanceSnapshot {
    this.performanceLimited = limited
    this.refreshAppearance()
    return this.getAppearanceSnapshot()
  }

  setAppearanceMode(mode: NonNullable<AppearanceSettings['mode']>): AppearanceSnapshot {
    if (mode !== 'light' && mode !== 'dark' && mode !== 'system') throw new Error('Invalid appearance mode')
    const settings = settingsStore.getAppearanceSettings()
    if (settings.mode === mode) return this.getAppearanceSnapshot()
    settingsStore.commitAppearanceSettings({ ...settings, mode })
    this.refreshAppearance()
    return this.getAppearanceSnapshot()
  }

  updateThemeProfile(patch: ThemeProfilePatch): AppearanceSnapshot {
    // Read through the store on every call so concurrent windows merge fields
    // rather than replacing a profile bag from a stale snapshot.
    const settings = settingsStore.getAppearanceSettings()
    const pack = findV2Pack(patch.theme)
    if (!pack) throw new Error('Theme is unavailable')
    const key = themeProfileKey(patch.theme)
    const current = settings.profiles[key] ?? {
      identity: patch.theme,
      schemaVersion: pack.schemaVersion,
      values: {},
      colors: {},
      quarantined: {}
    }
    const profile = patchThemeProfile(pack, current, patch)
    const isActiveProfile = patch.theme.source === settings.active.source && patch.theme.id === settings.active.id
    const resetPerformanceLimit = isActiveProfile && Object.keys(patch.values ?? {}).some(key =>
      pack.settings.groups.some(group => group.fields.some(field => field.key === key && field.binding.target === 'animation')))
    const next: AppearanceSettings = {
      ...settings,
      revision: settings.revision + 1,
      profiles: { ...settings.profiles, [key]: profile }
    }

    settingsStore.commitAppearanceSettings(next)
    if (resetPerformanceLimit) this.performanceLimited = false
    this.refreshAppearance()
    return this.getAppearanceSnapshot()
  }

  refreshAppearance(): ResolvedAppearance {
    const appearance = this.getAppearance()
    if (appearance.revision === this.publishedRevision) return appearance
    this.publishedRevision = appearance.revision
    for (const listener of [...this.listeners]) {
      try { listener({ revision: appearance.revision, appearance }) }
      catch { /* A bad subscriber must not roll back the durable state change. */ }
    }
    return appearance
  }

  invalidate(): ResolvedAppearance { return this.refreshAppearance() }

  subscribeAppearance(listener: AppearanceListener): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
}

export const appearanceService = new AppearanceService()
appearanceService.setHomeCoordinator(candidate => import('@main/home/HomeSurfaceManager').then(module => module.homeSurfaceManager.prepare(candidate)))
export const getAppearance = (preferred: PluginPreferredColorScheme = 'auto'): ResolvedAppearance => appearanceService.getAppearance(preferred)
