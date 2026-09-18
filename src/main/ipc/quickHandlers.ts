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
import { resolvePluginForm } from '@shared/types/plugin'
import {
  hideQuickWindow,
  setQuickContentHeight,
  toggleQuickWindow
} from '../window/createQuickWindow'
import {
  applyQuickHotkeys,
  getQuickHotkeyConfig,
  probeHotkey
} from '../hotkey/quickHotkey'
import { scanApplications } from '../launcher/appScanner'
import { searchQuickCommands, QUICK_RECENT_MAX } from '../launcher/commandIndex'
import { launchLocalApp } from '../launcher/appLauncher'
import { pluginHost } from '../plugin/PluginHost'
import { pluginRegistry } from '../plugin/PluginRegistry'
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
  if (req.kind === 'action') return `action:${req.action}`
  // plugin-escape / plugin-pin 不计入最近使用（非终结动作）
  return ''
}

/**
 * 成功打开后把命令写入 general.quickLauncher.recent（截断 20）。
 * 必须合并既有 quickLauncher（保留 enabled/hotkeys），禁止整段覆盖。
 */
async function touchRecent(req: QuickOpenRequest): Promise<void> {
  try {
    const id = recentIdOf(req)
    if (!id) return
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
      const enter = req.code ? { code: req.code } : undefined
      // mini 插件内嵌 Quick 小窗（container=quick）；panel 插件进主窗 Tab（行为不变）。
      // 渲染层未带 container 时按 manifest form 推导（mini → quick）。
      const manifestForm = resolvePluginForm(
        pluginRegistry.getManifest(req.pluginId)?.form ??
          pluginRegistry.get(req.pluginId)?.form
      )
      const container =
        req.container === 'quick' || req.container === 'shell'
          ? req.container
          : manifestForm === 'mini'
            ? 'quick'
            : 'shell'
      if (container === 'quick') {
        // Quick 小窗保持可见：插件 view 挂窗内（PluginHost 挂载 + 高度自适应 +
        // quick-plugin-mode 推送渲染层切插件态）
        const tabId = await pluginHost.openPlugin(req.pluginId, enter, { container: 'quick' })
        logInfo('quick', `mini open ${req.pluginId} (quick)${req.code ? ` code=${req.code}` : ''}`)
        void touchRecent(req)
        return { ok: true, tabId }
      }
      await pluginHost.openPlugin(req.pluginId, enter, { container: 'shell' })
      // 主窗路径同样先退场 quick 插件（openPlugin 的容器迁移已在 Host 内完成，
      // 这里只兜底清掉残留的其它 quick 挂载）
      hideQuickWindow()
      focusMainWindow()
      sendShellEvent({ type: 'plugins-changed' })
      void touchRecent(req)
      return { ok: true }
    }
    if (req.kind === 'plugin-escape') {
      // 插件态 Esc：回列表（view 隐藏保留进程，走休眠策略）
      pluginHost.dismissQuickPlugin(req.pluginId)
      return { ok: true }
    }
    if (req.kind === 'plugin-pin') {
      // ⌘Enter / 「固定到主窗」按钮：view 迁主窗 + Quick 收起 + 主窗前置
      pluginHost.pinToShell(req.pluginId)
      hideQuickWindow()
      focusMainWindow()
      sendShellEvent({ type: 'plugins-changed' })
      return { ok: true }
    }
    // action / panel 打开前：若 quick 正处插件态，先退场回列表（保留进程）
    const mounted = pluginHost.getQuickPlugin()
    if (mounted) pluginHost.dismissQuickPlugin(mounted)
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

  ipcMain.handle(IpcChannels.QuickProbeHotkey, (_e, payload: { acc?: string }) => {
    const acc = String(payload?.acc ?? '')
    if (!acc) return { acc: '', free: false, ours: false }
    return probeHotkey(acc)
  })

  ipcMain.handle(IpcChannels.QuickSetHotkeys,
    async (_e, payload: { enabled?: boolean; hotkeys?: string[]; activeHotkey?: string }) => {
      const applyResult = applyQuickHotkeys(payload)
      // 持久化槽位列表 + 当前生效键；生效以 registered/activeHotkey 为准
      const general = settingsStore.getAll().general
      const persistHotkeys = applyResult.hotkeys
      const persistActive = applyResult.activeHotkey ?? ''
      await settingsStore.setAll({
        general: {
          ...general,
          quickLauncher: {
            ...general.quickLauncher,
            enabled: applyResult.enabled,
            hotkeys: persistHotkeys,
            activeHotkey: persistActive
          }
        }
      })
      sendShellEvent({
        type: 'quick-config-changed',
        enabled: applyResult.enabled,
        hotkeys: persistHotkeys,
        activeHotkey: persistActive
      })
      const result: QuickHotkeyApplyResult = applyResult
      return result
    }
  )

  // Quick 渲染层请求隐藏（Esc）
  ipcMain.on(IpcChannels.QuickHideRequest, () => {
    hideQuickWindow()
  })

  // 内容撑开/收起
  ipcMain.on(IpcChannels.QuickResize, (_e, payload: { height?: number; animate?: boolean }) => {
    const h = Number(payload?.height)
    if (!Number.isFinite(h) || h <= 0) return
    setQuickContentHeight(h, payload?.animate !== false)
  })

  logInfo('quick', 'ipc handlers registered')
}
