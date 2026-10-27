import { normalizeSearchText } from '@shared/search'
import { prepareQuickName, scoreQuickName, type QuickNameIndex } from './nameMatching'
import type { QuickNameRow, QuickNameSearchRequest, QuickNameSearchResponse } from './nameSearchTypes'

let rows: Array<QuickNameRow & { prepared: QuickNameIndex[] }> = []
const worker = self as unknown as {
  onmessage: ((event: MessageEvent<QuickNameSearchRequest>) => void) | null
  postMessage(value: QuickNameSearchResponse): void
}

worker.onmessage = ({ data }) => {
  if (data.rows) rows = data.rows.map(row => ({ ...row, prepared: row.names.map(prepareQuickName) }))
  const query = normalizeSearchText(data.query)
  if (!query) { worker.postMessage({ id: data.id, hits: [] }); return }
  const preferred = new Set(data.preferred)
  const hits = rows.flatMap((row, index) => {
    if (data.filter && row.kind !== data.filter) return []
    let score = 0, keyword = row.title
    for (let name = 0; name < row.prepared.length; name++) {
      const next = scoreQuickName(row.prepared[name], query)
      if (next > score) { score = next; keyword = row.names[name] }
    }
    if (row.kind === 'app' && score > 0 && score < 10_000) score = Math.min(9_999, score + 300)
    return score > 0 ? [{ index, score, keyword }] : []
  }).sort((a, b) => Number(preferred.has(b.index)) - Number(preferred.has(a.index)) || b.score - a.score || rows[a.index].title.localeCompare(rows[b.index].title, 'zh-CN'))
  worker.postMessage({ id: data.id, hits: hits.slice(0, 100).map(({ index, keyword }) => ({ index, keyword })) })
}
