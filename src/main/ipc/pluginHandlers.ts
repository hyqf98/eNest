import { consumeFetchStream } from '@main/net/fetchStream'
import { websocketConnect, websocketSend, websocketClose } from '@main/net/websocketService'
import { handleShellIpc } from '@main/ipc/ipcSecurity'
import { isPluginPageUrl } from '@main/plugin/pluginSessionPolicy'
import { PLUGIN_PERMISSIONS } from '@shared/types/plugin'
import { isBuiltinCapability } from '@shared/pluginPermissionPolicy'
import { callPluginBackend, stopPluginBackend } from '@main/plugin/pluginBackendRpc'
import { isPluginSettingKey } from '@shared/pluginSettingsKeys'
import { callPluginBackground, refreshPluginBackgrounds, requiredBackgroundPermissions, stopPluginBackground } from '@main/plugin/pluginBackgroundRuntime'
/**
 * pluginHandlers — 插件 IPC 调用分发器
 * 职责：接收插件 preload 发起的 `plugin:call`，校验发送者身份与权限，按 method 分发到具体实现；
 *       转发 `plugin:lifecycle-ack`（关闭、休眠、保存确认）到 PluginHost。
 * 被 registerPluginHandlers 在 index.ts 中注册。
 * 关键依赖：PluginHost（识别 sender）、PluginPermissions（权限断言）、SettingsStore、
 * PluginSettingsBridge、themePacks、pluginStorage（storage.local 落 enest.db）、
 * quickHotkey（Quick 热键冲突预检，经 pluginRuntimeHotkeys 间接使用）。
 */
import { clipboard, ipcMain, nativeImage, Notification, shell, net as electronNet } from 'electron'
import { APP_NAME, EXTERNAL_URL_PROTOCOLS } from '@shared/constants'
import type {
  PermissionGrantSetPayload,
  PermissionResponsePayload,
  PluginCallRequest,
  PluginCallResult,
  PluginCallTraceEntry,
  PluginEventPayload
} from '@shared/types/ipc'
import { IpcChannels } from '@shared/types/ipc'
import type {
  AppLocale,
  PluginManifest,
  PluginPermission,
  PluginPermissionGrant,
  ScreenBounds,
  SettingsSectionContribution,
  ThemePack
} from '@shared/types/plugin'
import { resolvePluginUi } from '@shared/types/plugin'
import {
  clearPluginStorage,
  commitPluginStorage,
  flushPluginStorage,
  getPluginStorageValue,
  initPluginStorage,
  removePluginStorageValue,
  setPluginStorageValue
} from '@main/db/pluginStorage'
import type { PluginStorageOperation } from '@shared/types/storage'
import { assertPermission } from '@main/plugin/PluginPermissions'
import { pluginHost } from '@main/plugin/PluginHost'
import { hideQuickWindow } from '@main/window/createQuickWindow'
import { pickLocalFiles, readLocalFile, localFilesFromDrop, listLocalFiles, revealLocalFile, prepareLocalDrag, startLocalDrag, endLocalDrag } from '@main/plugin/localFiles'
import type { LocalFilePickOptions, PluginInputContext } from '@shared/types/local-files'
import {
  socketClose,
  socketConnect,
  socketList,
  socketSend,
  socketServeWs,
  type SocketConnectInput
} from '@main/net/socketBridge'
import { renameLocalFile, renameLocalFiles, pickLocalSaveFile } from '@main/plugin/localFiles'
import { sysProcesses, sysPorts, sysKill } from '@main/sys/sysInspectService'
import { pluginRegistry } from '@main/plugin/PluginRegistry'
import { getRuntimeScope, type PluginRuntimeScope } from '@main/plugin/PluginRuntimeScope'
import { randomUUID } from 'node:crypto'
import { PLUGIN_TOOL_PERMISSIONS, bindPluginTools, dispatchPluginTool } from '@main/ipc/pluginToolsHandlers'
import { getSessionValue, setSessionValue, removeSessionValue, clearPluginSession } from '@main/plugin/PluginSessionStore'
import {
  normalizeGrant,
  permissionService
} from '@main/plugin/PermissionService'
import {
  checkScreenCapture,
  assertScreenCaptureAllowed,
  openScreenCaptureSettings
} from '@main/plugin/OsPermissionChecks'
import { registerRuntimeHotkey, unregisterRuntimeHotkey } from '@main/hotkey/pluginRuntimeHotkeys'
import { logInfo, logWarn } from '@main/logs/logService'
import { resolveThemeTokens } from '@main/theme/resolveThemeCss'
import { pluginSettingsBridge } from '@main/settings/PluginSettingsBridge'
import { settingsStore } from '@main/settings/SettingsStore'
import { showNotification } from '@main/window/notificationOverlay'
import { themePackRegistry } from '@main/theme/themePacks'
import { appearanceService } from '@main/theme/appearanceService'
import { contributionRegistry } from '@main/contrib/ContributionRegistry'
import { registerDeclaredHomeContribution } from '@main/home/homeRegistry'
import { resolveQuickQuery } from '@main/launcher/quickProviders'
import {
  getShellWebContents,
  sendShellEvent
} from '@main/window/createShellWindow'
import { captureScreen, listCaptureDisplays } from '@main/screen/screenService'
import { openAuxiliaryWindow, sendAuxiliaryMessage, closeAuxiliaryWindow, listAuxiliaryWindows, revokeAuxiliaryCapture, revokeAuxiliaryTopmost } from '@main/window/pluginAuxiliaryWindows'
import { openFileStream, writeFileStream, finishFileStream, abortFileStream } from '@main/plugin/pluginFileStreams'
import { writeClipboardText, writeClipboardImage, writeClipboardFiles } from '@main/clipboard/clipboardNativeEvents'
import type { AuxiliaryOpen, AuxiliaryUpdate } from '@shared/types/auxiliary'
import type { FileStreamOpen } from '@shared/types/file-stream'
import { vaultSet, vaultHas, vaultRemove } from '@main/vault/secretVault'
import { assertInteractive, getHostInteractionSignal, interactionError, interactionErrorCode, isNonInteractive, isIndexSyncActivation, runHostRpc, trackHostRpc } from '@main/plugin/pluginInteractionPolicy'
import { getLaunchIndexState, replaceLaunchIndex, markLaunchIndexDirty } from '@main/launcher/launchIndex'
import { registerPluginActivationHandlers } from '@main/launcher/pluginActivation'

/** method → 所需权限映射；null 表示无需权限（settings.get/set 由 Bridge 管控 key 白名单） */
const runtimeLeases = new Map<string, { release: () => void; unregister: () => void; scope: PluginRuntimeScope }>()
const CLOSE_SAFE = /^(storage\.|files\.stream\.(write|finish|abort)$|auxiliary\.(send|close)$|runtime\.release$|backend\.stop$|net\.socket\.close$)/

