import { normalizeSearchText } from '@shared/search'
import { matchPreparedPluginTextPrefix, preparePluginTextAliases, preparePluginTextQuery } from '@shared/pluginTextInput'
import { compareQuickNameRanks, prepareQuickSearchNames, rankQuickName } from './nameMatching'
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
    const rank = rankQuickName(row, query, terms, row.kind, preferred.has(position), prefix)
    return rank ? [{ index: position, ...rank }] : []
  }).sort(compareQuickNameRanks)
  worker.postMessage({ id: data.id, hits: hits.slice(0, 100).map(({ index, prefix }) => ({ index, ...(prefix ? { prefix } : {}) })) })
}
