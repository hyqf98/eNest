import { forwardRef } from 'react'
import * as SliderPrimitive from '@radix-ui/react-slider'
import './ui.css'

export interface SliderProps extends React.ComponentPropsWithoutRef<typeof SliderPrimitive.Root> {}

/**
 * 统一滑杆：视觉对齐设置页原生 range 定制版（4px track + 16px accent 圆 thumb，无进度填充），
 * 键盘方向键 / 拖拽 / 触控由 Radix Slider 提供。布局类（如 .font-size-slider 的 flex）由调用点叠加。
 */
export const Slider = forwardRef<HTMLSpanElement, SliderProps>(function Slider(
  { className = '', ...props },
  ref
) {
  return (
    <SliderPrimitive.Root ref={ref} className={`ui-slider${className ? ` ${className}` : ''}`} {...props}>
      <SliderPrimitive.Track className="ui-slider-track">
        <SliderPrimitive.Range className="ui-slider-range" />
      </SliderPrimitive.Track>
      <SliderPrimitive.Thumb className="ui-slider-thumb" aria-label={props['aria-label']} />
    </SliderPrimitive.Root>
  )
})
