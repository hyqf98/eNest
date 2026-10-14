import { handleShellIpc, onShellIpc } from '@main/ipc/ipcSecurity'
/**
 * quickHandlers — 快捷启动 IPC
 * 职责：注册 quick:* 通道：toggle/hide/search/open/scan-apps/config/hotkeys。
 * 被 index.ts 在 app.whenReady 后调用 registerQuickHandlers。
 * 关键依赖：createQuickWindow、quickHotkey、commandIndex、appScanner、appLauncher、
 * pluginHost、settingsStore、sendShellEvent。
 */
import { ipcMain } from 'electron'
import { getQuickWindow } from '@main/window/createQuickWindow'
import { getQuickInputState, handleQuickInput } from '@main/plugin/quickInputService'
import type { QuickInputMessage } from '@shared/types/plugin-tools'
import { IpcChannels } from '@shared/types/ipc'
import type {
  QuickHotkeyApplyResult,
  QuickOpenRequest,
  QuickOpenResult,
  QuickSearchRequest,
  QuickSearchResult
} from '@shared/types/quick'
import type { PluginEnterPayload } from '@shared/types/plugin'
import { normalizeSearchText } from '@shared/search'
import { resolveLaunchMode } from '@main/hotkey/pluginLaunchHotkeys'
import {
  hideQuickWindow,
  setQuickContentHeight,
  toggleQuickWindow
} from '@main/window/createQuickWindow'
import {
  applyQuickHotkeys,
  getQuickHotkeyConfig,
  probeHotkey
} from '@main/hotkey/quickHotkey'
import { scanApplications } from '@main/launcher/appScanner'
import { searchQuickCommands, QUICK_RECENT_MAX } from '@main/launcher/commandIndex'
import { launchLocalApp } from '@main/launcher/appLauncher'
import { pluginHost } from '@main/plugin/PluginHost'
import { settingsStore } from '@main/settings/SettingsStore'
import { getMainWindow, sendShellEvent } from '@main/window/createShellWindow'
import { logError, logInfo } from '@main/logs/logService'

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
    settingsStore.recordQuickUse(id, 'query' in req ? req.query : undefined, QUICK_RECENT_MAX)
  } catch (err) {
    logError('quick', `touchRecent failed: ${(err as Error).message}`)
  }
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
      const enter: PluginEnterPayload | undefined = req.code || req.type || req.payload !== undefined
        ? {
            ...(req.code ? { code: req.code } : {}),
            ...(req.type ? { type: req.type } : {}),
            ...(req.payload !== undefined ? { payload: req.payload } : {})
          }
        : undefined
      // 容器决策链：显式 container（⌘Enter 强制主窗）> 用户每插件「启动方式」
      // 设置（pluginLaunch[id].mode）> 跟随入口（Quick 打开 → quick 小窗内嵌）。
      // 不再有 manifest form 区分——所有插件都可在小窗内嵌渲染，也可固定主窗。
      const container =
        req.container === 'quick' || req.container === 'shell'
          ? req.container
          : resolveLaunchMode(req.pluginId) ?? 'quick'
      if (container === 'quick') {
        // Quick 小窗保持可见：插件 view 挂窗内（PluginHost 挂载 + 高度自适应 +
        // quick-plugin-mode 推送渲染层切插件态）
        const tabId = await pluginHost.openPlugin(req.pluginId, enter, { container: 'quick' })
        logInfo('quick', `plugin open ${req.pluginId} (quick)${req.code ? ` code=${req.code}` : ''}`)
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
    if (req.kind === 'plugin-tab') {
      if (pluginHost.getQuickPlugin() !== req.pluginId) return { ok: false }
      const contents = pluginHost.getWebContents(req.pluginId)
      if (!contents || contents.isDestroyed()) return { ok: false }
      contents.focus()
      const modifiers: Array<'shift'> = req.shift ? ['shift'] : []
      contents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab', modifiers })
      contents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab', modifiers })
      return { ok: true }
    }
    if (req.kind === 'action' && req.action === 'refresh-apps') {
      const result = await scanApplications(true)
      if (result.complete) void touchRecent(req)
      return { ok: result.complete, error: result.errors[0] }
    }
    // action / panel 打开前：若 quick 正处插件态，先退场回列表（保留进程）
    const mounted = pluginHost.getQuickPlugin()
    if (mounted) pluginHost.dismissQuickPlugin(mounted)
    // action
    hideQuickWindow()
    focusMainWindow()
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
  handleShellIpc(IpcChannels.QuickInput, (event, message?: QuickInputMessage) => {
    if (event.sender.id !== getQuickWindow()?.webContents.id) throw new Error('Quick input sender rejected')
    return message ? handleQuickInput(message) : getQuickInputState()
  })
  handleShellIpc(IpcChannels.QuickToggle, () => {
    toggleQuickWindow()
    return { ok: true }
  })

  handleShellIpc(IpcChannels.QuickHide, () => {
    hideQuickWindow()
    return { ok: true }
  })

  handleShellIpc(IpcChannels.QuickSearch, async (_e, payload: QuickSearchRequest) => {
    const query = String(payload?.query ?? '')
    const quick = settingsStore.getQuickLauncherSettings()
    const items = await searchQuickCommands(
      query,
      payload?.limit ?? 20,
      quick.recent ?? [],
      payload?.kind === 'app' || payload?.kind === 'plugin' || payload?.kind === 'action' ? payload.kind : undefined,
      quick.queryPreferences?.find(entry => entry.query === normalizeSearchText(query))?.id,
      payload?.phase === 'static' || payload?.phase === 'enriched' || payload?.phase === 'providers' ? payload.phase : undefined
    )
    const result: QuickSearchResult = { items }
    return result
  })

  handleShellIpc(IpcChannels.QuickOpen, (_e, payload: QuickOpenRequest) => {
    return handleOpen(payload)
  })

  handleShellIpc(IpcChannels.QuickScanApps, async (_e, payload?: { force?: boolean }) => {
    return scanApplications(payload?.force === true)
  })

  handleShellIpc(IpcChannels.QuickGetConfig, () => {
    return getQuickHotkeyConfig()
  })

  handleShellIpc(IpcChannels.QuickProbeHotkey, (_e, payload: { acc?: string }) => {
    const acc = String(payload?.acc ?? '')
    if (!acc) return { acc: '', free: false, ours: false }
    return probeHotkey(acc)
  })

  handleShellIpc(IpcChannels.QuickSetHotkeys,
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

  // 内容撑开/收起
  onShellIpc(IpcChannels.QuickResize, (_e, payload: { height?: number; animate?: boolean }) => {
    // 列表上一帧的测量可能晚于插件挂载到达；插件态由 Host 管理尺寸。
    if (pluginHost.getQuickPlugin()) return
    const h = Number(payload?.height)
    if (!Number.isFinite(h) || h <= 0) return
    setQuickContentHeight(h)
  })

  logInfo('quick', 'ipc handlers registered')
}
