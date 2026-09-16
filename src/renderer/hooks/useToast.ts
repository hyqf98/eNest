/**
 * useToast — 全局 Toast 队列（zustand）
 * push 进队列并定时 dismiss；bindEl 绑定 DOM 节点以驱动入场/退场 GSAP。
 * 支持可选 type（info/success/warn/error），供插件 ui.toast 与壳子共用。
 * 依赖：marketMotion（toastIn/toastOut）、@shared/types/ipc（ToastKind）。
 */
import { create } from 'zustand'
import type { ToastKind } from '@shared/types/ipc'
import { toastIn, toastOut } from '../gsap/marketMotion'

/** 单条 Toast：id、文案、可选类型与已绑定 DOM 元素 */
export interface ToastItem {
  id: number
  message: string
  /** info 默认；success/warn/error 带强调色 */
  type?: ToastKind
  el?: HTMLElement | null
}

interface ToastState {
  items: ToastItem[]
  push: (message: string, type?: ToastKind) => void
  dismiss: (id: number) => void
  bindEl: (id: number, el: HTMLElement) => void
}

let seq = 0

/** Toast 全局队列 store；组件通过 useToast 订阅 */
export const toastStore = create<ToastState>((set, get) => ({
  items: [],
  push: (message, type) => {
    const id = ++seq
    set((s) => ({ items: [...s.items, { id, message, type }] }))
    window.setTimeout(() => {
      void get().dismiss(id)
    }, 2200)
  },
  dismiss: async (id) => {
    const item = get().items.find((t) => t.id === id)
    if (item?.el) await toastOut(item.el)
    set((s) => ({ items: s.items.filter((t) => t.id !== id) }))
  },
  bindEl: (id, el) => {
    set((s) => ({ items: s.items.map((t) => (t.id === id ? { ...t, el } : t)) }))
    toastIn(el)
  },
}))

/** 便捷 hook：读取 Toast 列表与 DOM 绑定回调 */
export function useToast() {
  const items = toastStore((s) => s.items)
  const bindEl = toastStore((s) => s.bindEl)
  const push = toastStore((s) => s.push)
  return { items, bindEl, push }
}
