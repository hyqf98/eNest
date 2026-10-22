import { isAbsolute, relative, resolve } from 'node:path'

const SOURCE_PATTERN = /^[a-z0-9]+(?:\.[a-zA-Z0-9-]+)+$/
const HOME_ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,127}$/
const VARIANT_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/

export function isInsideDirectory(root: string, candidate: string): boolean {
  const resolvedRoot = resolve(root)
  const resolvedCandidate = resolve(candidate)
  const relation = relative(resolvedRoot, resolvedCandidate)
  return relation === '' || (Boolean(relation) && !relation.startsWith('..') && !isAbsolute(relation))
}

/** The URL names a public manifest slot, never a caller-selected filesystem path. */
export function homeCatalogResourceUrl(pluginId: string, kind: 'icon' | 'readme' | 'screenshot', index?: number): string {
  const suffix = kind === 'screenshot' ? `screenshot/${index ?? 0}` : kind
  return `enest-home://catalog/${encodeURIComponent(pluginId)}/${suffix}`
}

export function parseHomeReference(value: {
  source?: unknown
  id?: unknown
  variant?: unknown
}): { source: string; id: string; variant: string } | null {
  if (!value || typeof value !== 'object') return null
  if (typeof value.source !== 'string' || typeof value.id !== 'string' || typeof value.variant !== 'string') return null
  if (value.source === 'enest.builtin') {
    if (value.id !== 'home') return null
  } else if (!SOURCE_PATTERN.test(value.source) || !HOME_ID_PATTERN.test(value.id)) {
    return null
  }
  if (!VARIANT_PATTERN.test(value.variant)) return null
  return { source: value.source, id: value.id, variant: value.variant }
}
