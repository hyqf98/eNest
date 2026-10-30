import { handleShellIpc, onShellIpc } from '@main/ipc/ipcSecurity'
/**
 * quickHandlers — 快捷启动 IPC
 * 职责：注册 quick:* 通道：toggle/hide/search/open/scan-apps/config/hotkeys。
 * 被 index.ts 在 app.whenReady 后调用 registerQuickHandlers。
 * 关键依赖：createQuickWindow、quickHotkey、commandIndex、appScanner、appLauncher、
 * pluginHost、settingsStore、sendShellEvent。
 */
import type { IpcMainInvokeEvent } from 'electron'
import { getQuickInputState, handleQuickInput } from '@main/plugin/quickInputService'
import type { QuickInputMessage } from '@shared/types/plugin-tools'
import { IpcChannels } from '@shared/types/ipc'
import type {
  QuickInputContextRequest,
  QuickInputContextResult,
  QuickEnterInput,
  QuickOpenRequest,
  QuickOpenResult,
  QuickSearchRequest,
  QuickSearchResult
} from '@shared/types/quick'
import { executePluginCommand } from '@main/launcher/pluginLauncher'
import {
  getQuickShowRevision,
  getQuickWindow,
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
import {
  cancelQuickProviderSession, getLaunchDirectorySnapshot, onLaunchDirectoryChanged,
  quickOpenedIdentity, resolveQuickOpenCommand, searchQuickCommands, validateQuickOpenTarget
} from '@main/launcher/commandIndex'
import {
  buildQuickEnterInput, getQuickInputEpoch, listQuickInputContext, readClipboardIntoContext, removeQuickInputContext
} from '@main/launcher/quickInputContext'
import { getRuntimeScope, type PluginRuntimeScope } from '@main/plugin/PluginRuntimeScope'
import { launchLocalApp } from '@main/launcher/appLauncher'
import { pluginHost } from '@main/plugin/PluginHost'
import { settingsStore } from '@main/settings/SettingsStore'
import { getMainWindow, sendShellEvent } from '@main/window/createShellWindow'
import { logError, logInfo } from '@main/logs/logService'
import { consumeQuickThemeGesture, getQuickThemeConfig, getQuickThemeStateOwner } from '@main/theme/quickThemeProtocol'
import { quickProviderStates } from '@main/theme/quickStateService'
import type { QuickProviderStateRequest, QuickProviderStateSnapshot } from '@shared/types/quickTheme'

interface QuickSession {
  id: string
  window: NonNullable<ReturnType<typeof getQuickWindow>>
  revision: number
  controller: AbortController
  openController?: AbortController
  openInputEpoch?: number
  searchRevision: number
  cancelRevision: number
  openRevision: number
  retire: () => void
}

let quickSession: QuickSession | undefined

function captureQuickSession(event: IpcMainInvokeEvent): QuickSession {
  const window = getQuickWindow(), contents = event.sender
  if (!window || window.isDestroyed() || contents.isDestroyed() || window.webContents !== contents) {
    throw new Error('Quick controller retired')
  }
  const revision = getQuickShowRevision()
  if (quickSession?.window === window && quickSession.revision === revision && !quickSession.controller.signal.aborted) return quickSession
  quickSession?.retire()
  const session: QuickSession = {
    id: `quick:${contents.id}`, window, revision, controller: new AbortController(),
    searchRevision: 0, cancelRevision: 0, openRevision: 0, retire: () => {}
  }
  const navigate = (_event: Electron.Event, _url: string, _inPlace: boolean, mainFrame: boolean) => {
    if (mainFrame) session.retire()
  }
  session.retire = () => {
    session.controller.abort()
    session.openController?.abort()
    if (quickSession === session) {
      cancelQuickProviderSession(session.id)
      quickSession = undefined
    }
    window.removeListener('hide', session.retire)
    window.removeListener('closed', session.retire)
    contents.removeListener('destroyed', session.retire)
    contents.removeListener('render-process-gone', session.retire)
    contents.removeListener('did-start-navigation', navigate)
  }
  window.on('hide', session.retire)
  window.on('closed', session.retire)
  contents.on('destroyed', session.retire)
  contents.on('render-process-gone', session.retire)
  contents.on('did-start-navigation', navigate)
  quickSession = session
  return session
}

function isQuickSessionCurrent(session: QuickSession, event: IpcMainInvokeEvent): boolean {
  return quickSession === session && !session.controller.signal.aborted
    && getQuickWindow() === session.window && getQuickShowRevision() === session.revision
    && !session.window.isDestroyed() && !event.sender.isDestroyed()
    && session.window.webContents === event.sender && event.senderFrame === event.sender.mainFrame
    && session.window.isVisible()
}

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

async function handleOpen(event: IpcMainInvokeEvent, req: QuickOpenRequest): Promise<QuickOpenResult> {
  let release = () => {}
  try {
    const session = captureQuickSession(event), revision = ++session.openRevision
    session.openController?.abort()
    const operation = new AbortController()
    session.openController = operation
    release = () => {
      if (session.openController === operation) { session.openController = undefined; session.openInputEpoch = undefined }
    }
    const cancelRevision = session.cancelRevision
    const inputEpoch = req?.kind === 'plugin' && req.input ? getQuickInputEpoch() : undefined
    session.openInputEpoch = inputEpoch
    const current = () => !operation.signal.aborted && session.openRevision === revision && session.cancelRevision === cancelRevision
      && (inputEpoch === undefined || inputEpoch === getQuickInputEpoch()) && isQuickSessionCurrent(session, event)
    if (!current()) return { ok: false, error: 'Quick session retired' }
    if (!await validateQuickOpenTarget(req)) return { ok: false, error: 'Quick target is unavailable' }
    if (!current()) return { ok: false, error: 'Quick session retired' }
    if (req.kind === 'app') {
      await launchLocalApp(req.path)
      if (current()) hideQuickWindow()
      return { ok: true, opened: openedFact(req) }
    }
    if (req.kind === 'plugin') {
      const command = resolveQuickOpenCommand(req, session.id)
      if (!command) return { ok: false, error: 'Launch entry is no longer available' }
      const query = typeof req.query === 'string' ? req.query.slice(0, 4_096) : ''
      let contextInput: QuickEnterInput | undefined
      let inputScope: PluginRuntimeScope | undefined
      const activationCurrent = () => current() && (!inputScope || inputScope.isCurrent() && !inputScope.isClosing && getRuntimeScope(req.pluginId) === inputScope)
      const configured = settingsStore.getPluginLaunchConfig(req.pluginId)?.mode
      const result = await executePluginCommand(command, {
        source: 'quick', sessionId: session.id, query, guard: activationCurrent, signal: operation.signal,
        defaultTarget: req.container === 'quick' || req.container === 'shell' ? req.container : configured === 'shell' ? 'shell' : 'quick',
        ...(req.container === 'quick' || req.container === 'shell' ? { target: req.container } : {}),
        ...(req.input ? { prepareInput: async () => {
          const scope = getRuntimeScope(req.pluginId)
          const assertCurrent = () => {
            if (!current() || !scope?.isCurrent() || scope.isClosing || getRuntimeScope(req.pluginId) !== scope) {
              throw new Error('Quick input owner retired')
            }
          }
          assertCurrent()
          inputScope = scope
          contextInput = await buildQuickEnterInput(req.pluginId, req.input, assertCurrent)
          return contextInput
        } } : {})
      })
      if (!result.ok) return { ok: false, error: result.error }
      const ownsQuick = result.presentation === 'quick' && pluginHost.getQuickPlugin() === req.pluginId
      if (result.input) {
        for (const ids of [req.input?.imageIds, req.input?.fileIds]) {
          for (const id of Array.isArray(ids) ? ids.slice(0, 20) : []) {
            if (typeof id === 'string' && id.length <= 64) removeQuickInputContext(id)
          }
        }
      }
      return {
        ok: true,
        ...(ownsQuick ? { tabId: req.pluginId } : {}),
        opened: openedFact({ kind: 'plugin', pluginId: req.pluginId, code: command.code, entryId: command.entryId })
      }
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
  } finally {
    release()
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

  handleShellIpc(IpcChannels.QuickSearch, async (event, payload: QuickSearchRequest): Promise<QuickSearchResult> => {
    const session = captureQuickSession(event)
    if (payload?.phase === 'cancel') {
      session.searchRevision++
      session.cancelRevision++
      session.openController?.abort()
      cancelQuickProviderSession(session.id)
      return { items: [] }
    }
    const kind = payload?.kind === 'app' || payload?.kind === 'plugin' || payload?.kind === 'action' ? payload.kind : undefined
    if (payload?.phase !== 'providers' && payload?.phase !== 'enriched') {
      const snapshot = await getLaunchDirectorySnapshot()
      // Read-only prewarming can finish across show/hide without caching a false empty directory.
      return { items: kind ? snapshot.items.filter(item => item.kind === kind) : snapshot.items, directoryRevision: snapshot.revision }
    }
    if (!isQuickSessionCurrent(session, event) || pluginHost.getQuickPlugin()) return { items: [] }
    const revision = payload.phase === 'providers' ? ++session.searchRevision : session.searchRevision
    const items = await searchQuickCommands(String(payload.query ?? ''), payload.limit ?? 20, kind, payload.phase, payload.ids,
      { sessionId: session.id, signal: session.controller.signal })
    return isQuickSessionCurrent(session, event) && revision === session.searchRevision && !pluginHost.getQuickPlugin() ? { items } : { items: [] }
  })

  handleShellIpc(IpcChannels.QuickOpen, (event, payload: QuickOpenRequest) => {
    return handleOpen(event, payload)
  })

  // Revisions are opaque cache keys; notifications only invalidate a previously read directory.
  onLaunchDirectoryChanged(() => sendShellEvent({ type: 'launch-directory-changed', revision: 'invalidated' }))

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
      if ((payload.operation === 'read-clipboard' || payload.operation === 'clear') && quickSession?.openInputEpoch !== undefined) {
        quickSession.openController?.abort()
      }
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
