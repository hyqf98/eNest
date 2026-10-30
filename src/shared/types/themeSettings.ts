import type { QuickThemeAppearance } from './quickTheme'

export interface ThemeSettingsReference { version: 1; entry: string }
export interface ThemeSettingsConfig { key: string; url: string }
export type ThemeSettingsValue = string | number | boolean | null
export interface ThemeSettingsFieldDescriptor {
  /** Session capability; it never encodes a setting key or filesystem target. */
  id: string
  label: string
  type: 'switch' | 'select' | 'number' | 'color'
  value: ThemeSettingsValue
  options?: Array<{ label: string; value: ThemeSettingsValue }>
  min?: number
  max?: number
  step?: number
  /** Editing another plugin's preferences always requires a native confirmation. */
  confirmation?: boolean
}
export type NativeSettingsSection = 'general' | 'theme' | 'dev' | `p:${string}`
export interface ThemeSettingsSnapshot {
  version: 1
  revision: number
  locale: 'zh-CN' | 'en-US'
  appearance: QuickThemeAppearance
  groups: Array<{ id: string; title: string; fields: ThemeSettingsFieldDescriptor[] }>
  nativeSections: Array<{ id: NativeSettingsSection; title: string }>
}
export type ThemeSettingsAction =
  | { type: 'set'; fieldId: string; value: ThemeSettingsValue }
  | { type: 'native'; section: NativeSettingsSection }
export interface ThemeSettingsActionResult { ok: boolean; error?: string; nativeSection?: NativeSettingsSection }
/** Isolated theme settings pages never receive shellApi, raw settings, grants, tokens or account data. */
export interface EnestSettingsApi {
  ready(): void
  getState(): Promise<ThemeSettingsSnapshot>
  onState(listener: (snapshot: ThemeSettingsSnapshot) => void): () => void
  action(action: ThemeSettingsAction): Promise<ThemeSettingsActionResult>
}
