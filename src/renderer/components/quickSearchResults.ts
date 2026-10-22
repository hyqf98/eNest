import type { QuickGridGroup } from './quickGrid'

/** Each group starts a new grid row, including a short final row. */
export function getQuickSearchResults(groups: QuickGridGroup[], columns: number, searching: boolean, expanded: boolean) {
  const allItems = groups.flatMap(group => group.items)
  if (!searching) return { groups, visibleItems: allItems, overflowCount: 0 }

  const width = Math.max(1, Math.floor(columns) || 1)
  const foldedGroups: QuickGridGroup[] = []
  let rowsLeft = 2
  let visibleCount = 0
  for (const group of groups) {
    if (!rowsLeft) break
    const count = Math.min(group.items.length, rowsLeft * width)
    if (!count) continue
    foldedGroups.push(count === group.items.length ? group : { ...group, items: group.items.slice(0, count) })
    visibleCount += count
    rowsLeft -= Math.ceil(count / width)
  }

  return {
    groups: expanded ? groups : foldedGroups,
    visibleItems: expanded ? allItems : allItems.slice(0, visibleCount),
    // Keep the folded overflow count even when expanded so collapse stays available.
    overflowCount: allItems.length - visibleCount
  }
}
