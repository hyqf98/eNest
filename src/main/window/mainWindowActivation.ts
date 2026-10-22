import type { BaseWindow } from 'electron'
import { shouldSuppressMainWindowActivation } from './createQuickWindow'

/** Dock/relaunch activation opens main, but Quick owns its own focus lifecycle. */
export function showMainWindowOnActivate(win: BaseWindow): void {
  if (win.isDestroyed() || shouldSuppressMainWindowActivation()) return
  win.show()
}
