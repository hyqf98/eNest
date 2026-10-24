/**
 * Pure ThemePackV2 contracts and appearance resolution.
 * This module has no host runtime dependency so the main process, renderer,
 * browser mock, and tests can all resolve the same semantic appearance.
 */
import type {
  AppearanceBackground,
  AppearanceColorMode,
  AppearanceComponents,
  AppearanceFonts,
  AppearanceLayout,
  AppearanceSettings,
  AppearanceSplash,
  LegacyAppearanceBackup,
  ResolvedAppearance,
  ThemeBackgroundKey,
  ThemeBackgroundPaletteDeclaration,
  ThemeColorToken,
  ThemeComponentKey,
  ThemeFontKey,
  ThemeSplashKey,
  ThemeIdentity,
  ThemeLayoutKey,
  ThemeNotificationKey,
  ThemeNotificationStyle,
  ThemePackV2,
  ThemeProfile,
  ThemeProfilePatch,
  ThemeSettingBinding,
  ThemeSettingOption,
  ThemeSettingOptionPreview,
  ThemeSettingPresentation,
  ThemeSettingValue,
  ThemeSettingsField,
  ThemeSettingsSchema,
  ThemeVariant,
} from '@shared/types/appearance'
import type { AnimationLevel, BackgroundConfig, ThemePack } from '@shared/types/plugin'
import { resolveThemePalette } from '@shared/theme/presets'
import { parseThemeColor } from '@shared/theme/colors'
import { isPluginAssetPath } from '@shared/pluginContract'
import { validateBackgroundEffects } from '@shared/backgroundEffects'
import { BUILTIN_THEME_PACKS, BUILTIN_THEME_SOURCE, DEFAULT_THEME_IDENTITY } from '@shared/theme/builtinThemes'
import { DEFAULT_BACKGROUND_PALETTES, backgroundPalette, backgroundPaletteForCss, isSafeAppearanceBackgroundColor, isSafePalettePaint, paletteById } from '@shared/theme/defaultTheme/backgroundPalettes'

export { DEFAULT_THEME_IDENTITY } from '@shared/theme/builtinThemes'

export const APPEARANCE_SCHEMA_VERSION = 2
export const THEME_PROFILE_LEGACY: ThemeIdentity = {
  source: 'enest.builtin',
  id: 'legacy-custom',
}
/** Compatibility export for callers compiled before the single-default-theme migration. */
export const THEME_HOME_LEGACY = { source: BUILTIN_THEME_SOURCE, id: 'home', variant: DEFAULT_THEME_IDENTITY.id }