const METHOD_PERMISSION: Record<string, PluginPermission | null> = {
  'contribute.replaceLaunchIndex': null,
  'contribute.launchIndexState': null,
  'contribute.markLaunchIndexDirty': null,
  'backend.call': 'backend.node',
  'backend.stop': null,
  'background.call': null,
  'auxiliary.open': null,
  'auxiliary.send': null,
  'auxiliary.close': null,
  'auxiliary.list': null,
  'files.stream.open': null,
  'files.stream.write': null,
  'files.stream.finish': null,
  'files.stream.abort': null,
  ...PLUGIN_TOOL_PERMISSIONS,
  'runtime.acquire': null,
  'runtime.release': null,
  'ui.setTitle': 'ui.setTitle',
  'ui.setIcon': 'ui.setIcon',
  'ui.setBadge': 'ui.setBadge',
  // 未保存标记上报：基础能力（插件自身状态，无需声明/授权）
  'state.setDirty': null,
  'ui.resize': 'ui.resize',
  'ui.setHeight': 'ui.resize',
  'ui.openInShell': null,
  'ui.setInputContext': null,
  'ui.focus': null,
  'ui.focusSearch': null,
  // quick 小窗「提交即收起」：基础 UI 能力，仅当前 quick 挂载者生效
  'ui.dismissQuick': null,
  'localFiles.read': 'fs.read',
  'localFiles.pick': 'fs.read',
  'localFiles.pickSave': 'fs.write',
  'localFiles.fromDrop': 'fs.read',
  'localFiles.list': 'fs.read',
  'localFiles.reveal': 'fs.read',
  'localFiles.prepareDrag': 'fs.read',
  // A prepared export is already a caller-owned capability; asking during dragstart cancels the gesture.
  'localFiles.startDrag': null,
  'localFiles.endDrag': null,
  'ui.toast': 'ui.toast',
  'settings.register': 'settings.register',
  'settings.get': null,
  'settings.set': null,
  'storage.get': 'storage.local',
  'storage.set': 'storage.local',
  'storage.remove': 'storage.local',
  'storage.clear': 'storage.local',
  'storage.flush': 'storage.local',
  'storage.commit': 'storage.local',
  // 会话态存储：权限复用 storage.local（弱于持久化，无需单独声明）
  'storage.session.get': 'storage.local',
  'storage.session.set': 'storage.local',
  'storage.session.remove': 'storage.local',
  'storage.session.clear': 'storage.local',
  'clipboard.readText': 'clipboard.read',
  'clipboard.writeText': 'clipboard.write',
  'clipboard.readImage': 'clipboard.readImage',
  'clipboard.writeImage': 'clipboard.writeImage',
  'clipboard.writeFiles': 'clipboard.write',
  'screen.capture': 'screen.capture',
  'screen.displays': null,
  'net.fetch': 'net.fetch',
  'shell.openExternal': 'shell.openExternal',
  notify: 'notify',
  'theme.register': 'theme',
  // 主题 Token 读取：所有插件可用（无需权限声明），用于主题感知绘制
  'theme.getTokens': null,
  'theme.getAppearance': null,
  // 全局热键：注册/注销共用 'hotkey' 权限
  'hotkey.register': 'hotkey',
  'hotkey.unregister': 'hotkey',
  // 贡献点（插槽化架构）：注册/注销共用 'contribute' 权限；
  // respondQuickQuery 为 quick-query 事件的回传通道，同受 contribute 门控
  'contribute.registerQuickProvider': 'contribute',
  'contribute.unregisterQuickProvider': 'contribute',
  'contribute.respondQuickQuery': 'contribute',
  // 语言读取：所有插件可用（无敏感面）
  'i18n.getLocale': null,
  // Plugin-private credentials; protocol adapters live in plugin backends.
  'vault.set': 'vault.write',
  'vault.has': 'vault.write',
  'vault.remove': 'vault.write',
  // Generic network transport and native system inspection.
  'net.websocket.connect': 'net.socket',
  'net.websocket.send': 'net.socket',
  'net.websocket.close': 'net.socket',
  'net.socket.connect': 'net.socket',
  'net.socket.send': 'net.socket',
  'net.socket.close': 'net.socket',
  'net.socket.list': 'net.socket',
  'net.socket.serveWs': 'net.socket',
  'fs.rename': 'fs.rename',
  'fs.renameBatch': 'fs.rename',
  'sys.processes': 'sys.inspect',
  'sys.ports': 'sys.inspect',
  'sys.kill': 'sys.control'
}

/** net.fetch 响应体上限（2MB），防止插件拉超大资源 */
const NET_FETCH_MAX_BODY = 2 * 1024 * 1024
/** net.fetch 流式（stream: true）响应体上限（32MB），经 net.chunk 分片推送 */
const NET_FETCH_STREAM_MAX_BODY = 32 * 1024 * 1024
const netFetchCounts = new WeakMap<PluginRuntimeScope, number>()
const NET_FETCH_DEFAULT_TIMEOUT = 15_000

/** 向指定插件的存活 webContents 推送 plugin:event 负载（找不到/已销毁则静默丢弃） */
function sendPluginEvent(pluginId: string, payload: PluginEventPayload): void {
  if (!pluginHost.isOpened(pluginId)) return
  pluginHost.sendEvent(pluginId, payload)
}

/** 调用跟踪环形缓冲上限（最近 N 条，超长丢弃最旧） */
const PLUGIN_CALL_TRACE_LIMIT = 200

/**
 * plugin:call 流量环形缓冲（DevConsole「调用跟踪」面板数据源）。
 * 记录走对象字面量 + push + 超长 shift，不做字符串拼接/时间格式化，
 * 保证热路径零额外开销。浅拷贝返回，防外部篡改缓冲本体。
 */
const pluginCallTrace: PluginCallTraceEntry[] = []

/** 读取最近 plugin:call 调用跟踪（浅拷贝，最新在后） */
export function getPluginCallTrace(): PluginCallTraceEntry[] {
  return pluginCallTrace.slice()
}

/** 追加一条调用跟踪（热路径：纯对象操作，永不抛错） */
function recordPluginCall(entry: PluginCallTraceEntry): void {
  pluginCallTrace.push(entry)
  if (pluginCallTrace.length > PLUGIN_CALL_TRACE_LIMIT) pluginCallTrace.shift()
}

/**
 * 向所有已打开插件广播 locale-change（settings.general.locale 变化时
 * 由 shellHandlers.ShellSetSettings 调用）。
 */
