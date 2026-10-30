/** Migrate legacy appearance and background selections while preserving saved profiles and recovery data. */
import type { AppearanceColorMode, AppearanceSettings, LegacyAppearanceBackup, ThemeColorToken, ThemeProfile, ThemeSettingValue } from '@shared/types/appearance'
import type { AnimationLevel, BackgroundConfig, ThemePack } from '@shared/types/plugin'
import { backgroundPaletteForCss } from '@shared/theme/defaultTheme/backgroundPalettes'
import { parseThemeColor } from '@shared/theme/colors'
import { BUILTIN_THEME_PACKS, BUILTIN_THEME_SOURCE, DEFAULT_THEME_IDENTITY } from '@shared/theme/builtinThemes'
import {
  ANIMATION_LEVELS,
  APPEARANCE_SCHEMA_VERSION,
  backgroundConfig,
  type Bag,
  COLOR_MODES,
  exactObject,
  identity,
  LEGACY_BACKGROUND_PENDING,
  LEGACY_BACKGROUND_PENDING_REASON,
  numberInRange,
  object,
  plainClone,
  SAFE_ID,
  SOURCE_ID,
  SPLASH_TYPES,
  text,
  THEME_PROFILE_LEGACY,
  TOKEN_KEYS,
  validMode,
  validTabStyle,
} from './appearanceValues'
import { cleanProfileShell, fieldsFor, quarantine, reconcileThemeProfile, safeIdentity, themeProfileKey, validSettingValue } from './appearanceProfiles'

function safeLegacy(value: unknown): LegacyAppearanceBackup {
  const bag = object(value, 'legacy appearance')
  const themeBag = object(bag.theme, 'legacy appearance.theme')
  const theme = {
    ...themeBag,
    mode: validMode(themeBag.mode) ? themeBag.mode : 'light',
    overrides: themeBag.overrides && typeof themeBag.overrides === 'object' && !Array.isArray(themeBag.overrides) ? themeBag.overrides : {},
  } as LegacyAppearanceBackup['theme']
  const generalBag = object(bag.general, 'legacy appearance.general')
  return plainClone({
    theme,
    general: {
      ...(validTabStyle(generalBag.tabStyle) ? { tabStyle: generalBag.tabStyle } : {}),
      fontFamily: typeof generalBag.fontFamily === 'string' ? generalBag.fontFamily : '',
      fontFamilyEn: typeof generalBag.fontFamilyEn === 'string' ? generalBag.fontFamilyEn : '',
      fontSizeScale: typeof generalBag.fontSizeScale === 'number' && Number.isFinite(generalBag.fontSizeScale)
        ? Math.max(0.9, Math.min(1.3, generalBag.fontSizeScale)) : 1,
      animationLevel: ANIMATION_LEVELS.includes(generalBag.animationLevel as AnimationLevel)
        ? generalBag.animationLevel as AnimationLevel : 'medium',
      splashBackground: generalBag.splashBackground && typeof generalBag.splashBackground === 'object'
        ? generalBag.splashBackground as LegacyAppearanceBackup['general']['splashBackground'] : { type: 'brand', opacity: 0.55 },
    },
  })
}

function legacyProfile(legacy: LegacyAppearanceBackup): ThemeProfile {
  const colors: ThemeProfile['colors'] = {}
  for (const mode of COLOR_MODES) {
    const source = legacy.theme.overrides[mode] ?? {}
    const modeColors: Partial<Record<ThemeColorToken, string>> = {}
    for (const key of Object.keys(source)) {
      if (TOKEN_KEYS.has(key) && typeof source[key as ThemeColorToken] === 'string') {
        modeColors[key as ThemeColorToken] = source[key as ThemeColorToken]
      }
    }
    colors[mode] = modeColors
  }
  return {
    identity: plainClone(THEME_PROFILE_LEGACY),
    schemaVersion: APPEARANCE_SCHEMA_VERSION,
    values: Object.create(null),
    colors,
    quarantined: Object.create(null),
  }
}

