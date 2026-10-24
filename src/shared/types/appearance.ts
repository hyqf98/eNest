import type { AnimationLevel, BackgroundConfig, CustomFontMeta, SplashBackgroundConfig, TabStyle, ThemeMode, ThemePack, ThemeTokens } from './plugin'

/** Source is assigned by the host, never trusted from a plugin request. */
export interface ThemeIdentity { source: string; id: string }
export type AppearanceColorMode = 'light' | 'dark'
export type ThemeSettingValue = string | number | boolean | BackgroundConfig | null
export type ThemeColorToken = '--bg' | '--surface' | '--surface-2' | '--surface-3' | '--text' | '--text-2' | '--text-3' | '--accent' | '--ok' | '--danger' | '--border' | '--border-strong' | '--link'
/** Options a theme can expose for the classic top tab strip. */
export type ThemeTabStripKey = 'tabOpacity' | 'tabAutoHide'
export type ThemeLayoutKey = 'density' | 'gap' | 'sidebarWidth' | 'contentWidth' | 'columns' | 'tabStyle' | ThemeTabStripKey
export type ThemeBackgroundKind = 'none' | 'gradient' | 'color' | 'image' | 'video'
export type ThemeBackgroundPalette = 'theme' | 'dawn' | 'mint' | 'linen' | 'peach' | 'ocean' | 'forest' | 'ink'
/** A pack-declared atmosphere preset; both paints are validated before the pack is accepted. */
export interface ThemeBackgroundPaletteDeclaration {
  id: string
  name: string
  css: string
  swatch?: string
}
export type ThemeBackgroundKey = 'texture' | 'intensity' | 'speed' | 'direction' | 'effect' | 'media' | 'warmth' | 'grain' | 'scale' | 'wash' | 'kind' | 'palette' | 'color' | 'opacity' | 'fit'
export type ThemeComponentKey = 'controlRadius' | 'cardRadius' | 'panelRadius' | 'borderWidth'
export type ThemeFontKey = 'body' | 'heading' | 'mono' | 'scale' | 'cjk' | 'latin'
export type ThemeSplashKey = 'type' | 'media' | 'opacity'
export interface ThemeNotificationStyle {
  layout: 'card' | 'compact' | 'banner'
  accent: 'stripe' | 'icon' | 'none'
  radius: number
  borderWidth: number
  density: number
  shadow: 'none' | 'soft' | 'raised'
}
export type ThemeNotificationKey = keyof ThemeNotificationStyle

/** Declarative bindings are semantic destinations, not CSS selectors or executable expressions. */
export type ThemeSettingBinding =
  | { target: 'token'; key: ThemeColorToken }
  | { target: 'layout'; key: ThemeLayoutKey }
  | { target: 'background'; key: ThemeBackgroundKey }
  | { target: 'component'; key: ThemeComponentKey }
  | { target: 'font'; key: ThemeFontKey }
  | { target: 'splash'; key: ThemeSplashKey }
  | { target: 'notification'; key: ThemeNotificationKey }
  | { target: 'animation'; key: 'level' }

/**
 * Declarative widget hint. The host still owns every control, its behaviour and its styles;
 * a pack only names the shape it prefers and the host falls back when the hint is unsupported.
 */
export type ThemeSettingPresentation = 'segmented' | 'cards' | 'slider-cluster'

/** A validated option thumbnail. Code is never executed; assets resolve inside the declaring plugin. */
export type ThemeSettingOptionPreview =
  | { kind: 'swatch'; stops: [string, string] }
  | { kind: 'asset'; src: string }

export interface ThemeSettingOption {
  label: string
  value: string | number | boolean
  description?: string
  /** Host-rendered thumbnail; omitted options render a text-only card. */
  preview?: ThemeSettingOptionPreview
}

export interface ThemeSettingsField {
  key: string
  label: string
  type: 'color' | 'slider' | 'switch' | 'select' | 'font' | 'media' | 'token'
  default: ThemeSettingValue
  binding: ThemeSettingBinding
  min?: number
  max?: number
  step?: number
  options?: ThemeSettingOption[]
  /** Preferred widget shape; the host validates it against the field's type and binding. */
  presentation?: ThemeSettingPresentation
  help?: string
  visibleWhen?: { field: string; equals: string | number | boolean }
}

export interface ThemeSettingsSchema {
  version: number
  groups: Array<{ id: string; title: string; description?: string; fields: ThemeSettingsField[] }>
}

export interface HomePageContribution {
  id: string
  source: string
  version: number
  /** Package-relative HTML entry. No remote URLs or traversal. */
  entry: string
  variants: string[]
}

