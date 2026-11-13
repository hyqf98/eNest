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

/**
 * 开机自启状态。enabled 是「系统实际注册结果」而非存储偏好——
 * 用户可在系统设置里手动禁用，读取时始终以系统为准并回写同步。
 * supported=false（如 Linux 无 XDG autostart 目录）时开关只读。
 */
export interface LoginItemState {
  supported: boolean
  enabled: boolean
  /** 注册/注销失败的原因（如 macOS 未签名导致静默失败）；成功时缺省 */
  error?: string
}

export interface LoginItemSetResult {
  ok: boolean
  enabled: boolean
  error?: string
}

export interface ProxySetResult {
  needRestart: boolean
  proxy: ProxyConfig
}
