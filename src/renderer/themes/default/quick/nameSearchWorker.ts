import { normalizeSearchText } from '@shared/search'
import { matchPreparedPluginTextPrefix, preparePluginTextAliases, preparePluginTextQuery } from '@shared/pluginTextInput'
import { matchQuickSearchNames, prepareQuickSearchNames } from './nameMatching'
import type { QuickNameRow, QuickNameSearchRequest, QuickNameSearchResponse } from './nameSearchTypes'

const index = new Map<string, ReturnType<typeof prepareQuickSearchNames> & { kind: QuickNameRow['kind']; prefixAliases?: string[][] }>()
let order: string[] = []
const worker = self as unknown as {
  onmessage: ((event: MessageEvent<QuickNameSearchRequest>) => void) | null
  postMessage(value: QuickNameSearchResponse): void
}

worker.onmessage = ({ data }) => {
  if (data.index) {
    for (const key of data.index.remove) index.delete(key)
    for (const row of data.index.upsert) {
      index.set(row.key, { ...prepareQuickSearchNames(row.title, row.names), kind: row.kind,
        ...(row.prefix && row.kind === 'plugin' ? { prefixAliases: preparePluginTextAliases(row.names) } : {}) })
    }
    if (data.index.order) order = data.index.order
  }
  const query = normalizeSearchText(data.query)
  const terms = query.split(/\s+/).filter(Boolean)
  if (!query) { worker.postMessage({ id: data.id, hits: [] }); return }
  const preferred = new Set(data.preferred)
  const textQuery = preparePluginTextQuery(data.query)
  const hits = order.flatMap((key, position) => {
    const row = index.get(key)
    if (!row) return []
    if (data.filter && row.kind !== data.filter) return []
    const prefix = row.prefixAliases ? matchPreparedPluginTextPrefix(textQuery, row.prefixAliases) : undefined
    if (prefix) return [{ index: position, score: 20_000 + prefix.trigger.length, keyword: prefix.trigger, title: row.title, prefix: true }]
    const match = matchQuickSearchNames(row, query, terms)
    let score = match.score
    if (row.kind === 'app' && score > 0 && score < 10_000) score = Math.min(9_999, score + 300)
    return score > 0 ? [{ index: position, score, keyword: match.keyword, title: row.title, prefix: false }] : []
  }).sort((a, b) => Number(b.prefix) - Number(a.prefix) || (a.prefix && b.prefix ? b.score - a.score : 0)
    || Number(preferred.has(b.index)) - Number(preferred.has(a.index))
    || b.score - a.score || a.title.localeCompare(b.title, 'zh-CN'))
  worker.postMessage({ id: data.id, hits: hits.slice(0, 100).map(({ index, keyword, prefix }) => ({ index, keyword, ...(prefix ? { prefix } : {}) })) })
}
