/**
 * CategoryChips — 分类筛选胶囊行
 * 渲染 CATEGORIES 并高亮当前项；onChange 更新 shellStore.category。
 * 由 MarketPage Hero 使用。
 */
interface Props {
  categories: readonly string[]
  value: string
  onChange: (c: string) => void
}

export function CategoryChips({ categories, value, onChange }: Props) {
  return (
    <div className="chip-row">
      {categories.map((c) => (
        <button
          key={c}
          type="button"
          className={`chip${c === value ? ' active' : ''}`}
          onClick={() => onChange(c)}
        >
          {c}
        </button>
      ))}
    </div>
  )
}