function migrateBackground(values: ThemeProfile['values'], media: unknown, slot: 'background' | 'splash'): void {
  if (!media || typeof media !== 'object' || Array.isArray(media)) return
  const input = media as Bag
  const opacity = typeof input.opacity === 'number' && Number.isFinite(input.opacity) ? Math.max(0, Math.min(1, input.opacity)) : slot === 'background' ? 0.85 : 0.55
  const fit = input.fit === 'contain' ? 'contain' : 'cover'
  if (slot === 'splash') {
    if (!SPLASH_TYPES.has(String(input.type))) return
    values.splashType = input.type as string
    values.splashOpacity = opacity
    if (input.type === 'image' && typeof input.value === 'string' && input.value) {
      values.splashMedia = { type: 'image', value: 'enest://appearance/legacy/splash', opacity, fit }
    }
    return
  }
  if (!['none', 'color', 'image', 'video'].includes(String(input.type))) return
  values.backgroundType = input.type as string
  values.backgroundOpacity = opacity
  values.backgroundFit = fit
  if (input.type === 'color') {
    const palette = backgroundPaletteForCss(input.value)
    if (palette) { values.backgroundType = 'gradient'; values.backgroundPalette = palette.id }
    else if (typeof input.value === 'string' && parseThemeColor(input.value)) values.backgroundColor = input.value
    else values.backgroundType = 'none'
  } else if ((input.type === 'image' || input.type === 'video') && typeof input.value === 'string' && input.value) {
    values.media = { type: input.type, value: 'enest://appearance/legacy/background', opacity, fit }
  }
}

/** Seed once. Existing default profiles, including intentionally reset ones, always win. */
function seedDefaultProfile(legacy: LegacyAppearanceBackup, previous?: ThemeProfile): ThemeProfile {
  const pack = BUILTIN_THEME_PACKS[0]
  const result = cleanProfileShell(DEFAULT_THEME_IDENTITY, APPEARANCE_SCHEMA_VERSION)
  const fields = fieldsFor(pack)
  const set = (key: string, value: unknown): void => {
    const field = fields.get(key)
    if (field && validSettingValue(field, value, BUILTIN_THEME_SOURCE)) result.values[key] = plainClone(value) as ThemeSettingValue
    else if (value !== undefined) quarantine(result, `values.${key}`, value, 'legacy-value-unsupported')
  }
  set('fontFamily', legacy.general.fontFamily ?? '')
  set('fontFamilyEn', legacy.general.fontFamilyEn ?? '')
  set('fontScale', legacy.general.fontSizeScale ?? 1)
  set('motion', legacy.general.animationLevel ?? 'medium')
  if (validTabStyle(legacy.general.tabStyle)) set('tabStyle', legacy.general.tabStyle)
  set('backgroundEffect', legacy.theme.backgroundEffect ?? 'tunnel')
  const pendingPackBackground = legacy.theme.backgroundSource === 'pack' || (
    legacy.theme.backgroundSource === undefined && !legacy.theme.background && Boolean(legacy.theme.packId)
  )
  if (pendingPackBackground) {
    if (typeof legacy.theme.packId === 'string' && SAFE_ID.test(legacy.theme.packId)) {
      quarantine(result, LEGACY_BACKGROUND_PENDING, legacy.theme.packId, LEGACY_BACKGROUND_PENDING_REASON)
    }
  } else migrateBackground(result.values, legacy.theme.background, 'background')
  migrateBackground(result.values, legacy.general.splashBackground, 'splash')
  const legacyColors = legacyProfile(legacy).colors
  for (const mode of COLOR_MODES) {
    result.colors[mode] = {}
    for (const [key, value] of Object.entries({ ...legacyColors[mode], ...previous?.colors[mode] })) {
      if (TOKEN_KEYS.has(key) && typeof value === 'string' && parseThemeColor(value)) result.colors[mode]![key as ThemeColorToken] = value
      else quarantine(result, `colors.${mode}.${key}`, value, 'legacy-color-unsupported')
    }
  }
  const aliases: Record<string, string> = { bodyFont: 'fontFamily', accent: 'colorAccent', canvasColor: 'colorBg', textColor: 'colorText' }
  for (const [oldKey, value] of Object.entries(previous?.values ?? {})) {
    const key = aliases[oldKey] ?? oldKey
    const field = fields.get(key)
    if (!field) continue
    if (field.binding.target === 'token' && typeof value === 'string' && parseThemeColor(value)) {
      for (const mode of COLOR_MODES) {
        if (!Object.hasOwn(previous?.colors[mode] ?? {}, field.binding.key)) result.colors[mode]![field.binding.key] = value
      }
    } else if (key === 'media' && value && typeof value === 'object') {
      if (validSettingValue(field, value, BUILTIN_THEME_SOURCE)) {
        result.values.media = plainClone(value)
        const config = value as BackgroundConfig
        result.values.backgroundType = config.type === 'color' ? backgroundPaletteForCss(config.value) ? 'gradient' : 'color' : config.type
        result.values.backgroundOpacity = config.opacity
        result.values.backgroundFit = config.fit
        if (config.type === 'color') {
          if (backgroundPaletteForCss(config.value)) result.values.backgroundPalette = backgroundPaletteForCss(config.value)!.id
          else result.values.backgroundColor = config.value
        }
      }
    } else set(key, value)
    if (field.binding.target === 'background' && validSettingValue(field, value, BUILTIN_THEME_SOURCE)) delete result.quarantined[LEGACY_BACKGROUND_PENDING]
  }
  if (previous?.values.background === false) result.values.backgroundEffect = 'none'
  return reconcileThemeProfile(pack, result)
}

