/**
 * Select — 自定义下拉（弹层向下，不使用原生 select）
 * 解决 Electron/Chromium 原生 option 弹层盖住触发器且样式不可控的问题。
 */
import { useEffect, useId, useRef, useState } from 'react'

export interface SelectOption<T extends string> {
  value: T
  label: string
}

interface Props<T extends string> {
  value: T
  options: SelectOption<T>[]
  onChange: (value: T) => void
  disabled?: boolean
  ariaLabel?: string
  /** 右侧附注，如端口类型 */
  hint?: string
  className?: string
  /** 触发器宽度；默认自适应 */
  minWidth?: number
}

export function Select<T extends string>({
  value,
  options,
  onChange,
  disabled = false,
  ariaLabel,
  hint,
  className,
  minWidth
}: Props<T>) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const listId = useId()
  const current = options.find((o) => o.value === value)

  useEffect(() => {
    if (!open) return
    const onPointerDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [open])

  return (
    <div
      ref={rootRef}
      className={`ui-select${open ? ' open' : ''}${className ? ` ${className}` : ''}`}
      style={minWidth ? { minWidth } : undefined}
    >
      <button
        type="button"
        className="ui-select-trigger"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        aria-label={ariaLabel}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="ui-select-value">{current?.label ?? value}</span>
        {hint ? <span className="ui-select-hint">{hint}</span> : null}
        <svg className="ui-select-caret" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
          <path d="M3 4.5L6 7.5L9 4.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open ? (
        <div className="ui-select-pop" id={listId} role="listbox" aria-label={ariaLabel}>
          {options.map((o) => {
            const selected = o.value === value
            return (
              <button
                key={o.value}
                type="button"
                role="option"
                aria-selected={selected}
                className={`ui-select-option${selected ? ' selected' : ''}`}
                onClick={() => {
                  onChange(o.value)
                  setOpen(false)
                }}
              >
                <span>{o.label}</span>
                {selected ? <span className="ui-select-check">✓</span> : null}
              </button>
            )
          })}
        </div>
      ) : null}
    </div>
  )
}
