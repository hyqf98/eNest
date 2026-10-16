import type { ReactNode } from 'react'
import * as TooltipPrimitive from '@radix-ui/react-tooltip'
import './ui.css'

interface TooltipProps {
  /** 提示内容；为空时直接渲染 children（不包 Trigger） */
  content: ReactNode
  children: ReactNode
  side?: 'top' | 'right' | 'bottom' | 'left'
  align?: 'start' | 'center' | 'end'
  /** 悬停延迟（ms），默认 350 */
  delayDuration?: number
}

/**
 * 统一轻提示。children 需要能接收 ref（原生元素或 forwardRef 组件）；
 * 悬停/聚焦均可触发，Esc 关闭，行为来自 Radix Tooltip。
 */
export function Tooltip({ content, children, side = 'top', align = 'center', delayDuration = 350 }: TooltipProps) {
  if (!content) return <>{children}</>
  return (
    <TooltipPrimitive.Root delayDuration={delayDuration}>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content side={side} align={align} sideOffset={6} className="ui-tooltip">
          {content}
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  )
}

export const TooltipProvider = TooltipPrimitive.Provider
