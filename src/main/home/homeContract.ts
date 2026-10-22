import type { HomePageContribution } from '@shared/types/appearance'
import { DEFAULT_THEME_PACKAGE } from '@shared/theme/defaultTheme/package'

const ENTRY_PATTERN = /^(?:[A-Za-z0-9_@-]+\/)*[A-Za-z0-9_-]+\.html$/
const VARIANT_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/
const ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,127}$/
export const BUILT_IN_HOME_PAGE = DEFAULT_THEME_PACKAGE.contributes.homePages[0]
export const BUILT_IN_HOME_SOURCE = DEFAULT_THEME_PACKAGE.id
export const BUILT_IN_HOME_ID = BUILT_IN_HOME_PAGE.id

/** Contributions are untrusted input; every field and resolved path is rechecked here. */
export function validateHomeContribution(input: unknown, expectedSource: string): HomePageContribution | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null
  const bag = input as Record<string, unknown>
  if (typeof bag.source !== 'string' || bag.source !== expectedSource) return null
  if (typeof bag.id !== 'string' || !ID_PATTERN.test(bag.id)) return null
  if (typeof bag.version !== 'number' || !Number.isSafeInteger(bag.version) || bag.version < 1 || bag.version > 1_000_000) return null
  if (typeof bag.entry !== 'string' || bag.entry.length > 240 || !ENTRY_PATTERN.test(bag.entry)) return null
  if (!Array.isArray(bag.variants) || bag.variants.length === 0 || bag.variants.length > 12) return null
  const variants = [...new Set(bag.variants)]
  if (variants.length !== bag.variants.length || !variants.every(item => typeof item === 'string' && VARIANT_PATTERN.test(item))) return null
  return { source: bag.source, id: bag.id, version: bag.version, entry: bag.entry, variants }
}
