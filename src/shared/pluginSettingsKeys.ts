/** Host authorization metadata must never be readable or writable as plugin business settings. */
const RESERVED_PLUGIN_SETTINGS_KEYS: ReadonlySet<string> = new Set([
  'permissionGrants',
  '__proto__',
  'prototype',
  'constructor'
])

export function isPluginSettingKey(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !RESERVED_PLUGIN_SETTINGS_KEYS.has(value)
}
