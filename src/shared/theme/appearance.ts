/** Resolve the authoritative appearance snapshot and CSS properties. Public exports remain stable across the pure contract modules. */
import type {
  AppearanceBackground,
  AppearanceColorMode,
  AppearanceComponents,
  AppearanceFonts,
  AppearanceLayout,
  AppearanceSettings,
  AppearanceSplash,
  ResolvedAppearance,
  ThemeBackgroundPaletteDeclaration,
  ThemePackV2,
  ThemeProfile,
  ThemeSettingValue,
  ThemeSettingsField,
  ThemeVariant,
} from '@shared/types/appearance'
import type { AnimationLevel } from '@shared/types/plugin'
import { backgroundPalette, paletteById } from '@shared/theme/defaultTheme/backgroundPalettes'
import { BUILTIN_THEME_PACKS, DEFAULT_THEME_IDENTITY } from '@shared/theme/builtinThemes'
import { resolveThemePalette } from '@shared/theme/presets'
import {
  ANIMATION_LEVELS,
  APPEARANCE_SCHEMA_VERSION,
  DEFAULT_APPEARANCE_SPLASH,
  DEFAULT_NOTIFICATION_STYLE,
  HOST_BASE,
  plainClone,
  THEME_HOME_LEGACY,
  validMode,
  validTabStyle,
} from './appearanceValues'
import { migrateAppearanceSettings } from './appearanceMigration'
import { cleanProfileShell, reconcileThemeProfile, themeProfileKey } from './appearanceProfiles'
export { DEFAULT_THEME_IDENTITY } from '@shared/theme/builtinThemes'
export {
  APPEARANCE_SCHEMA_VERSION,
  THEME_PROFILE_LEGACY,
  THEME_HOME_LEGACY,
  DEFAULT_APPEARANCE_SPLASH,
  DEFAULT_NOTIFICATION_STYLE,
} from './appearanceValues'
export { validateThemePackV2, declaredPalettePaints } from './appearanceSchema'
export { themeProfileKey, reconcileThemeProfile, patchThemeProfile } from './appearanceProfiles'
export { migrateAppearanceSettings, completeLegacyPackBackground } from './appearanceMigration'

type Diagnostic = ResolvedAppearance['diagnostics'][number]

/** Generic and system families resolve to a concrete face that also covers Chinese glyphs. */
const GENERIC_FONT_FAMILY = /^(?:serif|sans-serif|monospace|cursive|fantasy|fangsong|system-ui|ui-serif|ui-sans-serif|ui-monospace|ui-rounded|emoji|math|-apple-system|blinkmacsystemfont)$/i

