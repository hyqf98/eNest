export function resolveFileSearchKey(key: string, options: {
  filesOnly: boolean; count: number; index: number; regularCount?: number; regularIndex?: number; modified?: boolean
}): { action: 'focus' | 'select' | 'open'; index: number } | undefined {
  const { count, regularCount = 0, regularIndex = 0 } = options
  if (!count || options.modified) return
  if (!options.filesOnly) {
    if (key === 'ArrowDown' && !regularCount || key === 'Tab' && regularIndex >= regularCount - 1) return { action: 'focus', index: 0 }
    return
  }
  const index = options.index >= 0 && options.index < count ? options.index : 0
  if (key === 'Enter') return { action: 'open', index }
  if (key === 'ArrowDown' || key === 'ArrowUp') return { action: 'select', index: (index + (key === 'ArrowDown' ? 1 : -1) + count) % count }
}
