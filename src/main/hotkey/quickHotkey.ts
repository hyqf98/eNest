/**
 * quickHotkey — 快捷启动全局热键
 * 职责：按设置注册/注销 Electron globalShortcut；多 accelerator 任一触发 toggle；
 * 注册失败记录并回滚到上一成功集合；不引入原生输入监听。
 * 被 index.ts 启动调用，quickHandlers 更新设置时调用。
 * 关键依赖：globalShortcut、settingsStore、createQuickWindow、sendShellEvent。
 */
import { globalShortcut } from 'electron'
import type { QuickHotkeyApplyResult, QuickHotkeyConfig } from '@shared/types/quick'
import { defaultQuickHotkeys, settingsStore } from '../settings/SettingsStore'
import { sendShellEvent } from '../window/createShellWindow'
import { toggleQuickWindow } from '../window/createQuickWindow'
import { logError, logInfo, logWarn } from '../logs/logService'

let activeHotkeys: string[] = []
let lastGoodHotkeys: string[] = []

function readSettings(): { enabled: boolean; hotkeys: string[] } {
  const general = settingsStore.getAll().general
  const ql = general.quickLauncher
  return {
    enabled: ql?.enabled !== false,
    hotkeys:
      Array.isArray(ql?.hotkeys) && ql.hotkeys.length > 0
        ? ql.hotkeys
        : defaultQuickHotkeys()
  }
}

function unregisterActive(): void {
  for (const acc of activeHotkeys) {
    try {
      if (globalShortcut.isRegistered(acc)) globalShortcut.unregister(acc)
    } catch (err) {
      logWarn('quick', `unregister failed ${acc}: ${(err as Error).message}`)
    }
  }
  activeHotkeys = []
}

/**
 * 应用热键：先注销旧集合，再逐个注册。
 * 至少一个成功返回 ok；全部失败时回滚 lastGoodHotkeys。
 */
export function applyQuickHotkeys(
  patch?: Partial<{ enabled: boolean; hotkeys: string[] }>
): QuickHotkeyApplyResult {
  const current = readSettings()
  const enabled = patch?.enabled ?? current.enabled
  const hotkeys =
    patch?.hotkeys && patch.hotkeys.length > 0 ? [...patch.hotkeys] : current.hotkeys

  unregisterActive()

  if (!enabled) {
    lastGoodHotkeys = []
    logInfo('quick', 'hotkeys disabled')
    return { ok: true, enabled: false, hotkeys, registered: [], failed: [] }
  }

  const registered: string[] = []
  const failed: string[] = []

  for (const acc of hotkeys) {
    try {
      const ok = globalShortcut.register(acc, () => {
        toggleQuickWindow()
      })
      if (ok) {
        registered.push(acc)
        activeHotkeys.push(acc)
      } else {
        failed.push(acc)
      }
    } catch (err) {
      failed.push(acc)
      logError('quick', `register throw ${acc}: ${(err as Error).message}`)
    }
  }

  if (registered.length === 0) {
    // 全部失败：回滚上一成功集合（若仍是 enabled）
    logWarn('quick', `all hotkeys failed: ${hotkeys.join(', ')}; rollback`)
    if (lastGoodHotkeys.length > 0) {
      for (const acc of lastGoodHotkeys) {
        try {
          if (globalShortcut.register(acc, () => toggleQuickWindow())) {
            registered.push(acc)
            activeHotkeys.push(acc)
          }
        } catch {
          /* ignore rollback errors */
        }
      }
    }
    sendShellEvent({
      type: 'quick-hotkey-failed',
      failed: hotkeys,
      registered: [...registered]
    })
    return {
      ok: registered.length > 0,
      enabled,
      hotkeys,
      registered,
      failed: hotkeys.filter((h) => !registered.includes(h)),
      error: registered.length > 0 ? '部分快捷键回滚' : '全部快捷键注册失败'
    }
  }

  lastGoodHotkeys = [...registered]
  if (failed.length > 0) {
    sendShellEvent({ type: 'quick-hotkey-failed', failed, registered })
  }
  logInfo('quick', `hotkeys active: ${registered.join(', ') || '(none)'}`)
  return { ok: true, enabled, hotkeys, registered, failed }
}

export function initQuickHotkeys(): void {
  applyQuickHotkeys()
}

export function disposeQuickHotkeys(): void {
  unregisterActive()
  lastGoodHotkeys = []
}

export function getQuickHotkeyConfig(): QuickHotkeyConfig {
  const { enabled, hotkeys } = readSettings()
  return {
    enabled,
    hotkeys: activeHotkeys.length > 0 ? [...activeHotkeys] : hotkeys,
    platform: process.platform
  }
}
