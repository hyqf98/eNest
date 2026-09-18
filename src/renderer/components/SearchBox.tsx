/**
 * SearchBox — 市场搜索框
 * 受控搜索输入；value/onChange 由 MarketPage 连到 shellStore.query。
 * 无内部状态。图标：Lucide search。
 */
import { SearchIcon } from '@renderer/components/icons'

interface Props {
  value: string
  onChange: (v: string) => void
}

export function SearchBox({ value, onChange }: Props) {
  return (
    <div className="search-wrap">
      <label className="search-box">
        <SearchIcon size={18} />
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
