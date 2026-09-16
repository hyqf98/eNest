/**
 * Toast — 全局轻提示层
 * 挂在 App 根部，渲染 toastStore 队列；每条通过 bindEl 绑定节点触发出入场动画。
 * 支持 type（info/success/warn/error）样式修饰，供插件 ui.toast 共用。
 * 依赖：useToast / toastStore。
 */
import { useEffect, useRef } from 'react'
import type { ToastKind } from '@shared/types/ipc'
import { useToast } from '../hooks/useToast'

export function Toast() {
  const { items, bindEl } = useToast()

  return (
    <div className="toasts">
      {items.map((t) => (
        <ToastItem
          key={t.id}
          id={t.id}
          message={t.message}
          type={t.type}
          onMount={bindEl}
        />
      ))}
    </div>
  )
}

function ToastItem({
  id,
  message,
  type,
  onMount,
}: {
  id: number
  message: string
  type?: ToastKind
  onMount: (id: number, el: HTMLElement) => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (ref.current) onMount(id, ref.current)
  }, [id, onMount])
  const cls = type && type !== 'info' ? `toast toast-${type}` : 'toast'
  return (
    <div className={cls} ref={ref}>
      {message}
    </div>
  )
}
