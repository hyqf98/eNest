/** Reconcile, quarantine and patch source-owned theme profiles against the active pack schema. */
import type {
  AppearanceColorMode,
  ThemeColorToken,
  ThemeIdentity,
  ThemePackV2,
  ThemeProfile,
  ThemeProfilePatch,
  ThemeSettingValue,
  ThemeSettingsField,
} from '@shared/types/appearance'
import { DEFAULT_BACKGROUND_PALETTES } from '@shared/theme/defaultTheme/backgroundPalettes'
import { parseThemeColor } from '@shared/theme/colors'
import { DEFAULT_THEME_IDENTITY } from '@shared/theme/builtinThemes'
import {
  APPEARANCE_SCHEMA_VERSION,
  type Bag,
  COLOR_MODES,
  fail,
  identity,
  LEGACY_BACKGROUND_PENDING,
  object,
  plainClone,
  RESERVED_KEYS,
  SAFE_ID,
  SOURCE_ID,
  THEME_PROFILE_LEGACY,
  TOKEN_KEYS,
} from './appearanceValues'
import { defaultValueMatchesField } from './appearanceSchema'

export function safeIdentity(value: unknown, fallback: ThemeIdentity): ThemeIdentity {
  try {
    const result = identity(value, 'identity')
    return result
  } catch {
    return plainClone(fallback)
  }
}

/** A prefixed, encoded key prevents source/id text from colliding with Object prototypes. */
export function themeProfileKey(identity: ThemeIdentity): string {
  const result = identity ?? fail('identity is required')
  if (!SOURCE_ID.test(result.source) || !SAFE_ID.test(result.id)) fail('identity is invalid')
  return `v2:${encodeURIComponent(result.source)}:${encodeURIComponent(result.id)}`
}

export function validSettingValue(field: ThemeSettingsField, value: unknown, source: string, paletteIds?: ReadonlySet<string>): boolean {
  return defaultValueMatchesField(field, value as ThemeSettingValue, source, true, paletteIds)
}

/** Every id a profile value may legally name: built-ins plus the pack's own declarations. */
function paletteIdsFor(pack: ThemePackV2): ReadonlySet<string> {
  return new Set<string>([
    ...DEFAULT_BACKGROUND_PALETTES.map(palette => palette.id),
    ...(pack.palettes ?? []).map(palette => palette.id),
  ])
}

export function fieldsFor(pack: ThemePackV2): Map<string, ThemeSettingsField> {
  return new Map(pack.settings.groups.flatMap(group => group.fields).map(field => [field.key, field]))
}

export function quarantine(profile: ThemeProfile, key: string, value: unknown, reason: string): void {
  if (!Object.hasOwn(profile.quarantined, key)) {
    profile.quarantined[key] = { value: plainClone(value), reason, schemaVersion: profile.schemaVersion }
  }
}

export function cleanProfileShell(identity: ThemeIdentity, schemaVersion: number): ThemeProfile {
  return { identity: plainClone(identity), schemaVersion, values: Object.create(null), colors: {}, quarantined: Object.create(null) }
}

/** Keep only values supported by the current pack; recover previously quarantined valid upgrades. */
export function reconcileThemeProfile(pack: ThemePackV2 | null, profile: ThemeProfile): ThemeProfile {
  const currentIdentity = safeIdentity(profile.identity, THEME_PROFILE_LEGACY)
  const result = cleanProfileShell(currentIdentity, APPEARANCE_SCHEMA_VERSION)
  Object.assign(result.quarantined, plainClone(profile.quarantined ?? Object.create(null)))
  const colorsIn = profile.colors ?? {}
  for (const mode of COLOR_MODES) {
    const modeColors = object(colorsIn[mode] ?? {}, `profile.colors.${mode}`)
    result.colors[mode] = {}
    for (const [key, value] of Object.entries(modeColors)) {
      if (!TOKEN_KEYS.has(key) || typeof value !== 'string' || !parseThemeColor(value)) {
        quarantine(result, `colors.${mode}.${key}`, value, 'invalid-or-unsupported-color')
      } else {
        result.colors[mode]![key as ThemeColorToken] = value
      }
    }
  }
  if (!pack) {
    for (const [key, value] of Object.entries(profile.values ?? {})) {
      quarantine(result, `values.${key}`, value, 'theme-unavailable')
    }
    return result
  }
  if (pack.source !== currentIdentity.source || pack.id !== currentIdentity.id) return result
  result.schemaVersion = pack.schemaVersion
  const fields = fieldsFor(pack)
  const paletteIds = paletteIdsFor(pack)
  for (const [key, value] of Object.entries(profile.values ?? {})) {
    const field = fields.get(key)
    if (!field) {
      quarantine(result, `values.${key}`, value, 'field-removed')
      continue
    }
    if (!validSettingValue(field, value, pack.source, paletteIds)) {
      quarantine(result, `values.${key}`, value, 'field-invalid')
      continue
    }
    result.values[key] = plainClone(value) as ThemeSettingValue
  }
  for (const [key, entry] of Object.entries(result.quarantined)) {
    const match = /^values\.(.+)$/.exec(key)
    const field = match ? fields.get(match[1]) : undefined
    if (field && validSettingValue(field, entry.value, pack.source, paletteIds)) {
      if (!Object.hasOwn(result.values, field.key)) result.values[field.key] = plainClone(entry.value) as ThemeSettingValue
      delete result.quarantined[key]
    }
  }
  return result
}

