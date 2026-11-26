import { normalizeSearchText } from '@shared/search'
import { matchPluginTextPrefix } from '@shared/pluginTextInput'
import type { QuickCommandKind } from '@shared/types/quick'
import { compareQuickNameRanks, prepareQuickSearchNames, rankQuickName } from './nameMatching'
import { allowsQuickTextPrefix, asQuickNameMatch, assembleDefaultQuickResults, namesOf, rankDefaultQuickHome, type DefaultSearchEntry, type DefaultQuickMatch } from './catalogPolicy'

export { matchDefaultQuickMedia } from './catalogPolicy'
export type { DefaultSearchEntry, DefaultQuickMatch } from './catalogPolicy'

export function rankDefaultQuickCatalog<T extends DefaultSearchEntry>(
  catalog: T[], query: string, filter?: QuickCommandKind | null, limit = 60,
  contentMatches: ReadonlySet<string> = new Set(), mediaMatches: ReadonlySet<string> = new Set(),
  mediaPresent = false, now = Date.now()
): Array<DefaultQuickMatch<T>> {
  const q = normalizeSearchText(query)
  if (!q) return rankDefaultQuickHome(catalog, filter, limit, mediaMatches, now)
  const terms = q.split(' ')
  const pool = catalog.filter(entry => !filter || entry.kind === filter)
  // zTools 语义：粘贴大段文本（超 32 字符）仍可按名称/别名搜到插件；有图片/文件上下文时才抑制无关名称检索。
  const named = pool.filter(entry => !entry.content && !entry.provider).flatMap(item => {
    const prefix = allowsQuickTextPrefix(item) ? matchPluginTextPrefix(query, item.aliases) : undefined
    if (q.length > 32 && mediaPresent && !prefix) return []
    const rank = rankQuickName(prepareQuickSearchNames(item.title, namesOf(item)), q, terms, item.kind, item.preferred === true, prefix)
    return rank ? [{ item, ...rank }] : []
  }).sort(compareQuickNameRanks).map(({ item, prefix }) => asQuickNameMatch(item, prefix))
  return assembleDefaultQuickResults(catalog, named, filter, limit, contentMatches, mediaMatches, mediaPresent)
}
