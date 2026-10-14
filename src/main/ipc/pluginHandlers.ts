import { consumeFetchStream } from '@main/net/fetchStream'
import { websocketConnect, websocketSend, websocketClose } from '@main/net/websocketService'
import { handleShellIpc } from '@main/ipc/ipcSecurity'
import { isPluginPageUrl } from '@main/plugin/pluginSessionPolicy'
import { PLUGIN_PERMISSIONS } from '@shared/types/plugin'
import { isBuiltinCapability } from '@shared/pluginPermissionPolicy'
import { isPluginSettingKey } from '@shared/pluginSettingsKeys'
import { revalidateClipboardPolling } from '@main/clipboard/clipboardHistory'
/**
 * pluginHandlers — 插件 IPC 调用分发器
 * 职责：接收插件 preload 发起的 `plugin:call`，校验发送者身份与权限，按 method 分发到具体实现；
 *       转发 `plugin:lifecycle-ack`（beforeClose 确认）到 PluginHost。
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
  ThemePack
} from '@shared/types/plugin'
import { resolvePluginUi } from '@shared/types/plugin'
import {
  clearPluginStorage,
  getPluginStorageValue,
  initPluginStorage,
  removePluginStorageValue,
  setPluginStorageValue
} from '@main/db/pluginStorage'
import { assertPermission, confirmPluginOperation } from '@main/plugin/PluginPermissions'
import { pluginHost } from '@main/plugin/PluginHost'
import { acquireQuickInteraction } from '@main/window/createQuickWindow'
import { pickLocalFiles, readLocalFile, localFilesFromDrop, listLocalFiles, revealLocalFile, prepareLocalDrag, startLocalDrag, endLocalDrag } from '@main/plugin/localFiles'
import type { LocalFilePickOptions, PluginInputContext } from '@shared/types/local-files'
import { sshWorkbench, sshWorkbenchPermission } from '@main/ssh/sshWorkbench'
import type { SshWorkbenchRequest } from '@shared/types/ssh-workbench'
import { dbWorkbenchCall, dbWorkbenchPermission } from '@main/database/workbench'
import type { DbWorkbenchRequest } from '@shared/types/db-workbench'
import {
  socketClose,
  socketConnect,
  socketList,
  socketSend,
  socketServeWs,
  type SocketConnectInput
} from '@main/net/socketBridge'
import {
  lanShareStart,
  lanShareStatus,
  lanShareStop,
  lanShareList
} from '@main/net/lanShareService'
import { renameLocalFile, renameLocalFiles, resolveLocalFileHandle, pickLocalSaveFile } from '@main/plugin/localFiles'
import { agentApps, agentRead, agentWrite, agentBackups, agentRestore, agentSessionsList, agentSessionsRead } from '@main/config/agentConfigService'
import { sysProcesses, sysPorts, sysKill } from '@main/sys/sysInspectService'
import { mwWorkbenchCall, mwWorkbenchPermission } from '@main/middleware/workbench'
import type { MwWorkbenchRequest } from '@shared/types/mw-workbench'
import { dshWorkbenchCall, dshWorkbenchPermission } from '@main/dsh/workbench'
import type { DshWorkbenchRequest } from '@shared/types/dsh-workbench'
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
  openScreenCaptureSettings
} from '@main/plugin/OsPermissionChecks'
import { registerRuntimeHotkey, unregisterRuntimeHotkey } from '@main/hotkey/pluginRuntimeHotkeys'
import { logInfo, logWarn } from '@main/logs/logService'
import { resolveThemeTokens } from '@main/theme/resolveThemeCss'
import { pluginSettingsBridge } from '@main/settings/PluginSettingsBridge'
import { settingsStore } from '@main/settings/SettingsStore'
import { themePackRegistry } from '@main/theme/themePacks'
import { contributionRegistry } from '@main/contrib/ContributionRegistry'
import { resolveQuickQuery } from '@main/launcher/quickProviders'
import {
  getShellWebContents,
  sendShellEvent
} from '@main/window/createShellWindow'
import {
  cancelRecording,
  captureScreen,
  selectRegion,
  startRecording,
  stopRecording
} from '@main/screen/screenService'
import { closeAllPins, closePin, listPins, openPin } from '@main/pin/pinService'
import {
  clearHistory,
  getHistoryEntry,
  listHistory,
  noteExternalImage,
  noteExternalText,
  removeHistoryEntry,
  togglePinHistoryEntry
} from '@main/clipboard/clipboardHistory'
import { vaultSet, vaultHas, vaultRemove } from '@main/vault/secretVault'
import {
  sshConnect,
  sshWrite,
  sshResize,
  sshDisconnect,
  sshListSessions,
  sshExec,
  sshMetricsStart,
  sshMetricsStop,
  sshMetricsLatest,
  sshCompletionSuggest,
  sshSftpList,
  sshSftpDownload,
  sshSftpUpload,
  sshSftpMkdir,
  sshSftpRename,
  sshSftpDelete,
  sshSftpChmod,
  sshPickLocalFile
} from '@main/ssh/sshSessionManager'
import {
  dbTest,
  dbOpen,
  dbClose,
  dbListSessions,
  dbPickSqliteFile,
  dbPickImportFile,
  dbExecute,
  dbExplain,
  dbCancel,
  dbApplyChanges,
  dbSchemaTree,
  dbSchemaDescribe,
  dbSchemaDdl,
  dbCompletion,
  dbDialectsList,
  dbImportPreview,
  dbImportRun
} from '@main/database/dbSessionManager'
import type {
  DbApplyChangesInput,
  DbCompletionInput,
  DbConnectionConfig,
  DbExecuteInput,
  DbImportPreviewInput,
  DbImportRunInput,
  DbSchemaTreeInput,
  SshConnectInput,
  SshExecInput,
  SftpDownloadInput,
  SftpListInput,
  SftpUploadInput
} from '@shared/types/ssh-db'

/** method → 所需权限映射；null 表示无需权限（settings.get/set 由 Bridge 管控 key 白名单） */
const runtimeLeases = new Map<string, { release: () => void; unregister: () => void; pluginId: string }>()
const CLOSE_SAFE = /^(storage\.|screen\.record\.(stop|cancel)$|pin\.close|runtime\.release$|ssh\.(disconnect|unwatch)|db\.(disconnect|cancel)|net\.socket\.close$|lan\.share\.stop$)/

