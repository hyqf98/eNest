import type { PluginPermission, PluginPermissionGrant } from '@shared/types/plugin'
import { PLUGIN_PERMISSIONS } from '@shared/types/plugin'

/**
 * Built-in capabilities operate on a plugin's own data, shell contributions, or
 * files explicitly selected through a host picker. They need neither manifest
 * declaration nor an additional consent prompt. File handles still enforce the
 * selected target, access mode and runtime owner; raw paths never grant access.
 * Other external resources and system-wide effects require declared consent.
 */
export const BUILTIN_PLUGIN_CAPABILITIES = [
  'storage.local',
  'ui.setTitle',
  'ui.setIcon',
  'ui.setBadge',
  'ui.resize',
  'ui.toast',
  'settings.register',
  'settings.page',
  'theme',
  'vault.write',
  'timer.background',
  'fs.read',
  'fs.write'
] as const satisfies readonly PluginPermission[]

const builtinCapabilities: ReadonlySet<string> = new Set(BUILTIN_PLUGIN_CAPABILITIES)

export function isBuiltinCapability(permission: string): boolean {
  return builtinCapabilities.has(permission)
}

/** New or unknown capabilities must never become implicitly trusted. */
export function requiresUserConsent(permission: string): boolean {
  return !isBuiltinCapability(permission)
}

/** Only known sensitive permissions and valid decisions belong in the consent UI. */
export function filterPermissionGrants(value: unknown): Partial<Record<PluginPermission, PluginPermissionGrant>> {
  const result: Partial<Record<PluginPermission, PluginPermissionGrant>> = {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) return result
  const entries = value as Record<string, unknown>
  for (const permission of PLUGIN_PERMISSIONS) {
    if (!requiresUserConsent(permission)) continue
    const grant = Object.hasOwn(entries, permission) ? entries[permission] : undefined
    if (grant === 'ask' || grant === 'allow' || grant === 'deny') result[permission] = grant
  }
  return result
}
