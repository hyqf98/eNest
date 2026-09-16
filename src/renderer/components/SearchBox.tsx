/**
 * SearchBox — 市场搜索框
 * 受控搜索输入；value/onChange 由 MarketPage 连到 shellStore.query。
 * 无内部状态。
 */
interface Props {
  value: string
  onChange: (v: string) => void
}

export function SearchBox({ value, onChange }: Props) {
  return (
    <div className="search-wrap">
      <label className="search-box">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="11" cy="11" r="7" />
          <path d="m20 20-3.5-3.5" />
        </svg>
        <input
          type="search"
          placeholder="搜索插件…"
          autoComplete="off"
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      </label>
    </div>
  )
}
