import type { PluginLaunchMode } from './plugin'

/** A user-owned global shortcut. Registering it never starts a plugin. */
export interface PluginShortcutBinding {
  id: string
  pluginId: string
  accelerator: string
  mode: PluginLaunchMode
  enabled: boolean
}

export type PluginShortcutInput = Omit<PluginShortcutBinding, 'id'> & { id?: string }

export interface PluginShortcutState {
  id: string
  status: 'registered' | 'disabled' | 'plugin-disabled' | 'plugin-missing' | 'conflict' | 'suspended'
  error?: string
}

export interface PluginShortcutsSnapshot {
  bindings: PluginShortcutBinding[]
  states: PluginShortcutState[]
}

export interface ShortcutProbeResult {
  accelerator: string
  status: 'free' | 'system' | 'quick' | 'shortcut' | 'runtime' | 'invalid'
  ownerBindingId?: string
  ownerPluginId?: string
  ownerLabel?: string
  hint?: string
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
