import { forwardRef } from 'react'
import { Slot } from '@radix-ui/react-slot'

type Variant = 'primary' | 'ghost' | 'danger'
type Size = 'md' | 'sm'

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /** 视觉变体：primary 主按钮 / ghost 次要 / danger 危险操作；缺省为无底透明按钮 */
  variant?: Variant
  size?: Size
  /** 以子元素为渲染根（如把链接包成按钮外观） */
  asChild?: boolean
}

/**
 * 统一按钮：视觉沿用全局 `.btn / .btn-{variant} / .btn-sm` 体系（app.css），
 * 行为（焦点 / asChild）由 Radix Slot 补充。
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant, size = 'md', asChild = false, className = '', type = 'button', ...props },
  ref
) {
  const classes = ['btn']
  if (variant) classes.push(`btn-${variant}`)
  if (size === 'sm') classes.push('btn-sm')
  if (className) classes.push(className)
  const Comp = asChild ? Slot : 'button'
  return <Comp ref={ref} type={asChild ? undefined : type} className={classes.join(' ')} {...props} />
})
