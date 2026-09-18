/**
 * pluginHandlers — 插件 IPC 调用分发器
 * 职责：接收插件 preload 发起的 `plugin:call`，校验发送者身份与权限，按 method 分发到具体实现；
 *       转发 `plugin:lifecycle-ack`（beforeClose 确认）到 PluginHost。
 * 被 registerPluginHandlers 在 index.ts 中注册。
 * 关键依赖：PluginHost（识别 sender）、PluginPermissions（权限断言）、SettingsStore、
 * PluginSettingsBridge、themePacks、pluginStorage（storage.local 落 enest.db）、
 * quickHotkey（probeHotkey 冲突检测）、globalShortcut（插件全局热键）。
 */
import { clipboard, globalShortcut, ipcMain, nativeImage, Notification, shell } from 'electron'
import { toTabId } from '@shared/constants'
import type {
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
import { assertPermission } from '@main/plugin/PluginPermissions'
import { pluginHost } from '@main/plugin/PluginHost'
import { pluginRegistry } from '@main/plugin/PluginRegistry'
import { sessionBag } from '@main/plugin/PluginSessionStore'
import { probeHotkey } from '@main/hotkey/quickHotkey'
import { logInfo, logWarn } from '@main/logs/logService'
import { resolveThemeTokens } from '@main/theme/resolveThemeCss'
import { pluginSettingsBridge } from '@main/settings/PluginSettingsBridge'
import { settingsStore } from '@main/settings/SettingsStore'
import { themePackRegistry } from '@main/theme/themePacks'
import { contributionRegistry } from '@main/contrib/ContributionRegistry'
import { resolveQuickQuery } from '@main/launcher/quickProviders'
import {
  getMainWindow,
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

/** method → 所需权限映射；null 表示无需权限（settings.get/set 由 Bridge 管控，theme.register 暂不设权限） */
const METHOD_PERMISSION: Record<string, PluginPermission | null> = {
  'ui.setTitle': 'ui.setTitle',
  'ui.setIcon': 'ui.setIcon',
  'ui.setBadge': 'ui.setBadge',
  'ui.resize': 'ui.resize',
  'ui.setHeight': 'ui.resize',
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
  'theme.register': null,
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
  'ssh.pickLocalFile': 'ssh.sftp',
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
  'db.pickImportFile': 'db.connect',
  // 导出落盘：复用 shell.openExternal 权限（两插件均已声明）
  'shell.saveTextFile': 'shell.openExternal'
}

/** net.fetch 响应体上限（2MB），防止插件拉超大资源 */
const NET_FETCH_MAX_BODY = 2 * 1024 * 1024
const NET_FETCH_DEFAULT_TIMEOUT = 15_000

/** 单插件可注册的全局热键上限（防滥用） */
const MAX_PLUGIN_HOTKEYS = 4

/**
 * 插件全局热键注册表：pluginId → accelerator 列表。
 * register 用 quickHotkey.probeHotkey 预检冲突（壳子 Quick 热键 ours=true 也算冲突，
 * 除非是同插件重复注册）；触发时向该插件 webContents 推 plugin:event { type:'hotkey' }。
 */
const pluginHotkeys = new Map<string, string[]>()

/**
 * 取插件存活 webContents：PluginHost 未公开 view 访问器（归代理 E 管辖），
 * 经私有 entries 结构读取（{ view: WebContentsView }）。E 侧若重构字段，
 * 需同步此处或补公开 getWebContentsForPlugin(pluginId) 替换本反射。
 */
function getPluginWebContents(pluginId: string): Electron.WebContents | null {
  const internal = pluginHost as unknown as {
    entries?: Map<string, { view?: { webContents?: Electron.WebContents } }>
  }
  const entry = internal.entries?.get(pluginId)
  return entry?.view?.webContents ?? null
}

/** 向指定插件的存活 webContents 推送 plugin:event 负载（找不到/已销毁则静默丢弃） */
function sendPluginEvent(pluginId: string, payload: PluginEventPayload): void {
  if (!pluginHost.isOpened(pluginId)) return
  const wc = getPluginWebContents(pluginId)
  if (!wc) return
  try {
    if (wc.isDestroyed()) return
    wc.send(IpcChannels.PluginEvent, payload)
  } catch {
    // webContents 可能正在销毁
  }
}

/** 注册插件全局热键：预检冲突 → globalShortcut.register → 记录归属 */
function registerPluginHotkey(
  pluginId: string,
  accelerator: string
): { ok: true } | { ok: false; error: string } {
  const acc = String(accelerator ?? '').trim()
  if (!acc) return { ok: false, error: 'accelerator required' }

  const mine = pluginHotkeys.get(pluginId) ?? []
  if (!mine.includes(acc)) {
    if (mine.length >= MAX_PLUGIN_HOTKEYS) {
      return { ok: false, error: `hotkey limit reached (max ${MAX_PLUGIN_HOTKEYS})` }
    }
    // 冲突检测：壳子 Quick 热键（ours）与其它应用占用（!free）都拒绝；
    // 本插件已注册的键（上面 includes 分支）走覆盖式重注册，不视为冲突
    const probe = probeHotkey(acc)
    if (probe.ours) {
      return { ok: false, error: `accelerator already in use (eNest): ${acc}` }
    }
    if (!probe.free) {
      return {
        ok: false,
        error: `accelerator unavailable${probe.hint ? `: ${probe.hint}` : ''}: ${acc}`
      }
    }
  }

  try {
    const ok = globalShortcut.register(acc, () => {
      logInfo('hotkey', `plugin ${pluginId} hotkey fired: ${acc}`)
      sendPluginEvent(pluginId, { type: 'hotkey', accelerator: acc })
    })
    if (!ok) {
      // probe 与 register 之间存在竞态（他应用恰好抢占）——如实报失败
      return { ok: false, error: `accelerator registration failed: ${acc}` }
    }
  } catch (err) {
    return { ok: false, error: `accelerator invalid: ${(err as Error).message}` }
  }

  if (!mine.includes(acc)) {
    pluginHotkeys.set(pluginId, [...mine, acc])
  }
  return { ok: true }
}

/** 注销插件热键（单个）；未注册也返回 true（幂等） */
function unregisterPluginHotkey(pluginId: string, accelerator: string): boolean {
  const acc = String(accelerator ?? '').trim()
  const mine = pluginHotkeys.get(pluginId)
  if (!mine) return true
  try {
    if (globalShortcut.isRegistered(acc)) globalShortcut.unregister(acc)
  } catch (err) {
    logWarn('hotkey', `unregister failed ${acc}: ${(err as Error).message}`)
  }
  const next = mine.filter((a) => a !== acc)
  if (next.length === 0) pluginHotkeys.delete(pluginId)
  else pluginHotkeys.set(pluginId, next)
  return true
}

/**
 * 批量释放插件注册的全部全局热键（closePlugin / hibernate / 卸载时调用）。
 * 【交接】PluginHost 归属代理 E，需在 PluginHost.closePlugin（销毁路径，
 * clearPluginSession 附近）与 reloadPlugin/hibernate 处补一行调用：
 *   import { releasePluginHotkeys } from '@main/ipc/pluginHandlers'
 *   releasePluginHotkeys(pluginId)
 * 防止关闭后的插件继续占用全局快捷键。
 */
export function releasePluginHotkeys(pluginId: string): void {
  const mine = pluginHotkeys.get(pluginId)
  if (!mine || mine.length === 0) return
  for (const acc of mine) {
    try {
      if (globalShortcut.isRegistered(acc)) globalShortcut.unregister(acc)
    } catch (err) {
      logWarn('hotkey', `release failed ${acc}: ${(err as Error).message}`)
    }
  }
  pluginHotkeys.delete(pluginId)
}

/**
 * 插件期望内容高度（ui.setHeight 记录；Quick 内嵌容器在批次 2.5 消费）
 */
const pluginDesiredHeights = new Map<string, number>()

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

/** 读取插件经 ui.setHeight 上报的期望高度；未上报返回 null */
export function getPluginDesiredHeight(pluginId: string): number | null {
  return pluginDesiredHeights.get(pluginId) ?? null
}

/**
 * 释放插件的运行时贡献（quick provider 注册表）。
 * 【交接】PluginHost 归属代理 E，需在 PluginHost.closePlugin（销毁路径，与建议的
 * releasePluginHotkeys 同位置）补一行调用：
 *   import { releasePluginContribs } from '@main/ipc/pluginHandlers'
 *   releasePluginContribs(pluginId)
 * 防止已关闭插件的 provider 继续吃 quick-query 派发（超时浪费）。
 * 注意：只清内存 provider；声明式贡献（contributions 表）在卸载/禁用时才清
 *（unregisterBySource，见 PluginUninstaller / shellHandlers 交接说明）。
 */
export function releasePluginContribs(pluginId: string): void {
  for (const provider of contributionRegistry.getQuickProviders()) {
    if (provider.pluginId === pluginId) {
      contributionRegistry.unregisterQuickProvider(pluginId, provider.id)
    }
  }
}

/**
 * 向所有已打开插件广播 locale-change（settings.general.locale 变化时调用）。
 * 【交接】shellHandlers.ShellSetSettings 检测到 locale 变化处应调用本函数；
 * 若 PluginHost（代理 E）补了 broadcastLocale()，可迁移为 Host 方法并删除本反射实现。
 */
export function broadcastPluginLocale(locale: AppLocale): void {
  const ids = (pluginHost as unknown as { entries?: Map<string, unknown> }).entries
  if (!ids) return
  for (const pluginId of ids.keys()) {
    sendPluginEvent(pluginId, { type: 'locale-change', locale })
  }
}

/** 插件 UI 常传对象形参；与宿主位置参数签名对齐 */
function asObj(args: unknown[]): Record<string, unknown> {
  const a0 = args[0]
  return a0 && typeof a0 === 'object' && !Array.isArray(a0)
    ? (a0 as Record<string, unknown>)
    : {}
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

/** 按 method 分发到具体实现，权限已在调用前校验 */
async function dispatch(
  pluginId: string,
  method: string,
  args: unknown[]
): Promise<unknown> {
  switch (method) {
    case 'ui.setTitle': {
      const title = String(args[0] ?? '')
      sendShellEvent({ type: 'plugin-title', tabId: toTabId(pluginId), title })
      return true
    }
    case 'ui.setIcon': {
      const icon = String(args[0] ?? '')
      sendShellEvent({ type: 'plugin-icon', tabId: toTabId(pluginId), icon })
      return true
    }
    case 'ui.setBadge': {
      const badge = (args[0] ?? '') as string | number
      sendShellEvent({ type: 'plugin-badge', tabId: toTabId(pluginId), badge })
      return true
    }
    case 'ui.resize': {
      // 依据 manifest.window 的 minWidth/minHeight 对主窗设置最小尺寸（幂等）；
      // 插件传入的 width/height 仅作建议，不直接改窗（避免插件互相踩）
      const manifest = pluginRegistry.getManifest(pluginId)
      const minW = manifest?.window?.minWidth
      const minH = manifest?.window?.minHeight
      const win = getMainWindow()
      if (win && (Number.isFinite(minW) || Number.isFinite(minH))) {
        const current = win.getMinimumSize()
        const nextW = Number.isFinite(minW) ? Math.max(minW as number, 0) : current[0]
        const nextH = Number.isFinite(minH) ? Math.max(minH as number, 0) : current[1]
        win.setMinimumSize(nextW, nextH)
      }
      return true
    }
    case 'ui.setHeight': {
      // 记录期望高度，供 Quick 内嵌容器（批次 2.5）消费；主窗场景暂不动作
      const raw = Number(args[0])
      if (!Number.isFinite(raw) || raw <= 0) throw new Error('invalid height')
      pluginDesiredHeights.set(pluginId, Math.round(raw))
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
      pluginSettingsBridge.register(pluginId, {
        id: section.id,
        title: section.title,
        items: section.items ?? []
      })
      // 用已持久化值覆盖 bridge 中的 default，保证重启后 settings.get 读到上次写入
      const persisted = settingsStore.getPluginSettings(pluginId)
      for (const item of section.items ?? []) {
        if (item?.key && item.key in persisted) {
          pluginSettingsBridge.set(pluginId, item.key, persisted[item.key])
        }
      }
      return true
    }
    case 'settings.get': {
      const key = String(args[0] ?? '')
      // 持久化值优先（壳子/重启后写入），bridge 仅作未落盘时的 default 兜底
      const persisted = settingsStore.getPluginSettings(pluginId)
      if (key in persisted) return persisted[key]
      return pluginSettingsBridge.get(pluginId, key)
    }
    case 'settings.set': {
      const key = String(args[0] ?? '')
      const value = args[1]
      pluginSettingsBridge.set(pluginId, key, value)
      await settingsStore.setPluginSetting(pluginId, key, value)
      return true
    }
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
      return sessionBag(pluginId).get(key)
    }
    case 'storage.session.set': {
      const key = String(args[0] ?? '')
      sessionBag(pluginId).set(key, args[1])
      return true
    }
    case 'storage.session.remove': {
      const key = String(args[0] ?? '')
      sessionBag(pluginId).delete(key)
      return true
    }
    case 'storage.session.clear': {
      sessionBag(pluginId).clear()
      return true
    }
    case 'clipboard.readText': {
      return clipboard.readText()
    }
    case 'clipboard.writeText': {
      clipboard.writeText(String(args[0] ?? ''))
      noteExternalText(String(args[0] ?? ''))
      return true
    }
    case 'clipboard.readImage': {
      const img = clipboard.readImage()
      if (img.isEmpty()) return null
      const size = img.getSize()
      return {
        dataUrl: img.toDataURL(),
        width: size.width,
        height: size.height
      }
    }
    case 'clipboard.writeImage': {
      const dataUrl = String(args[0] ?? '')
      if (!/^data:image\//i.test(dataUrl)) throw new Error('invalid image dataUrl')
      const img = nativeImage.createFromDataURL(dataUrl)
      if (img.isEmpty()) throw new Error('invalid image data')
      clipboard.writeImage(img)
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
      return selectRegion()
    }
    case 'screen.record.start': {
      const opts = (args[0] ?? {}) as {
        bounds?: ScreenBounds
        withAudio?: boolean
        displayId?: number
      }
      return startRecording(opts)
    }
    case 'screen.record.stop': {
      return stopRecording(String(args[0] ?? ''))
    }
    case 'screen.record.cancel': {
      return cancelRecording(String(args[0] ?? ''))
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
    case 'net.fetch': {
      const req = (args[0] ?? {}) as {
        url?: string
        method?: string
        headers?: Record<string, string>
        body?: string
        timeoutMs?: number
      }
      let url = String(req.url ?? '')
      if (!/^https:\/\//i.test(url)) throw new Error('only https urls allowed')
      const method = (req.method ?? 'GET').toUpperCase()
      if (method !== 'GET' && method !== 'POST') {
        throw new Error('only GET/POST allowed')
      }
      const timeoutMs = Math.min(60_000, Math.max(1_000, req.timeoutMs ?? NET_FETCH_DEFAULT_TIMEOUT))
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      try {
        // 有限次手动跟随重定向，每一跳都校验 https，阻断 http/内网跳转 SSRF
        let res: Response | null = null
        for (let hop = 0; hop < 5; hop++) {
          res = await fetch(url, {
            method,
            headers: req.headers ?? {},
            body: method === 'POST' ? req.body : undefined,
            signal: controller.signal,
            redirect: 'manual'
          })
          if (res.status >= 300 && res.status < 400) {
            const loc = res.headers.get('location')
            if (!loc) throw new Error('redirect without location')
            url = new URL(loc, url).href
            if (!/^https:\/\//i.test(url)) throw new Error('only https urls allowed')
            continue
          }
          break
        }
        if (!res) throw new Error('net.fetch failed')
        const declared = Number(res.headers.get('content-length') ?? '0')
        if (declared > NET_FETCH_MAX_BODY) throw new Error('response body too large')
        const buf = Buffer.from(await res.arrayBuffer())
        if (buf.length > NET_FETCH_MAX_BODY) throw new Error('response body too large')
        const headers: Record<string, string> = {}
        res.headers.forEach((v, k) => {
          headers[k] = v
        })
        return {
          status: res.status,
          headers,
          body: buf.toString('utf-8')
        }
      } catch (err) {
        const msg = (err as Error).name === 'AbortError' ? 'net.fetch timeout' : (err as Error).message
        throw new Error(msg)
      } finally {
        clearTimeout(timer)
      }
    }
    case 'shell.openExternal': {
      const url = String(args[0] ?? '')
      // 仅允许 http(s) 协议，防止 file:// 或自定义协议注入
      if (!/^https?:\/\//i.test(url)) throw new Error('only http(s) urls allowed')
      await shell.openExternal(url)
      return true
    }
    case 'shell.saveTextFile': {
      const o = asObj(args)
      const content = String(o.content ?? args[1] ?? '')
      const defaultName = String(o.defaultName || o.filename || args[0] || 'export.txt')
      const win = getMainWindow()
      const { dialog } = await import('electron')
      const { writeFile } = await import('node:fs/promises')
      const saveOpts = { defaultName, filters: [{ name: 'All Files', extensions: ['*'] }] }
      const result = win
        ? await dialog.showSaveDialog(win as never, saveOpts)
        : await dialog.showSaveDialog(saveOpts)
      if (result.canceled || !result.filePath) return null
      await writeFile(result.filePath, content, 'utf-8')
      return { ok: true, path: result.filePath }
    }
    case 'db.pickImportFile': {
      return dbPickImportFile(pluginId)
    }
    case 'notify': {
      const payload = (args[0] ?? {}) as { title?: string; body?: string }
      new Notification({
        title: payload.title ?? 'eNest',
        body: payload.body ?? ''
      }).show()
      return true
    }
    case 'theme.register': {
      const pack = args[0] as ThemePack
      // 来源强制绑定当前插件 id，防伪造他人/内置来源（覆盖保护在 registry 内做）
      const saved = await themePackRegistry.register({
        ...pack,
        source: pluginId
      })
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
      return registerPluginHotkey(pluginId, String(args[0] ?? ''))
    }
    case 'hotkey.unregister': {
      return unregisterPluginHotkey(pluginId, String(args[0] ?? ''))
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
              localPath: args[2] != null ? String(args[2]) : undefined
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
              localPath: String(args[1] ?? ''),
              remotePath: String(args[2] ?? '')
            } as SftpUploadInput)
      return sshSftpUpload(pluginId, input)
    }
    case 'ssh.pickLocalFile': {
      return sshPickLocalFile(pluginId, args[0] as { properties?: Array<'openFile' | 'openDirectory'> } | undefined)
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
      return dbPickSqliteFile(pluginId)
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
      return dbCancel(pluginId, sid)
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
      return dbDialectsList()
    }
    default:
      throw new Error(`unknown method: ${method}`)
  }
}

/**
 * 注册 plugin:call IPC 处理器：校验 sender 身份、pluginId 匹配与权限后分发；
 * 另注册 plugin:lifecycle-ack，供插件确认 beforeClose（可选，Host 侧 300ms 超时兜底）。
 */
export function registerPluginHandlers(): void {
  // storage.local 底座：建表 + 一次性迁移旧 plugin-storage/*.json（幂等）
  initPluginStorage()
  ipcMain.handle(
    IpcChannels.PluginCall,
    async (event, request: PluginCallRequest): Promise<PluginCallResult> => {
      try {
        const senderId = event.sender.id
        // 仅允许 PluginHost 管理的 WebContents 发起调用
        const hostPluginId = pluginHost.getPluginIdByWebContentsId(senderId)
        if (!hostPluginId) {
          return { ok: false, error: 'unauthorized sender' }
        }
        // 防止插件伪造其他插件身份发起调用
        if (request.pluginId && request.pluginId !== hostPluginId) {
          return { ok: false, error: 'plugin id mismatch' }
        }
        const manifest: PluginManifest | null = pluginHost.getManifestForWebContents(senderId)
        if (!manifest) {
          return { ok: false, error: 'manifest not found' }
        }
        const { method, args = [] } = request
        // 权限为 null 表示该方法无需 manifest 声明（settings 由 Bridge 管控）
        const required = METHOD_PERMISSION[method]
        if (required === undefined) {
          return { ok: false, error: `unknown method: ${method}` }
        }
        if (required) {
          assertPermission(manifest, required)
        }
        const startedAt = Date.now()
        try {
          const data = await dispatch(hostPluginId, method, args)
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
    (event, payload?: { event?: string }) => {
      const hostPluginId = pluginHost.getPluginIdByWebContentsId(event.sender.id)
      if (!hostPluginId) return
      if (payload?.event === 'beforeClose') {
        pluginHost.ackBeforeClose(hostPluginId)
      }
    }
  )
}
