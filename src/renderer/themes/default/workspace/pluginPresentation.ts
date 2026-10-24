import type { PluginSummary } from '@shared/types/plugin'

/** Real package bytes only; decimal KB/MB/GB units, with no fabricated missing size. */
export function formatPluginPackageSize(bytes?: number): string | undefined {
  if (typeof bytes !== 'number' || !Number.isSafeInteger(bytes) || bytes <= 0) return undefined
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'] as const
  let value = bytes
  let unit = 0
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000
    unit += 1
  }
  // Round before promotion so a near-boundary size reads "1 MB", not "1000 KB".
  value = Number(value.toFixed(unit === 0 ? 0 : 1))
  if (value >= 1000 && unit < units.length - 1) {
    value /= 1000
    unit += 1
  }
  return `${value} ${units[unit]}`
}

/** Public rendering slots shared by the host adapters and isolated default Workspace. */
export type PluginPresentation = Pick<PluginSummary,
  'id' | 'name' | 'description' | 'version' | 'author' | 'category' | 'installs' | 'color' | 'glyph' |
  'icon' | 'screenshots' | 'readmeUrl' | 'readmeImages' | 'featured' | 'tags' | 'packageSize' |
  'permissions' | 'installed' | 'enabled' | 'latestVersion'>