/**
 * Keep extension selections and every saved profile. Retired host selections
 * converge on the single default; the original legacy snapshot remains immutable.
 */
export function migrateAppearanceSettings(
  existing: unknown,
  legacy: LegacyAppearanceBackup,
): AppearanceSettings {
  const firstLegacy = safeLegacy(legacy)
  const raw = existing && typeof existing === 'object' && !Array.isArray(existing) ? existing as Bag : {}
  const stored = raw.version === 2 ? raw : {}
  const storedLegacy = stored.legacy === undefined ? firstLegacy : safeLegacy(stored.legacy)
  const backupLegacy = stored.legacyBackup === undefined ? storedLegacy : safeLegacy(stored.legacyBackup)
  const previousProfiles = stored.profiles ?? {}
  const profiles: Record<string, ThemeProfile> = Object.create(null)
  for (const [rawKey, rawProfile] of Object.entries(previousProfiles)) {
    if (!rawKey.startsWith('v2:')) continue
    const profileBag = object(rawProfile, `appearance.profiles.${rawKey}`)
    const storedIdentity = safeIdentity(profileBag.identity, THEME_PROFILE_LEGACY)
    const expectedKey = themeProfileKey(storedIdentity)
    if (expectedKey !== rawKey) continue
    const values = object(profileBag.values ?? {}, `appearance.profiles.${rawKey}.values`)
    const rawColors = object(profileBag.colors ?? {}, `appearance.profiles.${rawKey}.colors`)
    const colors: ThemeProfile['colors'] = {}
    for (const mode of COLOR_MODES) {
      if (!(mode in rawColors)) continue
      colors[mode] = Object.fromEntries(Object.entries(object(rawColors[mode], `appearance.profiles.${rawKey}.colors.${mode}`))
        .filter(([key, value]) => TOKEN_KEYS.has(key) && typeof value === 'string')) as ThemeProfile['colors'][AppearanceColorMode]
    }
    const rawQuarantine = object(profileBag.quarantined ?? {}, `appearance.profiles.${rawKey}.quarantined`)
    const quarantined: ThemeProfile['quarantined'] = Object.create(null)
    for (const [key, entry] of Object.entries(rawQuarantine).slice(0, 256)) {
      const entryBag = object(entry, `appearance.profiles.${rawKey}.quarantined.${key}`)
      if (typeof entryBag.reason !== 'string' || typeof entryBag.schemaVersion !== 'number') continue
      quarantined[key] = { value: plainClone(entryBag.value), reason: entryBag.reason, schemaVersion: entryBag.schemaVersion }
    }
    profiles[rawKey] = { identity: storedIdentity, schemaVersion: 2, values: plainClone(values) as ThemeProfile['values'], colors, quarantined }
  }
  const legacyKey = themeProfileKey(THEME_PROFILE_LEGACY)
  if (!profiles[legacyKey]) profiles[legacyKey] = legacyProfile(storedLegacy)
  const defaultKey = themeProfileKey(DEFAULT_THEME_IDENTITY)
  const hadDefaultProfile = Object.hasOwn(profiles, defaultKey)
  const requestedActive = safeIdentity(stored.active, DEFAULT_THEME_IDENTITY)
  const active = requestedActive.source === BUILTIN_THEME_SOURCE ? plainClone(DEFAULT_THEME_IDENTITY) : requestedActive
  const activeKey = themeProfileKey(active)
  if (!profiles[activeKey]) profiles[activeKey] = cleanProfileShell(active, APPEARANCE_SCHEMA_VERSION)
  if (!hadDefaultProfile) profiles[defaultKey] = seedDefaultProfile(storedLegacy, requestedActive.source === BUILTIN_THEME_SOURCE ? profiles[themeProfileKey(requestedActive)] : undefined)
  const revision = typeof stored.revision === 'number' && Number.isSafeInteger(stored.revision) && stored.revision >= 0
    ? stored.revision : 0
  const mode = validMode(stored.mode) ? stored.mode : storedLegacy.theme.mode
  let recovery: AppearanceSettings['recovery']
  try {
    if (stored.recovery !== undefined) {
      const bag = exactObject(stored.recovery, 'appearance.recovery', new Set(['theme', 'reason']))
      recovery = { theme: identity(bag.theme, 'appearance.recovery.theme'), reason: text(bag.reason, 'appearance.recovery.reason', 240) }
    }
  } catch {
    // A corrupt recovery record must not prevent the known-good theme from loading.
  }
  return {
    version: APPEARANCE_SCHEMA_VERSION,
    revision,
    mode,
    active,
    profiles,
    legacyBackup: plainClone(backupLegacy),
    legacy: plainClone(storedLegacy),
    ...(recovery ? { recovery } : {}),
  }
}