export function broadcastPluginLocale(locale: AppLocale): void {
  pluginHost.broadcastEvent({ type: 'locale-change', locale })
}

/** 插件 UI 常传对象形参；与宿主位置参数签名对齐 */
function asObj(args: unknown[]): Record<string, unknown> {
  const a0 = args[0]
  return a0 && typeof a0 === 'object' && !Array.isArray(a0)
    ? (a0 as Record<string, unknown>)
    : {}
}

/** 外链允许的协议：@shared/constants EXTERNAL_URL_PROTOCOLS 单一来源（javascript: 等一律拒绝） */
function externalProtocolAllowed(rawUrl: string): boolean {
  try {
    return EXTERNAL_URL_PROTOCOLS.has(new URL(rawUrl).protocol)
  } catch {
    return false
  }
}

/**
 * 打开外部链接的统一门禁（plugin:call shell.openExternal 与插件页
 * window.open / will-navigate 引流共用）：
 * 1. 协议白名单（http/https/mailto/tel；javascript: 等拒绝）；
 * 2. manifest 声明校验（shell.openExternal 权限）；
 * 3. 壳层 grant 三态（deny 或 ask 被拒 → 抛 permission denied，文案不可改：
 *    插件侧普遍以该串判断）；
 * 4. OS 屏幕权限与外链无关，不涉及。
 * 非法协议静默忽略由调用方决定（dispatch 抛错 vs routeExternal 记日志）。
 */
async function openExternalWithPermission(
  pluginId: string,
  manifest: PluginManifest,
  rawUrl: string
): Promise<void> {
  const url = String(rawUrl ?? '')
  if (!externalProtocolAllowed(url)) {
    throw new Error('only http(s)/mailto/tel urls allowed')
  }
  assertPermission(manifest, 'shell.openExternal')
  assertInteractive(pluginId)
  await shell.openExternal(url)
}

/**
 * 基础能力免授权；敏感能力在声明校验后检查运行时 grant：
 * deny → false；allow → true；ask → 弹窗等待用户决策。
 */
async function ensureRuntimeGrant(
  pluginId: string,
  perm: PluginPermission,
  summary: string
): Promise<boolean> {
  if (isBuiltinCapability(perm)) return true
  const grant = settingsStore.getPermissionGrant(pluginId, perm)
  if (grant === 'allow') return true
  if (grant === 'deny') {
    if (isNonInteractive(pluginId)) throw interactionError('permission-denied', `permission denied: ${perm}`)
    return false
  }
  const osHint =
    perm === 'screen.capture' || perm === 'screen.record'
      ? checkScreenCapture().hint
      : undefined
  const scope = getRuntimeScope(pluginId)
  return permissionService.request(pluginId, perm, summary, osHint, scope ? getHostInteractionSignal(scope) : undefined)
}

function argStr(args: unknown[], objKey: string, pos: number): string {
  const o = asObj(args)
  if (o[objKey] != null) return String(o[objKey])
  return String(args[pos] ?? '')
}

