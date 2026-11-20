import type { BaseWindow } from 'electron'
import { shouldSuppressMainWindowActivation } from './createQuickWindow'

/** Dock/relaunch activation opens main, but Quick owns its own focus lifecycle. */
export function showMainWindowOnActivate(win: BaseWindow): void {
  if (win.isDestroyed() || shouldSuppressMainWindowActivation()) return
  win.show()
}

/**
 * 托盘点击：用户是**明确**要求回到主窗，比 Dock 的 activate 更坚决。
 *
 * 与 showMainWindowOnActivate 的差别：
 *  · 不理会 Quick 的激活抑制 —— 托盘是同步入口，Quick 正开着时也要把主窗带出来；
 *  · 补 minimize 恢复 —— Windows/Linux 上"最小化到托盘"可能留下 minimized 状态，
 *    只 show 不动它的话窗口会以最小化形态出现（看起来像没反应）；
 *  · show 之后 focus —— 托盘点击本来就是前台动作。
 */
export function showMainWindowFromTray(win: BaseWindow): void {
  if (win.isDestroyed()) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}
