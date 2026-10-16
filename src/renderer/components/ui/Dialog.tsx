import { forwardRef } from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import './ui.css'

/**
 * 通用弹窗基座：Overlay/Content/Title/Description/Close 均支持 asChild —— 业务弹窗
 * （如 ConfirmDialog）用自有类名 + asChild 接入，视觉零改变；
 * 焦点陷阱 / Esc / 点击遮罩关闭 / 焦点归还由 Radix Dialog 提供。
 */
export const Dialog = DialogPrimitive.Root
export const DialogTrigger = DialogPrimitive.Trigger
export const DialogClose = DialogPrimitive.Close

export const DialogOverlay = forwardRef<HTMLDivElement, React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>>(
  function DialogOverlay({ className = 'ui-dialog-overlay', ...props }, ref) {
    return <DialogPrimitive.Overlay ref={ref} className={className} {...props} />
  }
)

export const DialogContent = forwardRef<HTMLDivElement, React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content>>(
  function DialogContent({ className = 'ui-dialog-content', children, ...props }, ref) {
    return (
      <DialogPrimitive.Content ref={ref} className={className} {...props}>
        {children}
      </DialogPrimitive.Content>
    )
  }
)

export const DialogTitle = forwardRef<HTMLHeadingElement, React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>>(
  function DialogTitle({ className = 'ui-dialog-title', ...props }, ref) {
    return <DialogPrimitive.Title ref={ref} className={className} {...props} />
  }
)

export const DialogDescription = forwardRef<
  HTMLParagraphElement,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(function DialogDescription({ className = 'ui-dialog-description', ...props }, ref) {
  return <DialogPrimitive.Description ref={ref} className={className} {...props} />
})
