/**
 * dev 插件与壳窗口共用的调试快捷键（before-input-event 层拦截，浏览器同款）：
 * F12 / ⌘⌥I / Ctrl+Shift+I → DevTools 开关；⌘/Ctrl+R → 重载当前 dev 插件。
 * 插件 view 抢焦后渲染层收不到按键，必须在主进程拦截（同 hookQuickInput 范式）。
 */
import type { WebContents } from 'electron'

export type DevShortcutAction = 'devtools' | 'reload'

export function devShortcutAction(input: {
  key: string
  control: boolean
  meta: boolean
  alt: boolean
  shift: boolean
  isAutoRepeat: boolean
}): DevShortcutAction | null {
  const key = input.key.toLowerCase()
  if (key === 'f12' || (input.meta && input.alt && key === 'i') || (input.control && input.shift && key === 'i')) return 'devtools'
  if ((input.meta || input.control) && key === 'r') return input.isAutoRepeat ? null : 'reload'
  return null
}

/** 浏览器语义：DevTools 已开则关、未开则开。 */
export function toggleDevTools(wc: WebContents, mode: 'detach' | 'right' = 'detach'): void {
  if (wc.isDevToolsOpened()) wc.closeDevTools()
  else wc.openDevTools({ mode, activate: true })
}
