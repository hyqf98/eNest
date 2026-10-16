import { forwardRef } from 'react'
import * as SwitchPrimitive from '@radix-ui/react-switch'

export interface SwitchProps extends React.ComponentPropsWithoutRef<typeof SwitchPrimitive.Root> {}

/**
 * 统一开关：视觉沿用既有 `.switch` / `.card-switch` CSS（圆点由 ::after 绘制），
 * 因此不渲染 Radix Thumb，checked 时继续输出 `.on` 类，样式零改动。
 * 行为升级：role="switch" + aria-checked + 键盘空格切换由 Radix 提供。
 */
export const Switch = forwardRef<HTMLButtonElement, SwitchProps>(function Switch(
  { className = 'switch', checked, onCheckedChange, ...props },
  ref
) {
  return (
    <SwitchPrimitive.Root
      ref={ref}
      className={`${className}${checked ? ' on' : ''}`}
      checked={checked}
      onCheckedChange={onCheckedChange}
      {...props}
    />
  )
})
