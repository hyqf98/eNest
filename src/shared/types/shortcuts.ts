import type { PluginLaunchTarget } from './plugin'

/** A user-owned global shortcut. Registering it never starts a plugin. */
export interface PluginShortcutBinding {
  id: string
  pluginId: string
  accelerator: string
  mode: PluginLaunchTarget
  enabled: boolean
  /**
   * The user confirmed taking this chord over with the low-level keyboard hook (Windows).
   * It is an authorization, not a promise: normal registration is still tried first on every restore.
   */
  forced?: boolean
}

/**
 * `forced` is deliberately absent: only the main process may grant it, after an explicit `force`
 * request actually took the chord over. Otherwise a caller could forge the authorization.
 */
export type PluginShortcutInput = Omit<PluginShortcutBinding, 'id' | 'forced'> & {
  id?: string
  overrideToken?: string
  /** The user explicitly asked to take an externally occupied chord over with the keyboard hook. */
  force?: boolean
}

export interface PluginShortcutState {
  id: string
  status: 'registered' | 'pending-system' | 'disabled' | 'plugin-disabled' | 'plugin-missing' | 'conflict' | 'suspended' | 'forced'
  error?: string
}

/** A shortcut a plugin registered at runtime through `enest.hotkey.register`. Read-only for settings. */
export interface HotkeyRuntimeEntry {
  pluginId: string
  accelerator: string
  /** Feature name the plugin supplied; absent when it registered without one. */
  label?: string
}

export interface PluginShortcutsSnapshot {
  bindings: PluginShortcutBinding[]
  states: PluginShortcutState[]
  /** Currently registered plugin runtime shortcuts; lifecycle belongs to each plugin. */
  runtime: HotkeyRuntimeEntry[]
}

export interface ShortcutProbeResult {
  accelerator: string
  status: 'free' | 'system' | 'quick' | 'shortcut' | 'runtime' | 'invalid'
  ownerBindingId?: string
  ownerPluginId?: string
  ownerLabel?: string
  hint?: string
  /** system 占用是否可强制接管（Windows 低级键盘钩子；系统保留键不可） */
  forceable?: boolean
  /** Short-lived confirmation for replacing this exact user-owned conflict. Never supplied for OS/runtime keys. */
  overrideToken?: string
}

export interface PluginShortcutMutationResult {
  ok: boolean
  error?: string
  probe?: ShortcutProbeResult
  snapshot?: PluginShortcutsSnapshot
  binding?: PluginShortcutBinding
}

export interface PluginShortcutLaunchResult {
  ok: boolean
  error?: string
  cancelled?: boolean
}
