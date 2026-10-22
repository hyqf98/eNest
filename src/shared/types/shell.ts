import type { PluginLaunchConfig, ProxyConfig, SettingsSectionContribution, ThemePack, ThemeTokens } from './plugin'

export type ShellThemeResult = ThemeTokens & { packs: ThemePack[] }

export interface PluginLaunchSetResult {
  ok: boolean
  error?: string
  config?: PluginLaunchConfig | null
}

export interface ShellSettingsSection extends SettingsSectionContribution {
  pluginId: string
}

export interface PickFileOptions {
  filters?: 'image' | 'video' | 'media' | 'font'
}

export interface HardwareAccelState {
  enabled: boolean
}

export interface HardwareAccelSetResult {
  needRestart: boolean
}

export interface ProxySetResult {
  needRestart: boolean
  proxy: ProxyConfig
}
