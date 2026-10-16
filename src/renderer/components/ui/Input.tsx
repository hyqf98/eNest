import { forwardRef } from 'react'

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {}

/**
 * 统一输入框：透传原生 input，外观类名（如 .proxy-host）由调用点决定，
 * 保证既有视觉零改变；组件价值在于统一 ref/API 与插件侧模板同构。
 */
export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { className = '', type = 'text', ...props },
  ref
) {
  return <input ref={ref} type={type} className={className} {...props} />
})
