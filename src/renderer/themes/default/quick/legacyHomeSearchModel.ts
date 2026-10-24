import type { PluginSummary } from '@shared/types/plugin'
import type { QuickCommand, QuickCommandKind, QuickOpenRequest, QuickSearchPhase, QuickSearchResult } from '@shared/types/quick'
import { matchesSearchTerms, normalizeSearchText } from '@shared/search'
import { rankDefaultQuickCatalog } from './searchPolicy'
import { matchDefaultQuickContent } from './patternMatching'

export type HomeSearchScope = 'all' | 'app' | 'plugin' | 'market' | 'action'
export type HomeSearchEntry = { id: string; kind: 'command'; command: QuickCommand } | { id: string; kind: 'market'; plugin: PluginSummary }
export type HomeSearchRequest = (query: string, limit: number, kind: QuickCommandKind | undefined, phase: QuickSearchPhase, ids?: string[]) => Promise<QuickSearchResult>

/** The browser-preview compatibility surface uses the same default renderer policy, not host ranking. */
export async function searchHomeCommands(
  query: string,
  kind: QuickCommandKind | undefined,
  request: HomeSearchRequest,
  update: (items: QuickCommand[], initial: boolean) => void,
  current: () => boolean,
): Promise<boolean> {
  let catalog = (await request(query, 8_192, kind, 'catalog')).items
  if (!current()) return false
  let contentMatches = new Set<string>()
  const rank = () => rankDefaultQuickCatalog(catalog.map(item => ({ ...item, provider: item.group === 'provider' })), query, kind, 60, contentMatches)
  const initial = rank()
  update(initial, true)
  const settled = await Promise.allSettled([
    (async () => {
      const result = await request(query, 60, kind, 'enriched', initial.map(item => item.id))
      if (!current()) return
      const byId = new Map(result.items.map(item => [item.id, item]))
      catalog = catalog.map(item => byId.get(item.id) ?? item)
      update(rank(), false)
    })(),
    (async () => {
      if (kind && kind !== 'plugin') return
      const result = await request(query, 60, kind, 'providers')
      if (!current()) return
      const byId = new Map(catalog.map(item => [item.id, item]))
      for (const item of result.items) byId.set(item.id, item)
      catalog = [...byId.values()]
      update(rank(), false)
    })(),
    (async () => {
      contentMatches = await matchDefaultQuickContent(catalog, query)
      if (current()) update(rank(), false)
    })()
  ])
  return settled.some((result) => result.status === 'rejected')
}

/** Add catalog matches without duplicating installed commands already ranked by Quick. */
export function homeSearchEntries(commands: QuickCommand[], plugins: PluginSummary[], query: string, scope: HomeSearchScope): HomeSearchEntry[] {
  const q = normalizeSearchText(query)
  if (!q) return []
  const visible = scope === 'market' ? [] : commands.filter((command) => scope === 'all' || command.kind === scope)
  const entries: HomeSearchEntry[] = visible.map((command) => ({ id: command.id, kind: 'command', command }))
  if (scope === 'app' || scope === 'action') return entries
  const matchedPlugins = new Set(visible.filter((command) => command.kind === 'plugin').map((command) => command.pluginId))
  const catalog = plugins.filter((plugin) => matchesSearchTerms(`${plugin.name} ${plugin.description} ${plugin.id} ${plugin.author} ${plugin.tags?.join(' ') ?? ''}`, q))
    .sort((a, b) => Number(normalizeSearchText(b.name) === q) - Number(normalizeSearchText(a.name) === q))
  for (const plugin of catalog) {
    if (scope === 'plugin' && !plugin.installed) continue
    if (scope !== 'market' && matchedPlugins.has(plugin.id)) continue
    if (scope !== 'market' && plugin.installed && plugin.enabled !== false) {
      const command: QuickCommand = { id: `plugin:${plugin.id}:`, kind: 'plugin', pluginId: plugin.id, title: plugin.name, subtitle: plugin.description, icon: plugin.icon }
      entries.push({ id: command.id, kind: 'command', command })
    } else entries.push({ id: `market:${plugin.id}`, kind: 'market', plugin })
  }
  return entries
}

/** Main-window search always opens plugin results in the main window and keeps provider payloads intact. */
export function homeSearchOpenRequest(command: QuickCommand, query: string): QuickOpenRequest | null {
  if (command.kind === 'app' && command.path) return { kind: 'app', path: command.path, query }
  if (command.kind === 'plugin' && command.pluginId) return {
    kind: 'plugin', pluginId: command.pluginId, code: command.code, type: command.type,
    payload: command.content ? query : command.payload, query, container: 'shell',
  }
  if (command.kind === 'action' && command.action) return { kind: 'action', action: command.action, query }
  return null
}