const METHOD_PERMISSION: Record<string, PluginPermission | null> = {
  ...PLUGIN_TOOL_PERMISSIONS,
  'runtime.acquire': null,
  'runtime.release': null,
  'ui.setTitle': 'ui.setTitle',
  'ui.setIcon': 'ui.setIcon',
  'ui.setBadge': 'ui.setBadge',
  'ui.resize': 'ui.resize',
  'ui.setHeight': 'ui.resize',
  'ui.openInShell': null,
  'ui.setInputContext': null,
  'ui.focus': null,
  'ui.focusSearch': null,
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
  // 会话态存储：权限复用 storage.local（弱于持久化，无需单独声明）
  'storage.session.get': 'storage.local',
  'storage.session.set': 'storage.local',
  'storage.session.remove': 'storage.local',
  'storage.session.clear': 'storage.local',
  'clipboard.readText': 'clipboard.read',
  'clipboard.writeText': 'clipboard.write',
  'clipboard.readImage': 'clipboard.readImage',
  'clipboard.writeImage': 'clipboard.writeImage',
  'clipboard.history.list': 'clipboard.history',
  'clipboard.history.get': 'clipboard.history',
  'clipboard.history.remove': 'clipboard.history',
  'clipboard.history.clear': 'clipboard.history',
  'clipboard.history.togglePin': 'clipboard.history',
  'screen.capture': 'screen.capture',
  'screen.selectRegion': 'screen.capture',
  'screen.record.start': 'screen.record',
  'screen.record.stop': 'screen.record',
  'screen.record.cancel': 'screen.record',
  'pin.open': 'pin.create',
  'pin.close': 'pin.create',
  'pin.closeAll': 'pin.create',
  'pin.list': 'pin.create',
  'net.fetch': 'net.fetch',
  'shell.openExternal': 'shell.openExternal',
  notify: 'notify',
  'theme.register': 'theme',
  // 主题 Token 读取：所有插件可用（无需权限声明），用于主题感知绘制
  'theme.getTokens': null,
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
  // —— vault / ssh / db（Spec ssh-db-plugins 权限表）——
  'vault.set': 'vault.write',
  'vault.has': 'vault.write',
  'vault.remove': 'vault.write',
  'ssh.connect': 'ssh.session',
  'ssh.write': 'ssh.session',
  'ssh.resize': 'ssh.session',
  'ssh.disconnect': 'ssh.session',
  'ssh.listSessions': 'ssh.session',
  'ssh.exec': 'ssh.exec',
  'ssh.metrics.start': 'ssh.exec',
  'ssh.metrics.stop': 'ssh.exec',
  'ssh.metrics.latest': 'ssh.exec',
  'ssh.completion.suggest': 'ssh.exec',
  'ssh.sftp.list': 'ssh.sftp',
  'ssh.sftp.download': 'ssh.sftp',
  'ssh.sftp.upload': 'ssh.sftp',
  'ssh.sftp.mkdir': 'ssh.sftp',
  'ssh.sftp.rename': 'ssh.sftp',
  'ssh.sftp.delete': 'ssh.sftp',
  'ssh.sftp.chmod': 'ssh.sftp',
  'ssh.pickLocalFile': 'fs.read',
  'db.test': 'db.connect',
  'db.open': 'db.connect',
  'db.close': 'db.connect',
  'db.listSessions': 'db.connect',
  'db.pickSqliteFile': 'db.connect',
  'db.execute': 'db.query',
  'db.explain': 'db.query',
  'db.cancel': 'db.query',
  'db.applyChanges': 'db.query',
  'db.importPreview': 'db.query',
  'db.importRun': 'db.query',
  'db.schema.tree': 'db.schema',
  'db.schema.describe': 'db.schema',
  'db.schema.ddl': 'db.schema',
  'db.completion.suggest': 'db.schema',
  'db.dialects.list': 'db.schema',
  'db.pickImportFile': 'fs.read',
  // mw.workbench 权限按 action 动态判 mw.connect/mw.query/mw.admin（见下方 required 解析）
  'mw.workbench': 'mw.admin',
  // dsh.workbench 权限按 action 动态判 dsh.connect/dsh.chat/dsh.admin（见下方 required 解析）
  'dsh.workbench': 'dsh.admin',
  // —— net.socket / config.agent / sys.inspect（波 0 宿主能力扩展）——
  'net.websocket.connect': 'net.socket',
  'net.websocket.send': 'net.socket',
  'net.websocket.close': 'net.socket',
  'net.socket.connect': 'net.socket',
  'net.socket.send': 'net.socket',
  'net.socket.close': 'net.socket',
  'net.socket.list': 'net.socket',
  'net.socket.serveWs': 'net.socket',
  // —— lan.share / fs.rename（局域网传件 + 句柄白名单改名）——
  'lan.share.start': 'lan.share',
  'lan.share.status': 'lan.share',
  'lan.share.list': 'lan.share',
  'lan.share.stop': 'lan.share',
  'fs.rename': 'fs.rename',
  'fs.renameBatch': 'fs.rename',
  'agent.apps': 'config.agent.read',
  'agent.read': 'config.agent.read',
  'agent.write': 'config.agent.write',
  'agent.backups': 'config.agent.read',
  'agent.restore': 'config.agent.write',
  'agent.sessions.list': 'config.agent.read',
  'agent.sessions.read': 'config.agent.read',
  'sys.processes': 'sys.inspect',
  'sys.ports': 'sys.inspect',
  'sys.kill': 'sys.control',
  // 导出落盘：复用 shell.openExternal 权限（两插件均已声明）
  'shell.saveTextFile': 'fs.write'
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
  if (grant === 'deny') return false
  const osHint =
    perm === 'screen.capture' || perm === 'screen.record'
      ? checkScreenCapture().hint
      : undefined
  return permissionService.request(pluginId, perm, summary, osHint)
}