/** 按 method 分发到具体实现，权限已在调用前校验 */
async function dispatch(
  pluginId: string,
  method: string,
  args: unknown[],
  manifest: PluginManifest
): Promise<unknown> {
  if (method in PLUGIN_TOOL_PERMISSIONS) {
    if (method === 'deadlineTasks.start' && Array.isArray(asObj(args).steps)
      && (asObj(args).steps as Array<{ notification?: unknown }>).some(step => step?.notification)) {
      const scope = getRuntimeScope(pluginId)
      const allowed = manifest.permissions?.includes('notify') && await ensureRuntimeGrant(pluginId, 'notify', '后台任务到期提醒')
      // The optional grant may settle after close (or after a replacement opened).
      // Persistent host tasks must only be created by the original live owner.
      if (!scope?.isCurrent() || scope.isClosing || scope.signal.aborted) throw new Error('plugin runtime is closing')
      if (!allowed) args = [{ ...asObj(args), steps: (asObj(args).steps as Array<Record<string, unknown>>).map(step => {
        const { notification: _notification, ...rest } = step
        return rest
      }) }]
    }
    return dispatchPluginTool(pluginId, method, args)
  }
  switch (method) {
    case 'contribute.replaceLaunchIndex': return replaceLaunchIndex(pluginId, args[0])
    case 'contribute.launchIndexState': return getLaunchIndexState(pluginId)
    case 'contribute.markLaunchIndexDirty': return markLaunchIndexDirty(pluginId)
    case 'background.call': {
      const scope = getRuntimeScope(pluginId)
      for (const permission of requiredBackgroundPermissions(pluginId)) {
        assertPermission(manifest, permission)
        if (!(await ensureRuntimeGrant(pluginId, permission, '调用插件后台能力'))) throw new Error(`permission denied: ${permission}`)
        if (!scope?.isCurrent() || scope.isClosing) throw new Error('plugin runtime is closing or stale')
      }
      return callPluginBackground(pluginId, args[0], args[1], args[2])
    }
    case 'auxiliary.open': return openAuxiliaryWindow(pluginId, args[0] as AuxiliaryOpen)
    case 'auxiliary.send': return sendAuxiliaryMessage(pluginId, String(args[0] ?? ''), args[1], args[2] as AuxiliaryUpdate | undefined)
    case 'auxiliary.close': return closeAuxiliaryWindow(pluginId, String(args[0] ?? ''))
    case 'auxiliary.list': return listAuxiliaryWindows(pluginId)
    case 'files.stream.open': return openFileStream(pluginId, args[0] as FileStreamOpen)
    case 'files.stream.write': return writeFileStream(pluginId, String(args[0] ?? ''), args[1] as number, args[2] as ArrayBuffer)
    case 'files.stream.finish': return finishFileStream(pluginId, String(args[0] ?? ''))
    case 'files.stream.abort': return abortFileStream(pluginId, String(args[0] ?? ''))
    case 'backend.call': return callPluginBackend(pluginId, args[0], args[1], args[2])
    case 'backend.stop': return stopPluginBackend(pluginId)
    case 'runtime.acquire': {
      const scope = getRuntimeScope(pluginId)
      if (!scope?.isCurrent() || scope.isClosing || scope.signal.aborted) throw new Error('plugin runtime unavailable')
      if (args[0] !== undefined && (typeof args[0] !== 'string' || args[0].length > 160)) throw new Error('runtime reason must be a string of at most 160 characters')
      if (runtimeLeases.size >= 4096 || [...runtimeLeases.values()].filter(lease => lease.scope === scope).length >= 128) throw new Error('runtime activity lease limit reached')
      const token = randomUUID()
      const release = scope.acquireActivity(String(args[0] ?? 'plugin task'))
      const unregister = scope.addDisposer(() => { release(); runtimeLeases.delete(token) })
      runtimeLeases.set(token, { release, unregister, scope })
      return token
    }
    case 'runtime.release': {
      const token = String(args[0] ?? '')
      const lease = runtimeLeases.get(token)
      if (lease && lease.scope === getRuntimeScope(pluginId)) { lease.release(); lease.unregister(); runtimeLeases.delete(token) }
      return undefined
    }

    case 'ui.openInShell':
      assertInteractive(pluginId)
      pluginHost.pinToShell(pluginId)
      return true
    case 'ui.setInputContext':
      pluginHost.setInputContext(pluginId, args[0] as PluginInputContext)
      return true
    case 'ui.focus':
      assertInteractive(pluginId)
      return pluginHost.focusPlugin(pluginId)
    case 'ui.focusSearch':
      assertInteractive(pluginId)
      return pluginHost.focusSearch(pluginId)
    case 'ui.dismissQuick': {
      assertInteractive(pluginId)
      // 插件提交完成主动收起小窗（如回车回贴/复制后）；走统一隐藏语义，
      // 下次呼出仍恢复本插件。非 quick 挂载者调用为无操作。
      if (pluginHost.getQuickPlugin() !== pluginId) return false
      hideQuickWindow('plugin-dismiss')
      return true
    }
    case 'localFiles.read': return readLocalFile(pluginId, asObj(args) as { handleId: string; encoding?: 'text' | 'dataUrl'; maxBytes?: number })
    case 'localFiles.pick': return pickLocalFiles(pluginId, asObj(args) as LocalFilePickOptions)
    case 'localFiles.fromDrop': return localFilesFromDrop(pluginId, args[0] as string[])
    case 'localFiles.list': return listLocalFiles(pluginId, asObj(args) as { handleId: string; relativePath?: string })
    case 'localFiles.reveal': return revealLocalFile(pluginId, String(args[0] ?? ''))
    case 'localFiles.prepareDrag': return prepareLocalDrag(pluginId, asObj(args).handleIds as string[])
    case 'localFiles.startDrag': return startLocalDrag(pluginId, String(args[0] ?? ''))
    case 'localFiles.endDrag': return endLocalDrag(pluginId)
    case 'ui.setTitle': {
      return pluginHost.setTitle(pluginId, args[0])
    }
    case 'ui.setIcon': {
      return pluginHost.setIcon(pluginId, args[0])
    }
    case 'ui.setBadge': {
      return pluginHost.setBadge(pluginId, args[0])
    }
    case 'state.setDirty': {
      // 插件未保存标记（基础能力）：更新重启前的脏检测与一键保存依赖此上报
      if (typeof args[0] !== 'boolean') throw new Error('setDirty expects a boolean')
      pluginHost.setPluginDirty(pluginId, args[0])
      return true
    }
    case 'ui.resize': {
      const size = args[0] as { width?: number; height?: number } | undefined
      if (!size || typeof size !== 'object') throw new Error('invalid size')
      for (const value of [size.width, size.height]) {
        if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value) || value <= 0)) {
          throw new Error('invalid size')
        }
      }
      pluginHost.resizePlugin(pluginId, size)
      return true
    }
    case 'ui.setHeight': {
      const raw = Number(args[0])
      if (!Number.isFinite(raw) || raw <= 0) throw new Error('invalid height')
      pluginHost.resizePlugin(pluginId, { height: raw })
      return true
    }
    case 'ui.toast': {
      assertInteractive(pluginId)
      const scope = getRuntimeScope(pluginId)
      if (!scope || !scope.isCurrent() || scope.isClosing) throw new Error('plugin runtime unavailable')
      showNotification(pluginHost.getContainerWindow(pluginId), args[0], {
        owner: scope, source: manifest.name, signal: scope.signal
      })
      return true
    }
    case 'settings.register': {
      const section = args[0] as SettingsSectionContribution
      if (!section?.id || !section.title) throw new Error('invalid settings section')
      const items = Array.isArray(section.items) ? section.items.filter(item => isPluginSettingKey(item?.key)) : []
      pluginSettingsBridge.register(pluginId, {
        id: section.id,
        title: section.title,
        schemaVersion: section.schemaVersion,
        items
      })
      // 用已持久化值覆盖 bridge 中的 default，保证重启后 settings.get 读到上次写入
      const persisted = settingsStore.getPluginSettings(pluginId)
      for (const item of items) {
        if (item?.key && item.key in persisted) {
          pluginSettingsBridge.set(pluginId, item.key, persisted[item.key])
        }
      }
      return true
    }
    case 'settings.get': {
      const key = String(args[0] ?? '')
      if (!isPluginSettingKey(key)) throw new Error('reserved plugin settings key')
      // 持久化值优先（壳子/重启后写入），bridge 仅作未落盘时的 default 兜底
      const persisted = settingsStore.getPluginSettings(pluginId)
      if (key in persisted) return persisted[key]
      return pluginSettingsBridge.get(pluginId, key)
    }
    case 'settings.set': {
      const key = String(args[0] ?? '')
      if (!isPluginSettingKey(key)) throw new Error('reserved plugin settings key')
      const value = args[1]
      // key 白名单：必须在该插件注册的 settings item keys 内（运行时 register +
      // manifest contributes.settings 统一入 contributions 表），防止任意键写库
      if (!pluginSettingsBridge.isWritableKey(pluginId, key)) {
        throw new Error(`unknown settings key: ${key}`)
      }
      await settingsStore.setPluginSetting(pluginId, key, value)
      pluginSettingsBridge.set(pluginId, key, value)
      refreshPluginBackgrounds()
      pluginHost.sendEvent(pluginId, { type: 'settings-change', key, value })
      sendShellEvent({ type: 'plugin-settings-changed', pluginId })
      return true
    }
    case 'localFiles.pickSave': return pickLocalSaveFile(pluginId, asObj(args))
    case 'storage.get': {
      const key = String(args[0] ?? '')
      return getPluginStorageValue(pluginId, key)
    }
    case 'storage.set': {
      const key = String(args[0] ?? '')
      setPluginStorageValue(pluginId, key, args[1])
      return true
    }
    case 'storage.remove': {
      const key = String(args[0] ?? '')
      removePluginStorageValue(pluginId, key)
      return true
    }
    case 'storage.clear': {
      clearPluginStorage(pluginId)
      return true
    }
    case 'storage.flush': return flushPluginStorage(pluginId)
    case 'storage.commit': return commitPluginStorage(pluginId, args[0] as PluginStorageOperation[])
    case 'storage.session.get': {
      const key = String(args[0] ?? '')
      return getSessionValue(pluginId, key)
    }
    case 'storage.session.set': {
      const key = String(args[0] ?? '')
      setSessionValue(pluginId, key, args[1])
      return true
    }
    case 'storage.session.remove': {
      const key = String(args[0] ?? '')
      removeSessionValue(pluginId, key)
      return true
    }
    case 'storage.session.clear': {
      clearPluginSession(pluginId)
      return true
    }
    case 'clipboard.readText': {
      return clipboard.readText()
    }
    case 'clipboard.writeText': {
      const txt = String(args[0] ?? '')
      const options = args[1] as { excludeFromHistory?: unknown } | undefined
      if (options !== undefined && (!options || typeof options !== 'object' || Array.isArray(options) || (options.excludeFromHistory !== undefined && typeof options.excludeFromHistory !== 'boolean'))) throw new Error('invalid clipboard write options')
      await writeClipboardText(txt, { excludeFromHistory: options?.excludeFromHistory === true }, getRuntimeScope(pluginId)?.signal)
      return true
    }
    case 'clipboard.readImage': {
      // Electron 44：readImage 移除，经 read() → ClipboardItem(Blob) 重建
      const items = await clipboard.read()
      for (const item of items) {
        const type = item.types.find((t) => t.startsWith('image/'))
        if (!type) continue
        const blob = (await item.getType(type)) as Blob
        const img = nativeImage.createFromBuffer(Buffer.from(await blob.arrayBuffer()))
        if (img.isEmpty()) return null
        const size = img.getSize()
        return { dataUrl: img.toDataURL(), width: size.width, height: size.height }
      }
      return null
    }
    case 'clipboard.writeImage': {
      await writeClipboardImage(String(args[0] ?? ''), getRuntimeScope(pluginId)?.signal)
      return true
    }
    case 'clipboard.writeFiles': await writeClipboardFiles(args[0] as string[], getRuntimeScope(pluginId)?.signal); return true
    case 'screen.capture': {
      const opts = (args[0] ?? {}) as { displayId?: number; bounds?: ScreenBounds }
      return captureScreen(pluginId, opts)
    }
    case 'screen.displays': return listCaptureDisplays(pluginId)
    case 'net.socket.connect': {
      const o = asObj(args)
      const input = (o.host != null ? o : args[0]) as SocketConnectInput
      return socketConnect(pluginId, {
        sessionId: typeof input.sessionId === 'string' ? input.sessionId : undefined,
        host: String(input.host ?? ''),
        port: Number(input.port),
        tls: input.tls === true,
        timeoutMs: input.timeoutMs != null ? Number(input.timeoutMs) : undefined
      })
    }
    case 'net.socket.send': {
      const o = asObj(args)
      const encoding = asObj(args).encoding ?? args[2] ?? 'utf8'
      if (encoding !== 'utf8' && encoding !== 'base64') throw new Error('encoding must be utf8 or base64')
      return socketSend(pluginId, argStr(args, 'socketId', 0), argStr(args, 'data', 1), encoding)
    }
    case 'net.socket.close': {
      return socketClose(pluginId, argStr(args, 'socketId', 0))
    }
    case 'net.socket.list': {
      return socketList(pluginId)
    }
    case 'net.socket.serveWs': {
      return socketServeWs(pluginId, argStr(args, 'socketId', 0))
    }
    case 'fs.rename': {
      const o = asObj(args)
      return renameLocalFile(
        pluginId,
        o.handleId != null ? String(o.handleId) : String(args[0] ?? ''),
        o.newName != null ? String(o.newName) : String(args[1] ?? '')
      )
    }
    case 'fs.renameBatch': {
      const o = asObj(args)
      const items = (o.items ?? args[0]) as Array<{ handleId?: string; newName?: string }>
      return renameLocalFiles(pluginId, {
        items: (Array.isArray(items) ? items : []).map((item) => ({
          handleId: String(item?.handleId ?? ''),
          newName: String(item?.newName ?? '')
        })),
        confirmed: o.confirmed === true
      })
    }
    case 'sys.processes': {
      return sysProcesses()
    }
    case 'sys.ports': {
      return sysPorts()
    }
    case 'sys.kill': {
      const o = asObj(args)
      const pid = o.pid != null ? Number(o.pid) : Number(args[0])
      const signal =
        (o.signal ?? args[1]) === 'KILL' ? 'KILL'
        : (o.signal ?? args[1]) === 'INT' ? 'INT'
        : 'TERM'
      return sysKill(pluginId, pid, signal, o.confirmed === true || args[2] === true)
    }
    case 'net.websocket.connect': return websocketConnect(pluginId, args[0] as { url: string; protocols?: string[] })
    case 'net.websocket.send': return websocketSend(pluginId, String(args[0]), args[1] as string, args[2] as boolean | undefined)
    case 'net.websocket.close': return websocketClose(pluginId, String(args[0]))
    case 'net.fetch': {
      const requestScope = getRuntimeScope(pluginId)
      const assertRequestCurrent = (): void => {
        if (!requestScope?.isCurrent() || requestScope.isClosing || requestScope.signal.aborted) throw new Error('plugin runtime closed')
      }
      assertRequestCurrent()
      const req = (args[0] ?? {}) as {
        url?: string
        method?: string
        headers?: Record<string, string>
        body?: string
        /** 二进制请求体（base64）：优先于 body，解码后原样发送（multipart 等场景） */
        bodyBase64?: string
        /** 鉴权注入：主进程从本插件 vault 解引用后写入请求头，密钥不回到页面 */
        auth?: { secretRef: string; header?: string; scheme?: 'bearer' | 'raw' }
        timeoutMs?: number
        stream?: boolean
      }
      // 明文 http 仅在 manifest 声明 net.allowInsecure 时放行（PluginInstaller 已校验形状）
      const allowInsecure = manifest.net?.allowInsecure === true
      const schemeOk = (u: string): boolean =>
        allowInsecure ? /^https?:\/\//i.test(u) : /^https:\/\//i.test(u)
      const schemeName = allowInsecure ? 'http(s)' : 'https'
      if (req.body !== undefined && (typeof req.body !== 'string' || Buffer.byteLength(req.body) > 8 * 1024 * 1024)) throw new Error('request body exceeds 8 MiB')
      let binaryBody: Uint8Array | undefined
      if (req.bodyBase64 !== undefined) {
        if (typeof req.bodyBase64 !== 'string' || req.bodyBase64.length > 11 * 1024 * 1024) throw new Error('request body exceeds 8 MiB')
        binaryBody = new Uint8Array(Buffer.from(req.bodyBase64, 'base64'))
        if (binaryBody.byteLength > 8 * 1024 * 1024) throw new Error('request body exceeds 8 MiB')
      }
      const requestHeaders: Record<string, string> = { ...(req.headers ?? {}) }
      if (req.auth && typeof req.auth.secretRef === 'string' && req.auth.secretRef) {
        const { resolveSecret } = await import('@main/vault/secretVault')
        const secret = await resolveSecret(pluginId, req.auth.secretRef.slice(0, 512), assertRequestCurrent)
        assertRequestCurrent()
        if (!secret) throw new Error('vault secret not found; re-enter the credential in plugin settings')
        const header = (req.auth.header ?? 'authorization').toLowerCase()
        const scheme = req.auth.scheme ?? 'bearer'
        if (requestHeaders[header] !== undefined) throw new Error('auth header conflicts with explicit header')
        requestHeaders[header] = scheme === 'raw' ? secret : `Bearer ${secret}`
      }
      let url = String(req.url ?? '')
      if (!schemeOk(url)) throw new Error(`only ${schemeName} urls allowed`)
      const method = (req.method ?? 'GET').toUpperCase()
      if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'].includes(method)) {
        throw new Error('only GET/POST/PUT/PATCH/DELETE/HEAD allowed')
      }
      const timeoutMs = Math.min(120_000, Math.max(1_000, req.timeoutMs ?? NET_FETCH_DEFAULT_TIMEOUT))
      const controller = new AbortController()
      assertRequestCurrent()
      const scope = requestScope!
      const abort = () => controller.abort()
      scope.signal.addEventListener('abort', abort, { once: true })
      if ((netFetchCounts.get(scope) ?? 0) >= 8) { scope.signal.removeEventListener('abort', abort); throw new Error('network request limit (8) reached') }
      const releaseNetworkActivity = scope.acquireActivity('network request')
      const releaseNetworkRpc = trackHostRpc(scope)
      netFetchCounts.set(scope, (netFetchCounts.get(scope) ?? 0) + 1)
      let released = false
      const releaseActivity = (): void => { if (released) return; released = true; releaseNetworkActivity(); releaseNetworkRpc(); netFetchCounts.set(scope, Math.max(0, (netFetchCounts.get(scope) ?? 1) - 1)) }
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      const streamMode = req.stream === true
      let detachedStream = false
      const reqId = randomUUID()
      const emitChunk = (chunk: string, done = false, error?: string): void => {
        if (!scope.isCurrent() || scope.signal.aborted) return
        sendPluginEvent(pluginId, {
          type: 'net.chunk',
          reqId,
          chunk,
          ...(done ? { done: true } : {}),
          ...(error !== undefined ? { error } : {})
        })
      }
      try {
        // 有限次手动跟随重定向，每一跳都重新校验协议，阻断 SSRF
        let res: Response | null = null
        for (let hop = 0; hop < 5; hop++) {
          res = await electronNet.fetch(url, {
            method,
            headers: requestHeaders,
            body: method === 'GET' || method === 'HEAD' ? undefined : (binaryBody ?? req.body),
            signal: controller.signal,
            redirect: 'manual'
          })
          if (res.status >= 300 && res.status < 400) {
            await res.body?.cancel()
            const loc = res.headers.get('location')
            if (!loc) throw new Error('redirect without location')
            url = new URL(loc, url).href
            if (!schemeOk(url)) throw new Error(`only ${schemeName} urls allowed`)
            continue
          }
          break
        }
        if (!res) throw new Error('net.fetch failed')
        const headers: Record<string, string> = {}
        res.headers.forEach((v, k) => {
          headers[k] = v
        })
        const contentType = (headers['content-type'] ?? '').toLowerCase()
        const isSse = streamMode && contentType.includes('text/event-stream')
        // HEAD / 204/304 无响应体，直接返回
        if (method === 'HEAD' || res.status === 204 || res.status === 304) {
          return { status: res.status, headers, body: '', streamed: false, reqId }
        }
        const reader = res.body?.getReader()
        if (!reader) return { status: res.status, headers, body: '', streamed: false, reqId }
        const declared = Number(headers['content-length'] ?? '0')
        const declaredMax = streamMode ? NET_FETCH_STREAM_MAX_BODY : NET_FETCH_MAX_BODY
        if (declared > declaredMax) {
          await reader.cancel()
          throw new Error('response body too large')
        }
        // 流式模式：立即返回元信息；>2MB 的响应体经 net.chunk 分片（base64），上限 32MB
        if (streamMode) {
          detachedStream = true
          void consumeFetchStream(reader, isSse, chunk => emitChunk(chunk)).then(
            () => emitChunk('', true),
            error => emitChunk('', true, (error as Error).message)
          ).finally(() => {
            clearTimeout(timer)
            scope.signal.removeEventListener('abort', abort)
            releaseActivity()
          })
          return { status: res.status, headers, body: '', streamed: true, reqId }
        }
        // 非流式：一次性读回（2MB 上限，向后兼容旧返回形状）
        const chunks: Uint8Array[] = []
        let bytes = 0
        try {
          while (true) {
            const result = await reader.read()
            if (result.done) break
            bytes += result.value.byteLength
            if (bytes > NET_FETCH_MAX_BODY) { await reader.cancel(); throw new Error('response body too large') }
            chunks.push(result.value)
          }
        } finally { reader.releaseLock() }
        const buf = Buffer.concat(chunks)
        return { status: res.status, headers, body: buf.toString('utf-8'), streamed: false, reqId }
      } catch (err) {
        const msg = (err as Error).name === 'AbortError' ? 'net.fetch timeout' : (err as Error).message
        throw new Error(msg)
      } finally {
        // 流式模式的释放在其内部 async 完成时执行；此处只清非流式路径
        if (!detachedStream) {
          clearTimeout(timer)
          scope.signal.removeEventListener('abort', abort)
          releaseActivity()
        }
      }
    }
    case 'shell.openExternal': {
      const url = String(args[0] ?? '')
      await openExternalWithPermission(pluginId, manifest, url)
      return true
    }
    case 'notify': {
      assertInteractive(pluginId)
      const payload = (args[0] ?? {}) as { title?: string; body?: string }
      new Notification({
        title: payload.title ?? APP_NAME,
        body: payload.body ?? ''
      })
        // darwin 通知失败（典型：未授权/勿扰）无状态查询 API，仅记录引导日志
        .on('failed', (_e, reason) => {
          logWarn('notify', `notification failed (${reason}); check OS notification permission`)
        })
        .show()
      return true
    }
    case 'theme.register': {
      const pack = args[0] as ThemePack
      // 来源强制绑定当前插件 id，防伪造他人/内置来源（覆盖保护在 registry 内做）
      const saved = await themePackRegistry.registerPluginWithStatus(pack, pluginId)
      if (saved.changed) sendShellEvent({ type: 'theme-packs-changed' })
      return saved.pack
    }
    case 'theme.getTokens': {
      // 按插件 manifest.ui.preferredColorScheme 解析最终 Token
      const manifest = pluginRegistry.getManifest(pluginId)
      const ui = resolvePluginUi(manifest?.ui)
      return resolveThemeTokens(ui.preferredColorScheme)
    }
    case 'theme.getAppearance': {
      const manifest = pluginRegistry.getManifest(pluginId)
      const ui = resolvePluginUi(manifest?.ui)
      return appearanceService.getAppearance(ui.preferredColorScheme === 'light' || ui.preferredColorScheme === 'dark' ? ui.preferredColorScheme : 'auto')
    }
    case 'hotkey.register': {
      return registerRuntimeHotkey(pluginId, String(args[0] ?? ''), (acc) => {
        sendPluginEvent(pluginId, { type: 'hotkey', accelerator: acc })
      })
    }
    case 'hotkey.unregister': {
      return unregisterRuntimeHotkey(pluginId, String(args[0] ?? ''))
    }
    case 'contribute.registerQuickProvider': {
      const meta = (args[0] ?? {}) as { id?: string; explain?: string; schemaVersion?: string }
      if (typeof meta.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(meta.id)
        || meta.explain !== undefined && (typeof meta.explain !== 'string' || meta.explain.length > 512)) throw new Error('Invalid Quick provider metadata')
      const providers = contributionRegistry.getQuickProviders()
      if (!providers.some(item => item.pluginId === pluginId && item.id === meta.id)
        && (providers.length >= 64 || providers.filter(item => item.pluginId === pluginId).length >= 8)) throw new Error('Quick provider registration budget exceeded')
      const result = contributionRegistry.registerQuickProvider(pluginId, {
        id: String(meta?.id ?? ''),
        explain: typeof meta?.explain === 'string' ? meta.explain : undefined,
        schemaVersion: meta?.schemaVersion
      })
      if (result.ok) {
        logInfo('contrib', `quick provider registered: ${pluginId}:${String(meta?.id)}`)
      }
      return result
    }
    case 'contribute.unregisterQuickProvider': {
      return contributionRegistry.unregisterQuickProvider(pluginId, String(args[0] ?? ''))
    }
    case 'contribute.respondQuickQuery': {
      // quick-query 回传：reqId 命中 pending 才生效，未知 reqId 静默丢弃
      resolveQuickQuery(pluginId, String(args[0] ?? ''), args[1])
      return true
    }
    case 'i18n.getLocale': {
      const locale = settingsStore.getAll().general.locale
      return locale === 'en-US' ? 'en-US' : 'zh-CN'
    }
    // —— vault ——
    case 'vault.set': {
      const key = String(args[0] ?? '')
      const secret = args[1]
      const scope = getRuntimeScope(pluginId)
      return vaultSet(pluginId, key, String(secret ?? ''), () => {
        if (!scope?.isCurrent() || scope.isClosing || scope.signal.aborted) throw new Error('plugin runtime is closing or stale')
      })
    }
    case 'vault.has': {
      return vaultHas(pluginId, String(args[0] ?? ''))
    }
    case 'vault.remove': {
      return vaultRemove(pluginId, String(args[0] ?? ''))
    }
    default:
      throw new Error(`unknown method: ${method}`)
  }
}

