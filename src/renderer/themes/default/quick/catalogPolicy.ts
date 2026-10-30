import type { QuickActionId, QuickCommandKind, QuickContentMatch, QuickImageContext } from '@shared/types/quick'

export interface DefaultSearchEntry {
  id: string
  stateKey?: string
  kind: QuickCommandKind
  title: string
  aliases?: string[]
  action?: QuickActionId
  content?: QuickContentMatch
  textInput?: import('@shared/types/plugin').PluginFeatureInput
  provider?: boolean
  lastUsedTs?: number
  useCount?: number
  preferred?: boolean
}

export type DefaultQuickMatch<T> = T & { title: string; group: 'best' | 'match' | 'recommendation' | 'provider'; prefix?: boolean }

/** These names, discovery rules and weights are default-theme policy, never host search behavior. */
export const ACTION_COPY: Record<QuickActionId, { title: string; aliases: string[] }> = {
  'open-market': { title: '打开市场', aliases: ['打开市场', '插件市场', 'market', 'plugins'] },
  'open-settings': { title: '打开设置', aliases: ['打开设置', '设置', 'settings', 'preferences'] },
  'refresh-apps': { title: '重新扫描应用', aliases: ['重新扫描应用', '刷新应用', 'refresh apps', 'rescan'] }
}

/** Declarations that accept the current paste context (count, directory and extension bounds). */
export function matchDefaultQuickMedia(
  catalog: Array<{ id: string; content?: QuickContentMatch }>, context: QuickImageContext[] | null | undefined
): { matches: Set<string>; mediaPresent: boolean } {
  const matches = new Set<string>()
  if (!context?.length) return { matches, mediaPresent: false }
  const images = context.filter(item => item.kind === 'image')
  const files = context.filter(item => item.kind !== 'image')
  for (const entry of catalog) {
    const content = entry.content
    if (!content || (content.type !== 'img' && content.type !== 'files')) continue
    if (content.type === 'img') { if (images.length) matches.add(entry.id); continue }
    const min = content.minCount ?? 1
    const max = content.maxCount ?? 20
    if (files.length < min || files.length > max) continue
    const accepted = files.filter(file => {
      if (file.kind === 'directory' && !content.allowDirectory) return false
      if (!content.extensions?.length) return true
      const suffix = /\.([a-z0-9]+)$/.exec((file.name ?? '').toLocaleLowerCase())?.[1] ?? ''
      return content.extensions.includes(suffix)
    })
    if (accepted.length >= min && accepted.length <= max) matches.add(entry.id)
  }
  return { matches, mediaPresent: true }
}

export function namesOf(entry: DefaultSearchEntry): string[] {
  return entry.action ? ACTION_COPY[entry.action]?.aliases ?? [] : entry.aliases ?? [entry.title]
}

export function rankDefaultQuickMedia<T extends DefaultSearchEntry>(
  pool: T[], mediaMatches: ReadonlySet<string>
): Array<DefaultQuickMatch<T>> {
  return pool.filter(entry => entry.content && mediaMatches.has(entry.id))
    .sort((a, b) => (b.useCount ?? 0) - (a.useCount ?? 0))
    .map((item): DefaultQuickMatch<T> => ({ ...item, group: 'match' }))
}

function recentRank(entry: DefaultSearchEntry, now: number): number {
  if (!entry.lastUsedTs) return 0
  const decay = Math.pow(0.5, Math.max(0, now - entry.lastUsedTs) / (7 * 24 * 60 * 60 * 1_000))
  return decay * 100 + Math.min(entry.useCount ?? 0, 50) * 2
}

/** Home/paste ranking stays independent of the name worker's index readiness. */
export function rankDefaultQuickHome<T extends DefaultSearchEntry>(
  catalog: T[], filter?: QuickCommandKind | null, limit = 60,
  mediaMatches: ReadonlySet<string> = new Set(), now = Date.now()
): Array<DefaultQuickMatch<T>> {
  const pool = catalog.filter(entry => !filter || entry.kind === filter)
  const cap = Math.max(1, Math.min(100, Math.floor(limit) || 60))
  const home = pool.filter(entry => !entry.content && !entry.provider && (filter === 'action' || entry.kind !== 'action') && namesOf(entry).length > 0)
  const order = { plugin: 0, app: 1, action: 2 }
  const ranked = home.sort((a, b) => {
    if (Boolean(a.lastUsedTs) !== Boolean(b.lastUsedTs)) return a.lastUsedTs ? -1 : b.lastUsedTs ? 1 : 0
    return recentRank(b, now) - recentRank(a, now) || order[a.kind] - order[b.kind] || a.title.localeCompare(b.title, 'zh-CN')
  }).slice(0, cap).map(item => ({ ...item, title: item.action ? ACTION_COPY[item.action].title : item.title, group: 'best' as const }))
  return [...rankDefaultQuickMedia(pool, mediaMatches), ...ranked].slice(0, cap)
}

/** Merge independent name/content sources without importing the pinyin dictionary. */
export function assembleDefaultQuickResults<T extends DefaultSearchEntry>(
  catalog: T[], named: Array<DefaultQuickMatch<T>>, filter?: QuickCommandKind | null, limit = 60,
  contentMatches: ReadonlySet<string> = new Set(), mediaMatches: ReadonlySet<string> = new Set(), mediaPresent = false
): Array<DefaultQuickMatch<T>> {
  const pool = catalog.filter(entry => !filter || entry.kind === filter)
  const cap = Math.max(1, Math.min(100, Math.floor(limit) || 60))
  const content = pool.filter(item => item.content?.type !== 'img' && item.content?.type !== 'files' && contentMatches.has(item.id))
    .sort((a, b) => (b.useCount ?? 0) - (a.useCount ?? 0))
  const matches = content.filter(item => item.content?.type === 'regex').map((item): DefaultQuickMatch<T> => ({ ...item, group: 'match' }))
  const recommendations = mediaPresent && named.length ? []
    : content.filter(item => item.content?.type === 'over').map((item): DefaultQuickMatch<T> => ({ ...item, group: 'recommendation' }))
  const providers = pool.filter(item => item.provider).map((item): DefaultQuickMatch<T> => ({ ...item, group: 'provider' }))
  return [...named, ...rankDefaultQuickMedia(pool, mediaMatches), ...matches, ...recommendations, ...providers].slice(0, cap)
}