const COLOR_MODES: AppearanceColorMode[] = ['light', 'dark']
const ANIMATION_LEVELS: AnimationLevel[] = ['low', 'medium', 'high']
const FIELD_TYPES = new Set(['color', 'slider', 'switch', 'select', 'font', 'media', 'token'])
const TOKEN_KEYS = new Set<string>([
  '--bg', '--surface', '--surface-2', '--surface-3', '--text', '--text-2',
  '--text-3', '--accent', '--ok', '--danger', '--border', '--border-strong', '--link',
])
const LAYOUT_KEYS = new Set<string>(['density', 'gap', 'sidebarWidth', 'contentWidth', 'columns', 'tabStyle', 'tabOpacity', 'tabAutoHide'])
const BACKGROUND_KEYS = new Set<string>(['texture', 'intensity', 'speed', 'direction', 'effect', 'media', 'warmth', 'grain', 'scale', 'wash', 'kind', 'palette', 'color', 'opacity', 'fit'])
const COMPONENT_KEYS = new Set<string>(['controlRadius', 'cardRadius', 'panelRadius', 'borderWidth'])
const FONT_KEYS = new Set<string>(['body', 'heading', 'mono', 'scale', 'cjk', 'latin'])
const SPLASH_KEYS = new Set<string>(['type', 'media', 'opacity'])
const BACKGROUND_KINDS = new Set(['none', 'gradient', 'color', 'image', 'video'])
const SPLASH_TYPES = new Set(['brand', 'none', 'image', 'paper'])
export const DEFAULT_APPEARANCE_SPLASH: Readonly<AppearanceSplash> = Object.freeze({ type: 'brand', media: null, opacity: 0.55 })
const NOTIFICATION_KEYS = new Set<string>(['layout', 'accent', 'radius', 'borderWidth', 'density', 'shadow'])
const NOTIFICATION_ENUMS = {
  layout: ['card', 'compact', 'banner'],
  accent: ['stripe', 'icon', 'none'],
  shadow: ['none', 'soft', 'raised'],
} as const
export const DEFAULT_NOTIFICATION_STYLE: Readonly<ThemeNotificationStyle> = Object.freeze({
  layout: 'card', accent: 'stripe', radius: 16, borderWidth: 1, density: 1, shadow: 'soft',
})
const SAFE_ID = /^[A-Za-z][A-Za-z0-9_-]{0,127}$/
const SOURCE_ID = /^[a-z0-9]+(?:\.[a-zA-Z0-9-]+)+$/
const FONT_STACK = /^[\p{L}\p{N}_ '".,\-]{0,240}$/u
const TOKEN_NAME = /^--[A-Za-z0-9_-]{1,126}$/
const SAFE_TEXT = /^[^\u0000-\u001f\u007f<>]+$/
const MEDIA_EFFECT = /^(?:none|[A-Za-z][A-Za-z0-9_-]{0,95}|plugin:[A-Za-z0-9_.%-]+:[A-Za-z0-9_.%-]+:[A-Za-z0-9_.%-]+)$/
const RESERVED_KEYS = new Set(['__proto__', 'prototype', 'constructor'])
const LEGACY_BACKGROUND_PENDING = 'migration.background-pack'
const LEGACY_BACKGROUND_PENDING_REASON = 'legacy-pack-background-pending'

type Diagnostic = ResolvedAppearance['diagnostics'][number]
type Bag = Record<string, unknown>

function fail(message: string): never {
  throw new Error(`invalid theme pack: ${message}`)
}

function object(value: unknown, path: string): Bag {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${path} must be an object`)
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== null && prototype !== Object.prototype) fail(`${path} must be a plain object`)
  if (Reflect.ownKeys(value).some(key => typeof key !== 'string' || RESERVED_KEYS.has(key))) {
    fail(`${path} contains a reserved key`)
  }
  if (Object.values(Object.getOwnPropertyDescriptors(value)).some(descriptor => !('value' in descriptor))) {
    fail(`${path} cannot contain accessors`)
  }
  return value as Bag
}

function exactObject(value: unknown, path: string, allowed: Set<string>): Bag {
  const bag = object(value, path)
  for (const key of Object.keys(bag)) {
    if (!allowed.has(key)) fail(`unknown ${path} field "${key}"`)
  }
  return bag
}

function plainClone<T>(value: T): T {
  return structuredClone(value)
}

function text(value: unknown, path: string, maximum: number, pattern = SAFE_TEXT): string {
  if (typeof value !== 'string' || !pattern.test(value) || value.trim() !== value) fail(`${path} has invalid text`)
  if (value.length > maximum) fail(`${path} exceeds ${maximum} characters`)
  return value
}

function optionalText(value: unknown, path: string, maximum: number, pattern = SAFE_TEXT): string | undefined {
  return value === undefined ? undefined : text(value, path, maximum, pattern)
}

function finite(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(`${path} must be a finite number`)
  return value
}

function numberInRange(value: unknown, path: string, minimum: number, maximum: number): number {
  const result = finite(value, path)
  if (result < minimum || result > maximum) fail(`${path} must be between ${minimum} and ${maximum}`)
  return result
}

function color(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length > 96 || !parseThemeColor(value)) fail(`${path} must be a supported color`)
  return value
}

function fontStack(value: unknown, path: string): string {
  if (typeof value !== 'string' || !FONT_STACK.test(value)) fail(`${path} has an invalid font stack`)
  return value
}

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

function identity(value: unknown, path: string): ThemeIdentity {
  const bag = exactObject(value, path, new Set(['source', 'id']))
  const source = text(bag.source, `${path}.source`, 256, SOURCE_ID)
  const id = text(bag.id, `${path}.id`, 128, SAFE_ID)
  return { source, id }
}

function safeVariantId(value: unknown, path: string): string {
  return text(value, path, 96, SAFE_ID)
}

/** Palette ids come from the built-in table plus the pack's own validated declarations. */
function paletteId(value: unknown, path: string, paletteIds: ReadonlySet<string>): string {
  const id = safeVariantId(value, path)
  return paletteIds.has(id) ? id : fail(`${path} is not a declared atmosphere preset`)
}

function backgroundConfig(value: unknown, path: string, source: string, allowLibrary = false): BackgroundConfig {
  const bag = exactObject(value, path, new Set(['type', 'value', 'opacity', 'fit']))
  if (bag.type !== 'none' && bag.type !== 'color' && bag.type !== 'image' && bag.type !== 'video') {
    fail(`${path}.type is unsupported`)
  }
  const rawValue = typeof bag.value === 'string' ? bag.value : ''
  const opacity = bag.opacity === undefined ? 0.85 : numberInRange(bag.opacity, `${path}.opacity`, 0, 1)
  const fit = bag.fit === undefined || bag.fit === 'cover' ? 'cover' : bag.fit === 'contain' ? 'contain' : null
  if (!fit) fail(`${path}.fit is invalid`)
  if (typeof bag.value !== 'string' || !bag.value) fail(`${path}.value must be a string`)
  if (bag.type === 'none') fail(`${path}.value must be empty`)
  if (rawValue.length > 2048 || rawValue.trim() !== rawValue || /[\u0000-\u001f\u007f]/.test(rawValue)) fail(`${path}.value is invalid`)
  if (bag.type === 'color') {
    if (!isSafeAppearanceBackgroundColor(rawValue)) fail(`${path}.value is not a safe color or atmosphere preset`)
    return { type: 'color', value: rawValue, opacity, fit }
  }
  try {
    if (allowLibrary && source === BUILTIN_THEME_SOURCE && /^enest:\/\/appearance\/legacy\/(?:background|splash)$/.test(rawValue)) {
      if (rawValue.endsWith('/splash') && bag.type !== 'image') fail(`${path}.value is not a startup image`)
      return { type: bag.type, value: rawValue, opacity, fit }
    }
    if (allowLibrary && /^enest:\/\/appearance\/media\/[a-f0-9]{64}\.(?:png|jpe?g|gif|webp|mp4|webm)$/.test(rawValue)) {
      const matchesType = bag.type === 'video' ? /\.(mp4|webm)$/.test(rawValue) : /\.(png|jpe?g|gif|webp)$/.test(rawValue)
      if (!matchesType) fail(`${path}.value has an unsupported media extension`)
      return { type: bag.type, value: rawValue, opacity, fit }
    }
    // A host-owned profile may retain a previously selected plugin's public asset.
    // Registration and third-party patches still require the declaring source.
    const hostAssetSource = allowLibrary && source === BUILTIN_THEME_SOURCE ? /^enest:\/\/plugin\/([^/]+)\//.exec(rawValue)?.[1] : undefined
    const assetSource = hostAssetSource && hostAssetSource.length <= 256 && SOURCE_ID.test(hostAssetSource) ? hostAssetSource : source
    const prefix = `enest://plugin/${assetSource}/`
    if (!rawValue.startsWith(prefix)) fail(`${path}.value must belong to its source`)
    const rawAsset = decodeURIComponent(rawValue.slice(prefix.length))
    if (!rawAsset.startsWith('assets/') || !isPluginAssetPath(rawAsset)) fail(`${path}.value escapes its plugin assets`)
    const url = new URL(rawValue)
    if (
      url.protocol !== 'enest:' || url.hostname !== 'plugin' || url.port || url.username ||
      url.password || url.search || url.hash
    ) fail(`${path}.value must be a plugin asset URL`)
    const decoded = decodeURIComponent(url.pathname)
    const pathPrefix = `/${assetSource}/`
    const asset = decoded.startsWith(pathPrefix) ? decoded.slice(pathPrefix.length) : ''
    if (!asset.startsWith('assets/') || !isPluginAssetPath(asset)) fail(`${path}.value escapes its plugin assets`)
    const extension = bag.type === 'image' ? /\.(png|jpe?g|gif|webp|svg|ico)$/i : /\.(mp4|webm|mov)$/i
    if (!extension.test(asset)) fail(`${path}.value has an unsupported media extension`)
    return { type: bag.type, value: url.href, opacity, fit }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('invalid theme pack:')) throw error
    fail(`${path}.value is not a valid URL`)
  }
}

