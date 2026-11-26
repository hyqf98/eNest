import type { QuickActionId, QuickCommandKind, QuickContentMatch, QuickImageContext } from '@shared/types/quick'
import type { QuickNameRow } from './nameSearchTypes'

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

export function asQuickNameMatch<T extends DefaultSearchEntry>(item: T, prefix = false): DefaultQuickMatch<T> {
  return { ...item, title: item.action ? ACTION_COPY[item.action].title : item.title, group: 'best', ...(prefix ? { prefix } : {}) }
}

export function allowsQuickTextPrefix(entry: DefaultSearchEntry): entry is DefaultSearchEntry & { aliases: string[] } {
  return entry.kind === 'plugin' && entry.textInput?.trigger === 'prefix' && Boolean(entry.aliases?.length)
}

export function quickNameRow(entry: DefaultSearchEntry): QuickNameRow {
  return { key: entry.id, kind: entry.kind, title: entry.title, names: namesOf(entry), prefix: allowsQuickTextPrefix(entry) }
}

export function rankDefaultQuickMedia<T extends DefaultSearchEntry>(
  pool: T[], mediaMatches: ReadonlySet<string>
): Array<DefaultQuickMatch<T>> {
  return pool.filter(entry => entry.content && mediaMatches.has(entry.id))
    .sort((a, b) => (b.useCount ?? 0) - (a.useCount ?? 0))
    .map((item): DefaultQuickMatch<T> => ({ ...item, group: 'match' }))
}

/**
 * 首页排序分：最近使用是主信号，打开次数是次信号。
 * 之前是「7 天半衰期的衰减占 40 + 次数对数占 30」：实测一次 4.2 天前用了 4 次的条目（96.0 分）
 * 仍然压过刚刚启动的条目（87.4 分），用户感知就是「刚用过却没排到第一」。
 * 现在半衰期缩到 2 天、时间权重提到 60，次数降到 20——刚启动的条目稳居首位，
 * 但 1~3 天内的常用项仍能靠累计次数留在前排，不会变成纯时间流。
 */
type QuickUsageFacts = { lastUsedTs?: number; useCount?: number }

function recentRank(entry: QuickUsageFacts, now: number): number {
  if (!entry.lastUsedTs && !entry.useCount) return 0
  const decay = entry.lastUsedTs ? Math.pow(0.5, Math.max(0, now - entry.lastUsedTs) / (2 * 24 * 60 * 60 * 1_000)) : 0
  return decay * 60 + Math.log2(1 + Math.min(entry.useCount ?? 0, 200)) * 20
}

/** 插件身份：`plugin:<id>:<code>` 去掉 code；用于把同一插件的多个入口归成一组。 */
function pluginGroupOf(id: string): string | null {
  const match = /^plugin:([^:]+):/.exec(id)
  return match ? match[1] : null
}

/**
 * 同一插件的其它入口借用「本组最强」的使用记录打折参与排序。
 * 没有这一层时，从 Quick 用 zmhb 打开「桌面画板」只会抬高 desktop-canvas 一条，
 * 用户再看首页仍然找不到刚碰过的「画板」——两个入口，同一个插件，却像两个插件。
 * 折扣取 0.55 并额外衰减时间：借用只用于「别掉队」，不足以压过真正刚用过的那一条。
 */
function groupBoost(home: Array<DefaultSearchEntry & { id: string }>, now: number): Map<string, number> {
  const best = new Map<string, { ts: number; count: number }>()
  for (const entry of home) {
    const group = pluginGroupOf(entry.id)
    if (!group || (!entry.lastUsedTs && !entry.useCount)) continue
    const previous = best.get(group)
    if (!previous || (entry.lastUsedTs ?? 0) > previous.ts) best.set(group, { ts: entry.lastUsedTs ?? 0, count: entry.useCount ?? 0 })
  }
  const boosts = new Map<string, number>()
  for (const entry of home) {
    const group = pluginGroupOf(entry.id)
    const source = group ? best.get(group) : undefined
    if (!source || source.ts === (entry.lastUsedTs ?? 0)) continue
    boosts.set(entry.id, recentRank({ lastUsedTs: source.ts, useCount: source.count }, now) * 0.55)
  }
  return boosts
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
  const boosts = groupBoost(home, now)
  const score = (entry: DefaultSearchEntry) => recentRank(entry, now) + (boosts.get(entry.id) ?? 0)
  const ranked = home.sort((a, b) => {
    // 借用加成不能把「从没碰过的插件」整体炒热：先按有无真实记录分组。
    const aUsed = Boolean(a.lastUsedTs || a.useCount), bUsed = Boolean(b.lastUsedTs || b.useCount)
    if (aUsed !== bUsed) return aUsed ? -1 : 1
    return score(b) - score(a) || order[a.kind] - order[b.kind] || a.title.localeCompare(b.title, 'zh-CN')
  }).slice(0, cap).map(item => asQuickNameMatch(item))
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
