import { handleShellIpc, onShellIpc } from '@main/ipc/ipcSecurity'
/**
 * quickHandlers — 快捷启动 IPC
 * 职责：注册 quick:* 通道：toggle/hide/search/open/scan-apps/config/hotkeys。
 * 被 index.ts 在 app.whenReady 后调用 registerQuickHandlers。
 * 关键依赖：createQuickWindow、quickHotkey、commandIndex、appScanner、appLauncher、
 * pluginHost、settingsStore、sendShellEvent。
 */
import { getQuickWindow } from '@main/window/createQuickWindow'
import { getQuickInputState, handleQuickInput } from '@main/plugin/quickInputService'
import type { QuickInputMessage } from '@shared/types/plugin-tools'
import { IpcChannels } from '@shared/types/ipc'
import type {
  QuickInputContextRequest,
  QuickInputContextResult,
  QuickOpenRequest,
  QuickOpenResult,
  QuickSearchRequest,
  QuickSearchResult
} from '@shared/types/quick'
import type { PluginEnterPayload } from '@shared/types/plugin'
import { launchPlugin } from '@main/launcher/pluginLauncher'
import {
  hideQuickWindow,
  setQuickContentHeight,
  toggleQuickWindow
} from '@main/window/createQuickWindow'
import {
  saveQuickHotkeys,
  getQuickHotkeyConfig,
  probeHotkey
} from '@main/hotkey/quickHotkey'
import { scanApplications } from '@main/launcher/appScanner'
import { searchQuickCommands, validateQuickOpenTarget, quickOpenedIdentity } from '@main/launcher/commandIndex'
import {
  buildQuickEnterInput, forgetQuickEnterInput, listQuickInputContext, readClipboardIntoContext,
  rememberQuickEnterInput, removeQuickInputContext
} from '@main/launcher/quickInputContext'
import { getRuntimeScope } from '@main/plugin/PluginRuntimeScope'
import { launchLocalApp } from '@main/launcher/appLauncher'
import { pluginHost } from '@main/plugin/PluginHost'
import { settingsStore } from '@main/settings/SettingsStore'
import { getMainWindow, sendShellEvent } from '@main/window/createShellWindow'
import { logError, logInfo } from '@main/logs/logService'
import { consumeQuickThemeGesture, getQuickThemeConfig, getQuickThemeStateOwner } from '@main/theme/quickThemeProtocol'
import { quickProviderStates } from '@main/theme/quickStateService'
import type { QuickProviderStateRequest, QuickProviderStateSnapshot } from '@shared/types/quickTheme'

function focusMainWindow(): void {
  const win = getMainWindow()
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  }
}

function openedFact(req: QuickOpenRequest): QuickOpenResult['opened'] {
  try {
    const stateKey = quickOpenedIdentity(req)
    return stateKey ? { stateKey, at: Date.now() } : undefined
  } catch {
    // A failed private-state store must not report an already completed launch as failed.
    logError('quick', 'native launch identity unavailable')
    return undefined
  }
}

