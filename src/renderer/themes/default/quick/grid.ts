import type { QuickCommand, QuickCommandKind } from '@shared/types/quick'

const TITLES = { best: '最佳搜索结果', match: '最佳匹配', recommendation: '匹配推荐', provider: '插件搜索结果' }

export interface QuickGridEntry { id: string; kind: QuickCommandKind; group?: string }

export interface QuickGridGroup<T extends QuickGridEntry = QuickCommand> {
  id: string
  title: string
  items: T[]
  offset: number
}

/** Keep backend ranking intact, even if a group occurs in more than one run. */
export function groupQuickCommands<T extends QuickGridEntry>(items: T[], searching: boolean, homeLimit: number): QuickGridGroup<T>[] {
  if (!searching) {
    return [{ id: 'home', title: '常用', items: items.filter(item => item.kind !== 'action').slice(0, homeLimit), offset: 0 }]
  }
  const groups: QuickGridGroup<T>[] = []
  for (const item of items) {
    const group = item.group ?? 'best'
    const previous = groups.at(-1)
    if (previous?.id.startsWith(`${group}:`)) previous.items.push(item)
    else groups.push({ id: `${group}:${groups.length}`, title: TITLES[group as keyof typeof TITLES] ?? group, items: [item], offset: groups.reduce((sum, entry) => sum + entry.items.length, 0) })
  }
  return groups
}

/** Dynamic results are appended without changing static identities or ranking. */
export function appendQuickProviders(items: QuickCommand[], providers: QuickCommand[]): QuickCommand[] {
  const ids = new Set(items.map(item => item.id))
  const appended = providers.filter(item => {
    if (ids.has(item.id)) return false
    ids.add(item.id)
    return true
  }).map(item => ({ ...item, group: 'provider' as const }))
  return appended.length ? [...items, ...appended] : items
}

/** Enrichment supplies ranked static matches; retain usable commands and live providers. */
export function mergeQuickEnriched(items: QuickCommand[], enriched: QuickCommand[]): QuickCommand[] {
  if (!enriched.length) return items
  const previous = new Map(items.map(item => [item.id, item]))
  const seen = new Set<string>()
  const merged: QuickCommand[] = []
  for (const item of enriched) {
    if (seen.has(item.id)) continue
    seen.add(item.id)
    const existing = previous.get(item.id)
    merged.push({ ...item, group: item.group ?? 'best', icon: item.icon ?? (existing?.group === 'provider' ? undefined : existing?.icon) })
  }
  // Content matches can displace names at the backend limit. Keep those names
  // usable for this query, so a command under the user's cursor never vanishes.
  for (const item of items) {
    if (item.group !== 'provider' && !seen.has(item.id)) {
      seen.add(item.id)
      merged.push(item)
    }
  }
  return appendQuickProviders(merged, items.filter(item => item.group === 'provider'))
}

/** Locate the same command after an enriched group has been inserted before it. */
export function quickSelectionIndex(items: Array<{ id: string }>, selectedId: string | null, fallbackIndex = 0): number {
  const preserved = selectedId === null ? -1 : items.findIndex(item => item.id === selectedId)
  return preserved >= 0 ? preserved : Math.max(0, Math.min(fallbackIndex, items.length - 1))
}

export type QuickGridKey = 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown' | 'Tab'

/** Groups start a new visual row; up/down retain the column and clamp short rows. */
export function moveQuickGridSelection(index: number, groupLengths: number[], columns: number, key: QuickGridKey, reverse = false): number {
  const count = groupLengths.reduce((sum, length) => sum + length, 0)
  if (!count) return 0
  const current = Math.max(0, Math.min(index, count - 1))
  if (key === 'Tab') return (current + (reverse ? -1 : 1) + count) % count
  if (key === 'ArrowLeft') return (current - 1 + count) % count
  if (key === 'ArrowRight') return (current + 1) % count
  const width = Math.max(1, Math.floor(columns) || 1)
  const rows: { start: number; length: number }[] = []
  let offset = 0
  for (const length of groupLengths) {
    for (let start = 0; start < length; start += width) rows.push({ start: offset + start, length: Math.min(width, length - start) })
    offset += length
  }
  const rowIndex = rows.findIndex(row => current >= row.start && current < row.start + row.length)
  const next = rows[(rowIndex + (key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length]
  return next.start + Math.min(current - rows[rowIndex].start, next.length - 1)
}
