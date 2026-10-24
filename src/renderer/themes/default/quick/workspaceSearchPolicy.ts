import { matchesSearchTerms, normalizeSearchText } from '@shared/search'
import type { HomeSearchEntry, HomeSearchScope } from '@shared/types/home'
import { rankDefaultQuickCatalog } from './searchPolicy'

/** Workspace and Quick share default name rules, but marketplace discovery stays a provider choice. */
export function rankDefaultWorkspaceSearch(
  entries: HomeSearchEntry[], query: string, scope: HomeSearchScope,
  contentMatches: ReadonlySet<string> = new Set()
): HomeSearchEntry[] {
  const commands = entries.filter(entry => entry.kind === 'app' || entry.kind === 'plugin' || entry.kind === 'action')
    .map(entry => ({ ...entry, id: entry.handle, kind: entry.kind as 'app' | 'plugin' | 'action' }))
  const kind = scope === 'installed' ? 'plugin' : scope === 'app' || scope === 'plugin' || scope === 'action' ? scope : undefined
  const matches = scope === 'market' ? [] : rankDefaultQuickCatalog(commands, query, kind, 60, contentMatches)
  const represented = new Set(matches.flatMap(entry => entry.kind === 'plugin' && entry.pluginId ? [entry.pluginId] : []))
  const q = normalizeSearchText(query)
  const market = scope === 'app' || scope === 'action' ? [] : entries.filter(entry => entry.kind === 'market'
    && (scope !== 'installed' && scope !== 'plugin' || entry.installed)
    && (scope === 'market' || !entry.pluginId || !represented.has(entry.pluginId))
    && matchesSearchTerms([entry.title, entry.subtitle, entry.pluginId, ...(entry.aliases ?? []), ...(entry.tags ?? [])].filter(Boolean).join(' '), query))
    .sort((a, b) => Number(normalizeSearchText(b.title) === q) - Number(normalizeSearchText(a.title) === q) || a.title.localeCompare(b.title, 'zh-CN'))
  return [...matches, ...market].slice(0, 60)
}
