import * as ToggleGroupPrimitive from '@radix-ui/react-toggle-group'

export interface SegmentedOption<T extends string> {
  value: T
  label: React.ReactNode
  disabled?: boolean
}

interface SegmentedProps<T extends string> {
  value: T
  options: SegmentedOption<T>[]
  onChange: (value: T) => void
  /** 追加到 .segmented 容器上的类名（如 tab-style-seg / shortcut-mode） */
  className?: string
  style?: React.CSSProperties
  ariaLabel?: string
  disabled?: boolean
  /** 语义角色：默认 group；单选必选场景（如启动位置）用 radiogroup */
  role?: 'group' | 'radiogroup'
}

/**
 * 统一分段控件：视觉沿用全局 `.segmented` 体系（app.css），选中项继续输出 `.active` 类，
 * 样式零改动；roving focus / 方向键 / type-ahead 由 Radix ToggleGroup 提供。
 * single 模式下重复点击选中项不产生回调（onValueChange 过滤空值），保持必选。
 */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  className = '',
  style,
  ariaLabel,
  disabled,
  role = 'group',
}: SegmentedProps<T>) {
  return (
    <ToggleGroupPrimitive.Root
      type="single"
      value={value}
      onValueChange={(next) => {
        if (next) onChange(next as T)
      }}
      className={`segmented${className ? ` ${className}` : ''}`}
      style={style}
      role={role}
      aria-label={ariaLabel}
      disabled={disabled}
    >
      {options.map((option) => (
        <ToggleGroupPrimitive.Item
          key={option.value}
          value={option.value}
          disabled={option.disabled}
          className={value === option.value ? 'active' : ''}
        >
          {option.label}
        </ToggleGroupPrimitive.Item>
      ))}
    </ToggleGroupPrimitive.Root>
  )
}
