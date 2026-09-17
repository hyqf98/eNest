/**
 * quickHandlers — 快捷启动 IPC
 * 职责：注册 quick:* 通道：toggle/hide/search/open/scan-apps/config/hotkeys。
 * 被 index.ts 在 app.whenReady 后调用 registerQuickHandlers。
 * 关键依赖：createQuickWindow、quickHotkey、commandIndex、appScanner、appLauncher、
 * pluginHost、settingsStore、sendShellEvent。
 */
import { ipcMain } from 'electron'
import { IpcChannels } from '@shared/types/ipc'
import type {
  QuickHotkeyApplyResult,
  QuickOpenRequest,
  QuickOpenResult,
  QuickSearchResult
} from '@shared/types/quick'
import type { QuickRecentEntry } from '@shared/types/plugin'
import {
  hideQuickWindow,
  toggleQuickWindow
} from '../window/createQuickWindow'
import {
  applyQuickHotkeys,
  getQuickHotkeyConfig
} from '../hotkey/quickHotkey'
import { scanApplications } from '../launcher/appScanner'
import { searchQuickCommands, QUICK_RECENT_MAX } from '../launcher/commandIndex'
import { launchLocalApp } from '../launcher/appLauncher'
import { pluginHost } from '../plugin/PluginHost'
import { settingsStore } from '../settings/SettingsStore'
import { getMainWindow, sendShellEvent } from '../window/createShellWindow'
import { logError, logInfo } from '../logs/logService'

function focusMainWindow(): void {
  const win = getMainWindow()
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  }
}

function recentIdOf(req: QuickOpenRequest): string {
  if (req.kind === 'app') return `app:${req.path}`
  if (req.kind === 'plugin') return `plugin:${req.pluginId}:${req.code ?? ''}`
  return `action:${req.action}`
}

/**
 * 成功打开后把命令写入 general.quickLauncher.recent（截断 20）。
 * 必须合并既有 quickLauncher（保留 enabled/hotkeys），禁止整段覆盖。
 */
async function touchRecent(req: QuickOpenRequest): Promise<void> {
  try {
    const id = recentIdOf(req)
    const general = settingsStore.getAll().general
    const ql = general.quickLauncher
    const prev: QuickRecentEntry[] = ql?.recent ?? []
    const existing = prev.find((r) => r.id === id)
    const next: QuickRecentEntry[] = [
      { id, ts: Date.now(), count: (existing?.count ?? 0) + 1 },
      ...prev.filter((r) => r.id !== id)
    ].slice(0, QUICK_RECENT_MAX)
    await settingsStore.setAll({
      general: {
        ...general,
        quickLauncher: {
          enabled: ql?.enabled ?? true,
          hotkeys: ql?.hotkeys ?? [],
          ...ql,
          recent: next
        }
      }
    })
  } catch (err) {
    logError('quick', `touchRecent failed: ${(err as Error).message}`)
  }
}

function readRecent(): QuickRecentEntry[] {
  return settingsStore.getAll().general.quickLauncher?.recent ?? []
}

async function handleOpen(req: QuickOpenRequest): Promise<QuickOpenResult> {
  try {
    if (req.kind === 'app') {
      await launchLocalApp(req.path)
      hideQuickWindow()
      void touchRecent(req)
      return { ok: true }
    }
    if (req.kind === 'plugin') {
      await pluginHost.openPlugin(req.pluginId, req.code ? { code: req.code } : undefined)
      hideQuickWindow()
      focusMainWindow()
      sendShellEvent({ type: 'plugins-changed' })
      void touchRecent(req)
      return { ok: true }
    }
    // action
    hideQuickWindow()
    focusMainWindow()
    if (req.action === 'refresh-apps') {
      const result = await scanApplications(true)
      if (result.complete) void touchRecent(req)
      return { ok: result.complete, error: result.errors[0] }
    }
    if (req.action === 'open-settings') {
      sendShellEvent({ type: 'quick-open-view', view: 'settings' })
      void touchRecent(req)
      return { ok: true }
    }
    if (req.action === 'open-market') {
      sendShellEvent({ type: 'quick-open-view', view: 'home' })
      void touchRecent(req)
      return { ok: true }
    }
    return { ok: true }
  } catch (err) {
    logError('quick', `open failed: ${(err as Error).message}`)
    return { ok: false, error: (err as Error).message }
  }
}

export function registerQuickHandlers(): void {
  ipcMain.handle(IpcChannels.QuickToggle, () => {
    toggleQuickWindow()
    return { ok: true }
  })

  ipcMain.handle(IpcChannels.QuickHide, () => {
    hideQuickWindow()
    return { ok: true }
  })

  ipcMain.handle(IpcChannels.QuickSearch, async (_e, payload: { query?: string; limit?: number }) => {
    const items = await searchQuickCommands(
      String(payload?.query ?? ''),
      payload?.limit ?? 20,
      readRecent()
    )
    const result: QuickSearchResult = { items }
    return result
  })

  ipcMain.handle(IpcChannels.QuickOpen, (_e, payload: QuickOpenRequest) => {
    return handleOpen(payload)
  })

  ipcMain.handle(IpcChannels.QuickScanApps, async (_e, payload?: { force?: boolean }) => {
    return scanApplications(payload?.force === true)
  })

  ipcMain.handle(IpcChannels.QuickGetConfig, () => {
    return getQuickHotkeyConfig()
  })

  ipcMain.handle(
    IpcChannels.QuickSetHotkeys,
    async (_e, payload: { enabled?: boolean; hotkeys?: string[] }) => {
      const applyResult = applyQuickHotkeys(payload)
      // 只持久化「当前生效」集合：全失败时主进程已回滚到 lastGood，
      // 若写入请求值会导致下次启动重复失败并丢失可用快捷键。
      // 合并既有 quickLauncher，保留 recent 等扩展字段。
      const general = settingsStore.getAll().general
      const persistHotkeys =
        applyResult.enabled && applyResult.registered.length > 0
          ? applyResult.registered
          : applyResult.hotkeys
      await settingsStore.setAll({
        general: {
          ...general,
          quickLauncher: {
            ...general.quickLauncher,
            enabled: applyResult.enabled,
            hotkeys: persistHotkeys
          }
        }
      })
      sendShellEvent({
        type: 'quick-config-changed',
        enabled: applyResult.enabled,
        hotkeys: persistHotkeys
      })
      const result: QuickHotkeyApplyResult = applyResult
      return result
    }
  )

  // Quick 渲染层请求隐藏（Esc）
  ipcMain.on(IpcChannels.QuickHideRequest, () => {
    hideQuickWindow()
  })

  logInfo('quick', 'ipc handlers registered')
}