function patchColors(
  colors: ThemeProfile['colors'],
  patch: NonNullable<ThemeProfilePatch['colors']>,
): ThemeProfile['colors'] {
  const result = plainClone(colors)
  for (const rawMode of Object.keys(patch)) {
    if (!COLOR_MODES.includes(rawMode as AppearanceColorMode)) throw new Error('invalid theme profile color mode')
    const mode = rawMode as AppearanceColorMode
    const incoming = patch[mode] && typeof patch[mode] === 'object' && !Array.isArray(patch[mode]) ? patch[mode] as Bag : fail(`colors.${mode} must be an object`)
    if (Reflect.ownKeys(incoming).some(key => typeof key !== 'string' || RESERVED_KEYS.has(key))) {
      throw new Error(`colors.${mode} contains a reserved key`)
    }
    result[mode] = { ...(result[mode] ?? {}) }
    for (const [key, value] of Object.entries(incoming)) {
      if (!TOKEN_KEYS.has(key)) throw new Error(`invalid theme color token "${key}"`)
      if (value === null) delete result[mode]![key as ThemeColorToken]
      else if (typeof value === 'string' && parseThemeColor(value)) result[mode]![key as ThemeColorToken] = value
      else throw new Error(`invalid theme color value "${key}"`)
    }
  }
  return result
}

/** Apply one atomic field-level patch; a bad field cannot partially mutate the profile. */
export function patchThemeProfile(
  pack: ThemePackV2 | null,
  profile: ThemeProfile,
  patch: ThemeProfilePatch,
): ThemeProfile {
  const patchIdentity = identity(patch.theme, 'patch.theme')
  if (pack && (pack.source !== patchIdentity.source || pack.id !== patchIdentity.id)) {
    throw new Error('theme patch identity does not match pack')
  }
  if (patchIdentity.source !== profile.identity.source || patchIdentity.id !== profile.identity.id) {
    throw new Error('theme patch identity does not match profile')
  }
  if (patch.reset) {
    const reset = cleanProfileShell(patchIdentity, pack?.schemaVersion ?? APPEARANCE_SCHEMA_VERSION)
    if (patchIdentity.source === DEFAULT_THEME_IDENTITY.source && patchIdentity.id === DEFAULT_THEME_IDENTITY.id) {
      const values = reconcileThemeProfile(pack, profile).values
      for (const key of ['tabStyle', 'tabOpacity', 'tabAutoHide']) {
        if (Object.hasOwn(values, key)) reset.values[key] = plainClone(values[key])
      }
    }
    return reset
  }
  const base = reconcileThemeProfile(pack, profile)
  const next: ThemeProfile = {
    ...base,
    values: plainClone(base.values),
    colors: base.colors,
    quarantined: plainClone(base.quarantined),
  }
  if (patch.values !== undefined) {
    const incoming = object(patch.values, 'patch.values')
    const fields = pack ? fieldsFor(pack) : new Map<string, ThemeSettingsField>()
    const paletteIds = pack ? paletteIdsFor(pack) : undefined
    for (const [key, value] of Object.entries(incoming)) {
      const field = fields.get(key)
      if (!field) throw new Error(`unknown theme setting "${key}"`)
      if (!validSettingValue(field, value, pack!.source, paletteIds)) throw new Error(`invalid theme setting "${key}"`)
      next.values[key] = plainClone(value) as ThemeSettingValue
      if (field.binding.target === 'background') delete next.quarantined[LEGACY_BACKGROUND_PENDING]
    }
  }
  if (patch.colors !== undefined) next.colors = patchColors(next.colors, patch.colors)
  return next
}
