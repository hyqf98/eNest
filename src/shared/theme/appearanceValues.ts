/** Shared semantic defaults and safe value primitives; no host or renderer runtime dependencies. */
import type { AppearanceColorMode, AppearanceSettings, AppearanceSplash, ThemeIdentity, ThemeNotificationStyle, ThemeVariant } from '@shared/types/appearance'
import { BUILTIN_THEME_SOURCE, DEFAULT_THEME_IDENTITY } from '@shared/theme/builtinThemes'
import type { AnimationLevel, BackgroundConfig } from '@shared/types/plugin'
import { parseThemeColor } from '@shared/theme/colors'
import { isSafeAppearanceBackgroundColor } from '@shared/theme/defaultTheme/backgroundPalettes'
import { isPluginAssetPath } from '@shared/pluginContract'

export const APPEARANCE_SCHEMA_VERSION = 2

export const THEME_PROFILE_LEGACY: ThemeIdentity = {
  source: 'enest.builtin',
  id: 'legacy-custom',
}

/** Compatibility export for callers compiled before the single-default-theme migration. */
export const THEME_HOME_LEGACY = { source: BUILTIN_THEME_SOURCE, id: 'home', variant: DEFAULT_THEME_IDENTITY.id }

export const COLOR_MODES: AppearanceColorMode[] = ['light', 'dark']

export const ANIMATION_LEVELS: AnimationLevel[] = ['low', 'medium', 'high']

export const TOKEN_KEYS = new Set<string>([
  '--bg', '--surface', '--surface-2', '--surface-3', '--text', '--text-2',
  '--text-3', '--accent', '--ok', '--danger', '--border', '--border-strong', '--link',
])

export const SPLASH_TYPES = new Set(['brand', 'none', 'image', 'paper'])

export const DEFAULT_APPEARANCE_SPLASH: Readonly<AppearanceSplash> = Object.freeze({ type: 'brand', media: null, opacity: 0.55 })

export const DEFAULT_NOTIFICATION_STYLE: Readonly<ThemeNotificationStyle> = Object.freeze({
  layout: 'card', accent: 'stripe', radius: 16, borderWidth: 1, density: 1, shadow: 'soft',
})

export const SAFE_ID = /^[A-Za-z][A-Za-z0-9_-]{0,127}$/

export const SOURCE_ID = /^[a-z0-9]+(?:\.[a-zA-Z0-9-]+)+$/

export const FONT_STACK = /^[\p{L}\p{N}_ '".,\-]{0,240}$/u

const SAFE_TEXT = /^[^\u0000-\u001f\u007f<>]+$/

export const MEDIA_EFFECT = /^(?:none|[A-Za-z][A-Za-z0-9_-]{0,95}|plugin:[A-Za-z0-9_.%-]+:[A-Za-z0-9_.%-]+:[A-Za-z0-9_.%-]+)$/

export const RESERVED_KEYS = new Set(['__proto__', 'prototype', 'constructor'])

export const LEGACY_BACKGROUND_PENDING = 'migration.background-pack'

export const LEGACY_BACKGROUND_PENDING_REASON = 'legacy-pack-background-pending'

export type Bag = Record<string, unknown>

export function fail(message: string): never {
  throw new Error(`invalid theme pack: ${message}`)
}

export function object(value: unknown, path: string): Bag {
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

export function exactObject(value: unknown, path: string, allowed: Set<string>): Bag {
  const bag = object(value, path)
  for (const key of Object.keys(bag)) {
    if (!allowed.has(key)) fail(`unknown ${path} field "${key}"`)
  }
  return bag
}

export function plainClone<T>(value: T): T {
  return structuredClone(value)
}

export function text(value: unknown, path: string, maximum: number, pattern = SAFE_TEXT): string {
  if (typeof value !== 'string' || !pattern.test(value) || value.trim() !== value) fail(`${path} has invalid text`)
  if (value.length > maximum) fail(`${path} exceeds ${maximum} characters`)
  return value
}

export function optionalText(value: unknown, path: string, maximum: number, pattern = SAFE_TEXT): string | undefined {
  return value === undefined ? undefined : text(value, path, maximum, pattern)
}

function finite(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(`${path} must be a finite number`)
  return value
}

export function numberInRange(value: unknown, path: string, minimum: number, maximum: number): number {
  const result = finite(value, path)
  if (result < minimum || result > maximum) fail(`${path} must be between ${minimum} and ${maximum}`)
  return result
}

export function color(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length > 96 || !parseThemeColor(value)) fail(`${path} must be a supported color`)
  return value
}

export function fontStack(value: unknown, path: string): string {
  if (typeof value !== 'string' || !FONT_STACK.test(value)) fail(`${path} has an invalid font stack`)
  return value
}

export function identity(value: unknown, path: string): ThemeIdentity {
  const bag = exactObject(value, path, new Set(['source', 'id']))
  const source = text(bag.source, `${path}.source`, 256, SOURCE_ID)
  const id = text(bag.id, `${path}.id`, 128, SAFE_ID)
  return { source, id }
}

export function safeVariantId(value: unknown, path: string): string {
  return text(value, path, 96, SAFE_ID)
}

export function backgroundConfig(value: unknown, path: string, source: string, allowLibrary = false): BackgroundConfig {
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

export function optionalBackground(value: unknown, path: string, source: string): BackgroundConfig | null {
  return value === undefined || value === null ? null : backgroundConfig(value, path, source)
}

export const HOST_BASE: Record<AppearanceColorMode, ThemeVariant> = {
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

export function validMode(value: unknown): value is AppearanceSettings['mode'] {
  return value === 'light' || value === 'dark' || value === 'system'
}

export function validTabStyle(value: unknown): value is 'classic' | 'orb' {
  return value === 'classic' || value === 'orb'
}
