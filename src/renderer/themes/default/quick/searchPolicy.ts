import { normalizeSearchText } from '@shared/search'
import type { QuickActionId, QuickCommandKind, QuickContentMatch } from '@shared/types/quick'
import { prepareQuickName, scoreQuickName } from './nameMatching'

export interface DefaultSearchEntry {
  id: string
  kind: QuickCommandKind
  title: string
  aliases?: string[]
  action?: QuickActionId
  content?: QuickContentMatch
  provider?: boolean
  lastUsedTs?: number
  useCount?: number
  preferred?: boolean
}

export type DefaultQuickMatch<T> = T & { title: string; group: 'best' | 'match' | 'recommendation' | 'provider' }

/** These names, discovery rules and weights are default-theme policy, never host search behavior. */
const ACTION_COPY: Record<QuickActionId, { title: string; aliases: string[] }> = {
  'open-market': { title: '打开市场', aliases: ['打开市场', '插件市场', 'market', 'plugins'] },
  'open-settings': { title: '打开设置', aliases: ['打开设置', '设置', 'settings', 'preferences'] },
  'refresh-apps': { title: '重新扫描应用', aliases: ['重新扫描应用', '刷新应用', 'refresh apps', 'rescan'] }
}

function namesOf(entry: DefaultSearchEntry): string[] {
  return entry.action ? ACTION_COPY[entry.action]?.aliases ?? [] : entry.aliases ?? [entry.title]
}

function recentRank(entry: DefaultSearchEntry, now: number): number {
  if (!entry.lastUsedTs) return 0
  const decay = Math.pow(0.5, Math.max(0, now - entry.lastUsedTs) / (7 * 24 * 60 * 60 * 1_000))
  return decay * 100 + Math.min(entry.useCount ?? 0, 50) * 2
}

export function rankDefaultQuickCatalog<T extends DefaultSearchEntry>(
  catalog: T[], query: string, filter?: QuickCommandKind | null, limit = 60,
  contentMatches: ReadonlySet<string> = new Set(), now = Date.now()
): Array<DefaultQuickMatch<T>> {
  const q = normalizeSearchText(query), pool = catalog.filter(entry => !filter || entry.kind === filter)
  const cap = Math.max(1, Math.min(100, Math.floor(limit) || 60))
  if (!q) {
    const home = pool.filter(entry => !entry.content && !entry.provider && (filter === 'action' || entry.kind !== 'action') && namesOf(entry).length > 0)
    const order = { plugin: 0, app: 1, action: 2 }
    return home.sort((a, b) => {
      if (Boolean(a.lastUsedTs) !== Boolean(b.lastUsedTs)) return a.lastUsedTs ? -1 : 1
      return recentRank(b, now) - recentRank(a, now) || order[a.kind] - order[b.kind] || a.title.localeCompare(b.title, 'zh-CN')
    }).slice(0, cap).map(item => ({ ...item, title: item.action ? ACTION_COPY[item.action].title : item.title, group: 'best' }))
  }
  const named = (q.length <= 32 ? pool.filter(entry => !entry.content && !entry.provider) : []).map(item => {
    let score = 0, keyword = item.title
    for (const name of namesOf(item)) {
      const next = scoreQuickName(prepareQuickName(name), q)
      if (next > score) { score = next; keyword = name }
    }
    if (item.kind === 'app' && score > 0 && score < 10_000) score = Math.min(9_999, score + 300)
    return { item, score, keyword }
  }).filter(hit => hit.score > 0).sort((a, b) => Number(b.item.preferred === true) - Number(a.item.preferred === true) || b.score - a.score || a.item.title.localeCompare(b.item.title, 'zh-CN'))
    .map(({ item, keyword }): DefaultQuickMatch<T> => ({ ...item, title: item.action ? ACTION_COPY[item.action].title : item.kind === 'plugin' ? keyword : item.title, group: 'best' }))
  const content = pool.filter(item => item.content && contentMatches.has(item.id))
    .sort((a, b) => (b.useCount ?? 0) - (a.useCount ?? 0))
  const matches = content.filter(item => item.content?.type === 'regex').map((item): DefaultQuickMatch<T> => ({ ...item, group: 'match' }))
  const recommendations = content.filter(item => item.content?.type === 'over').map((item): DefaultQuickMatch<T> => ({ ...item, group: 'recommendation' }))
  const providers = pool.filter(item => item.provider).map((item): DefaultQuickMatch<T> => ({ ...item, group: 'provider' }))
  return [...named, ...matches, ...recommendations, ...providers].slice(0, cap)
}