function splitFontStack(stack: string): { named: string[]; generic: string[] } {
  const named: string[] = []
  const generic: string[] = []
  for (const raw of stack.split(',').map(part => part.trim()).filter(Boolean)) {
    const family = raw.replace(/^(["'])(.*)\1$/, '$2')
    ;(GENERIC_FONT_FAMILY.test(family) ? generic : named).push(raw)
  }
  return { named, generic }
}

/**
 * 英文槽位在前、中文槽位在后；但 `sans-serif`、`-apple-system` 这类通用族同样包含中文字形，
 * 排在中文族之前就会把「中文字体」整体吃掉，所以通用族统一挪到两个槽位的具名族之后。
 */
export function composeFontStacks(latin: string, cjk: string): string {
  const latinStack = splitFontStack(latin)
  const cjkStack = splitFontStack(cjk)
  if (!latinStack.named.length && !latinStack.generic.length) return cjk
  if (!cjkStack.named.length && !cjkStack.generic.length) return latin
  const seen = new Set<string>()
  const unique = (families: string[]) => families.filter(raw => {
    const key = raw.replace(/^(["'])(.*)\1$/, '$2').toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  // 中文槽位自带通用族时以它收尾，否则用英文槽位的通用族；两者都只是最后的兜底。
  const tail = cjkStack.generic.length ? cjkStack.generic : latinStack.generic
  return [...unique(latinStack.named), ...unique(cjkStack.named), ...unique(tail)].join(', ')
}

function assignSetting(target: ThemeVariant, field: ThemeSettingsField, value: ThemeSettingValue): void {
  const binding = field.binding
  if (binding.target === 'token') {
    target.tokens[binding.key] = String(value)
    return
  }
  if (binding.target === 'layout') {
    const key = binding.key as keyof AppearanceLayout
    ;(target.layout[key] as number | string) = value as string | number
    return
  }
  if (binding.target === 'background') {
    const key = binding.key as keyof AppearanceBackground
    ;(target.background[key] as AppearanceBackground[typeof key]) = value as never
    return
  }
  if (binding.target === 'component') {
    const key = binding.key as keyof AppearanceComponents
    ;(target.components[key] as number) = value as number
    return
  }
  if (binding.target === 'font') {
    const key = binding.key as keyof AppearanceFonts
    ;(target.fonts[key] as string | number) = value as string | number
    return
  }
  if (binding.target === 'notification') {
    target.notifications ??= { ...DEFAULT_NOTIFICATION_STYLE }
    ;(target.notifications[binding.key] as string | number) = value as string | number
    return
  }
  if (binding.target === 'splash') {
    target.splash ??= { ...DEFAULT_APPEARANCE_SPLASH }
    ;(target.splash[binding.key] as AppearanceSplash[typeof binding.key]) = value as never
    return
  }
  target.animation = value as AnimationLevel
}

function resolveBackgroundMedia(background: AppearanceBackground, palettes?: ReadonlyArray<ThemeBackgroundPaletteDeclaration>): void {
  if (background.kind === undefined) return
  const opacity = background.opacity ?? background.media?.opacity ?? 0.85
  const fit = background.fit ?? background.media?.fit ?? 'cover'
  if (background.kind === 'gradient') {
    background.media = { type: 'color', value: paletteById(background.palette, palettes)?.css ?? backgroundPalette('theme')!.css, opacity, fit }
  } else if (background.kind === 'color') {
    background.media = { type: 'color', value: background.color ?? '#bd542b', opacity, fit }
  } else if (background.kind === 'none' || background.media?.type !== background.kind) {
    background.media = null
  } else background.media = { ...background.media, opacity, fit }
}

function animationLevel(value: unknown, fallback: AnimationLevel = 'medium'): AnimationLevel {
  return ANIMATION_LEVELS.includes(value as AnimationLevel) ? value as AnimationLevel : fallback
}

function diagnosticsFor(profile: ThemeProfile): Diagnostic[] {
  return Object.keys(profile.quarantined ?? {}).map(key => ({
    path: `profile.${key}`,
    code: 'appearance.quarantined',
    message: `Value retained but not applied: ${key}`,
  }))
}

function constrainAppearance(
  appearance: Omit<ResolvedAppearance, 'animation'> & { animation: { requested: AnimationLevel; effective: AnimationLevel; continuous: boolean } },
  reducedMotion: boolean,
  performanceLimited: boolean,
): void {
  if (!reducedMotion && !performanceLimited) return
  appearance.animation.effective = 'low'
  appearance.animation.continuous = false
  if (appearance.background.speed > 0.25) appearance.background.speed = 0.25
  appearance.diagnostics.push({
    path: reducedMotion ? 'accessibility.reducedMotion' : 'performance.limited',
    code: 'appearance.motion-constrained',
    message: reducedMotion ? 'Reduced motion is active' : 'Continuous animation is limited',
  })
}

/** Resolve one authoritative snapshot using the fixed V2 appearance precedence. */
export function resolveAppearance(input: {
  settings: AppearanceSettings
  pack?: ThemePackV2 | null
  systemDark?: boolean
  reducedMotion?: boolean
  performanceLimited?: boolean
}): ResolvedAppearance {
  const settings = migrateAppearanceSettings(input.settings, input.settings.legacy)
  const requestedMode = validMode(settings.mode) ? settings.mode : 'light'
  const mode: AppearanceColorMode = requestedMode === 'system' ? (input.systemDark ? 'dark' : 'light') : requestedMode
  let active = settings.active
  let pack = input.pack && input.pack.source === active.source && input.pack.id === active.id ? input.pack : null
  const diagnostics: Diagnostic[] = []
  if (!pack) {
    if (active.source !== DEFAULT_THEME_IDENTITY.source || active.id !== DEFAULT_THEME_IDENTITY.id) diagnostics.push({
      path: 'appearance.active',
      code: 'appearance.theme-unavailable',
      message: 'Requested theme is unavailable; the default theme is applied and saved profiles are preserved',
    })
    active = plainClone(DEFAULT_THEME_IDENTITY)
    pack = BUILTIN_THEME_PACKS[0]
  }

  const storedProfile = settings.profiles[themeProfileKey(active)] ??
    cleanProfileShell(active, pack.schemaVersion)
  const profile = reconcileThemeProfile(pack, storedProfile)
  diagnostics.push(...diagnosticsFor(profile))
  const resolved: ThemeVariant = plainClone(HOST_BASE[mode])
  resolved.tokens = { ...resolved.tokens, ...pack.variants[mode].tokens }
  resolved.fonts = { ...resolved.fonts, ...pack.variants[mode].fonts }
  resolved.components = { ...resolved.components, ...pack.variants[mode].components }
  resolved.background = { ...resolved.background, ...pack.variants[mode].background }
  resolved.splash = { ...DEFAULT_APPEARANCE_SPLASH, ...pack.variants[mode].splash }
  resolved.layout = { ...resolved.layout, ...pack.variants[mode].layout }
  resolved.notifications = { ...DEFAULT_NOTIFICATION_STYLE, ...pack.variants[mode].notifications }
  resolved.animation = pack.variants[mode].animation
  for (const group of pack.settings.groups) {
    for (const field of group.fields) {
      const hasValue = Object.hasOwn(profile.values, field.key)
      // Color defaults describe the editor, not a replacement for the dark palette.
      if (!hasValue && field.binding.target === 'token' && (resolved.tokens[field.binding.key] || field.binding.key === '--link')) continue
      const value = hasValue ? profile.values[field.key] : field.default
      if (field.type === 'switch' && field.binding.target === 'background' && field.binding.key === 'effect') {
        resolved.background.effect = value === true ? pack.variants[mode].background.effect : 'none'
      } else {
        assignSetting(resolved, field, value)
      }
    }
  }
  // Main-window navigation is host-owned. Retain the existing built-in profile as
  // the global preference store; switching packs must not move/hide session tabs.
  const chromeValues = settings.profiles[themeProfileKey(DEFAULT_THEME_IDENTITY)]?.values ?? {}
  resolved.layout.tabStyle = validTabStyle(chromeValues.tabStyle) ? chromeValues.tabStyle : 'classic'
  resolved.layout.tabAutoHide = chromeValues.tabAutoHide === true
  resolved.layout.tabOpacity = typeof chromeValues.tabOpacity === 'number' && Number.isFinite(chromeValues.tabOpacity)
    ? Math.max(0, Math.min(1, chromeValues.tabOpacity)) : 1
  resolved.tokens = { ...resolved.tokens, ...(profile.colors[mode] ?? {}) }
  resolved.fonts.latin ||= pack.variants[mode].fonts.latin ?? ''
  resolved.fonts.cjk ||= pack.variants[mode].fonts.cjk ?? ''
  const modeFonts = pack.variants[mode].fonts
  const fontSlotsChanged = resolved.fonts.latin !== (modeFonts.latin ?? '') || resolved.fonts.cjk !== (modeFonts.cjk ?? '')
  if (fontSlotsChanged && (resolved.fonts.latin || resolved.fonts.cjk)) {
    const originalBody = resolved.fonts.body
    resolved.fonts.body = composeFontStacks(resolved.fonts.latin ?? '', resolved.fonts.cjk ?? '')
    if (!resolved.fonts.heading || resolved.fonts.heading === originalBody) resolved.fonts.heading = resolved.fonts.body
  }
  resolveBackgroundMedia(resolved.background, pack.palettes)
  const requestedAnimation = animationLevel(resolved.animation)
  const result: ResolvedAppearance = {
    version: APPEARANCE_SCHEMA_VERSION,
    revision: settings.revision,
    theme: { ...active, name: pack.name, version: pack.version, legacy: false },
    requestedMode,
    mode,
    tokens: resolveThemePalette(mode, resolved.tokens as Record<string, string>, undefined),
    fonts: resolved.fonts,
    components: resolved.components,
    background: resolved.background,
    splash: resolved.splash,
    layout: resolved.layout,
    notifications: resolved.notifications,
    animation: { requested: requestedAnimation, effective: requestedAnimation, continuous: requestedAnimation !== 'low' },
    home: pack.home ? plainClone(pack.home) : plainClone(THEME_HOME_LEGACY),
    ...(pack.quick ? { quick: plainClone(pack.quick) } : {}),
    ...(pack.chrome ? { chrome: plainClone(pack.chrome) } : {}),
    ...(pack.settingsPage ? { settingsPage: plainClone(pack.settingsPage) } : {}),
    diagnostics,
  }
  constrainAppearance(result, Boolean(input.reducedMotion), Boolean(input.performanceLimited))
  return result
}

/** Shared by trusted shell, Home and opted-in plugin style adapters. */
export function appearanceStyleProperties(
  appearance: Pick<ResolvedAppearance, 'theme' | 'tokens' | 'fonts' | 'components' | 'background' | 'layout'> & Partial<Pick<ResolvedAppearance, 'notifications'>>,
  options: { baseFontSize?: 13 | 14 } = {},
): Record<string, string> {
  const notifications = appearance.notifications ?? DEFAULT_NOTIFICATION_STYLE
  return {
    ...appearance.tokens,
    '--font': appearance.fonts.body,
    '--font-heading': appearance.fonts.heading || appearance.fonts.body,
    '--font-mono': appearance.fonts.mono,
    '--mono': appearance.fonts.mono,
    '--font-size-base': `${Number(((options.baseFontSize ?? 14) * appearance.fonts.scale).toFixed(2))}px`,
    '--appearance-font-scale': String(appearance.fonts.scale),
    '--appearance-control-radius': `${appearance.components.controlRadius}px`,
    '--appearance-card-radius': `${appearance.components.cardRadius}px`,
    '--appearance-panel-radius': `${appearance.components.panelRadius}px`,
    '--appearance-border-width': `${appearance.components.borderWidth}px`,
    '--appearance-notification-radius': `${notifications.radius}px`,
    '--appearance-notification-border-width': `${notifications.borderWidth}px`,
    '--appearance-notification-density': String(notifications.density),
    '--appearance-density': String(appearance.layout.density),
    '--appearance-tab-opacity': String(appearance.layout.tabOpacity ?? 1),
    '--appearance-tab-autohide': appearance.layout.tabAutoHide ? '1' : '0',
    '--appearance-gap': `${appearance.layout.gap}px`,
    '--appearance-sidebar-width': `${appearance.layout.sidebarWidth}px`,
    '--appearance-content-width': `${appearance.layout.contentWidth}px`,
    '--appearance-columns': String(Math.round(appearance.layout.columns)),
    '--appearance-bg-effect': appearance.background.effect,
    '--appearance-bg-texture': appearance.background.texture,
    '--appearance-bg-intensity': String(appearance.background.intensity),
    '--appearance-bg-speed': String(appearance.background.speed),
    '--appearance-bg-duration': `${40 - ((appearance.background.speed - 0.25) / 1.75) * 16}s`,
    '--appearance-bg-direction': `${appearance.background.direction}deg`,
    '--appearance-bg-warmth': String(appearance.background.warmth ?? 0.5),
    '--appearance-bg-grain': String(appearance.background.grain ?? 0.12),
    '--appearance-bg-scale': String(appearance.background.scale ?? 1),
    '--appearance-bg-wash': String(appearance.background.wash ?? 0.35),
  }
}
