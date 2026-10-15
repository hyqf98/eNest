import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { useAnchoredPopover } from './useAnchoredPopover'
import './select.css'

export interface SelectOption<T extends string> {
  value: T
  label: string
  disabled?: boolean
}
interface Props<T extends string> {
  value: T
  options: SelectOption<T>[]
  onChange: (value: T) => void
  disabled?: boolean
  ariaLabel?: string
  hint?: string
  className?: string
  minWidth?: number
}

/** Select-only combobox: focus stays on the trigger while aria-activedescendant follows the list. */
export function Select<T extends string>({ value, options, onChange, disabled = false, ariaLabel, hint, className, minWidth }: Props<T>) {
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const search = useRef({ text: '', at: 0 })
  const listId = useId()
  const current = options.find(option => option.value === value)
  const position = useAnchoredPopover(open, triggerRef, listRef)
  const enabledIndices = options.flatMap((option, index) => option.disabled ? [] : [index])
  const close = (restoreFocus = false) => {
    setOpen(false)
    if (restoreFocus) triggerRef.current?.focus({ preventScroll: true })
  }
  const show = (last = false) => {
    if (disabled || !enabledIndices.length) return
    const selected = options.findIndex(option => option.value === value && !option.disabled)
    setActive(selected >= 0 ? selected : enabledIndices[last ? enabledIndices.length - 1 : 0])
    search.current = { text: '', at: 0 }
    setOpen(true)
  }
  const choose = (index: number) => {
    const option = options[index]
    if (!option || option.disabled || disabled) return
    onChange(option.value)
    close(true)
  }
  const move = (direction: number) => {
    for (let offset = 1; offset <= options.length; offset++) {
      const next = (active + offset * direction + options.length) % options.length
      if (!options[next].disabled) { setActive(next); return }
    }
  }
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'Tab') { close(); return }
    if (event.key === 'Escape' && open) { event.preventDefault(); event.stopPropagation(); close(true); return }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (open) move(event.key === 'ArrowDown' ? 1 : -1)
      else show(event.key === 'ArrowUp')
      return
    }
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault()
      if (!open) show()
      setActive(enabledIndices[event.key === 'Home' ? 0 : enabledIndices.length - 1] ?? 0)
      return
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      if (open) choose(active)
      else show()
      return
    }
    if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault()
      const text = (Date.now() - search.current.at < 600 ? search.current.text : '') + event.key.toLocaleLowerCase()
      if (!open) show()
      search.current = { text, at: Date.now() }
      const match = options.findIndex(option => !option.disabled && option.label.toLocaleLowerCase().startsWith(text))
      if (match >= 0) setActive(match)
    }
  }
  useEffect(() => { if (disabled) setOpen(false) }, [disabled])
  useEffect(() => {
    if (!open) return
    const outside = (event: Event) => {
      if (!rootRef.current?.contains(event.target as Node) && !listRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', outside, true)
    document.addEventListener('focusin', outside)
    return () => { document.removeEventListener('pointerdown', outside, true); document.removeEventListener('focusin', outside) }
  }, [open])
  useEffect(() => {
    if (open) listRef.current?.querySelector<HTMLElement>('[data-index="' + active + '"]')?.scrollIntoView({ block: 'nearest' })
  }, [open, active])
  return <div ref={rootRef} className={'ui-select' + (open ? ' open' : '') + (className ? ' ' + className : '')} style={minWidth ? { minWidth } : undefined}>
    <button ref={triggerRef} type="button" role="combobox" className="ui-select-trigger" disabled={disabled}
      aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? listId : undefined}
      aria-activedescendant={open && options[active] ? listId + '-' + active : undefined}
      aria-label={ariaLabel} onKeyDown={onKeyDown} onClick={() => open ? close() : show()}>
      <span className="ui-select-value">{current?.label ?? value}</span>
      {hint && <span className="ui-select-hint">{hint}</span>}
      <svg className="ui-select-caret" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="m3 4.5 3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
    </button>
    {open && createPortal(<div ref={listRef} className="ui-select-pop ui-select-portal" id={listId} role="listbox" aria-label={ariaLabel} style={position}>
      {options.map((option, index) => <button key={option.value} id={listId + '-' + index} data-index={index} type="button" role="option" tabIndex={-1}
        disabled={option.disabled} aria-disabled={option.disabled || undefined} aria-selected={option.value === value}
        className={'ui-select-option' + (option.value === value ? ' selected' : '') + (index === active ? ' highlighted' : '')}
        onPointerMove={() => { if (!option.disabled) setActive(index) }} onMouseDown={event => event.preventDefault()} onClick={() => choose(index)}>
        <span>{option.label}</span><span className="ui-select-check" aria-hidden="true">{option.value === value ? '✓' : ''}</span>
      </button>)}
    </div>, document.body)}
  </div>
}