function optionalBackground(value: unknown, path: string, source: string): BackgroundConfig | null {
  return value === undefined || value === null ? null : backgroundConfig(value, path, source)
}

function validateTokens(value: unknown, path: string): Record<string, string> {
  const bag = object(value, path)
  const result: Record<string, string> = {}
  if (Object.keys(bag).length > 128) fail(`${path} contains too many tokens`)
  for (const [key, raw] of Object.entries(bag)) {
    if (!TOKEN_NAME.test(key)) fail(`${path}.${key} is not a custom property`)
    if (!TOKEN_KEYS.has(key)) fail(`${path}.${key} is not a semantic appearance token`)
    if (typeof raw !== 'string' || !raw.trim() || raw.length > 200 || /[\u0000-\u001f\u007f<>\\;{}]/i.test(raw) ||
      /url\s*\(|expression\s*\(|javascript:|@import/i.test(raw) ||
      !/^[\p{L}\p{N}_ #%'"(),.\-]+$/u.test(raw)) fail(`${path}.${key} has an unsafe value`)
    result[key] = raw
  }
  return result
}

const HOST_BASE: Record<AppearanceColorMode, ThemeVariant> = {
  light: {
    tokens: {},
    fonts: { body: '', heading: '', mono: '', scale: 1 },
    components: { controlRadius: 10, cardRadius: 14, panelRadius: 18, borderWidth: 1 },
    background: { media: null, effect: 'tunnel', texture: 'none', intensity: 1, speed: 1, direction: 0, warmth: 0.5, grain: 0.12, scale: 1, wash: 0.35 },
    layout: { variant: 'default', tabStyle: 'classic', tabOpacity: 1, tabAutoHide: false, density: 1, gap: 16, sidebarWidth: 280, contentWidth: 960, columns: 3 },
    notifications: { ...DEFAULT_NOTIFICATION_STYLE },
    animation: 'medium',
  },
  dark: {
    tokens: {},
    fonts: { body: '', heading: '', mono: '', scale: 1 },
    components: { controlRadius: 10, cardRadius: 14, panelRadius: 18, borderWidth: 1 },
    background: { media: null, effect: 'tunnel', texture: 'none', intensity: 1, speed: 1, direction: 0, warmth: 0.5, grain: 0.12, scale: 1, wash: 0.35 },
    layout: { variant: 'default', tabStyle: 'classic', tabOpacity: 1, tabAutoHide: false, density: 1, gap: 16, sidebarWidth: 280, contentWidth: 960, columns: 3 },
    notifications: { ...DEFAULT_NOTIFICATION_STYLE },
    animation: 'medium',
  },
}

function variant(value: unknown, path: string, source: string, paletteIds: ReadonlySet<string>): ThemeVariant {
  const bag = exactObject(value, path, new Set(['tokens', 'fonts', 'components', 'background', 'layout', 'notifications', 'splash', 'animation']))
  const rawTokens = object(bag.tokens ?? {}, `${path}.tokens`)
  const tokens: Partial<Record<ThemeColorToken, string>> = {}
  for (const [key, raw] of Object.entries(rawTokens)) {
    if (!TOKEN_KEYS.has(key)) fail(`${path}.tokens.${key} is not a semantic token`)
    tokens[key as ThemeColorToken] = color(raw, `${path}.tokens.${key}`)
  }

  const fontsBag = exactObject(bag.fonts, `${path}.fonts`, FONT_KEYS)
  const fonts: AppearanceFonts = {
    body: fontStack(fontsBag.body, `${path}.fonts.body`),
    heading: fontStack(fontsBag.heading, `${path}.fonts.heading`),
    mono: fontStack(fontsBag.mono, `${path}.fonts.mono`),
    scale: numberInRange(fontsBag.scale, `${path}.fonts.scale`, 0.9, 1.3),
    cjk: fontsBag.cjk === undefined ? '' : fontStack(fontsBag.cjk, `${path}.fonts.cjk`),
    latin: fontsBag.latin === undefined ? '' : fontStack(fontsBag.latin, `${path}.fonts.latin`),
  }
  const componentsBag = exactObject(bag.components, `${path}.components`, new Set(Object.keys(HOST_BASE.light.components)))
  const components: AppearanceComponents = {
    controlRadius: numberInRange(componentsBag.controlRadius, `${path}.components.controlRadius`, 0, 24),
    cardRadius: numberInRange(componentsBag.cardRadius, `${path}.components.cardRadius`, 0, 32),
    panelRadius: numberInRange(componentsBag.panelRadius, `${path}.components.panelRadius`, 0, 40),
    borderWidth: numberInRange(componentsBag.borderWidth, `${path}.components.borderWidth`, 0, 6),
  }
  const backgroundBag = exactObject(bag.background, `${path}.background`, BACKGROUND_KEYS)
  const background: AppearanceBackground = {
    media: optionalBackground(backgroundBag.media, `${path}.background.media`, source),
    effect: text(backgroundBag.effect, `${path}.background.effect`, 96, MEDIA_EFFECT),
    texture: safeVariantId(backgroundBag.texture, `${path}.background.texture`),
    intensity: numberInRange(backgroundBag.intensity, `${path}.background.intensity`, 0, 1),
    speed: numberInRange(backgroundBag.speed, `${path}.background.speed`, 0.25, 2),
    direction: numberInRange(backgroundBag.direction, `${path}.background.direction`, 0, 360),
    warmth: backgroundBag.warmth === undefined ? 0.5 : numberInRange(backgroundBag.warmth, `${path}.background.warmth`, 0, 1),
    grain: backgroundBag.grain === undefined ? 0.12 : numberInRange(backgroundBag.grain, `${path}.background.grain`, 0, 1),
    scale: backgroundBag.scale === undefined ? 1 : numberInRange(backgroundBag.scale, `${path}.background.scale`, 0.25, 2),
    wash: backgroundBag.wash === undefined ? 0.35 : numberInRange(backgroundBag.wash, `${path}.background.wash`, 0, 1),
    ...(backgroundBag.kind === undefined ? {} : { kind: BACKGROUND_KINDS.has(String(backgroundBag.kind)) ? backgroundBag.kind as AppearanceBackground['kind'] : fail(`${path}.background.kind is invalid`) }),
    ...(backgroundBag.palette === undefined ? {} : { palette: paletteId(backgroundBag.palette, `${path}.background.palette`, paletteIds) }),
    ...(backgroundBag.color === undefined ? {} : { color: color(backgroundBag.color, `${path}.background.color`) }),
    ...(backgroundBag.opacity === undefined ? {} : { opacity: numberInRange(backgroundBag.opacity, `${path}.background.opacity`, 0, 1) }),
    ...(backgroundBag.fit === undefined ? {} : { fit: backgroundBag.fit === 'cover' || backgroundBag.fit === 'contain' ? backgroundBag.fit : fail(`${path}.background.fit is invalid`) }),
  }
  const layoutBag = exactObject(bag.layout, `${path}.layout`, new Set(Object.keys(HOST_BASE.light.layout)))
  const layout: AppearanceLayout = {
    variant: safeVariantId(layoutBag.variant, `${path}.layout.variant`),
    tabStyle: layoutBag.tabStyle === undefined ? 'classic'
      : validTabStyle(layoutBag.tabStyle) ? layoutBag.tabStyle : fail(`${path}.layout.tabStyle is invalid`),
    tabOpacity: layoutBag.tabOpacity === undefined ? 1 : numberInRange(layoutBag.tabOpacity, `${path}.layout.tabOpacity`, 0, 1),
    tabAutoHide: layoutBag.tabAutoHide === undefined ? false
      : typeof layoutBag.tabAutoHide === 'boolean' ? layoutBag.tabAutoHide : fail(`${path}.layout.tabAutoHide must be boolean`),
    density: numberInRange(layoutBag.density, `${path}.layout.density`, 0.8, 1.2),
    gap: numberInRange(layoutBag.gap, `${path}.layout.gap`, 0, 32),
    sidebarWidth: numberInRange(layoutBag.sidebarWidth, `${path}.layout.sidebarWidth`, 220, 440),
    contentWidth: numberInRange(layoutBag.contentWidth, `${path}.layout.contentWidth`, 640, 1920),
    columns: numberInRange(layoutBag.columns, `${path}.layout.columns`, 1, 6),
  }
  const animation = ANIMATION_LEVELS.includes(bag.animation as AnimationLevel)
    ? bag.animation as AnimationLevel
    : fail(`${path}.animation is invalid`)
  const notifications = bag.notifications === undefined ? undefined : notificationStyle(bag.notifications, `${path}.notifications`)
  const splash = bag.splash === undefined ? undefined : splashStyle(bag.splash, `${path}.splash`, source)
  return { tokens, fonts, components, background, layout, ...(notifications ? { notifications } : {}), ...(splash ? { splash } : {}), animation }
}

function splashStyle(value: unknown, path: string, source: string): AppearanceSplash {
  const bag = exactObject(value, path, SPLASH_KEYS)
  if (!SPLASH_TYPES.has(String(bag.type))) fail(`${path}.type is invalid`)
  const media = optionalBackground(bag.media, `${path}.media`, source)
  if (media && media.type !== 'image') fail(`${path}.media must be an image`)
  return { type: bag.type as AppearanceSplash['type'], media, opacity: numberInRange(bag.opacity, `${path}.opacity`, 0, 1) }
}

function notificationValueAllowed(key: ThemeNotificationKey, value: unknown): boolean {
  if (key === 'layout' || key === 'accent' || key === 'shadow') {
    return typeof value === 'string' && (NOTIFICATION_ENUMS[key] as readonly string[]).includes(value)
  }
  const range = key === 'density' ? [0.8, 1.2] : key === 'radius' ? [0, 24] : [0, 6]
  return typeof value === 'number' && Number.isFinite(value) && value >= range[0] && value <= range[1]
}

function notificationStyle(value: unknown, path: string): ThemeNotificationStyle {
  const bag = exactObject(value, path, NOTIFICATION_KEYS)
  for (const key of NOTIFICATION_KEYS) {
    if (!notificationValueAllowed(key as ThemeNotificationKey, bag[key])) fail(`${path}.${key} is invalid`)
  }
  return { layout: bag.layout, accent: bag.accent, radius: bag.radius, borderWidth: bag.borderWidth, density: bag.density, shadow: bag.shadow } as ThemeNotificationStyle
}

function binding(value: unknown, path: string): ThemeSettingBinding {
  const bag = exactObject(value, path, new Set(['target', 'key']))
  const target = bag.target
  if (target === 'token') {
    if (!TOKEN_KEYS.has(String(bag.key))) fail(`${path}.key is invalid`)
    return { target, key: bag.key as ThemeColorToken }
  }
  if (target === 'layout' || target === 'background' || target === 'component' || target === 'font') {
    const allowed = target === 'layout' ? LAYOUT_KEYS : target === 'background' ? BACKGROUND_KEYS
      : target === 'component' ? COMPONENT_KEYS : FONT_KEYS
    if (!allowed.has(String(bag.key))) fail(`${path}.key is invalid`)
    if (target === 'layout') return { target, key: bag.key as ThemeLayoutKey }
    if (target === 'background') return { target, key: bag.key as ThemeBackgroundKey }
    if (target === 'component') return { target, key: bag.key as ThemeComponentKey }
    return { target, key: bag.key as ThemeFontKey }
  }
  if (target === 'animation' && bag.key === 'level') return { target, key: 'level' }
  if (target === 'splash' && SPLASH_KEYS.has(String(bag.key))) return { target, key: bag.key as ThemeSplashKey }
  if (target === 'notification' && NOTIFICATION_KEYS.has(String(bag.key))) return { target, key: bag.key as ThemeNotificationKey }
  fail(`${path} is invalid`)
}

function scalar(value: unknown): value is string | number | boolean {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
}

function bindingValueType(binding: ThemeSettingBinding): 'color' | 'number' | 'boolean' | 'string' | 'media' {
  if (binding.target === 'token') return 'color'
  if (binding.target === 'font') return binding.key === 'scale' ? 'number' : 'string'
  if (binding.target === 'animation') return 'string'
  if (binding.target === 'splash') return binding.key === 'media' ? 'media' : binding.key === 'opacity' ? 'number' : 'string'
  if (binding.target === 'notification') return ['layout', 'accent', 'shadow'].includes(binding.key) ? 'string' : 'number'
  if (binding.target === 'layout' && binding.key === 'tabStyle') return 'string'
  if (binding.target === 'layout' && binding.key === 'tabAutoHide') return 'boolean'
  if (binding.target === 'background') {
    if (binding.key === 'media') return 'media'
    if (binding.key === 'color') return 'color'
    if (['texture', 'effect', 'kind', 'palette', 'fit'].includes(binding.key)) return 'string'
    return 'number'
  }
  if (binding.target === 'layout' && binding.key === 'columns') return 'number'
  if (binding.target === 'component' || binding.target === 'layout') return 'number'
  return 'number'
}

function bindingMatchesField(field: ThemeSettingsField): boolean {
  const binding = field.binding
  if (field.type === 'color') return binding.target === 'token' || binding.target === 'background' && binding.key === 'color'
  if (field.type === 'token') return binding.target === 'token'
  if (field.type === 'slider') {
    return binding.target !== 'animation' && bindingValueType(binding) === 'number'
  }
  if (field.type === 'switch') {
    return (binding.target === 'background' && field.binding.key === 'effect') ||
      (binding.target === 'layout' && field.binding.key === 'tabAutoHide')
  }
  if (field.type === 'select') {
    if (binding.target === 'animation') return binding.key === 'level'
    return (binding.target === 'layout' || binding.target === 'background' || binding.target === 'component' || binding.target === 'notification' || binding.target === 'splash') && bindingValueType(binding) !== 'media' && bindingValueType(binding) !== 'color'
  }
  if (field.type === 'font') return binding.target === 'font'
  if (field.type === 'media') return (binding.target === 'background' || binding.target === 'splash') && binding.key === 'media'
  return false
}

const PRESENTATIONS = new Set<ThemeSettingPresentation>(['segmented', 'cards', 'slider-cluster'])

function presentationHint(value: unknown, path: string): ThemeSettingPresentation {
  return PRESENTATIONS.has(value as ThemeSettingPresentation)
    ? value as ThemeSettingPresentation
    : fail(`${path} is not a supported presentation`)
}

/**
 * A hint is a preference, not a layout override: `cards` needs real options, `segmented` needs
 * a short list, and `slider-cluster` only groups continuous numeric bindings.
 */
function presentationMatchesField(presentation: ThemeSettingPresentation, field: ThemeSettingsField): boolean {
  const optionCount = field.options?.length ?? 0
  if (presentation === 'cards') return field.type === 'select' && optionCount >= 1
  if (presentation === 'segmented') return field.type === 'select' && optionCount >= 1 && optionCount <= 5
  return field.type === 'slider' && numericBindingRange(field.binding) !== undefined
}

/** Option thumbnails are data only: a two-stop swatch or a same-plugin asset under `assets/`. */
function optionPreview(value: unknown, path: string, source: string): ThemeSettingOptionPreview {
  const bag = exactObject(value, path, new Set(['kind', 'stops', 'src']))
  if (bag.kind === 'swatch') {
    const stops = bag.stops
    if (!Array.isArray(stops) || stops.length !== 2) fail(`${path}.stops must contain exactly 2 paints`)
    const paints = stops.map((stop, index) => {
      const paint = text(stop, `${path}.stops.${index}`, 1024)
      if (!isSafePalettePaint(paint)) fail(`${path}.stops.${index} is not a safe paint`)
      return paint
    })
    if (bag.src !== undefined) fail(`${path} cannot mix swatch and asset`)
    return { kind: 'swatch', stops: [paints[0], paints[1]] }
  }
  if (bag.kind === 'asset') {
    if (bag.stops !== undefined) fail(`${path} cannot mix swatch and asset`)
    const raw = text(bag.src, `${path}.src`, 512)
    if (!raw.startsWith('assets/') || !isPluginAssetPath(raw)) fail(`${path}.src escapes its plugin assets`)
    if (!/\.(png|jpe?g|gif|webp|svg)$/i.test(raw)) fail(`${path}.src is not an image`)
    return { kind: 'asset', src: `enest://plugin/${source}/${raw}` }
  }
  return fail(`${path}.kind is unsupported`)
}

function numericBindingRange(binding: ThemeSettingBinding): [number, number] | undefined {  if (binding.target === 'splash' && binding.key === 'opacity') return [0, 1]
  if (binding.target === 'notification') {
    return ({ radius: [0, 24], borderWidth: [0, 6], density: [0.8, 1.2] } as Record<string, [number, number]>)[binding.key]
  }
  if (binding.target === 'background') {
    if (['intensity', 'warmth', 'grain', 'wash', 'opacity'].includes(binding.key)) return [0, 1]
    if (binding.key === 'speed' || binding.key === 'scale') return [0.25, 2]
    if (binding.key === 'direction') return [0, 360]
  }
  if (binding.target === 'font' && binding.key === 'scale') return [0.9, 1.3]
  if (binding.target === 'layout') {
    if (binding.key === 'tabOpacity') return [0, 1]
    return ({ density: [0.8, 1.2], gap: [0, 32], sidebarWidth: [220, 440], contentWidth: [640, 1920], columns: [1, 6] } as Record<string, [number, number]>)[binding.key]
  }
  if (binding.target === 'component') {
    return [0, ({ controlRadius: 24, cardRadius: 32, panelRadius: 40, borderWidth: 6 })[binding.key]]
  }
  return undefined
}

function defaultValueMatchesField(field: ThemeSettingsField, value: ThemeSettingValue, source = 'schema-validation', allowLibrary = false, paletteIds?: ReadonlySet<string>): boolean {
  if (field.binding.target === 'layout' && field.binding.key === 'tabStyle' && !validTabStyle(value)) return false
  if (field.binding.target === 'notification' && !notificationValueAllowed(field.binding.key, value)) return false
  if (!semanticChoiceAllowed(field.binding, value, paletteIds)) return false
  const semanticRange = numericBindingRange(field.binding)
  if (semanticRange && (typeof value !== 'number' || value < semanticRange[0] || value > semanticRange[1])) return false
  if (field.type === 'color' || field.type === 'token') {
    return typeof value === 'string' && Boolean(parseThemeColor(value))
  }
  if (field.type === 'slider') {
    return typeof value === 'number' && Number.isFinite(value) &&
      value >= (field.min ?? -Infinity) && value <= (field.max ?? Infinity)
  }
  if (field.type === 'switch') {
    return typeof value === 'boolean' && typeof field.default === 'boolean'
  }
  if (field.type === 'select') {
    const expected = bindingValueType(field.binding)
    const legacyEffect = allowLibrary && source === BUILTIN_THEME_SOURCE && field.binding.target === 'background' && field.binding.key === 'effect' && typeof value === 'string' && value.startsWith('plugin:') && MEDIA_EFFECT.test(value)
    return value !== undefined && ((field.options ?? []).some(option => option.value === value) || legacyEffect) &&
      (expected === 'number' ? typeof value === 'number' : expected === 'boolean' ? typeof value === 'boolean' : typeof value === 'string')
  }
  if (field.type === 'font') return typeof value === 'string' && FONT_STACK.test(value)
  if (field.type === 'media') return value === null || (
    (() => {
      try {
        const media = backgroundConfig(value, 'media', source, allowLibrary)
        if (field.binding.target === 'splash' && media.type !== 'image') return false
        return true
      } catch {
        return false
      }
    })()
  )
  return false
}

function semanticChoiceAllowed(binding: ThemeSettingBinding, value: unknown, paletteIds?: ReadonlySet<string>): boolean {
  if (binding.target === 'animation') return ANIMATION_LEVELS.includes(value as AnimationLevel)
  if (binding.target === 'splash' && binding.key === 'type') return SPLASH_TYPES.has(String(value))
  if (binding.target === 'background') {
    if (binding.key === 'kind') return BACKGROUND_KINDS.has(String(value))
    if (binding.key === 'palette') {
      return paletteIds ? paletteIds.has(String(value)) : Boolean(backgroundPalette(value))
    }
    if (binding.key === 'fit') return value === 'cover' || value === 'contain'
    if (binding.key === 'texture') return typeof value === 'string' && SAFE_ID.test(value)
    if (binding.key === 'effect' && typeof value !== 'boolean') return typeof value === 'string' && MEDIA_EFFECT.test(value)
  }
  return true
}

/**
 * Pack-declared atmosphere presets. Both paints pass the renderer allowlist, and an id may
 * never shadow a host preset — that keeps `background.palette` resolution unambiguous.
 */
function paletteDeclarations(value: unknown, path: string): ThemeBackgroundPaletteDeclaration[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 12) fail(`${path} must contain 1 to 12 presets`)
  const seen = new Set<string>(DEFAULT_BACKGROUND_PALETTES.map(palette => palette.id))
  return value.map((raw, index) => {
    const entryPath = `${path}.${index}`
    const bag = exactObject(raw, entryPath, new Set(['id', 'name', 'css', 'swatch']))
    const id = safeVariantId(bag.id, `${entryPath}.id`)
    if (seen.has(id)) fail(`${entryPath}.id is duplicate or shadows a host preset`)
    seen.add(id)
    const css = text(bag.css, `${entryPath}.css`, 1024)
    if (!isSafePalettePaint(css)) fail(`${entryPath}.css is not a safe paint`)
    const swatch = bag.swatch === undefined ? undefined : text(bag.swatch, `${entryPath}.swatch`, 1024)
    if (swatch !== undefined && !isSafePalettePaint(swatch)) fail(`${entryPath}.swatch is not a safe paint`)
    return { id, name: text(bag.name, `${entryPath}.name`, 96), css, ...(swatch === undefined ? {} : { swatch }) }
  })
}

function settingsSchema(value: unknown, path: string, source: string, paletteIds: ReadonlySet<string>): ThemeSettingsSchema {
  const bag = exactObject(value, path, new Set(['version', 'groups']))
  const version = numberInRange(bag.version, `${path}.version`, 1, 100)
  if (!Array.isArray(bag.groups) || bag.groups.length < 1 || bag.groups.length > 12) {
    fail(`${path}.groups must contain 1 to 12 groups`)
  }
  const groupIds = new Set<string>()
  const fieldKeys = new Set<string>()
  const destinations = new Set<string>()
  let fieldCount = 0
  const groups = bag.groups.map((rawGroup, groupIndex) => {
    const groupPath = `${path}.groups.${groupIndex}`
    const groupBag = exactObject(rawGroup, groupPath, new Set(['id', 'title', 'description', 'fields']))
    const id = safeVariantId(groupBag.id, `${groupPath}.id`)
    if (groupIds.has(id)) fail(`${groupPath}.id is duplicate`)
    groupIds.add(id)
    if (!Array.isArray(groupBag.fields) || fieldCount + groupBag.fields.length > 48) {
      fail(`${groupPath}.fields exceeds the schema field limit`)
    }
    fieldCount += groupBag.fields.length
    const fields = groupBag.fields.map((rawField, fieldIndex) => {
      const fieldPath = `${groupPath}.fields.${fieldIndex}`
      const fieldBag = exactObject(rawField, fieldPath, new Set([
        'key', 'label', 'type', 'default', 'binding', 'min', 'max', 'step', 'options', 'presentation', 'help', 'visibleWhen',
      ]))
      const key = safeVariantId(fieldBag.key, `${fieldPath}.key`)
      if (fieldKeys.has(key)) fail(`${fieldPath}.key is duplicate`)
      fieldKeys.add(key)
      const fieldType = String(fieldBag.type)
      if (!FIELD_TYPES.has(fieldType)) fail(`${fieldPath}.type is invalid`)
      const field: ThemeSettingsField = {
        key,
        label: text(fieldBag.label, `${fieldPath}.label`, 96),
        type: fieldType as ThemeSettingsField['type'],
        default: fieldBag.default as ThemeSettingValue,
        binding: binding(fieldBag.binding, `${fieldPath}.binding`),
      }
      const destination = `${field.binding.target}:${field.binding.key}`
      if (destinations.has(destination)) fail(`${fieldPath}.binding is duplicate`)
      destinations.add(destination)
      if (!bindingMatchesField(field)) fail(`${fieldPath}.binding does not match ${field.type}`)
      const presentation = fieldBag.presentation === undefined
        ? undefined
        : presentationHint(fieldBag.presentation, `${fieldPath}.presentation`)
      if (fieldBag.min !== undefined) field.min = numberInRange(fieldBag.min, `${fieldPath}.min`, -1e6, 1e6)
      if (fieldBag.max !== undefined) field.max = numberInRange(fieldBag.max, `${fieldPath}.max`, -1e6, 1e6)
      if (field.min !== undefined && field.max !== undefined && field.min > field.max) fail(`${fieldPath}.range is reversed`)
      if (fieldBag.step !== undefined) field.step = numberInRange(fieldBag.step, `${fieldPath}.step`, 0.001, 1000)
      if (field.type === 'slider' && (field.min === undefined || field.max === undefined || field.step === undefined)) {
        fail(`${fieldPath} requires min, max and step`)
      }
      const range = numericBindingRange(field.binding)
      if (range && ((field.min !== undefined && field.min < range[0]) || (field.max !== undefined && field.max > range[1]))) {
        fail(`${fieldPath}.range exceeds its semantic binding`)
      }
      if (field.type === 'select' || field.type === 'font' && fieldBag.options !== undefined) {
        if (!Array.isArray(fieldBag.options) || fieldBag.options.length < 1 || fieldBag.options.length > 12) {
          fail(`${fieldPath}.options must contain 1 to 12 values`)
        }
        const values = new Set<string | number | boolean>()
        field.options = fieldBag.options.map((option, optionIndex) => {
          const optionPath = `${fieldPath}.options.${optionIndex}`
          const optionBag = exactObject(option, optionPath, new Set(['label', 'value', 'description', 'preview']))
          const value = optionBag.value
          if (!scalar(value) || values.has(value)) fail(`${optionPath}.value is invalid or duplicate`)
          if (field.type === 'select') {
            const expected = bindingValueType(field.binding)
            if (typeof value !== expected || typeof value === 'number' && !Number.isFinite(value)) fail(`${optionPath}.value does not match its semantic binding`)
            if (range && (typeof value !== 'number' || value < range[0] || value > range[1])) fail(`${optionPath}.value exceeds its semantic binding`)
          }
          if (field.binding.target === 'layout' && field.binding.key === 'tabStyle' && !validTabStyle(value)) fail(`${optionPath}.value is not a supported tab style`)
          if (field.binding.target === 'notification' && !notificationValueAllowed(field.binding.key, value)) fail(`${optionPath}.value is not a supported notification style`)
          if (!semanticChoiceAllowed(field.binding, value, paletteIds)) fail(`${optionPath}.value is not a supported semantic choice`)
          if (field.type === 'font' && (typeof value !== 'string' || !FONT_STACK.test(value))) fail(`${optionPath}.value is not a font stack`)
          values.add(value)
          // 字体字段永远渲染成下拉加预览，缩略图没有落点；明确拒绝而不是静默丢弃。
          if (optionBag.preview !== undefined && field.type === 'font') fail(`${optionPath}.preview is not rendered for font fields`)
          const preview = optionBag.preview === undefined ? undefined : optionPreview(optionBag.preview, `${optionPath}.preview`, source)
          return {
            label: text(optionBag.label, `${optionPath}.label`, 96),
            value,
            ...(optionBag.description === undefined ? {} : { description: text(optionBag.description, `${optionPath}.description`, 160) }),
            ...(preview === undefined ? {} : { preview }),
          }
        })
      } else if (fieldBag.options !== undefined) fail(`${fieldPath} cannot declare options`)
      // 兼容性依赖已解析的 options 数量，必须放在 options 之后。
      if (presentation !== undefined) {
        if (!presentationMatchesField(presentation, field)) fail(`${fieldPath}.presentation does not fit this field`)
        field.presentation = presentation
      }
      if (fieldBag.help !== undefined) field.help = text(fieldBag.help, `${fieldPath}.help`, 240)
      if (fieldBag.visibleWhen !== undefined) {
        const conditionBag = exactObject(fieldBag.visibleWhen, `${fieldPath}.visibleWhen`, new Set(['field', 'equals']))
        const conditionField = safeVariantId(conditionBag.field, `${fieldPath}.visibleWhen.field`)
        if (!fieldKeys.has(conditionField) && !Array.from(fieldKeys).includes(conditionField)) {
          fail(`${fieldPath}.visibleWhen.field does not exist`)
        }
        if (!scalar(conditionBag.equals)) fail(`${fieldPath}.visibleWhen.equals is invalid`)
        field.visibleWhen = { field: conditionField, equals: conditionBag.equals }
      }
      if (!defaultValueMatchesField(field, field.default, source, false, paletteIds)) fail(`${fieldPath}.default is invalid`)
      return field
    })
    return {
      id,
      title: text(groupBag.title, `${groupPath}.title`, 96),
      ...(groupBag.description === undefined ? {} : { description: text(groupBag.description, `${groupPath}.description`, 240) }),
      fields,
    }
  })
  return { version, groups }
}

/**
 * Validate and normalize untrusted V2 input. `source` is host identity and
 * always replaces any caller-supplied source, including built-in requests.
 */
export function validateThemePackV2(input: unknown, source: string): ThemePackV2 {
  if (!SOURCE_ID.test(source)) fail('source is invalid')
  if (source === 'enest.builtin') fail('reserved theme source')
  const bag = exactObject(input, 'pack', new Set([
    'id', 'name', 'source', 'mode', 'tokens', 'background', 'backgroundEffects', 'schemaVersion',
    'version', 'description', 'variants', 'settings', 'palettes', 'home', 'quick', 'chrome', 'settingsPage',
  ]))
  const id = text(bag.id, 'pack.id', 128, SAFE_ID)
  const name = text(bag.name, 'pack.name', 96)
  if (bag.schemaVersion !== 2) fail('schemaVersion must be 2')
  if (typeof bag.version !== 'number' || !Number.isSafeInteger(bag.version) || bag.version < 1 || bag.version > 1e6) {
    fail('pack.version must be a positive integer')
  }
  const mode = bag.mode === 'light' || bag.mode === 'dark' || bag.mode === 'system' ? bag.mode : fail('pack.mode is invalid')
  const palettes = bag.palettes === undefined ? undefined : paletteDeclarations(bag.palettes, 'pack.palettes')
  const paletteIds = new Set<string>([
    ...DEFAULT_BACKGROUND_PALETTES.map(palette => palette.id),
    ...(palettes ?? []).map(palette => palette.id),
  ])
  const variantsBag = exactObject(bag.variants, 'pack.variants', new Set(COLOR_MODES))
  const variants = {
    light: variant(variantsBag.light, 'pack.variants.light', source, paletteIds),
    dark: variant(variantsBag.dark, 'pack.variants.dark', source, paletteIds),
  }
  const settings = settingsSchema(bag.settings, 'pack.settings', source, paletteIds)
  let home: ThemePackV2['home']
  if (bag.home !== undefined) {
    const homeBag = exactObject(bag.home, 'pack.home', new Set(['source', 'id', 'variant']))
    home = {
      source: text(homeBag.source, 'pack.home.source', 256, SOURCE_ID),
      id: safeVariantId(homeBag.id, 'pack.home.id'),
      variant: safeVariantId(homeBag.variant, 'pack.home.variant'),
    }
    if (home.source !== source) fail('pack.home must reference its owning source')
  }
  let quick: ThemePackV2['quick']
  if (bag.quick !== undefined) {
    const quickBag = exactObject(bag.quick, 'pack.quick', new Set(['version', 'entry']))
    if (quickBag.version !== 1) fail('pack.quick.version must be 1')
    const entry = text(quickBag.entry, 'pack.quick.entry', 240)
    if (!/^(?:(?!(?:backend|runtime|node_modules|src|tests?)\/)[A-Za-z0-9_@-]+\/)*[A-Za-z0-9_-]+\.html$/.test(entry)) fail('pack.quick.entry must be a package-relative HTML asset')
    quick = { version: 1, entry }
  }
  let chrome: ThemePackV2['chrome']
  if (bag.chrome !== undefined) {
    const chromeBag = exactObject(bag.chrome, 'pack.chrome', new Set(['version', 'classic', 'rail', 'dock']))
    if (chromeBag.version !== 1) fail('pack.chrome.version must be 1')
    chrome = { version: 1 }
    for (const part of ['classic', 'rail', 'dock'] as const) {
      if (chromeBag[part] === undefined) continue
      const descriptor = exactObject(chromeBag[part], `pack.chrome.${part}`, new Set(['entry']))
      const entry = text(descriptor.entry, `pack.chrome.${part}.entry`, 240)
      if (!/^(?:(?!(?:backend|runtime|node_modules|src|tests?)\/)[A-Za-z0-9_@-]+\/)*[A-Za-z0-9_-]+\.html$/.test(entry)) fail('pack.chrome entry must be a package-relative HTML asset')
      chrome[part] = { entry }
    }
    if (!chrome.classic && !chrome.rail && !chrome.dock) fail('pack.chrome needs a renderer')
  }
  let settingsPage: ThemePackV2['settingsPage']
  if (bag.settingsPage !== undefined) {
    const page = exactObject(bag.settingsPage, 'pack.settingsPage', new Set(['version', 'entry']))
    if (page.version !== 1) fail('pack.settingsPage.version must be 1')
    const entry = text(page.entry, 'pack.settingsPage.entry', 240)
    if (!/^(?:(?!(?:backend|runtime|node_modules|src|tests?)\/)[A-Za-z0-9_@-]+\/)*[A-Za-z0-9_-]+\.html$/.test(entry)) fail('pack.settingsPage.entry must be a package-relative HTML asset')
    settingsPage = { version: 1, entry }
  }
  const pack: ThemePackV2 = {
    id,
    name,
    source,
    mode,
    tokens: validateTokens(bag.tokens ?? {}, 'pack.tokens'),
    ...(bag.background === undefined ? {} : {
      background: optionalBackground(bag.background, 'pack.background', source) ?? undefined,
    }),
    ...(bag.backgroundEffects === undefined ? {} : {
      backgroundEffects: validateBackgroundEffects(bag.backgroundEffects, source),
    }),
    schemaVersion: 2,
    version: bag.version,
    ...(optionalText(bag.description, 'pack.description', 300) === undefined ? {} : { description: optionalText(bag.description, 'pack.description', 300) }),
    variants,
    settings,
    ...(palettes === undefined ? {} : { palettes }),
    ...(home ? { home } : {}),
    ...(quick ? { quick } : {}),
    ...(chrome ? { chrome } : {}),
    ...(settingsPage ? { settingsPage } : {}),
  }
  return plainClone(pack)
}

function safeIdentity(value: unknown, fallback: ThemeIdentity): ThemeIdentity {
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

function validMode(value: unknown): value is AppearanceSettings['mode'] {
  return value === 'light' || value === 'dark' || value === 'system'
}

function validTabStyle(value: unknown): value is 'classic' | 'orb' {
  return value === 'classic' || value === 'orb'
}

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

function validSettingValue(field: ThemeSettingsField, value: unknown, source: string, paletteIds?: ReadonlySet<string>): boolean {
  return defaultValueMatchesField(field, value as ThemeSettingValue, source, true, paletteIds)
}

/** Every id a profile value may legally name: built-ins plus the pack's own declarations. */
function paletteIdsFor(pack: ThemePackV2): ReadonlySet<string> {
  return new Set<string>([
    ...DEFAULT_BACKGROUND_PALETTES.map(palette => palette.id),
    ...(pack.palettes ?? []).map(palette => palette.id),
  ])
}

/**
 * The pack's own validated palette paints. Publication boundaries use this to let a theme's
 * declared gradients cross into the renderer while still rejecting arbitrary CSS.
 */
export function declaredPalettePaints(pack: ThemePackV2 | null | undefined): ReadonlySet<string> | undefined {
  const paints = (pack?.palettes ?? []).map(palette => palette.css)
  return paints.length ? new Set(paints) : undefined
}

function fieldsFor(pack: ThemePackV2): Map<string, ThemeSettingsField> {
  return new Map(pack.settings.groups.flatMap(group => group.fields).map(field => [field.key, field]))
}

function quarantine(profile: ThemeProfile, key: string, value: unknown, reason: string): void {
  if (!Object.hasOwn(profile.quarantined, key)) {
    profile.quarantined[key] = { value: plainClone(value), reason, schemaVersion: profile.schemaVersion }
  }
}

function cleanProfileShell(identity: ThemeIdentity, schemaVersion: number): ThemeProfile {
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
