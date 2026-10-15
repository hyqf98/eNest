import type { PluginSummary } from '@shared/types/plugin'
import type { QuickCommand, QuickCommandKind, QuickOpenRequest, QuickSearchResult } from '@shared/types/quick'
import { matchesSearchTerms, normalizeSearchText } from '@shared/search'
import { appendQuickProviders, mergeQuickEnriched } from './quickGrid'

export type HomeSearchScope = 'all' | 'app' | 'plugin' | 'market' | 'action'
export type HomeSearchEntry = { id: string; kind: 'command'; command: QuickCommand } | { id: string; kind: 'market'; plugin: PluginSummary }
export type HomeSearchRequest = (query: string, limit: number, kind: QuickCommandKind | undefined, phase: 'static' | 'enriched' | 'providers') => Promise<QuickSearchResult>

/** Quick's static matches stay usable while icons and dynamic plugin providers arrive independently. */
export async function searchHomeCommands(
  query: string,
  kind: QuickCommandKind | undefined,
  request: HomeSearchRequest,
  update: (items: QuickCommand[], initial: boolean) => void,
  current: () => boolean,
): Promise<boolean> {
  let items = (await request(query, 60, kind, 'static')).items
  if (!current()) return false
  update(items, true)
  const settled = await Promise.allSettled((['enriched', 'providers'] as const).map(async (phase) => {
    const result = await request(query, 60, kind, phase)
    if (!current()) return
    items = phase === 'enriched' ? mergeQuickEnriched(items, result.items) : appendQuickProviders(items, result.items)
    update(items, false)
  }))
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
    payload: command.payload, query, container: 'shell',
  }
  if (command.kind === 'action' && command.action) return { kind: 'action', action: command.action, query }
  return null
}
