/**
 * LanguageSelect — 语言分段选择（中文 | English）
 * 受控组件；复用 .segmented 样式，value 为 Locale。
 */
import type { Locale } from '@renderer/i18n'

interface Props {
  value: Locale
  onChange: (locale: Locale) => void
}

const OPTIONS: { value: Locale; label: string }[] = [
  { value: 'zh-CN', label: '中文' },
  { value: 'en-US', label: 'English' },
]

export function LanguageSelect({ value, onChange }: Props) {
  return (
    <div className="segmented" role="group" aria-label="Language">
      {OPTIONS.map((opt) => (
        <button
          key={opt.value}
          type="button"
          className={value === opt.value ? 'active' : ''}
          onClick={() => onChange(opt.value)}
        >
          {opt.label}
        </button>
      ))}
    </div>
  )
}