function argStr(args: unknown[], objKey: string, pos: number): string {
  const o = asObj(args)
  if (o[objKey] != null) return String(o[objKey])
  return String(args[pos] ?? '')
}

function argNum(args: unknown[], objKey: string, pos: number, fallback: number): number {
  const o = asObj(args)
  if (o[objKey] != null && o[objKey] !== '') return Number(o[objKey])
  const v = args[pos]
  return v == null || v === '' ? fallback : Number(v)
}

/** 该插件已注册的 settings item key 集合（运行时 register 与 manifest 声明统一入 contributions 表） */
function registeredSettingKeys(pluginId: string): Set<string> {
  const keys = new Set<string>()
  for (const section of pluginSettingsBridge.listAll()) {
    if (section.pluginId !== pluginId) continue
    for (const item of section.items ?? []) {
      if (item?.key) keys.add(item.key)
    }
  }
  return keys
}

/** 按 method 分发到具体实现，权限已在调用前校验 */
async function dispatch(
  pluginId: string,
  method: string,
  args: unknown[],
  manifest: PluginManifest
): Promise<unknown> {
  if (method in PLUGIN_TOOL_PERMISSIONS) {
    if (method === 'clipboard.history.copy' || method === 'clipboard.history.paste') {
      const scope = getRuntimeScope(pluginId)
      const permissions: PluginPermission[] = ['clipboard.history']
      const entry = await getHistoryEntry(String(args[0] ?? ''))
      if (!entry) throw new Error('该记录已删除')
      permissions.push(entry.type === 'image' ? 'clipboard.writeImage' : 'clipboard.write')
      for (const permission of permissions) {
        assertPermission(manifest, permission)
        if (!(await ensureRuntimeGrant(pluginId, permission, '复制剪贴板历史内容'))) throw new Error(`permission denied: ${permission}`)
      }
      if (!scope?.isCurrent() || scope.isClosing) throw new Error('plugin runtime is closing or stale')
    }
    if (method === 'focusTimer.start' && asObj(args).notify !== false) {
      const scope = getRuntimeScope(pluginId)
      const allowed = manifest.permissions?.includes('notify') && await ensureRuntimeGrant(pluginId, 'notify', '专注计时到期提醒')
      // The optional grant may settle after close (or after a replacement opened).
      // Persistent host tasks must only be created by the original live owner.
      if (!scope?.isCurrent() || scope.isClosing || scope.signal.aborted) throw new Error('plugin runtime is closing')
      args = [{ ...asObj(args), notify: Boolean(allowed) }]
    }
    return dispatchPluginTool(pluginId, method, args)
  }
  switch (method) {
    case 'runtime.acquire': {
      const scope = getRuntimeScope(pluginId)
      if (!scope || scope.isClosing) throw new Error('plugin runtime unavailable')
      const token = randomUUID()
      const release = scope.acquireActivity(String(args[0] ?? 'plugin task'))
      const unregister = scope.addDisposer(() => { release(); runtimeLeases.delete(token) })
      runtimeLeases.set(token, { release, unregister, pluginId })
      return token
    }
    case 'runtime.release': {
      const token = String(args[0] ?? '')
      const lease = runtimeLeases.get(token)
      if (lease?.pluginId === pluginId) { lease.release(); lease.unregister(); runtimeLeases.delete(token) }
      return true
    }

    case 'ui.openInShell':
      pluginHost.pinToShell(pluginId)
      return true
    case 'ui.setInputContext':
      pluginHost.setInputContext(pluginId, args[0] as PluginInputContext)
      return true
    case 'ui.focus':
      return pluginHost.focusPlugin(pluginId)
    case 'ui.focusSearch':
      return pluginHost.focusSearch(pluginId)
    case 'localFiles.read': return readLocalFile(pluginId, asObj(args) as { handleId: string; encoding?: 'text' | 'dataUrl'; maxBytes?: number })
    case 'localFiles.pick': return pickLocalFiles(pluginId, asObj(args) as LocalFilePickOptions)
    case 'localFiles.fromDrop': return localFilesFromDrop(pluginId, args[0] as string[])
    case 'localFiles.list': return listLocalFiles(pluginId, asObj(args) as { handleId: string; relativePath?: string })
    case 'localFiles.reveal': return revealLocalFile(pluginId, String(args[0] ?? ''))
    case 'localFiles.prepareDrag': return prepareLocalDrag(pluginId, asObj(args).handleIds as string[])
    case 'localFiles.startDrag': return startLocalDrag(pluginId, String(args[0] ?? ''))
    case 'localFiles.endDrag': return endLocalDrag(pluginId)
    case 'ssh.workbench': return sshWorkbench(pluginId, args[0] as SshWorkbenchRequest)
    case 'db.workbench': return dbWorkbenchCall(pluginId, args[0] as DbWorkbenchRequest)
    case 'mw.workbench': return mwWorkbenchCall(pluginId, args[0] as MwWorkbenchRequest)
    case 'dsh.workbench': return dshWorkbenchCall(pluginId, args[0] as DshWorkbenchRequest)
    case 'ui.setTitle': {
      return pluginHost.setTitle(pluginId, args[0])
    }
    case 'ui.setIcon': {
      return pluginHost.setIcon(pluginId, args[0])
    }
    case 'ui.setBadge': {
      return pluginHost.setBadge(pluginId, args[0])
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
      const payload = (args[0] ?? {}) as { message?: string; type?: string }
      const message = String(payload.message ?? '')
      if (!message) throw new Error('toast message required')
      const toastType = payload.type
      sendShellEvent({
        type: 'plugin-toast',
        pluginId,
        message,
        toastType:
          toastType === 'success' || toastType === 'warn' || toastType === 'error'
            ? toastType
            : 'info'
      })
      return true
    }
    case 'settings.register': {
      const section = args[0] as {
        id: string
        title: string
        items: Array<{
          key: string
          type: string
          label: string
          default?: unknown
        }>
      }
      if (!section?.id || !section.title) throw new Error('invalid settings section')
      const items = Array.isArray(section.items) ? section.items.filter(item => isPluginSettingKey(item?.key)) : []
      pluginSettingsBridge.register(pluginId, {
        id: section.id,
        title: section.title,
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
      if (!registeredSettingKeys(pluginId).has(key)) {
        throw new Error(`unknown settings key: ${key}`)
      }
      pluginSettingsBridge.set(pluginId, key, value)
      await settingsStore.setPluginSetting(pluginId, key, value)
      pluginHost.sendEvent(pluginId, { type: 'settings-change', key, value })
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
      await clipboard.writeText(txt)
      noteExternalText(txt)
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
      const dataUrl = String(args[0] ?? '')
      if (!/^data:image\//i.test(dataUrl)) throw new Error('invalid image dataUrl')
      const img = nativeImage.createFromDataURL(dataUrl)
      if (img.isEmpty()) throw new Error('invalid image data')
      // Electron 44：writeImage 移除，经 write([ClipboardItem])（Blob）写图
      const blob = new Blob([new Uint8Array(img.toPNG())], { type: 'image/png' })
      await clipboard.write([new Electron.ClipboardItem({ 'image/png': blob })])
      noteExternalImage(img)
      return true
    }
    case 'clipboard.history.list': {
      const opts = (args[0] ?? {}) as { limit?: number }
      return listHistory(opts?.limit ?? 100)
    }
    case 'clipboard.history.get': {
      return getHistoryEntry(String(args[0] ?? ''))
    }
    case 'clipboard.history.remove': {
      return removeHistoryEntry(String(args[0] ?? ''))
    }
    case 'clipboard.history.clear': {
      return clearHistory()
    }
    case 'clipboard.history.togglePin': {
      return togglePinHistoryEntry(String(args[0] ?? ''))
    }
    case 'screen.capture': {
      const opts = (args[0] ?? {}) as { displayId?: number; bounds?: ScreenBounds }
      return captureScreen(opts)
    }
    case 'screen.selectRegion': {
      return selectRegion(pluginId)
    }
    case 'screen.record.start': {
      const opts = (args[0] ?? {}) as {
        bounds?: ScreenBounds
        withAudio?: boolean
        displayId?: number
      }
      return startRecording(pluginId, opts)
    }
    case 'screen.record.stop': {
      return stopRecording(pluginId, String(args[0] ?? ''))
    }
    case 'screen.record.cancel': {
      return cancelRecording(pluginId, String(args[0] ?? ''))
    }
    case 'pin.open': {
      const payload = (args[0] ?? {}) as {
        dataUrl?: string
        path?: string
        x?: number
        y?: number
        width?: number
        title?: string
      }
      return openPin({ ...payload, pluginId })
    }
    case 'pin.close': {
      return closePin(String(args[0] ?? ''), pluginId)
    }
    case 'pin.closeAll': {
      return closeAllPins(pluginId)
    }
    case 'pin.list': {
      return listPins(pluginId)
    }
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
      return socketSend(pluginId, argStr(args, 'socketId', 0), argStr(args, 'data', 1))
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
    case 'lan.share.start': {
      const o = asObj(args)
      // files 支持两种形态：{handleId}（localFiles 句柄，宿主侧解析真实路径）
      // 与 {path}（已有绝对路径，如 db 导出）；句柄解析失败给友好错误
      const rawFiles = Array.isArray(o.files) ? (o.files as Array<{ handleId?: string; path?: string; name?: string }>) : []
      if (!rawFiles.length) throw new Error('files required (handleId or path)')
      const files = await Promise.all(rawFiles.map(async (item) => {
        if (item?.handleId != null && item.handleId !== '') {
          let path: string
          try {
            path = await resolveLocalFileHandle(pluginId, String(item.handleId))
          } catch {
            throw new Error('文件句柄已失效（文件可能已被移动或删除），请重新选择')
          }
          return { path, name: item.name != null ? String(item.name) : undefined }
        }
        throw new Error('each shared file requires a selected handleId; raw paths are not supported')
      }))
      return lanShareStart(pluginId, { files, minutes: o.minutes != null ? Number(o.minutes) : undefined })
    }
    case 'lan.share.status': {
      const status = lanShareStatus(pluginId, argStr(args, 'shareId', 0))
      if (!status) throw new Error('share not found')
      return status
    }
    case 'lan.share.list': {
      return lanShareList(pluginId)
    }
    case 'lan.share.stop': {
      const stopped = lanShareStop(pluginId, argStr(args, 'shareId', 0))
      if (!stopped) throw new Error('share not found')
      return true
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
    case 'agent.apps': {
      return agentApps()
    }
    case 'agent.read': {
      return agentRead(pluginId, argStr(args, 'app', 0))
    }
    case 'agent.write': {
      const o = asObj(args)
      await confirmPluginOperation(pluginId, '修改 AI CLI 配置？', `应用：${String(o.app ?? args[0] ?? '')}\n修改字段：${Object.keys((o.changes ?? args[1] ?? {}) as object).join(', ')}`)
      return agentWrite(pluginId, {
        app: o.app != null ? String(o.app) : String(args[0] ?? ''),
        changes: (o.changes ?? args[1]) as Record<string, unknown>,
        confirmed: true
      })
    }
    case 'agent.backups': {
      return agentBackups(pluginId, argStr(args, 'app', 0))
    }
    case 'agent.restore': {
      const o = asObj(args)
      await confirmPluginOperation(pluginId, '恢复 AI CLI 配置备份？', `应用：${String(o.app ?? args[0] ?? '')}\n备份：${String(o.id ?? args[1] ?? '')}`)
      return agentRestore(pluginId, {
        app: o.app != null ? String(o.app) : String(args[0] ?? ''),
        id: o.id != null ? String(o.id) : String(args[1] ?? '')
      })
    }
    case 'agent.sessions.list': {
      return agentSessionsList(pluginId, argStr(args, 'app', 0))
    }
    case 'agent.sessions.read': {
      const o = asObj(args)
      return agentSessionsRead(pluginId, {
        app: o.app != null ? String(o.app) : String(args[0] ?? ''),
        file: o.file != null ? String(o.file) : String(args[1] ?? ''),
        maxBytes: o.maxBytes != null ? Number(o.maxBytes) : undefined
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
      const req = (args[0] ?? {}) as {
        url?: string
        method?: string
        headers?: Record<string, string>
        body?: string
        timeoutMs?: number
        stream?: boolean
      }
      // 明文 http 仅在 manifest 声明 net.allowInsecure 时放行（PluginInstaller 已校验形状）
      const allowInsecure = manifest.net?.allowInsecure === true
      const schemeOk = (u: string): boolean =>
        allowInsecure ? /^https?:\/\//i.test(u) : /^https:\/\//i.test(u)
      const schemeName = allowInsecure ? 'http(s)' : 'https'
      if (req.body !== undefined && (typeof req.body !== 'string' || Buffer.byteLength(req.body) > 8 * 1024 * 1024)) throw new Error('request body exceeds 8 MiB')
      let url = String(req.url ?? '')
      if (!schemeOk(url)) throw new Error(`only ${schemeName} urls allowed`)
      const method = (req.method ?? 'GET').toUpperCase()
      if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'].includes(method)) {
        throw new Error('only GET/POST/PUT/PATCH/DELETE/HEAD allowed')
      }
      const timeoutMs = Math.min(120_000, Math.max(1_000, req.timeoutMs ?? NET_FETCH_DEFAULT_TIMEOUT))
      const controller = new AbortController()
      const scope = getRuntimeScope(pluginId)
      if (!scope || scope.signal.aborted) throw new Error('plugin runtime closed')
      const abort = () => controller.abort()
      scope.signal.addEventListener('abort', abort, { once: true })
      if ((netFetchCounts.get(scope) ?? 0) >= 8) { scope.signal.removeEventListener('abort', abort); throw new Error('network request limit (8) reached') }
      const releaseNetworkActivity = scope.acquireActivity('network request')
      netFetchCounts.set(scope, (netFetchCounts.get(scope) ?? 0) + 1)
      let released = false
      const releaseActivity = (): void => { if (released) return; released = true; releaseNetworkActivity(); netFetchCounts.set(scope, Math.max(0, (netFetchCounts.get(scope) ?? 1) - 1)) }
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
            headers: req.headers ?? {},
            body: method === 'GET' || method === 'HEAD' ? undefined : req.body,
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
    case 'shell.saveTextFile': {
      const o = asObj(args)
      const content = String(o.content ?? args[1] ?? '')
      const defaultName = String(o.defaultName || o.filename || args[0] || 'export.txt')
      const scope = getRuntimeScope(pluginId)
      if (!scope || !scope.isCurrent() || scope.signal.aborted) throw new Error('plugin runtime is closing')
      const releaseActivity = scope.acquireActivity('file:export')
      const releaseFocus = acquireQuickInteraction()
      const release = () => { releaseFocus(); releaseActivity() }
      scope.signal.addEventListener('abort', release, { once: true })
      const assertCurrent = () => {
        if (!scope.isCurrent() || scope.signal.aborted) throw new Error('plugin runtime is closing')
      }
      try {
        const { dialog } = await import('electron')
        assertCurrent()
        const { writeFile } = await import('node:fs/promises')
        assertCurrent()
        const win = pluginHost.getContainerWindow(pluginId)
        const saveOpts = { defaultPath: defaultName, filters: [{ name: 'All Files', extensions: ['*'] }] }
        const result = win ? await dialog.showSaveDialog(win, saveOpts) : await dialog.showSaveDialog(saveOpts)
        assertCurrent()
        if (result.canceled || !result.filePath) return null
        await writeFile(result.filePath, content, 'utf-8')
        return { ok: true, path: result.filePath }
      } finally {
        scope.signal.removeEventListener('abort', release)
        release()
      }
    }
    case 'db.pickImportFile': {
      return dbPickImportFile(pluginId)
    }
    case 'notify': {
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
      const saved = await themePackRegistry.registerPlugin(pack, pluginId)
      sendShellEvent({ type: 'theme-packs-changed' })
      return saved
    }
    case 'theme.getTokens': {
      // 按插件 manifest.ui.preferredColorScheme 解析最终 Token
      const manifest = pluginRegistry.getManifest(pluginId)
      const ui = resolvePluginUi(manifest?.ui)
      return resolveThemeTokens(ui.preferredColorScheme)
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
      return vaultSet(pluginId, key, String(secret ?? ''))
    }
    case 'vault.has': {
      return vaultHas(pluginId, String(args[0] ?? ''))
    }
    case 'vault.remove': {
      return vaultRemove(pluginId, String(args[0] ?? ''))
    }
    // —— ssh ——
    case 'ssh.connect': {
      const o = asObj(args)
      const input = (o.host != null ? o : args[0]) as SshConnectInput & {
        password?: string
      }
      return sshConnect(pluginId, input)
    }
    case 'ssh.write': {
      return sshWrite(pluginId, argStr(args, 'sessionId', 0), argStr(args, 'data', 1))
    }
    case 'ssh.resize': {
      return sshResize(
        pluginId,
        argStr(args, 'sessionId', 0),
        argNum(args, 'cols', 1, 80),
        argNum(args, 'rows', 2, 24)
      )
    }
    case 'ssh.disconnect': {
      return sshDisconnect(pluginId, argStr(args, 'sessionId', 0))
    }
    case 'ssh.listSessions': {
      return sshListSessions(pluginId)
    }
    case 'ssh.exec': {
      const o = asObj(args)
      if (o.sessionId != null || o.host != null) {
        const input = o as unknown as SshExecInput & { command?: string; cmd?: string }
        if (!input.command && typeof input.cmd === 'string') input.command = input.cmd
        return sshExec(pluginId, input)
      }
      // 位置参数：sessionId, command, opts?
      return sshExec(pluginId, {
        sessionId: String(args[0] ?? ''),
        command: String(args[1] ?? '')
      } as SshExecInput)
    }
    case 'ssh.metrics.start': {
      const o = asObj(args)
      const sessionId = o.sessionId != null ? String(o.sessionId) : String(args[0] ?? '')
      const intervalMs =
        o.intervalMs != null
          ? Number(o.intervalMs)
          : (args[1] as number | undefined)
      return sshMetricsStart(pluginId, sessionId, intervalMs)
    }
    case 'ssh.metrics.stop': {
      return sshMetricsStop(pluginId, argStr(args, 'sessionId', 0))
    }
    case 'ssh.metrics.latest': {
      return sshMetricsLatest(pluginId, argStr(args, 'sessionId', 0))
    }
    case 'ssh.completion.suggest': {
      const o = asObj(args)
      const sessionId = o.sessionId != null ? String(o.sessionId) : String(args[0] ?? '')
      const line =
        o.line != null
          ? String(o.line)
          : o.prefix != null
            ? String(o.prefix)
            : String(args[1] ?? '')
      return sshCompletionSuggest(pluginId, {
        sessionId,
        line,
        cursor: o.cursor != null ? Number(o.cursor) : undefined,
        cwd: typeof o.cwd === 'string' ? o.cwd : undefined,
        history: Array.isArray(o.history) ? (o.history as string[]) : undefined,
        snippets: Array.isArray(o.snippets)
          ? (o.snippets as Array<{ title: string; command: string }>)
          : undefined
      })
    }
    case 'ssh.sftp.list': {
      const o = asObj(args)
      const input =
        o.sessionId != null
          ? (o as unknown as SftpListInput)
          : ({ sessionId: String(args[0] ?? ''), path: String(args[1] ?? '/') } as SftpListInput)
      return sshSftpList(pluginId, input)
    }
    case 'ssh.sftp.download': {
      const o = asObj(args)
      const input =
        o.sessionId != null
          ? (o as unknown as SftpDownloadInput)
          : ({
              sessionId: String(args[0] ?? ''),
              remotePath: String(args[1] ?? ''),
              localDirectoryHandleId: String(args[2] ?? '')
            } as SftpDownloadInput)
      return sshSftpDownload(pluginId, input)
    }
    case 'ssh.sftp.upload': {
      const o = asObj(args)
      const input =
        o.sessionId != null
          ? (o as unknown as SftpUploadInput)
          : ({
              sessionId: String(args[0] ?? ''),
              localHandleId: String(args[1] ?? ''),
              remotePath: String(args[2] ?? '')
            } as SftpUploadInput)
      return sshSftpUpload(pluginId, input)
    }
    case 'ssh.sftp.mkdir': {
      // 兼容对象形 { sessionId, path } 与位置参数 (sessionId, path)
      const o = asObj(args)
      return sshSftpMkdir(
        pluginId,
        o.sessionId != null ? String(o.sessionId) : String(args[0] ?? ''),
        o.path != null ? String(o.path) : String(args[1] ?? '')
      )
    }
    case 'ssh.sftp.rename': {
      // 兼容对象形 { sessionId, path, newPath } 与位置参数 (sessionId, path, newPath)
      const o = asObj(args)
      return sshSftpRename(
        pluginId,
        o.sessionId != null ? String(o.sessionId) : String(args[0] ?? ''),
        o.path != null ? String(o.path) : String(args[1] ?? ''),
        o.newPath != null ? String(o.newPath) : String(args[2] ?? '')
      )
    }
    case 'ssh.sftp.delete': {
      // 兼容对象形 { sessionId, path, recursive } 与位置参数 (sessionId, path, recursive)
      const o = asObj(args)
      return sshSftpDelete(
        pluginId,
        o.sessionId != null ? String(o.sessionId) : String(args[0] ?? ''),
        o.path != null ? String(o.path) : String(args[1] ?? ''),
        o.recursive != null ? Boolean(o.recursive) : Boolean(args[2])
      )
    }
    case 'ssh.sftp.chmod': {
      // 兼容对象形 { sessionId, path, mode } 与位置参数 (sessionId, path, mode)
      const o = asObj(args)
      return sshSftpChmod(
        pluginId,
        o.sessionId != null ? String(o.sessionId) : String(args[0] ?? ''),
        o.path != null ? String(o.path) : String(args[1] ?? ''),
        (o.mode != null ? o.mode : args[2]) as number | string
      )
    }
    case 'ssh.pickLocalFile': {
      return sshPickLocalFile(pluginId, args[0] as LocalFilePickOptions | undefined)
    }
    // —— db ——
    case 'db.test': {
      return dbTest(pluginId, (args[0] ?? {}) as DbConnectionConfig)
    }
    case 'db.open': {
      const o = asObj(args)
      return dbOpen(pluginId, (o.host != null || o.driver != null || o.config ? o : args[0]) as never)
    }
    case 'db.close': {
      return dbClose(pluginId, String(args[0] ?? ''))
    }
    case 'db.listSessions': {
      return dbListSessions(pluginId)
    }
    case 'db.pickSqliteFile': {
      return dbPickSqliteFile(pluginId, asObj(args))
    }
    case 'db.execute': {
      return dbExecute(pluginId, (args[0] ?? {}) as DbExecuteInput)
    }
    case 'db.explain': {
      return dbExplain(pluginId, (args[0] ?? {}) as { sessionKey: string; sql: string })
    }
    case 'db.cancel': {
      const o = asObj(args)
      const sid = o.sessionKey != null ? String(o.sessionKey) : String(args[0] ?? '')
      return dbCancel(pluginId, { sessionKey: sid, executionId: typeof o.executionId === 'string' ? o.executionId : undefined })
    }
    case 'db.applyChanges': {
      return dbApplyChanges(pluginId, (args[0] ?? {}) as DbApplyChangesInput)
    }
    case 'db.importPreview': {
      return dbImportPreview(pluginId, (args[0] ?? {}) as DbImportPreviewInput)
    }
    case 'db.importRun': {
      return dbImportRun(pluginId, (args[0] ?? {}) as DbImportRunInput)
    }
    case 'db.schema.tree': {
      const o = asObj(args)
      return dbSchemaTree(pluginId, (o.sessionKey != null ? o : args[0]) as never)
    }
    case 'db.schema.describe': {
      return dbSchemaDescribe(pluginId, (args[0] ?? {}) as {
        sessionKey: string
        database?: string
        schema?: string
        table: string
      })
    }
    case 'db.schema.ddl': {
      return dbSchemaDdl(pluginId, (args[0] ?? {}) as {
        sessionKey: string
        database?: string
        schema?: string
        table: string
      })
    }
    case 'db.completion.suggest': {
      return dbCompletion(pluginId, (args[0] ?? {}) as DbCompletionInput)
    }
    case 'db.dialects.list': {
      return dbDialectsList(pluginId)
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
        const allowed = () => scope?.owner.wcId === senderId && scope.isCurrent() && (!scope.isClosing || CLOSE_SAFE.test(method))
        if (!allowed()) return { ok: false, error: 'plugin runtime is closing or stale' }
        // 权限为 null 表示该方法无需 manifest 声明（settings 由 Bridge 管控）
        const required = method === 'db.pickSqliteFile'
          ? (asObj(args).readOnly === true && asObj(args).createIfMissing !== true ? 'fs.read' : 'fs.write')
          : (method === 'localFiles.pick' || method === 'ssh.pickLocalFile') && asObj(args).access === 'write'
          ? 'fs.write'
          : method === 'ssh.workbench'
          ? sshWorkbenchPermission(String(asObj(args).action ?? ''))
          : method === 'db.workbench'
            ? dbWorkbenchPermission(String(asObj(args).action ?? ''))
            : method === 'mw.workbench'
              ? mwWorkbenchPermission(String(asObj(args).action ?? ''))
              : method === 'dsh.workbench'
                ? dshWorkbenchPermission(String(asObj(args).action ?? ''))
                : METHOD_PERMISSION[method]
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
            const osCheck = checkScreenCapture()
            if (!osCheck.ok) {
              return { ok: false, error: 'os permission denied: screen' }
            }
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
          return { ok: false, error }
        }
      } catch (err) {
        return { ok: false, error: (err as Error).message }
      }
    }
  )

  // beforeClose ack：插件 preload 在收到 beforeClose 后可回 ack，Host 解除等待
  ipcMain.on(
    IpcChannels.PluginLifecycleAck,
    (event, payload?: { event?: string; operationId?: string; success?: boolean }) => {
      const hostPluginId = pluginHost.getPluginIdByWebContentsId(event.sender.id)
      if (!hostPluginId || event.senderFrame !== event.sender.mainFrame || !isPluginPageUrl(event.senderFrame.url, hostPluginId, pluginRegistry.get(hostPluginId)?.devUrl)) return
      if (payload?.event === 'beforeClose' || payload?.event === 'beforeSuspend') {
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
      revalidateClipboardPolling()
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