/** Finish only a first-seed pack choice once its source-bound registry is available. */
export function completeLegacyPackBackground(settings: AppearanceSettings, packs: readonly ThemePack[]): AppearanceSettings {
  const key = themeProfileKey(DEFAULT_THEME_IDENTITY)
  const profile = settings.profiles[key]
  const pending = profile?.quarantined[LEGACY_BACKGROUND_PENDING]
  if (!pending || pending.reason !== LEGACY_BACKGROUND_PENDING_REASON || typeof pending.value !== 'string') return settings
  const pack = packs.find(candidate => candidate.id === pending.value)
  if (!pack || pack.source === BUILTIN_THEME_SOURCE || !SOURCE_ID.test(pack.source)) return settings
  let media: BackgroundConfig
  try {
    if (pack.background === undefined) media = { type: 'none', value: '', opacity: 0.85, fit: 'cover' }
    else if (pack.background.type === 'none') {
      const bag = exactObject(pack.background, 'legacy pack background', new Set(['type', 'value', 'opacity', 'fit']))
      if (bag.value !== '' || bag.fit !== 'cover' && bag.fit !== 'contain') return settings
      media = { type: 'none', value: '', opacity: numberInRange(bag.opacity, 'legacy pack background.opacity', 0, 1), fit: bag.fit }
    } else media = backgroundConfig(pack.background, 'legacy pack background', pack.source)
  } catch {
    // Missing/invalid source data cannot prevent the known-good default from loading.
    return settings
  }
  const values: ThemeProfile['values'] = Object.create(null)
  if (media.type === 'image' || media.type === 'video') {
    Object.assign(values, { backgroundType: media.type, media, backgroundOpacity: media.opacity, backgroundFit: media.fit })
  } else migrateBackground(values, media, 'background')
  const quarantined = { ...profile.quarantined }
  delete quarantined[LEGACY_BACKGROUND_PENDING]
  const completed = reconcileThemeProfile(BUILTIN_THEME_PACKS[0], {
    ...profile, values: { ...values, ...profile.values }, quarantined,
  })
  return { ...settings, revision: settings.revision + 1, profiles: { ...settings.profiles, [key]: completed } }
}