async function handleOpen(req: QuickOpenRequest): Promise<QuickOpenResult> {
  try {
    if (!await validateQuickOpenTarget(req)) return { ok: false, error: 'Quick target is unavailable' }
    if (req.kind === 'app') {
      await launchLocalApp(req.path)
      hideQuickWindow()
      return { ok: true, opened: openedFact(req) }
    }
    if (req.kind === 'plugin') {
      const query = typeof req.query === 'string' ? req.query.trim().slice(0, 4_096) : ''
      const contextInput = req.input ? await buildQuickEnterInput(req.pluginId, req.input) : undefined
      const hasPayload = req.payload !== undefined && req.payload !== null
      // zTools 对齐：任何插件打开都携带当前输入文本；内容匹配/provider 自带载荷优先。
      const enter: PluginEnterPayload | undefined =
        req.code || req.type || hasPayload || query || contextInput
          ? {
              ...(req.code ? { code: req.code } : {}),
              ...(req.type ? { type: req.type } : {}),
              ...(hasPayload ? { payload: req.payload } : query ? { payload: query, type: req.type ?? 'text' } : {}),
              ...(contextInput ? { input: contextInput } : {})
            }
          : undefined
      const result = await launchPlugin({
        pluginId: req.pluginId, source: 'quick', enter,
        mode: req.container === 'quick' || req.container === 'shell' ? req.container : undefined
      })
      if (!result.ok) return { ok: false, error: result.error }
      if (contextInput) {
        // Context bytes were consumed by this launch; the plugin reads them back via quickInput.readContext.
        const scope = getRuntimeScope(req.pluginId)
        if (scope?.isCurrent() && !scope.isClosing) {
          rememberQuickEnterInput(req.pluginId, scope.owner.generation, contextInput)
          scope.addDisposer(() => forgetQuickEnterInput(req.pluginId))
        }
        removeQuickInputContext()
      }
      return { ok: true, tabId: req.pluginId, opened: openedFact(req) }
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
      return { ok: result.complete, error: result.errors[0], ...(result.complete ? { opened: openedFact(req) } : {}) }
    }
    // action / panel 打开前：若 quick 正处插件态，先退场回列表（保留进程）
    const mounted = pluginHost.getQuickPlugin()
    if (mounted) pluginHost.dismissQuickPlugin(mounted)
    // action
    hideQuickWindow()
    focusMainWindow()
    if (req.action === 'open-settings') {
      sendShellEvent({ type: 'quick-open-view', view: 'settings' })
      return { ok: true, opened: openedFact(req) }
    }
    if (req.action === 'open-market') {
      sendShellEvent({ type: 'quick-open-view', view: 'home' })
      return { ok: true, opened: openedFact(req) }
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
    if (message && message.pluginId !== pluginHost.getQuickPlugin()) throw new Error('Quick input owner rejected')
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
    const items = await searchQuickCommands(
      query,
      payload?.limit ?? 20,
      payload?.kind === 'app' || payload?.kind === 'plugin' || payload?.kind === 'action' ? payload.kind : undefined,
      payload?.phase === 'catalog' || payload?.phase === 'static' || payload?.phase === 'enriched' || payload?.phase === 'providers' ? payload.phase : undefined,
      payload?.ids
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
  handleShellIpc(IpcChannels.QuickThemeGetConfig, (event) => {
    if (event.sender.id !== getQuickWindow()?.webContents.id) throw new Error('Quick theme controller rejected')
    return getQuickThemeConfig()
  })
  handleShellIpc(IpcChannels.QuickThemeAuthorize, (event, key: unknown) => {
    if (event.sender.id !== getQuickWindow()?.webContents.id || typeof key !== 'string' || key.length > 128) return false
    return consumeQuickThemeGesture(key)
  })
  handleShellIpc(IpcChannels.QuickProviderState, (event, request: QuickProviderStateRequest) => {
    if (event.sender.id !== getQuickWindow()?.webContents.id) throw new Error('Quick state controller rejected')
    if (!request || typeof request !== 'object' || Array.isArray(request) ||
        request.providerKey !== null && (typeof request.providerKey !== 'string' || request.providerKey.length > 128)) {
      throw new Error('Invalid Quick state request')
    }
    const owner = request.providerKey === null ? { source: 'enest.builtin', packId: 'default' }
      : getQuickThemeStateOwner(request.providerKey)
    if (!owner) throw new Error('Quick state provider retired')
    if (request.operation === 'keys') {
      if (request.providerKey !== null || !Array.isArray(request.identities) || request.identities.length > 256 ||
          request.identities.some(id => typeof id !== 'string' || !id || id.length > 4_096)) {
        throw new Error('Quick identity encoding rejected')
      }
      return { keys: quickProviderStates.encodeIdentities(request.identities) }
    }
    if (request.operation === 'write') return quickProviderStates.write(owner, request.expectedRevision, request.value)
    if (request.operation !== 'read') throw new Error('Invalid Quick state operation')
    const snapshot: QuickProviderStateSnapshot = quickProviderStates.read(owner)
    // The trusted bundled provider alone interprets this opaque backup, never an untrusted theme.
    if (request.providerKey === null && snapshot.revision === 0) snapshot.legacy = settingsStore.getQuickLauncherSettings()
    return snapshot
  })

  handleShellIpc(IpcChannels.QuickProbeHotkey, (_e, payload: { acc?: string }) => {
    const acc = String(payload?.acc ?? '')
    if (!acc) return { acc: '', free: false, ours: false }
    return probeHotkey(acc)
  })

  handleShellIpc(IpcChannels.QuickSetHotkeys,
    (_e, payload: import('@shared/types/quick').QuickHotkeyPatch) => saveQuickHotkeys(payload)
  )

  // 粘贴上下文只经可信控制器进出；主题表面的 paste 动作在控制器侧已核对一次性原生手势。
  handleShellIpc(IpcChannels.QuickInputContext, async (event, payload: QuickInputContextRequest): Promise<QuickInputContextResult> => {
    if (event.sender.id !== getQuickWindow()?.webContents.id) return { ok: false, error: 'Quick context sender rejected' }
    if (!payload || typeof payload !== 'object') return { ok: false, error: 'Invalid context request' }
    try {
      if (payload.operation === 'read-clipboard') {
        await readClipboardIntoContext()
        return { ok: true, items: listQuickInputContext() }
      }
      if (payload.operation === 'clear') return { ok: true, items: removeQuickInputContext(typeof payload.id === 'string' ? payload.id : undefined) }
      if (payload.operation === 'list') return { ok: true, items: listQuickInputContext() }
    } catch (error) {
      logError('quick', `input context failed: ${(error as Error).message}`)
    }
    return { ok: false, error: 'Input context unavailable' }
  })

  // 列表根据内容测量伸缩；插件始终使用宿主分配的最大内容区。
  onShellIpc(IpcChannels.QuickResize, (_e, payload: { height?: number; animate?: boolean }) => {
    // 列表上一帧的测量可能晚于插件挂载到达，无需再次布局原生插件。
    if (pluginHost.getQuickPlugin()) return
    const h = Number(payload?.height)
    if (!Number.isFinite(h) || h <= 0) return
    setQuickContentHeight(h)
  })

  logInfo('quick', 'ipc handlers registered')
}
