/** 首页与 Quick 共用输入、清空和焦点反馈；检索范围由所在页面决定。 */
import type { InputHTMLAttributes, ReactNode, RefObject } from 'react'
import { SearchIcon, XIcon } from './icons'
import './SearchField.css'

interface Props {
  value: string
  onChange: (value: string) => void
  inputRef: RefObject<HTMLInputElement>
  placeholder: string
  clearLabel?: string
  leading?: ReactNode
  trailing?: ReactNode
  /** 输入有内容、显示清空按钮时仍保留的工具入口。 */
  accessory?: ReactNode
  inputProps?: Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'placeholder'>
}

export function SearchField({ value, onChange, inputRef, placeholder, clearLabel = '清空搜索', leading, trailing, accessory, inputProps }: Props) {
  return (
    <div className="search-box">
      {leading ?? <SearchIcon size={19} />}
      <input ref={inputRef} type="search" aria-label={placeholder} autoComplete="off" spellCheck={false}
        {...inputProps} placeholder={placeholder} value={value} onChange={(event) => onChange(event.target.value)} />
      {value ? (
        <button type="button" className="search-clear" aria-label={clearLabel}
          onClick={() => { onChange(''); inputRef.current?.focus() }}><XIcon size={15} /></button>
      ) : trailing}
      {accessory}
    </div>
  )
}
