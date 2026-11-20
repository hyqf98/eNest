import type { QuickCommand, QuickCommandKind } from '@shared/types/quick'

const TITLES = { best: '最佳搜索结果', match: '最佳匹配', recommendation: '用当前文本执行', provider: '插件内搜索结果' }

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

/** Locate the same command after an enriched group has been inserted before it. */
export function quickSelectionIndex(items: Array<{ id: string }>, selectedId: string | null, fallbackIndex = 0): number {
  const preserved = selectedId === null ? -1 : items.findIndex(item => item.id === selectedId)
  return preserved >= 0 ? preserved : Math.max(0, Math.min(fallbackIndex, items.length - 1))
}

export type QuickGridKey = 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown' | 'Tab'

/**
 * Groups start a new visual row; up/down retain the column and clamp short rows.
 *
 * 左右/上下都是**边界钳制**而不是环绕回绕：从第一格再按左/上就停在第一格，
 * 从末格再按右/下停在末格。环绕会让用户按一次「上」就跳到网格最后一格，
 * 看起来像"选中没从第一个开始"——那正是这条改动要修掉的困惑。
 * Tab 仍保留环绕：它是焦点遍历语义，绕回起点才是期望行为。
 */
export function moveQuickGridSelection(index: number, groupLengths: number[], columns: number, key: QuickGridKey, reverse = false): number {
  const count = groupLengths.reduce((sum, length) => sum + length, 0)
  if (!count) return 0
  const current = Math.max(0, Math.min(index, count - 1))
  if (key === 'Tab') return (current + (reverse ? -1 : 1) + count) % count
  if (key === 'ArrowLeft') return Math.max(0, current - 1)
  if (key === 'ArrowRight') return Math.min(count - 1, current + 1)
  const width = Math.max(1, Math.floor(columns) || 1)
  const rows: { start: number; length: number }[] = []
  let offset = 0
  for (const length of groupLengths) {
    for (let start = 0; start < length; start += width) rows.push({ start: offset + start, length: Math.min(width, length - start) })
    offset += length
  }
  const rowIndex = rows.findIndex(row => current >= row.start && current < row.start + row.length)
  const target = rowIndex + (key === 'ArrowDown' ? 1 : -1)
  if (target < 0 || target >= rows.length) return current
  const next = rows[target]
  return next.start + Math.min(current - rows[rowIndex].start, next.length - 1)
}
