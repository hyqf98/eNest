import * as SelectPrimitive from '@radix-ui/react-select'

export interface SelectOption<T extends string> {
  value: T
  label: string
  disabled?: boolean
}

interface SelectProps<T extends string> {
  value: T
  options: SelectOption<T>[]
  onChange: (value: T) => void
  disabled?: boolean
  ariaLabel?: string
  /** 触发器内右侧的浅色提示文案 */
  hint?: string
  className?: string
  minWidth?: number
}

/**
 * 统一下拉选择：视觉沿用 `.ui-select-*` 体系（app.css / select.css），
 * 键盘导航、type-ahead、焦点管理由 Radix Select 提供（焦点停留在触发器，与旧实现一致）。
 * 弹层为 popper 定位，宽度不小于触发器（select.css 中消费 --radix-select-trigger-width）。
 */
export function Select<T extends string>({
  value,
  options,
  onChange,
  disabled = false,
  ariaLabel,
  hint,
  className,
  minWidth,
}: SelectProps<T>) {
  const current = options.find((option) => option.value === value)
  return (
    <SelectPrimitive.Root value={value} onValueChange={(next) => onChange(next as T)} disabled={disabled}>
      <SelectPrimitive.Trigger
        className={`ui-select-trigger${className ? ` ${className}` : ''}`}
        aria-label={ariaLabel}
        style={minWidth ? { minWidth } : undefined}
      >
        <span className="ui-select-value">{current?.label ?? value}</span>
        {hint && <span className="ui-select-hint">{hint}</span>}
        <SelectPrimitive.Icon className="ui-select-caret">
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
            <path d="m3 4.5 3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Content
          position="popper"
          className="ui-select-pop ui-select-portal"
          sideOffset={6}
          collisionPadding={12}
        >
          <SelectPrimitive.Viewport>
            {options.map((option) => (
              <SelectPrimitive.Item
                key={option.value}
                value={option.value}
                disabled={option.disabled}
                className="ui-select-option"
              >
                <SelectPrimitive.ItemText>{option.label}</SelectPrimitive.ItemText>
                <span className="ui-select-check" aria-hidden="true">{option.value === value ? '✓' : ''}</span>
              </SelectPrimitive.Item>
            ))}
          </SelectPrimitive.Viewport>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  )
}
