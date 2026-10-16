import { forwardRef } from 'react'
import * as CheckboxPrimitive from '@radix-ui/react-checkbox'
import './ui.css'

export interface CheckboxProps extends React.ComponentPropsWithoutRef<typeof CheckboxPrimitive.Root> {}

/** 统一复选框：视觉对齐设置页既有 checkbox（16px 方框 + accent 勾），行为/无障碍来自 Radix。 */
export const Checkbox = forwardRef<HTMLButtonElement, CheckboxProps>(function Checkbox(
  { className = '', ...props },
  ref
) {
  return (
    <CheckboxPrimitive.Root ref={ref} className={`ui-checkbox${className ? ` ${className}` : ''}`} {...props}>
      <CheckboxPrimitive.Indicator className="ui-checkbox-indicator">
        <svg viewBox="0 0 10 8" fill="none" aria-hidden="true">
          <path d="M1 4l2.5 2.5L9 1" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  )
})
