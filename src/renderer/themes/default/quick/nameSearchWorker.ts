import { normalizeSearchText } from '@shared/search'
import { matchPreparedPluginTextPrefix, preparePluginTextAliases, preparePluginTextQuery } from '@shared/pluginTextInput'
import { prepareQuickName, scoreQuickName, type QuickNameIndex } from './nameMatching'
import type { QuickNameRow, QuickNameSearchRequest, QuickNameSearchResponse } from './nameSearchTypes'

const index = new Map<string, QuickNameRow & { prepared: QuickNameIndex[]; combined?: QuickNameIndex; prefixAliases?: string[][] }>()
let order: string[] = []
const worker = self as unknown as {
  onmessage: ((event: MessageEvent<QuickNameSearchRequest>) => void) | null
  postMessage(value: QuickNameSearchResponse): void
}

worker.onmessage = ({ data }) => {
  if (data.index) {
    for (const key of data.index.remove) index.delete(key)
    for (const row of data.index.upsert) index.set(row.key, { ...row, prepared: row.names.map(prepareQuickName),
      ...(row.prefix && row.kind === 'plugin' ? { prefixAliases: preparePluginTextAliases(row.names) } : {}),
      ...(row.names.length > 1 ? { combined: prepareQuickName(row.names.join(' ')) } : {}) })
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
    let score = 0, keyword = row.title
    for (let name = 0; name < row.prepared.length; name++) {
      const next = scoreQuickName(row.prepared[name], query, terms)
      if (next > score) { score = next; keyword = row.names[name] }
    }
    if (row.combined && terms.length > 1) {
      const combined = scoreQuickName(row.combined, query, terms) * 0.5
      if (combined > score) { score = combined; keyword = row.title }
    }
    if (row.kind === 'app' && score > 0 && score < 10_000) score = Math.min(9_999, score + 300)
    return score > 0 ? [{ index: position, score, keyword, title: row.title, prefix: false }] : []
  }).sort((a, b) => Number(b.prefix) - Number(a.prefix) || (a.prefix && b.prefix ? b.score - a.score : 0)
    || Number(preferred.has(b.index)) - Number(preferred.has(a.index))
    || b.score - a.score || a.title.localeCompare(b.title, 'zh-CN'))
  worker.postMessage({ id: data.id, hits: hits.slice(0, 100).map(({ index, keyword, prefix }) => ({ index, keyword, ...(prefix ? { prefix } : {}) })) })
}
