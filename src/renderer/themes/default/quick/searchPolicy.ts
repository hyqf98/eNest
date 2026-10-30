import { normalizeSearchText } from '@shared/search'
import { matchPluginTextPrefix } from '@shared/pluginTextInput'
import type { QuickCommandKind } from '@shared/types/quick'
import { prepareQuickName, scoreQuickName } from './nameMatching'
import { ACTION_COPY, assembleDefaultQuickResults, namesOf, rankDefaultQuickHome, type DefaultSearchEntry, type DefaultQuickMatch } from './catalogPolicy'

export { matchDefaultQuickMedia } from './catalogPolicy'
export type { DefaultSearchEntry, DefaultQuickMatch } from './catalogPolicy'

export function rankDefaultQuickCatalog<T extends DefaultSearchEntry>(
  catalog: T[], query: string, filter?: QuickCommandKind | null, limit = 60,
  contentMatches: ReadonlySet<string> = new Set(), mediaMatches: ReadonlySet<string> = new Set(),
  mediaPresent = false, now = Date.now()
): Array<DefaultQuickMatch<T>> {
  const q = normalizeSearchText(query)
  if (!q) return rankDefaultQuickHome(catalog, filter, limit, mediaMatches, now)
  const pool = catalog.filter(entry => !filter || entry.kind === filter)
  // zTools 语义：粘贴大段文本（超 32 字符）仍可按名称/别名搜到插件；有图片/文件上下文时才抑制无关名称检索。
  const named = pool.filter(entry => !entry.content && !entry.provider).map(item => {
    const prefix = item.kind === 'plugin' && item.textInput?.trigger === 'prefix' ? matchPluginTextPrefix(query, namesOf(item)) : undefined
    let score = prefix ? 20_000 + prefix.trigger.length : 0, keyword = prefix?.trigger ?? item.title
    for (const name of namesOf(item)) {
      const next = scoreQuickName(prepareQuickName(name), q)
      if (next > score) { score = next; keyword = name }
    }
    if (item.kind === 'app' && score > 0 && score < 10_000) score = Math.min(9_999, score + 300)
    return { item, score, keyword, prefix: Boolean(prefix) }
  }).filter(hit => hit.score > 0 && (q.length <= 32 || !mediaPresent || hit.prefix))
    .sort((a, b) => Number(b.prefix) - Number(a.prefix) || (a.prefix && b.prefix ? b.score - a.score : 0)
      || Number(b.item.preferred === true) - Number(a.item.preferred === true)
      || b.score - a.score || a.item.title.localeCompare(b.item.title, 'zh-CN'))
    .map(({ item, keyword, prefix }): DefaultQuickMatch<T> => ({ ...item, title: item.action ? ACTION_COPY[item.action].title : item.kind === 'plugin' ? keyword : item.title, group: 'best', ...(prefix ? { prefix } : {}) }))
  return assembleDefaultQuickResults(catalog, named, filter, limit, contentMatches, mediaMatches, mediaPresent)
}
