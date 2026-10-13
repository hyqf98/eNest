/** 首页内搜索；快捷键只在市场页挂载时生效。 */
import { useEffect, useRef } from 'react'
import { IS_MAC } from '@shared/platform'
import { useI18n } from '@renderer/hooks/useI18n'
import { SearchField } from './SearchField'

interface Props {
  value: string
  onChange: (v: string) => void
}

export function SearchBox({ value, onChange }: Props) {
  const inputRef = useRef<HTMLInputElement>(null)
  const { t, locale } = useI18n()
  const shortcut = IS_MAC ? '⌘ K' : 'Ctrl K'

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        // 插件详情打开时让弹层保留键盘焦点。
        if (document.querySelector('[data-detail-modal]')) return
        event.preventDefault()
        inputRef.current?.focus()
        inputRef.current?.select()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <div className="search-wrap" role="search">
      <SearchField value={value} onChange={onChange} inputRef={inputRef} placeholder={t('market.searchPlaceholder')}
        clearLabel={locale === 'en-US' ? 'Clear search' : '清空搜索'}
        trailing={<kbd className="search-shortcut" aria-hidden="true">{shortcut}</kbd>}
        inputProps={{ onKeyDown: (event) => { if (event.key === 'Escape') { onChange(''); inputRef.current?.blur() } } }} />
    </div>
  )
}
