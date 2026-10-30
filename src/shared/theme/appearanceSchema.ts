/** Validate and normalize untrusted theme packs and settings schemas without applying user profiles. */
import type {
  AppearanceBackground,
  AppearanceComponents,
  AppearanceFonts,
  AppearanceLayout,
  AppearanceSplash,
  ThemeBackgroundKey,
  ThemeBackgroundPaletteDeclaration,
  ThemeColorToken,
  ThemeComponentKey,
  ThemeFontKey,
  ThemeLayoutKey,
  ThemeNotificationKey,
  ThemeNotificationStyle,
  ThemePackV2,
  ThemeSettingBinding,
  ThemeSettingOptionPreview,
  ThemeSettingPresentation,
  ThemeSettingValue,
  ThemeSettingsField,
  ThemeSettingsSchema,
  ThemeSplashKey,
  ThemeVariant,
} from '@shared/types/appearance'
import type { AnimationLevel } from '@shared/types/plugin'
import { DEFAULT_BACKGROUND_PALETTES, backgroundPalette, isSafePalettePaint } from '@shared/theme/defaultTheme/backgroundPalettes'
import { isPluginAssetPath } from '@shared/pluginContract'
import { parseThemeColor } from '@shared/theme/colors'
import { BUILTIN_THEME_SOURCE } from '@shared/theme/builtinThemes'
import { validateBackgroundEffects } from '@shared/backgroundEffects'
import {
  ANIMATION_LEVELS,
  backgroundConfig,
  color,
  COLOR_MODES,
  exactObject,
  fail,
  FONT_STACK,
  fontStack,
  HOST_BASE,
  MEDIA_EFFECT,
  numberInRange,
  object,
  optionalBackground,
  optionalText,
  plainClone,
  SAFE_ID,
  safeVariantId,
  SOURCE_ID,
  SPLASH_TYPES,
  text,
  TOKEN_KEYS,
  validTabStyle,
} from './appearanceValues'

const FIELD_TYPES = new Set(['color', 'slider', 'switch', 'select', 'font', 'media', 'token'])

const LAYOUT_KEYS = new Set<string>(['density', 'gap', 'sidebarWidth', 'contentWidth', 'columns', 'tabStyle', 'tabOpacity', 'tabAutoHide'])

const BACKGROUND_KEYS = new Set<string>(['texture', 'intensity', 'speed', 'direction', 'effect', 'media', 'warmth', 'grain', 'scale', 'wash', 'kind', 'palette', 'color', 'opacity', 'fit'])

const COMPONENT_KEYS = new Set<string>(['controlRadius', 'cardRadius', 'panelRadius', 'borderWidth'])

const FONT_KEYS = new Set<string>(['body', 'heading', 'mono', 'scale', 'cjk', 'latin'])

const SPLASH_KEYS = new Set<string>(['type', 'media', 'opacity'])

const BACKGROUND_KINDS = new Set(['none', 'gradient', 'color', 'image', 'video'])

const NOTIFICATION_KEYS = new Set<string>(['layout', 'accent', 'radius', 'borderWidth', 'density', 'shadow'])

const NOTIFICATION_ENUMS = {
  layout: ['card', 'compact', 'banner'],
  accent: ['stripe', 'icon', 'none'],
  shadow: ['none', 'soft', 'raised'],
} as const

const TOKEN_NAME = /^--[A-Za-z0-9_-]{1,126}$/

/** Palette ids come from the built-in table plus the pack's own validated declarations. */
function paletteId(value: unknown, path: string, paletteIds: ReadonlySet<string>): string {
  const id = safeVariantId(value, path)
  return paletteIds.has(id) ? id : fail(`${path} is not a declared atmosphere preset`)
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

export function defaultValueMatchesField(field: ThemeSettingsField, value: ThemeSettingValue, source = 'schema-validation', allowLibrary = false, paletteIds?: ReadonlySet<string>): boolean {
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

/**
 * The pack's own validated palette paints. Publication boundaries use this to let a theme's
 * declared gradients cross into the renderer while still rejecting arbitrary CSS.
 */
export function declaredPalettePaints(pack: ThemePackV2 | null | undefined): ReadonlySet<string> | undefined {
  const paints = (pack?.palettes ?? []).map(palette => palette.css)
  return paints.length ? new Set(paints) : undefined
}