export interface ThemeHomeReference { source: string; id: string; variant: string }
export interface AppearanceFonts {
  body: string
  heading: string
  mono: string
  scale: number
  /** Latin precedes CJK in the composed body stack; empty slots use the authored body. */
  cjk?: string
  latin?: string
}
export interface AppearanceComponents { controlRadius: number; cardRadius: number; panelRadius: number; borderWidth: number }
export interface AppearanceLayout {
  variant: string
  tabStyle?: TabStyle
  /** Titlebar background opacity, 0–1; labels, icons and window controls stay opaque. */
  tabOpacity?: number
  /** Classic titlebar collapses to an 8px host-owned reveal strip. */
  tabAutoHide?: boolean
  density: number
  gap: number
  sidebarWidth: number
  contentWidth: number
  columns: number
}
export interface AppearanceBackground {
  media: BackgroundConfig | null
  effect: string
  texture: string
  intensity: number
  speed: number
  direction: number
  /** Independent material controls; omitted V2 fields retain host defaults. */
  warmth?: number
  grain?: number
  scale?: number
  wash?: number
  kind?: ThemeBackgroundKind
  /** Built-in preset id, or an id the active pack declared in `ThemePackV2.palettes`. */
  palette?: ThemeBackgroundPalette | (string & {})
  color?: string
  opacity?: number
  fit?: 'cover' | 'contain'
}
export interface AppearanceSplash {
  type: 'brand' | 'none' | 'image' | 'paper'
  media: BackgroundConfig | null
  opacity: number
}
export interface ThemeVariant {
  tokens: Partial<Record<ThemeColorToken, string>>
  fonts: AppearanceFonts
  components: AppearanceComponents
  background: AppearanceBackground
  layout: AppearanceLayout
  /** Host-authored notification structure; omission retains host defaults. */
  notifications?: ThemeNotificationStyle
  /** Independent startup fallback, after any shared effect/atmosphere precedence. */
  splash?: AppearanceSplash
  animation: AnimationLevel
}

/** V1 fields remain present as a compatibility view for older consumers. */
export interface ThemePackV2 extends ThemePack {
  schemaVersion: 2
  version: number
  description?: string
  variants: Record<AppearanceColorMode, ThemeVariant>
  settings: ThemeSettingsSchema
  /** Extra atmosphere presets usable from `background.palette`; ids never shadow host presets. */
  palettes?: ThemeBackgroundPaletteDeclaration[]
  /** Omission uses the built-in workspace; a supplied provider must support Workspace V1. */
  home?: ThemeHomeReference
  /** Isolated Quick presentation. Omission keeps the host's built-in launcher. */
  quick?: import('./quickTheme').ThemeQuickReference
  /** Optional sandboxed navigation renderers. The host retains geometry and lifecycle. */
  chrome?: import('./themeChrome').ThemeChromeReference
  /** Optional isolated settings presentation; protected actions stay native. */
  settingsPage?: import('./themeSettings').ThemeSettingsReference
}

export interface ThemeProfile {
  identity: ThemeIdentity
  schemaVersion: number
  values: Record<string, ThemeSettingValue>
  colors: Partial<Record<AppearanceColorMode, Partial<Record<ThemeColorToken, string>>>>
  /** Removed/invalid values are retained for recovery but never applied. */
  quarantined: Record<string, { value: unknown; reason: string; schemaVersion: number }>
}

export interface LegacyAppearanceBackup {
  theme: ThemeTokens
  general: {
    tabStyle?: TabStyle
    fontFamily?: string
    fontFamilyEn?: string
    fontSizeScale?: number
    animationLevel?: AnimationLevel
    splashBackground?: SplashBackgroundConfig
  }
}

export interface AppearanceSettings {
  version: 2
  revision: number
  mode: ThemeMode
  active: ThemeIdentity
  profiles: Record<string, ThemeProfile>
  /** Immutable migration input; removed theme profiles remain available for recovery. */
  legacyBackup?: LegacyAppearanceBackup
  legacy: LegacyAppearanceBackup
  /** Failed paired activation is retained for explicit recovery/retry. */
  recovery?: { theme: ThemeIdentity; reason: string }
}

export interface AppearanceDiagnostic { path: string; code: string; message: string }
export interface ResolvedAppearance {
  version: 2
  revision: number
  theme: ThemeIdentity & { name: string; version: number; legacy: boolean }
  requestedMode: ThemeMode
  mode: AppearanceColorMode
  tokens: Record<string, string>
  fonts: AppearanceFonts
  components: AppearanceComponents
  background: AppearanceBackground
  splash: AppearanceSplash
  layout: AppearanceLayout
  notifications: ThemeNotificationStyle
  animation: { requested: AnimationLevel; effective: AnimationLevel; continuous: boolean }
  home: ThemeHomeReference
  quick?: import('./quickTheme').ThemeQuickReference
  chrome?: import('./themeChrome').ThemeChromeReference
  settingsPage?: import('./themeSettings').ThemeSettingsReference
  diagnostics: AppearanceDiagnostic[]
  /** Host-owned public font handles; no local paths or custom-font metadata. */
  resources?: { fonts: Array<{ family: string; url: string }> }
}

/** One patch addresses one source/theme. It cannot replace another window's profile bag. */
export interface ThemeProfilePatch {
  theme: ThemeIdentity
  values?: Record<string, ThemeSettingValue>
  colors?: Partial<Record<AppearanceColorMode, Partial<Record<ThemeColorToken, string | null>>>>
  reset?: boolean
}

export interface AppearanceSnapshot {
  appearance: ResolvedAppearance
  profile: ThemeProfile
  packs: ThemePackV2[]
  customFonts: CustomFontMeta[]
}