/**
 * 注册 plugin:call IPC 处理器：校验 sender 身份、pluginId 匹配与权限后分发；
 * 另注册 plugin:lifecycle-ack，供插件确认 beforeClose（可选，Host 侧 1500ms 超时兜底）。
 */
export function registerPluginHandlers(): void {
  bindPluginTools()
  // storage.local 底座：建表 + 一次性迁移旧 plugin-storage/*.json（幂等）
  initPluginStorage()
  registerPluginActivationHandlers()
  ipcMain.handle(IpcChannels.PluginHomeRegister, async (event, contribution: unknown) => {
    const senderId = event.sender.id
    const source = pluginHost.getPluginIdByWebContentsId(senderId)
    if (!source || event.sender.isDestroyed() || event.senderFrame !== event.sender.mainFrame || !isPluginPageUrl(event.senderFrame.url, source, pluginRegistry.get(source)?.devUrl)) {
      return { ok: false, error: 'unauthorized sender' }
    }
    const scope = getRuntimeScope(source)
    const allowed = (): boolean => scope?.owner.wcId === senderId && scope.isCurrent() && !scope.isClosing && !event.sender.isDestroyed()
    if (!allowed()) return { ok: false, error: 'plugin runtime is closing or stale' }
    if (isIndexSyncActivation(scope!)) return { ok: false, error: 'Index synchronization may only read local plugin data' }
    try {
      const result = await registerDeclaredHomeContribution(source, contribution)
      return allowed() ? result : { ok: false, error: 'plugin runtime is closing or stale' }
    } catch (error) {
      logWarn('home', `registration failed for ${source}: ${(error as Error).message}`)
      return { ok: false, error: 'home registration failed' }
    }
  })
  ipcMain.handle(
    IpcChannels.PluginCall,
    async (event, request: PluginCallRequest): Promise<PluginCallResult> => {
      try {
        const senderId = event.sender.id
        // 仅允许 PluginHost 管理的 WebContents 发起调用
        const hostPluginId = pluginHost.getPluginIdByWebContentsId(senderId)
        if (!hostPluginId || event.senderFrame !== event.sender.mainFrame || !isPluginPageUrl(event.senderFrame.url, hostPluginId, pluginRegistry.get(hostPluginId)?.devUrl)) {
          return { ok: false, error: 'unauthorized sender' }
        }
        if (!request || typeof request !== 'object' || typeof request.method !== 'string' || (request.args !== undefined && !Array.isArray(request.args))) return { ok: false, error: 'invalid plugin request' }
        // 防止插件伪造其他插件身份发起调用
        if (request.pluginId && request.pluginId !== hostPluginId) {
          return { ok: false, error: 'plugin id mismatch' }
        }
        const manifest: PluginManifest | null = pluginHost.getManifestForWebContents(senderId)
        if (!manifest) {
          return { ok: false, error: 'manifest not found' }
        }
        if (!request || typeof request !== 'object' || typeof request.method !== 'string' || (request.args !== undefined && !Array.isArray(request.args))) return { ok: false, error: 'invalid plugin request' }
        const { method, args = [] } = request
        const scope = getRuntimeScope(hostPluginId)
        if (scope && isIndexSyncActivation(scope) && !['storage.get', 'storage.session.get', 'settings.get', 'theme.getTokens', 'theme.getAppearance',
          'i18n.getLocale', 'contribute.launchIndexState', 'runtime.release'].includes(method)) return { ok: false, error: 'Index synchronization may only read local plugin data' }
        const allowed = () => scope?.owner.wcId === senderId && scope.isCurrent() && (!scope.isClosing || CLOSE_SAFE.test(method))
        if (!allowed()) return { ok: false, error: 'plugin runtime is closing or stale' }
        return await runHostRpc(scope!, async (): Promise<PluginCallResult> => {
          // 权限为 null 表示该方法无需 manifest 声明（settings 由 Bridge 管控）
          const required = method === 'localFiles.pick' && asObj(args).access === 'write' ? 'fs.write'
            : method === 'auxiliary.open' && asObj(args).capture ? 'screen.record'
            : method === 'auxiliary.open' && asObj(args).alwaysOnTop === true ? 'pin.create' : METHOD_PERMISSION[method]
          if (required === undefined) {
            return { ok: false, error: `unknown method: ${method}` }
          }
          if (required) {
            // 基础能力无需声明；敏感能力必须声明（错误文案为插件兼容契约）。
            assertPermission(manifest, required)
            // 基础能力免弹窗；敏感能力按壳层 grant 三态授权。
            const granted = await ensureRuntimeGrant(
              hostPluginId,
              required,
              `调用宿主 API：${method}`
            )
            if (!granted) {
              return { ok: false, error: `permission denied: ${required}` }
            }
            // OS 层（darwin 屏幕授权）：grant 放行后在执行前检查，避免黑屏/空帧
            if (required === 'screen.capture' || required === 'screen.record') {
              assertScreenCaptureAllowed(hostPluginId)
            }
          }
          if (!allowed()) return { ok: false, error: 'plugin runtime is closing or stale' }
          const startedAt = Date.now()
          try {
            const data = await dispatch(hostPluginId, method, args, manifest)
            recordPluginCall({
              ts: startedAt,
              pluginId: hostPluginId,
              method,
              ok: true,
              durationMs: Date.now() - startedAt
            })
          return { ok: true, data }
        } catch (err) {
          const error = (err as Error).message
          recordPluginCall({
            ts: startedAt,
            pluginId: hostPluginId,
            method,
            ok: false,
            durationMs: Date.now() - startedAt,
            error
          })
          return { ok: false, error, errorCode: interactionErrorCode(err) }
        }
        })
      } catch (err) {
        return { ok: false, error: (err as Error).message, errorCode: interactionErrorCode(err) }
      }
    }
  )

  // beforeClose / beforeSuspend / save-requested share owner- and operation-bound acknowledgements.
  ipcMain.on(
    IpcChannels.PluginLifecycleAck,
    (event, payload?: { event?: string; operationId?: string; success?: boolean }) => {
      const hostPluginId = pluginHost.getPluginIdByWebContentsId(event.sender.id)
      if (!hostPluginId || event.senderFrame !== event.sender.mainFrame || !isPluginPageUrl(event.senderFrame.url, hostPluginId, pluginRegistry.get(hostPluginId)?.devUrl)) return
      if (payload?.event === 'beforeClose' || payload?.event === 'beforeSuspend' || payload?.event === 'save-requested') {
        pluginHost.ackBeforeClose(hostPluginId, event.sender.id, payload.operationId, payload.success !== false)
      }
    }
  )

  // —— 运行时权限：壳渲染层专用通道（sender 必须是壳窗口 webContents）——

  /** 保留旧 IPC 兼容；渲染层响应始终拒绝，只有原生授权窗口能作出决策。 */
  handleShellIpc(
    IpcChannels.PermissionResponse,
    (event, payload: PermissionResponsePayload): { ok: boolean; error?: string } => {
      if (event.sender !== getShellWebContents()) {
        return { ok: false, error: 'unauthorized sender' }
      }
      const requestId = String(payload?.requestId ?? '')
      const decision = payload?.decision
      if (
        (decision !== 'once' && decision !== 'always' && decision !== 'deny') ||
        !permissionService.resolveRequest(requestId, decision)
      ) {
        return { ok: false, error: 'invalid permission response' }
      }
      return { ok: true }
    }
  )

  /** 读插件授权表（设置页权限管理块初始值） */
  handleShellIpc(
    IpcChannels.PermissionGrantsGet,
    (event, pluginId: string): { ok: boolean; data?: unknown; error?: string } => {
      if (event.sender !== getShellWebContents()) {
        return { ok: false, error: 'unauthorized sender' }
      }
      const id = String(pluginId ?? '')
      if (!id) return { ok: false, error: 'plugin id required' }
      return { ok: true, data: settingsStore.getPermissionGrants(id) }
    }
  )

  /** 写单项授权（三态分段切换） */
  handleShellIpc(
    IpcChannels.PermissionGrantsSet,
    async (
      event,
      payload: PermissionGrantSetPayload
    ): Promise<{ ok: boolean; error?: string }> => {
      if (event.sender !== getShellWebContents()) {
        return { ok: false, error: 'unauthorized sender' }
      }
      const id = String(payload?.pluginId ?? '')
      if (!id) return { ok: false, error: 'plugin id required' }
      if (!PLUGIN_PERMISSIONS.includes(payload.permission)) return { ok: false, error: 'invalid permission' }
      if (isBuiltinCapability(payload.permission)) return { ok: false, error: 'built-in capabilities do not require user consent' }
      await settingsStore.setPermissionGrant(
        id,
        payload.permission,
        normalizeGrant(payload.grant)
      )
      if (normalizeGrant(payload.grant) !== 'allow') {
        stopPluginBackground(id, 'permission revoked')
        if (payload.permission === 'screen.record') revokeAuxiliaryCapture(id)
        if (payload.permission === 'pin.create') revokeAuxiliaryTopmost(id)
      }
      refreshPluginBackgrounds()
      if (normalizeGrant(payload.grant) !== 'allow') {
        permissionService.cancelFor(id)
        getRuntimeScope(id)?.markClosing()
        await pluginHost.closePlugin(id, 'tab-close')
      }
      return { ok: true }
    }
  )

  /** 打开 macOS 屏幕录制系统设置（权限弹窗引导；只读安全） */
  handleShellIpc(IpcChannels.OsOpenScreenSettings, (event): { ok: boolean } => {
    if (event.sender !== getShellWebContents()) {
      return { ok: false }
    }
    openScreenCaptureSettings()
    return { ok: true }
  })
}
