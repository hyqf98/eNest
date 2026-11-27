import { raiseTransientViews } from '@main/window/transientViews'
import { PluginQuickSession } from './pluginQuickSession'
import { forgetQuickEnterInput, readQuickEnterInput, rememberQuickEnterInput } from '@main/launcher/quickInputContext'
/**
 * PluginHost — 插件运行时宿主
 * 职责：为每个打开的插件创建独立 WebContentsView / session partition，
 * 管理激活、关闭（立即销毁）、窗口缩放时的布局；
 * 负责 UI 标准落地：chrome 高度、背景透明、主题 Token 注入与变更广播；
 * 负责完整生命周期事件（enter/out/beforeClose/destroy）与状态机推进。
 * 被 createShellWindow / shellHandlers / quickHandlers 调用。
 * 关键依赖：PluginRegistry、pluginProtocol、PluginLifecycle（状态机）、
 * createShellWindow（窗口引用与事件推送）、createQuickWindow（quick 容器）、
 * resolveThemeCss（主题 Token 解析）、logService。
 *
 * 布局模式 layoutMode = 'shell' | 'quick' 与原生挂载 placements 独立：
 * - shell：插件 view 挂主窗 contentView（大窗 Tab，桌面适配样式），bounds 走
 *   getPluginContentBounds；激活语义 = activeTabId（全局唯一）
 * - quick：插件 view 挂 Quick 小窗 contentView（叠在 quick 渲染层之上，渲染在
 *   输入条下方，小窗适配样式），bounds 走 getQuickPluginBounds；
 *   挂载语义 = quickPluginId。两个容器各自的激活互不干扰（可同时各有一个激活插件）
 * - detached：单插件独立 BaseWindow，保留原布局和 WebContents/runtime scope；
 *   detach/dock 显式迁移，普通 open 聚焦已独立窗口。回收时才切换目标布局。
 * - 未适配布局回退：入口请求的布局不在 manifest views.layouts 时按 views.default
 *   渲染（入口分流在 pluginLauncher，容器内归一在 modeFor）。
 * - placements / layoutModes 保留唤醒和崩溃重试目标；只有布局真正改变才发 mode-change。
 * - 输入拦截：quick 容器 view 注册 before-input-event，插件态 Esc 回列表、
 *   ⌘/Ctrl+Enter 固定到主窗（插件区域持焦时渲染层收不到键盘事件，必须主进程拦截）
 * - 尺寸自适应：Quick 插件使用固定内容高度，退出恢复常用页高度；
 *   ui.resize/setHeight 保留兼容但不调整窗体；
 *   插件自身响应实际 viewport resize，不测量/改写它的 DOM 或内部布局
 *
 * 生命周期（见 PluginLifecycle.ts 头注释）：
 *   installed → opening → ready → active ⇄ background --hibernate--> hibernated
 *                                 ↘ crash                        --open--> opening
 *   hibernated：后台空闲插件销毁渲染进程、保留逻辑 Tab 与 session 快照，activate 即唤醒重建
 *   uninstall: any → clearing-storage → uninstalled
 *
 * 资源策略：
 * - 空闲休眠：background 后 PLUGIN_HIBERNATE_DELAY_MS 无激活 → hibernatePlugin
 *   （saveSessionSnapshot 快照 sessionBag → destroy 通知 → 销毁 view；保留 hibernated 轻量记录）
 *   Quick 仅在显式退出后参与回收；自动隐藏保留当前会话和输入，不销毁页面状态。
 * - LRU 上限：存活（非 hibernated）entry 数超过 PLUGIN_ALIVE_LIMIT 时，
 *   最久未激活的 background 插件立即休眠（active / quick 挂载中 / dev 白名单除外）
 * - crash：清理原生视图和资源，保留错误 Tab，由用户显式重试
 * - dev 插件（summary.dev === true）默认永不休眠 / 不参与 LRU 驱逐；
 *   开「退出即杀」开关者除外（killOnHidePlugins）
 *
 * 向插件推送的事件（通道 plugin:lifecycle）：
 *   enter       — 首次 did-finish-load 后 + 每次 activate（与 out 成对，便于 pause/resume）
 *   out         — 其它 Tab 成为 active / quick 退场（本视图隐藏），isKill 固定 false
 *   beforeClose — 销毁前，reason: tab-close | uninstall | app-quit；可选等 ack，最多 1500ms
 *   destroy     — 关闭开始后的尽力通知
 */
import { randomUUID } from 'node:crypto'
import { basename, dirname, join } from 'node:path'
import { getAppPaths, getAppPathsGeneration, retainAppPaths } from '@main/paths/pathsService'
import { selectsInstalledVersion } from './packageIdentity'
import { ownedPackageVersion } from './packageOwnership'
import { configurePluginSession, releasePluginEndpoints } from '@main/plugin/pluginSessionPolicy'
import { createRuntimeScope, type PluginRuntimeScope } from '@main/plugin/PluginRuntimeScope'
import { hasNativeInteraction, hasNonInteractiveLease, retireInteractionEpoch, setBackgroundNonInteractive, setActivationContext, setResidentActivation } from '@main/plugin/pluginInteractionPolicy'
import type { PluginActivationContext } from '@shared/types/pluginLaunch'
import { permissionService } from '@main/plugin/PermissionService'
import { releasePluginStorage } from '@main/db/pluginStorage'
import { setPluginInstallLifecycleHooks, withInstallLock } from '@main/plugin/PluginInstaller'
import { nativeTheme, session, WebContentsView, type WebContents } from 'electron'
import {
  IpcChannels,
  type PluginEventPayload,
  type PluginSaveSummary,
  type ShellEventPayload
} from '@shared/types/ipc'
import { createShellNotice } from '@shared/notice'
import type { ShellSaveReason } from '@shared/types/notice'
import {
  pluginPartition,
  pluginProtocolUrl,
  pluginChromeBarHeight,
  toTabId,
  toPluginId,
  PLUGIN_HIBERNATE_DELAY_MS,
  PLUGIN_ALIVE_LIMIT,
  BEFORE_CLOSE_ACK_TIMEOUT_MS,
  SAVE_REQUEST_ACK_TIMEOUT_MS,
  QUICK_HEIGHT,
  QUICK_HOME_HEIGHT
} from '@shared/constants'
import type {
  PluginCloseReason,
  PluginEnterPayload,
  PluginLifecycleMessage,
  PluginLaunchMode,
  PluginLaunchTarget,
  DetachedWindowSession
} from '@shared/types/plugin'
import { resolvePluginUi, type PluginUiConfig } from '@shared/types/plugin'
import { resolvePluginLayoutMode } from '@shared/pluginPresentation'
import type { QuickHostPluginPresentation } from '@shared/types/quick'
import { getCatalogPluginIcon } from '@main/launcher/catalogIcons'
import {
  getMainWindow,
  getPluginContentBounds,
  resolvePreload,
  sendQuickEvent,
  sendShellEvent
} from '@main/window/createShellWindow'
import {
  ensureQuickWindow,
  showQuickWindow,
  prepareQuickWindowForPlugin,
  presentQuickWindowForPlugin,
  getQuickPluginBounds,
  getQuickPluginParent,
  finishQuickPluginReveal,
  getQuickWebContents,
  getQuickWindow,
  getQuickShowRevision, isQuickVisible,
  setQuickContentSize,
  hideQuickWindow,
  setQuickPluginHiddenHook,
  setQuickPluginRelayout,
  setQuickPluginSummonHook
} from '@main/window/createQuickWindow'
import { raiseOrbRailViews } from '@main/window/orbRailViews'
import { logInfo, logWarn } from '@main/logs/logService'
import {
  clearPluginSession,
  releaseSessionMemory,
  deleteSessionSnapshot,
  loadSessionSnapshot,
  saveSessionSnapshot,
  getSessionRevision
} from '@main/plugin/PluginSessionStore'
import {
  INITIAL_LIFECYCLE_STATE,
  nextState,
  type PluginLifecycleAction,
  type PluginLifecycleState
} from '@main/plugin/PluginLifecycle'
import { pluginRegistry } from '@main/plugin/PluginRegistry'
import { isEnabledSync } from '@main/plugin/pluginEnabledStore'
import { applyProxyToPluginPartition } from '@main/proxy/proxyService'
import {
  registerPluginProtocolForSession,
  invalidatePluginFileCache,
  invalidatePluginCodeCache
} from '@main/plugin/pluginProtocol'
import { contributionRegistry } from '@main/contrib/ContributionRegistry'
import { releasePluginHotkeys } from '@main/hotkey/pluginRuntimeHotkeys'
import { releaseSockets } from '@main/net/socketBridge'
import { acquirePluginActivity, hasPluginActivity, onPluginActivityIdle, releasePluginActivities } from '@main/plugin/activityRegistry'
import { quickInputAction } from '@main/plugin/quickInputPolicy'
import { devShortcutAction, toggleDevTools } from '@main/dev/devShortcuts'
import { startDevWatch, stopDevWatch } from '@main/dev/devPluginWatcher'
import { clearQuickInput, escapeQuickInput, getQuickInputState } from '@main/plugin/quickInputService'
import type { PluginInputContext } from '@shared/types/local-files'
import { releaseLocalFiles } from '@main/plugin/localFiles'
import { resolveThemeTokens, themeTokensToInjectScript } from '@main/theme/resolveThemeCss'
import { appearanceService } from '@main/theme/appearanceService'
import { routeExternal, isInternalNavigation } from '@main/plugin/externalLinks'
import type { DetachedPluginState, PluginPlacement, PluginPlacementKind } from '@shared/types/plugin-window'
import { settingsStore } from '@main/settings/SettingsStore'
import { stopDevServer, stopDevServerAndWait } from '@main/dev/devServerManager'
import { cancelDevPluginPreparation } from '@main/dev/devPluginRuntime'
import { stopPluginProcesses } from '@main/plugin/pluginOwnedProcesses'
import { PluginWindowSession } from '@main/plugin/pluginWindowSession'
import {
  bindDetachedWindowHost, createDetachedWindow, destroyDetachedWindow,
  getDetachedWindow, getDetachedParent, getDetachedPluginBounds, getDetachedChrome,
  sendDetachedEvent, updateDetachedState, presentRestoredDetachedWindow, getDetachedWindowSession
} from '@main/window/detachedPluginWindows'
import {
  bindFloatWindowHost, createFloatWindow, destroyFloatWindow, destroyAllFloatWindows, getFloatGeometry,
  getFloatParent, getFloatPluginBounds, getFloatWindow, normalizeFloatOptions, setFloatAlwaysOnTop, showFloatWindow
} from '@main/window/floatPluginWindow'
import { broadcastAuxiliaryTheme, closeStaleAuxiliaryWindows } from '@main/window/pluginAuxiliaryWindows'
import { closeWebLoginWindows } from '@main/window/webLoginWindow'

/** beforeClose 等待插件 ack 的上限；超时直接销毁，避免挂死关闭流程 */
const BEFORE_CLOSE_ACK_TIMEOUT = BEFORE_CLOSE_ACK_TIMEOUT_MS

/**
 * 可作为迁移/启动目标的容器（placement kind 的无参子集）。
 */
export type PluginContainer = PluginLaunchTarget

interface PluginOpenOptions {
  container?: PluginContainer
  /** Explicit layout for the chosen native container; used by resolved launches and reloads. */
  layoutMode?: PluginLaunchMode
  guard?: () => boolean
  /** Allocate without loading or stealing focus; directed launch commits separately. */
  deferPresentation?: boolean
  resumePlacement?: boolean
  /** Load an installed plugin without committing foreground presentation. */
  backgroundExecution?: boolean
  activationContext?: Exclude<PluginActivationContext, 'view'>
  /** Set only by trusted shell navigation, never by a plugin capability. */
  trustedUserNavigation?: boolean
  /** Records only this request's new instance, even if native setup later rejects. */
  preparation?: PluginPreparation
}

interface PluginEntry {
  view: WebContentsView
  scope: PluginRuntimeScope
  generation: number
  documentEpoch: number
  documentStarted: boolean
  buildRevision: string
  tabSessionId: string
  pluginId: string
  partition: string
  rootPath: string
  /** 已归一的 UI 配置（来自 manifest.ui） */
  ui: PluginUiConfig
  /** 当前布局模式（quick/shell）；bounds 计算与激活语义按 placements 分流 */
  layoutMode: PluginLaunchMode
  presentationPending?: boolean
  pendingLoadUrl?: string
  /** 插件经 enest.setDirty 上报的未保存标记；save ack 成功后清除 */
  dirty: boolean
  /** 最近一次成为 active 的时间戳（LRU 驱逐依据） */
  lastActivatedAt: number
}

export interface McpRuntime {
  scope: PluginRuntimeScope
  contents: WebContents
  generation: number
  documentEpoch: number
  buildRevision: string
}

/** 休眠插件的轻量记录：逻辑 Tab 仍在，渲染进程已销毁 */
interface HibernatedInfo {
  pluginId: string
  /** 休眠时的显示名（唤醒前 Tab 标题兜底） */
  title: string
  /** 已归一的 UI 配置（唤醒时无需重新查 manifest 即可布局） */
  ui: PluginUiConfig
  /** 休眠时刻（ms） */
  hibernatedAt: number
  buildRevision: string
  tabSessionId: string
}

interface PluginPreparation {
  entry?: PluginEntry
  source?: {
    placement?: PluginPlacement
    layoutMode?: PluginLaunchMode
    revision: number
    state?: PluginLifecycleState
    hibernated?: HibernatedInfo
    lazyDetached: boolean
  }
}

interface PluginOpeningOperation {
  cancelled: boolean
  preserveDevServer?: boolean
  promise: Promise<string>
  entry?: PluginEntry
}

interface PluginClosingOperation {
  preserveSession: boolean
  fullStop?: Promise<PromiseSettledResult<void>[]>
}

interface DetachedRestoreOperation {
  pluginId: string
  session: DetachedWindowSession
  revision: number
  cancelled: boolean
  promise: Promise<void>
  resolve: () => void
}

/** 管理插件 WebContentsView 的生命周期、分区与激活状态 */
export class PluginHost {
  private generation = 0
  private shuttingDown = false
  private barriers = new Map<string, number>()
  private unblockedListeners = new Set<(id: string) => void>()
  private opening = new Map<string, PluginOpeningOperation>()
  private finalClosing = new Map<string, PluginClosingOperation>()
  private closing = new Map<string, Promise<void>>()
  private reloading = new Map<string, { cancelled: boolean; promise: Promise<void> }>()
  private retiringViews = new Map<string, PluginEntry>()
  private suspending = new Map<string, symbol>()
  private logicalTabs = new Map<string, { title: string; tabSessionId: string }>()
  /** Runtime presentation survives suspend and container migration, but not final close. */
  private tabPresentation = new Map<string, { title?: string; glyph?: string; badge?: string }>()
  private tabRevision = 0
  private entries = new Map<string, PluginEntry>()
  private closingEntries = new Map<string, PluginEntry>()
  /** Covers resources created before a View exists and retained after its destruction. */
  private resourceOwners = new Map<string, { closing: boolean }>()
  private byWcId = new Map<number, string>()
  private activeTabId: string | null = null
  private shellVisible = true
  private quickSession = new PluginQuickSession()
  private quickPresentationRevision = 0
  private get quickPluginId(): string | null { return this.quickSession.visiblePluginId }
  /** 上次布局在运行实例销毁后保留；原生父级独立记录在 placements。 */
  private layoutModes = new Map<string, PluginLaunchMode>()
  /** Placement owns the native parent, not the plugin's layout. */
  private placements = new Map<string, PluginPlacement>()
  private placementRevisions = new Map<string, number>()
  private closeRevisions = new Map<string, number>()
  private detachedVisible = new Map<string, boolean>()
  private detachedStateSignatures = new Map<string, string>()
  private lazyDetached = new Set<string>()
  private restoredSessionIds = new Set<string>()
  private restoringDetached = new Map<string, DetachedRestoreOperation>()
  private restoreQueue: DetachedRestoreOperation[] = []
  private restoreWorkers = 0
  private transfers = new Map<string, Promise<void>>()
  private windowInteractions = new Map<string, number>()
  private windowSession = new PluginWindowSession(
    () => settingsStore.getAll().general,
    snapshot => { void settingsStore.setAll({ general: { ...snapshot } }).catch(error => logWarn('session', String(error))) }
  )
  /** nativeTheme 监听是否已挂载（system 模式下 OS 主题切换时广播） */
  private nativeThemeHooked = false

  /** 每插件生命周期状态；未打开的插件视为 installed */
  private states = new Map<string, PluginLifecycleState>()
  /** 待发送的 enter 载荷（首次 open / 显式带 code·payload 的再进入） */
  private pendingEnter = new Map<string, PluginEnterPayload>()
  /** 是否已发送过首次 enter；再激活默认不重放原始载荷 */
  private enterSent = new Set<string>()
  /** beforeClose 等待中的 ack 回调 */
  private pendingAcks = new Map<string, { wcId: number; operationId: string; resolve: (success?: boolean) => void }>()

  /** hibernated 插件的轻量记录（entry 已摘除，逻辑 Tab 仍存在） */
  private hibernated = new Map<string, HibernatedInfo>()
  /** 空闲休眠计时器：插件进入 background 后启动，activate/crash/close 清除 */
  private hibernateTimers = new Map<string, ReturnType<typeof setTimeout>>()
  /** dev 插件「退出即杀」开关（对齐 uTools）：开启后退后台立即休眠，下次进入冷启动读最新代码 */
  private killOnHidePlugins = new Set<string>()
  private inputContexts = new Map<string, PluginInputContext>()
  private mcpBackgroundPlugins = new Set<string>()
  private launcherInput = new WeakMap<WebContents, { epoch: number; until: number }>()
  private residentLeases = new Map<string, { scope: PluginRuntimeScope; release(): void }>()
  private mcpRetiredListeners = new Set<(pluginId: string, reason: string) => void>()

  constructor() {
    onPluginActivityIdle((pluginId) => {
      if (this.getState(pluginId) === 'background') {
        this.scheduleHibernate(pluginId)
        this.enforceAliveLimit()
      }
      this.enforceAliveLimit()
    })
  }

  getContainerWindow(pluginId: string) {
    const placement = this.getPlacement(pluginId)
    return placement.kind === 'detached' ? getDetachedWindow(pluginId)
      : placement.kind === 'float' ? getFloatWindow(pluginId)
      : placement.kind === 'quick' ? getQuickWindow() : getMainWindow()
  }

  getPlacement(pluginId: string): PluginPlacement {
    const placement = this.placements.get(toPluginId(pluginId))
    return placement ? { ...placement } : { kind: this.getLayoutMode(toPluginId(pluginId)) === 'quick' ? 'quick' : 'shell' }
  }

  getPlacementRevision(pluginId: string): number { return this.placementRevisions.get(toPluginId(pluginId)) ?? 0 }
  getLayoutMode(pluginId: string): PluginLaunchMode {
    const id = toPluginId(pluginId)
    return this.entries.get(id)?.layoutMode ?? this.layoutModes.get(id) ?? 'shell'
  }
  hasShellTab(pluginId: string): boolean { return this.logicalTabs.has(toPluginId(pluginId)) }
  hasWindowInteraction(pluginId: string): boolean { return this.hasPlacementInteraction(this.getPlacement(toPluginId(pluginId))) }
  private hasPlacementInteraction(placement: PluginPlacement): boolean {
    for (const id of this.windowInteractions.keys()) {
      const owner = this.getPlacement(id)
      if (owner.kind !== placement.kind) continue
      if ((owner.kind === 'detached' || owner.kind === 'float') && (placement.kind === 'detached' || placement.kind === 'float')) {
        if (owner.windowId === placement.windowId) return true
        continue
      }
      return true
    }
    return false
  }
  private bumpPlacement(pluginId: string): void { this.placementRevisions.set(pluginId, this.getPlacementRevision(pluginId) + 1) }

  acquireWindowInteraction(pluginId: string): () => void {
    const scope = this.entries.get(pluginId)?.scope
    if (!scope || scope.isClosing || this.transfers.has(pluginId)) throw new Error('plugin window is unavailable or moving')
    this.windowInteractions.set(pluginId, (this.windowInteractions.get(pluginId) ?? 0) + 1)
    let released = false
    const release = () => {
      if (released) return
      released = true
      scope.signal.removeEventListener('abort', release)
      const remaining = (this.windowInteractions.get(pluginId) ?? 1) - 1
      if (remaining > 0) this.windowInteractions.set(pluginId, remaining)
      else this.windowInteractions.delete(pluginId)
    }
    scope.signal.addEventListener('abort', release, { once: true })
    return release
  }

  isQuickInputOwner(pluginId: string): boolean {
    return this.getLayoutMode(pluginId) === 'quick' && (this.quickSession.retains(pluginId) || this.getPlacement(pluginId).kind === 'detached')
  }

  private releaseQuickSession(pluginId = this.quickSession.pluginId): boolean {
    if (!pluginId || !this.quickSession.release(pluginId)) return false
    forgetQuickEnterInput(pluginId)
    if (this.getPlacement(pluginId).kind !== 'detached') clearQuickInput(pluginId)
    return true
  }

  sendSurfaceEvent(pluginId: string, event: ShellEventPayload): void {
    const placement = this.getPlacement(pluginId)
    if (placement.kind === 'detached') sendDetachedEvent(pluginId, event)
    // Float windows have no chrome renderer; shell events stay meaningful for the main window only.
    else if (placement.kind !== 'float') sendShellEvent(event)
  }

  getWindowPresentation(pluginId: string): QuickHostPluginPresentation {
    const tab = this.tabPresentation.get(pluginId), summary = pluginRegistry.get(pluginId)
    const title = tab?.title ?? summary?.name ?? pluginId
    if (tab?.glyph) return { title, glyph: tab.glyph }
    const packageIcon = summary?.rootPath && summary.icon?.startsWith(pluginProtocolUrl(pluginId, '')) ? summary.icon : undefined
    return { title, packageIcon }
  }

  getDetachedState(pluginId: string): DetachedPluginState | null {
    if (this.getPlacement(pluginId).kind !== 'detached') return null
    const entry = this.entries.get(pluginId), { title, glyph, packageIcon } = this.getWindowPresentation(pluginId)
    return {
      pluginId, title, glyph, icon: glyph ? null : packageIcon,
      mode: this.getLayoutMode(pluginId), generation: entry?.generation ?? 0,
      status: this.getState(pluginId) === 'crash' ? 'error' : this.hibernated.has(pluginId) ? 'hibernated' : this.lazyDetached.has(pluginId) && !this.opening.has(pluginId) ? 'lazy' : !entry || this.getState(pluginId) === 'opening' ? 'loading' : 'ready',
      alwaysOnTop: getDetachedWindowSession(pluginId)?.alwaysOnTop ?? false,
      badge: this.tabPresentation.get(pluginId)?.badge ?? '', input: getQuickInputState(pluginId)
    }
  }

  prepareSessionShutdown(): void {
    for (const [id, placement] of this.placements) {
      if (placement.kind === 'detached') {
        const state = getDetachedWindowSession(id)
        if (state) this.windowSession.setDetached(id, state)
      }
    }
    destroyAllFloatWindows()
    this.windowSession.prepareShutdown()
    settingsStore.flushNow()
  }

  updateDetachedHistory(pluginId: string, session: DetachedWindowSession): void {
    if (this.getPlacement(pluginId).kind !== 'detached') return
    this.windowSession.setDetached(pluginId, session)
  }

  async activateDetachedPlugin(pluginId: string): Promise<void> {
    if (this.getPlacement(pluginId).kind !== 'detached' && !this.restoringDetached.has(pluginId)) return
    await this.openPlugin(pluginId)
  }

  private isPresented(pluginId: string): boolean {
    if (this.entries.get(pluginId)?.presentationPending) return false
    const placement = this.getPlacement(pluginId)
    if (placement.kind === 'detached') return this.detachedVisible.get(pluginId) === true
    // A float window is its own visible surface; it stays presented while the user watches.
    if (placement.kind === 'float') return !!getFloatWindow(pluginId)?.isVisible()
    return this.isShellActive(pluginId) || this.quickPluginId === pluginId
  }

  setDetachedVisible(pluginId: string, visible: boolean): void {
    if (this.getPlacement(pluginId).kind !== 'detached') return
    if (this.detachedVisible.get(pluginId) === visible) {
      if (visible && !this.lazyDetached.has(pluginId)) this.windowSession.focus(pluginId)
      return
    }
    this.detachedVisible.set(pluginId, visible)
    this.bumpPlacement(pluginId)
    if (visible) {
      if (!this.lazyDetached.has(pluginId)) void this.openPlugin(pluginId).catch(error => logWarn('window', String(error)))
      return
    }
    const entry = this.entries.get(pluginId)
    if (entry) {
      entry.view.setVisible(false)
      if (this.getState(pluginId) === 'active') {
        this.sendToPlugin(entry.view.webContents, { event: 'out', isKill: false })
        this.applyTransition(pluginId, 'deactivate')
      }
      this.scheduleHibernate(pluginId)
      this.enforceAliveLimit()
    }
  }

  private activateDetached(pluginId: string, enter?: PluginEnterPayload): void {
    const entry = this.entries.get(pluginId), win = getDetachedWindow(pluginId)
    if (!entry || !win || win.isDestroyed()) return
    entry.presentationPending = false
    this.suspending.delete(pluginId)
    this.clearHibernateTimer(pluginId)
    this.detachedVisible.set(pluginId, true)
    entry.lastActivatedAt = Date.now()
    entry.view.setBounds(getDetachedPluginBounds(pluginId))
    entry.view.setVisible(this.getState(pluginId) !== 'opening')
    if (enter && (enter.code !== undefined || enter.payload !== undefined || enter.input !== undefined)) this.pendingEnter.set(pluginId, enter)
    if (['ready', 'active', 'background'].includes(this.getState(pluginId))) this.sendEnter(pluginId)
    if (win.isMinimized()) win.restore()
    win.show(); win.focus()
    entry.view.webContents.focus()
    this.windowSession.focus(pluginId)
    this.publishTabs()
  }

  layoutDetachedPlugin(pluginId: string): void {
    const entry = this.entries.get(pluginId)
    if (entry && this.getPlacement(pluginId).kind === 'detached') entry.view.setBounds(getDetachedPluginBounds(pluginId))
  }

  private ensureResourceOwner(pluginId: string): { closing: boolean } {
    let owner = this.resourceOwners.get(pluginId)
    if (!owner) { owner = { closing: false }; this.resourceOwners.set(pluginId, owner) }
    return owner
  }

  private stopAllPluginResources(pluginId: string, operation: PluginClosingOperation): Promise<PromiseSettledResult<void>[]> {
    return operation.fullStop ??= Promise.allSettled([stopPluginProcesses(pluginId), stopDevServerAndWait(pluginId)])
  }

  getPluginView(pluginId: string): WebContentsView | null {
    return this.entries.get(toPluginId(pluginId))?.view ?? null
  }

  /** Source refreshes wait for transport selection and instance teardown to settle. */
  getPluginTransitionTask(pluginId: string): Promise<unknown> | null {
    const id = toPluginId(pluginId)
    return this.reloading.get(id)?.promise ?? this.closing.get(id) ?? this.opening.get(id)?.promise ?? null
  }

  setInputContext(pluginId: string, context: PluginInputContext): void {
    if (!['workbench', 'terminal', 'editor', 'overlay'].includes(context)) throw new Error('invalid input context')
    this.inputContexts.set(pluginId, context)
  }

  focusPlugin(pluginId: string): boolean {
    const entry = this.entries.get(pluginId)
    if (!entry || entry.view.webContents.isDestroyed()) return false
    const placement = this.getPlacement(pluginId)
    if (placement.kind === 'detached') {
      if (!this.isPresented(pluginId)) this.activateDetached(pluginId)
      else { getDetachedWindow(pluginId)?.focus(); entry.view.webContents.focus() }
      return true
    }
    if (placement.kind === 'float') {
      if (!this.isPresented(pluginId)) showFloatWindow(placement.windowId)
      else { getFloatWindow(placement.windowId)?.focus(); entry.view.webContents.focus() }
      return true
    }
    if (!this.isPresented(pluginId)) return false
    entry.view.webContents.focus()
    return true
  }

  focusSearch(pluginId: string): boolean {
    if (!this.isQuickInputOwner(pluginId) || !this.isPluginVisible(pluginId)) return false
    if (this.getPlacement(pluginId).kind === 'detached') {
      getDetachedWindow(pluginId)?.focus()
      getDetachedChrome(pluginId)?.webContents.focus()
    }
    else this.focusQuickShell()
    this.sendSurfaceEvent(pluginId, { type: 'quick-focus-search' })
    return true
  }

  /**
   * 设置 dev 插件「退出即杀」开关（DevConsole 切换时调用）。
   * 已在后台的插件立即休眠，让开关即刻生效而非等下次退场。
   */
  setKillOnHide(pluginId: string, enabled: boolean): void {
    if (enabled) {
      this.killOnHidePlugins.add(pluginId)
      // 插件当前不在前台：立即休眠（后台/休眠中一律对齐 uTools「立即结束运行」）
      if (this.entries.has(pluginId) && !this.isPresented(pluginId)) {
        this.hibernatePlugin(pluginId)
      }
    } else {
      this.killOnHidePlugins.delete(pluginId)
    }
  }

  getKillOnHide(pluginId: string): boolean {
    return this.killOnHidePlugins.has(pluginId)
  }

  /** A hidden/minimized main window keeps selection, but its renderer is idle. */
  setShellVisible(visible: boolean): void {
    if (this.shellVisible === visible) return
    this.shellVisible = visible
    const id = this.activeTabId
    if (!id) return
    if (visible) { this.activatePlugin(id); return }
    const entry = this.entries.get(id)
    if (entry && this.getPlacement(id).kind === 'shell') {
      entry.view.setVisible(false)
      if (this.getState(id) === 'active') {
        this.sendToPlugin(entry.view.webContents, { event: 'out', isKill: false })
        this.applyTransition(id, 'deactivate')
      }
      this.scheduleHibernate(id)
      this.enforceAliveLimit()
    }
  }

  private isShellActive(pluginId: string): boolean {
    return this.shellVisible && this.activeTabId === pluginId && this.getPlacement(pluginId).kind === 'shell'
  }

  getActive(): string | null {
    return this.activeTabId
  }

  /**
   * 当前逻辑 Tab 的公开投影（不含内部句柄）。
   *
   * 首页自绘 Tab 条直接读这里，而不是等主壳 renderer 把 tabs 回推成
   * orbRailState——那条链路要走一次 renderer 往返，首屏时首页还拿不到数据，
   * 表现为"进设置再回首页才显示"。这里读宿主实时状态，没有时序空窗。
   */
  listTabs(): Array<{ id: string; title: string; color: string; glyph: string; icon?: string | null; badge?: string; lazy?: boolean }> {
    return [...this.logicalTabs].map(([pluginId, tab]) => {
      const summary = pluginRegistry.get(pluginId), presentation = this.tabPresentation.get(pluginId)
      /*
       * icon 的回退链与主壳 store 保持一致，否则首页自绘 Tab 条会退成字形：
       *   插件自改 glyph → 不显示图标（避免图标和字形叠加）
       *   否则用清单图标；清单没有图标时才落字形。
       * 之前这里直接 `summary?.icon`，dev 插件或清单未声明 icon 的插件
       * 会让首页 Tab 一律显示字体。
       */
      const declaredIcon = presentation?.glyph ? null : summary?.icon
      return {
        id: toTabId(pluginId),
        title: presentation?.title ?? tab.title,
        color: summary?.color ?? '',
        glyph: presentation?.glyph ?? summary?.glyph ?? '⌥',
        icon: declaredIcon ?? null,
        badge: presentation?.badge || undefined,
        // 恢复出来的 shell 占位：有逻辑 Tab 但没有活运行时，首次点击才加载。
        lazy: !this.entries.has(pluginId) && !this.hibernated.has(pluginId) && !this.opening.has(pluginId)
      }
    })
  }

  /** Main-process diagnostics contain immutable metadata, never native handles or plugin state. */
  getDiagnostics() {
    return {
      opening: this.opening.size,
      closing: this.closing.size,
      hibernated: this.hibernated.size,
      logicalTabs: this.logicalTabs.size,
      // Restored shell placeholders are not hibernated runtimes or lazy detached windows.
      coldShellTabs: [...this.logicalTabs.keys()].filter(pluginId =>
        this.getPlacement(pluginId).kind === 'shell' && this.getState(pluginId) === 'installed'
        && !this.entries.has(pluginId) && !this.hibernated.has(pluginId) && !this.opening.has(pluginId)
        && !this.isClosing(pluginId)
        && !this.reloading.has(pluginId) && !this.transfers.has(pluginId)
      ).length,
      lazyDetached: this.lazyDetached.size,
      restoringDetached: this.restoringDetached.size,
      tabPresentations: this.tabPresentation.size,
      retiring: this.retiringViews.size,
      entries: [...this.entries.values()].map((entry) => ({
        pluginId: entry.pluginId, generation: entry.generation, buildRevision: entry.buildRevision,
        tabSessionId: entry.tabSessionId, wcId: entry.scope.owner.wcId,
        state: this.getState(entry.pluginId), container: entry.layoutMode
      }))
    }
  }

  getMemoryOwners(): Array<{ pluginId: string; generation: number; wcId: number; closing: boolean }> {
    const entries = new Set([...this.entries.values(), ...this.closingEntries.values(), ...this.retiringViews.values()])
    return [...entries].map(entry => ({
      pluginId: entry.pluginId, generation: entry.generation, wcId: entry.scope.owner.wcId, closing: entry.scope.isClosing
    }))
  }

  isClosing(pluginId: string): boolean {
    return this.resourceOwners.get(pluginId)?.closing === true || this.closing.has(pluginId)
      || this.finalClosing.has(pluginId) || this.retiringViews.has(pluginId) || this.closingEntries.has(pluginId)
  }

  getPluginIdByWebContentsId(wcId: number): string | undefined {
    return this.byWcId.get(wcId)
  }

  onMcpRuntimeRetired(listener: (pluginId: string, reason: string) => void): () => void {
    this.mcpRetiredListeners.add(listener)
    return () => { this.mcpRetiredListeners.delete(listener) }
  }

  private retireMcpRuntime(pluginId: string, reason: string): void {
    for (const listener of this.mcpRetiredListeners) {
      try { listener(pluginId, reason) }
      catch (error) { logWarn('mcp', `runtime retirement failed: ${String(error)}`) }
    }
  }

  isCurrentBuildSender(pluginId: string, wcId: number): boolean {
    const entry = this.entries.get(pluginId)
    return !!entry && !this.shuttingDown && !this.barriers.has(pluginId) && isEnabledSync(pluginId)
      && entry.scope.isCurrent() && !entry.scope.isClosing && !entry.view.webContents.isDestroyed()
      && entry.scope.owner.wcId === wcId && entry.buildRevision === pluginRegistry.getBuildRevision(pluginId)
  }

  getMcpRuntime(pluginId: string): McpRuntime | null {
    pluginId = toPluginId(pluginId)
    const entry = this.entries.get(pluginId)
    if (!entry || !this.isCurrentBuildSender(pluginId, entry.scope.owner.wcId)) return null
    return {
      scope: entry.scope, contents: entry.view.webContents, generation: entry.generation,
      documentEpoch: entry.documentEpoch, buildRevision: entry.buildRevision
    }
  }

  /** SDK readiness is a separate handshake; this only ensures a real, silently loaded page. */
  async ensureRunningForMcp(pluginId: string, signal?: AbortSignal): Promise<McpRuntime> {
    pluginId = toPluginId(pluginId)
    const descriptor = pluginRegistry.getInstalledDescriptors().find(item => item.id === pluginId && item.enabled)
    if (!descriptor) throw new Error('MCP plugin is not installed or enabled')
    const closeRevision = this.closeRevisions.get(pluginId) ?? 0
    const current = () => !signal?.aborted && !this.shuttingDown && !this.barriers.has(pluginId) && isEnabledSync(pluginId)
      && (this.closeRevisions.get(pluginId) ?? 0) === closeRevision
      && pluginRegistry.getBuildRevision(pluginId) === descriptor.buildRevision
    const release = acquirePluginActivity(pluginId, `mcp-start:${randomUUID()}`, 'MCP runtime startup')
    signal?.addEventListener('abort', release, { once: true })
    try {
      if (!current()) throw new Error('MCP plugin runtime is unavailable')
      await this.openPlugin(pluginId, undefined, { backgroundExecution: true, guard: current })
      const runtime = this.getMcpRuntime(pluginId)
      if (!current() || !runtime) throw new Error('MCP plugin runtime was retired during startup')
      return runtime
    } finally { signal?.removeEventListener('abort', release); release() }
  }

  /** User commands and index synchronization reuse the ordinary sandbox, without a Tab or presentation. */
  async ensureRunningForActivation(pluginId: string, context: Exclude<PluginActivationContext, 'view'>, signal?: AbortSignal): Promise<McpRuntime> {
    const descriptor = pluginRegistry.getInstalledDescriptors().find(item => item.id === pluginId && item.enabled)
    if (!descriptor) throw new Error('Plugin is not installed or enabled')
    const closeRevision = this.closeRevisions.get(pluginId) ?? 0
    const current = () => !signal?.aborted && !this.shuttingDown && !this.barriers.has(pluginId) && isEnabledSync(pluginId)
      && (this.closeRevisions.get(pluginId) ?? 0) === closeRevision && pluginRegistry.getBuildRevision(pluginId) === descriptor.buildRevision
    const release = acquirePluginActivity(pluginId, `activation-start:${randomUUID()}`, 'Plugin activation startup')
    try {
      if (!current()) throw new Error('Plugin activation retired')
      await this.openPlugin(pluginId, undefined, { activationContext: context, guard: current })
      const runtime = this.getMcpRuntime(pluginId)
      if (!current() || !runtime) throw new Error('Plugin activation retired during startup')
      return runtime
    } finally { release() }
  }

  setResidentLease(pluginId: string, enabled: boolean): void {
    const previous = this.residentLeases.get(pluginId)
    if (!enabled) {
      if (previous) { this.residentLeases.delete(pluginId); setResidentActivation(previous.scope, false); previous.release() }
      return
    }
    const scope = this.entries.get(pluginId)?.scope
    if (!scope?.isCurrent() || scope.isClosing) throw new Error('Resident owner is unavailable')
    if (previous?.scope === scope) return
    previous?.release()
    const lease = { scope, release: scope.acquireActivity('declared resident setting') }
    this.residentLeases.set(pluginId, lease)
    setResidentActivation(scope, true)
    scope.addDisposer(() => {
      if (this.residentLeases.get(pluginId) === lease) this.residentLeases.delete(pluginId)
      setResidentActivation(scope, false)
      lease.release()
    })
  }

  async closePresentation(tabId: string, preserveSharedResources = false): Promise<void> {
    const pluginId = toPluginId(tabId), entry = this.entries.get(pluginId)
    if (!entry || this.residentLeases.get(pluginId)?.scope !== entry.scope) return this.closePlugin(tabId, 'tab-close', false, preserveSharedResources)
    const wasActive = this.activeTabId === pluginId
    const next = [...this.logicalTabs.keys()].find(id => id !== pluginId)
    this.detachView(entry)
    setActivationContext(entry.scope, 'resident')
    setBackgroundNonInteractive(entry.scope, true)
    retireInteractionEpoch(entry.scope)
    if (this.getState(pluginId) === 'active') this.sendToPlugin(entry.view.webContents, { event: 'out', isKill: false })
    this.applyTransition(pluginId, 'deactivate')
    entry.presentationPending = true
    this.logicalTabs.delete(pluginId)
    this.windowSession.remove(pluginId)
    if (this.getPlacement(pluginId).kind === 'detached') destroyDetachedWindow(pluginId)
    this.placements.set(pluginId, { kind: 'shell' })
    entry.view.webContents.setBackgroundThrottling(true)
    this.bumpPlacement(pluginId)
    if (this.releaseQuickSession(pluginId)) {
      clearQuickInput(pluginId)
      setQuickContentSize({ height: QUICK_HOME_HEIGHT })
      sendShellEvent({ type: 'quick-plugin-mode', mode: null })
    }
    if (wasActive) this.activeTabId = null
    sendShellEvent({ type: 'tab-closed', tabId: toTabId(pluginId) })
    this.publishTabs()
    if (wasActive) { if (next) this.activatePlugin(next); else sendShellEvent({ type: 'plugin-active', tabId: null }) }
  }

  restrictMcpInteraction(pluginId: string, runtime: McpRuntime): void {
    if (this.getMcpRuntime(pluginId)?.scope !== runtime.scope || hasNativeInteraction()) throw new Error('MCP presentation is unavailable')
    this.mcpBackgroundPlugins.add(pluginId)
    setBackgroundNonInteractive(runtime.scope, true)
    retireInteractionEpoch(runtime.scope)
  }

  private acceptTrustedNavigation(pluginId: string): void {
    const scope = this.entries.get(pluginId)?.scope
    if (scope && hasNonInteractiveLease(scope)) return
    this.mcpBackgroundPlugins.delete(pluginId)
    if (scope) { setActivationContext(scope, 'view'); setBackgroundNonInteractive(scope, false) }
  }

  getManifestForWebContents(wcId: number) {
    const pluginId = this.byWcId.get(wcId)
    if (!pluginId) return null
    return pluginRegistry.getManifest(pluginId)
  }

  /** 读取已打开插件的 UI 配置（未打开但已休眠时返回休眠记录中的配置，否则 null） */
  getUiConfig(pluginId: string): PluginUiConfig | null {
    return this.entries.get(pluginId)?.ui ?? this.hibernated.get(pluginId)?.ui ?? null
  }

  /** 插件是否有存活 entry（View 仍在）；hibernated/crash 后为 false */
  isOpened(pluginId: string): boolean {
    return this.entries.has(pluginId)
  }

  isPluginVisible(pluginId: string): boolean {
    const win = this.getContainerWindow(pluginId)
    return this.entries.has(pluginId) && this.isPresented(pluginId) && !!win && !win.isDestroyed() && win.isVisible() && !win.isMinimized()
  }

  /** quick 容器当前挂载的 mini 插件 id（无 = 列表态）；quickHandlers 交互用 */
  getQuickPlugin(): string | null {
    return this.quickPluginId
  }

  showQuickSearch(guard: () => boolean, files = false): Promise<boolean> {
    if (!guard()) return Promise.resolve(false)
    if (this.quickSession.pluginId) this.dismissQuickPlugin(this.quickSession.pluginId)
    return showQuickWindow(guard, files)
  }

  showExistingWorkspace(pluginId: string): boolean {
    const entry = this.entries.get(pluginId), win = this.getContainerWindow(pluginId)
    if (!entry || entry.scope.isClosing || entry.view.webContents.isDestroyed() || !win || win.isDestroyed() || !win.isEnabled()
      || this.shuttingDown || this.transfers.has(pluginId) || this.barriers.has(pluginId) || this.hasWindowInteraction(pluginId)) return false
    const placement = this.getPlacement(pluginId)
    if (placement.kind === 'quick') return this.quickSession.retains(pluginId) && presentQuickWindowForPlugin(() => this.showQuickPlugin(pluginId))
    if (placement.kind === 'detached') { this.activateDetached(pluginId); return true }
    if (placement.kind === 'float') { showFloatWindow(placement.windowId); entry.view.webContents.focus(); return true }
    if (!this.logicalTabs.has(pluginId)) return false
    this.activatePlugin(pluginId)
    if (win.isMinimized()) win.restore()
    win.show(); win.focus(); entry.view.webContents.focus()
    return true
  }

  consumeLauncherInput(pluginId: string): boolean {
    const runtime = this.getMcpRuntime(pluginId)
    if (!runtime || !runtime.contents.isFocused() || !this.isPluginVisible(pluginId)) return false
    const receipt = this.launcherInput.get(runtime.contents)
    this.launcherInput.delete(runtime.contents)
    return !!receipt && receipt.epoch === runtime.documentEpoch && receipt.until > Date.now()
  }

  private setLayoutMode(pluginId: string, mode: PluginLaunchMode): void {
    this.layoutModes.set(pluginId, mode)
    const entry = this.entries.get(pluginId)
    if (!entry || entry.layoutMode === mode) return
    entry.layoutMode = mode
    if (mode !== 'quick') clearQuickInput(pluginId)
    this.sendModeChange(entry, mode)
  }

  /**
   * 布局回退：目标容器的布局插件未适配时，回落 manifest views.default
   * （例：未适配 quick 的插件即使被装入 Quick 容器也按默认视图渲染）。
   */
  private modeFor(pluginId: string, kind: PluginLaunchMode): PluginLaunchMode {
    return resolvePluginLayoutMode(pluginRegistry.getManifest(pluginId)?.views, kind)
  }

  /** 联动布局：把 quick 容器挂载中的插件 view bounds 对齐当前 quick 窗（尺寸变化时调用） */
  layoutQuickPlugins(): void {
    const pid = this.quickPluginId
    if (!pid) return
    const entry = this.entries.get(pid)
    if (!entry || this.getPlacement(pid).kind !== 'quick') return
    try {
      entry.view.setBounds(getQuickPluginBounds())
      raiseTransientViews(getQuickWindow() ?? undefined)
    } catch {
      // view 可能正在销毁
    }
  }

  /** quick 呼出回常用网格，保留后台插件进程供下次显式打开。 */
  resetQuickSession(): void {
    this.onQuickHidden()
    const pluginId = this.quickSession.pluginId
    this.releaseQuickSession()
    if (pluginId) { clearQuickInput(pluginId); this.pendingEnter.delete(pluginId); this.scheduleHibernate(pluginId) }
    for (const entry of this.entries.values()) {
      if (this.getPlacement(entry.pluginId).kind === 'quick') entry.view.setVisible(false)
    }
    sendShellEvent({ type: 'quick-plugin-mode', mode: null })
  }

  /**
   * quick 呼出编排：上次隐藏时仍挂载的插件（未 Esc 退场）直接恢复，
   * 复用 launchPluginIn 的守卫与呈现事务，保留当前运行实例；
   * 不可恢复时回常用网格。返回是否恢复了插件。
   */
  async prepareQuickSummon(guard: () => boolean = () => true): Promise<boolean> {
    if (!guard()) return false
    const token = this.quickSession.capture(), pid = token?.pluginId
    if (token && pid && !this.shuttingDown && !this.barriers.has(pid)) {
      const summary = pluginRegistry.get(pid)
      if (summary?.installed && summary.enabled !== false && this.getState(pid) !== 'crash') {
        try {
          await this.launchPluginIn(pid, 'quick', undefined,
            () => guard() && this.quickSession.matches(token) && !this.shuttingDown && !this.barriers.has(pid))
          return true
        } catch (error) {
          const message = (error as Error).message
          if (!guard() || !this.quickSession.matches(token) || /cancelled/.test(message)) return false
          logWarn('quick', `restore ${pid} failed: ${message}`)
        }
      }
    }
    this.resetQuickSession()
    return false
  }

  /**
   * 自动隐藏只改变可见性；当前逻辑会话、接管输入和运行实例保留到显式退出。
   */
  onQuickHidden(): void {
    finishQuickPluginReveal()
    const pid = this.quickSession.hide()
    if (!pid) return
    this.clearHibernateTimer(pid)
    const entry = this.entries.get(pid)
    if (!entry) return
    entry.view.setVisible(false)
    if (this.getState(pid) === 'active') {
      this.sendToPlugin(entry.view.webContents, { event: 'out', isKill: false })
      this.applyTransition(pid, 'deactivate')
    }
  }

  /** 当前生命周期状态（未打开返回 installed） */
  getState(pluginId: string): PluginLifecycleState {
    return this.states.get(pluginId) ?? INITIAL_LIFECYCLE_STATE
  }

  /** 卸载开始：任意 → clearing-storage（由 PluginUninstaller 调用） */
  beginUninstall(pluginId: string): void {
    this.restoredSessionIds.add(pluginId)
    this.cancelDetachedRestore(pluginId)
    this.clearHibernateTimer(pluginId)
    this.applyTransition(pluginId, 'uninstall')
  }

  /** 卸载完成：clearing-storage → uninstalled */
  finishUninstall(pluginId: string): void {
    this.cancelDetachedRestore(pluginId)
    this.applyTransition(pluginId, 'uninstalled')
    this.states.delete(pluginId)
    this.enterSent.delete(pluginId)
    this.pendingEnter.delete(pluginId)
    this.hibernated.delete(pluginId)
    this.logicalTabs.delete(pluginId)
    this.layoutModes.delete(pluginId)
    this.placements.delete(pluginId)
    this.lazyDetached.delete(pluginId)
    this.windowSession.remove(pluginId)
    this.releaseQuickSession(pluginId)
    forgetQuickEnterInput(pluginId)
    clearQuickInput(pluginId)
    this.clearHibernateTimer(pluginId)
  }

  /** ACKs are tied to both renderer incarnation and operation. */
  ackBeforeClose(pluginId: string, wcId: number, operationId?: string, success = true): void {
    const ack = this.pendingAcks.get(pluginId)
    if (ack?.wcId === wcId && ack.operationId === operationId) ack.resolve(success)
  }

  blockPlugin(pluginId: string, reason = 'blocked'): () => void {
    this.barriers.set(pluginId, (this.barriers.get(pluginId) ?? 0) + 1)
    this.retireMcpRuntime(pluginId, reason)
    let released = false
    return () => {
      if (released) return
      released = true
      const count = (this.barriers.get(pluginId) ?? 1) - 1
      if (count) this.barriers.set(pluginId, count)
      else {
        this.barriers.delete(pluginId)
        for (const listener of this.unblockedListeners) {
          try { listener(pluginId) } catch (error) { logWarn('lifecycle', `${pluginId}: ${String(error)}`) }
        }
      }
    }
  }

  isBlockedForOpen(pluginId: string): boolean { return (this.barriers.get(pluginId) ?? 0) > 0 }

  onPluginUnblocked(listener: (id: string) => void): () => void {
    this.unblockedListeners.add(listener)
    return () => { this.unblockedListeners.delete(listener) }
  }

  async restoreTabs(ids: string[]): Promise<void> {
    const pending: Promise<void>[] = []
    for (const id of ids) {
      if (this.shuttingDown) break
      const pluginId = toPluginId(id)
      const restoring = this.restoringDetached.get(pluginId)
      if (restoring) { pending.push(restoring.promise); continue }
      if (this.restoredSessionIds.has(pluginId)) continue
      this.restoredSessionIds.add(pluginId)
      const summary = pluginRegistry.get(pluginId)
      if (!summary?.rootPath || !isEnabledSync(pluginId)) { this.windowSession.remove(pluginId); continue }
      if (this.logicalTabs.has(pluginId) || this.placements.has(pluginId) || this.opening.has(pluginId) || this.closing.has(pluginId) || this.barriers.has(pluginId)) continue
      const saved = this.windowSession.get(pluginId)
      this.windowSession.retain(pluginId, summary.name)
      if (saved?.detached) {
        let resolve!: () => void
        const operation: DetachedRestoreOperation = {
          pluginId, session: saved.detached, revision: this.getPlacementRevision(pluginId), cancelled: false,
          promise: new Promise<void>(done => { resolve = done }), resolve: () => resolve()
        }
        this.restoringDetached.set(pluginId, operation)
        this.restoreQueue.push(operation)
        pending.push(operation.promise)
      } else this.logicalTabs.set(pluginId, { title: summary.name, tabSessionId: randomUUID() })
    }
    this.publishTabs()
    this.drainDetachedRestores()
    await Promise.all(pending)
  }

  private cancelDetachedRestore(pluginId: string): void {
    const operation = this.restoringDetached.get(pluginId)
    if (!operation) return
    operation.cancelled = true
    destroyDetachedWindow(pluginId)
  }

  private drainDetachedRestores(): void {
    while (this.restoreWorkers < 2 && this.restoreQueue.length) {
      const operation = this.restoreQueue.shift()!
      this.restoreWorkers++
      void this.restoreDetachedWindow(operation).finally(() => {
        this.restoreWorkers--
        if (this.restoringDetached.get(operation.pluginId) === operation) this.restoringDetached.delete(operation.pluginId)
        operation.resolve()
        this.drainDetachedRestores()
      })
    }
  }

  private async restoreDetachedWindow(operation: DetachedRestoreOperation): Promise<void> {
    const { pluginId, session, revision } = operation
    const current = () => !operation.cancelled && !this.shuttingDown && !this.barriers.has(pluginId)
      && this.getPlacementRevision(pluginId) === revision && !!pluginRegistry.get(pluginId)?.rootPath && isEnabledSync(pluginId)
    if (!current()) return
    let restoredWindowId: number | undefined
    try {
      const win = await createDetachedWindow(pluginId, session.mode, session.bounds, undefined, { restored: session, lazy: true })
      if (!current()) { if (getDetachedWindow(pluginId) === win) destroyDetachedWindow(pluginId); return }
      restoredWindowId = win.id
      this.setLayoutMode(pluginId, this.modeFor(pluginId, session.mode))
      this.placements.set(pluginId, { kind: 'detached', windowId: win.id })
      this.lazyDetached.add(pluginId)
      this.detachedVisible.set(pluginId, false)
      this.publishTabs()
      presentRestoredDetachedWindow(pluginId)
      const restored = getDetachedWindowSession(pluginId)
      if (restored) this.windowSession.setDetached(pluginId, restored)
    } catch (error) {
      const placement = this.placements.get(pluginId)
      const ownsPreparedWindow = this.lazyDetached.has(pluginId) && placement?.kind === 'detached' && placement.windowId === restoredWindowId
      if (operation.cancelled || this.shuttingDown || this.barriers.has(pluginId) || !current() && !ownsPreparedWindow) return
      destroyDetachedWindow(pluginId)
      this.placements.delete(pluginId)
      this.layoutModes.delete(pluginId)
      this.lazyDetached.delete(pluginId)
      this.detachedVisible.delete(pluginId)
      this.detachedStateSignatures.delete(pluginId)
      this.windowSession.clearDetached(pluginId)
      this.logicalTabs.set(pluginId, { title: pluginRegistry.get(pluginId)?.name ?? pluginId, tabSessionId: randomUUID() })
      this.publishTabs()
      logWarn('session', `independent window restore failed for ${pluginId}: ${String(error)}`)
    }
  }

  private publishTabs(): void {
    for (const [id, tab] of this.logicalTabs) this.windowSession.retain(id, this.tabPresentation.get(id)?.title ?? tab.title)
    for (const [id, placement] of this.placements) {
      if (placement.kind !== 'detached') continue
      const state = this.getDetachedState(id)
      if (state) {
        this.windowSession.retain(id, state.title)
        // Input changes have their own targeted events; unrelated Tab changes must not
        // broadcast every independent chrome, or serialize large search values.
        const { input: _input, ...metadata } = state
        const signature = JSON.stringify(metadata)
        if (this.detachedStateSignatures.get(id) !== signature) {
          this.detachedStateSignatures.set(id, signature)
          updateDetachedState(state)
        }
      }
    }
    sendShellEvent({ type: 'plugin-tabs', revision: ++this.tabRevision,
      activeTabId: this.activeTabId ? toTabId(this.activeTabId) : null,
      tabs: [...this.logicalTabs].map(([id, tab]) => {
        const summary = pluginRegistry.get(id), presentation = this.tabPresentation.get(id)
        return { id: toTabId(id), title: presentation?.title ?? tab.title,
          icon: presentation?.glyph ? null : summary?.icon,
          glyph: presentation?.glyph ?? summary?.glyph ?? '⌥', color: summary?.color,
          badge: presentation?.badge ?? '',
          status: this.getState(id) === 'crash' ? 'error' : this.hibernated.has(id) || !this.entries.has(id) && !this.opening.has(id) ? 'hibernated' : this.getState(id) === 'opening' || this.opening.has(id) ? 'loading' : 'ready' }
      }) })
  }

  private updateTabPresentation(pluginId: string, patch: { title?: string; glyph?: string; badge?: string }): boolean {
    const entry = this.entries.get(pluginId)
    if (!entry || entry.scope.isClosing) return false
    const previous = this.tabPresentation.get(pluginId), next = { ...previous, ...patch }
    this.tabPresentation.set(pluginId, next)
    if (this.quickSession.retains(pluginId) && (previous?.title !== next.title || previous?.glyph !== next.glyph)) this.publishQuickPresentation(pluginId)
    this.publishTabs()
    return true
  }

  setTitle(pluginId: string, value: unknown): boolean {
    if (typeof value !== 'string' || Array.from(value).length > 120 || /[\u0000-\u001f\u007f]/.test(value)) throw new Error('title must be at most 120 visible characters')
    return this.updateTabPresentation(pluginId, { title: value.trim() || undefined })
  }

  /** setIcon is a short text glyph; package images come only from validated manifests. */
  setIcon(pluginId: string, value: unknown): boolean {
    if (typeof value !== 'string' || Array.from(value).length > 2 || /[\s/\\:\u0000-\u001f\u007f]/u.test(value)) throw new Error('icon must be at most 2 visible characters, not a URL or path')
    return this.updateTabPresentation(pluginId, { glyph: value || undefined })
  }

  setBadge(pluginId: string, value: unknown): boolean {
    if (typeof value === 'number') {
      if (!Number.isSafeInteger(value) || value < 0 || value > 999999) throw new Error('badge number must be an integer from 0 to 999999')
    } else if (typeof value !== 'string' || Array.from(value).length > 8 || /[\u0000-\u001f\u007f]/.test(value)) throw new Error('badge must be at most 8 visible characters')
    return this.updateTabPresentation(pluginId, { badge: String(value).trim() })
  }

  openPlugin(pluginId: string, enter?: PluginEnterPayload, opts?: PluginOpenOptions): Promise<string> {
    pluginId = toPluginId(pluginId)
    if (opts?.guard && !opts.guard()) return Promise.reject(new Error('plugin launch cancelled'))
    if (this.shuttingDown || this.barriers.has(pluginId)) return Promise.reject(new Error('plugin unavailable during shutdown or replacement'))
    if (opts?.trustedUserNavigation) this.acceptTrustedNavigation(pluginId)
    const restoring = this.restoringDetached.get(pluginId)
    if (restoring) return restoring.promise.then(() => {
      if (restoring.cancelled) throw new Error('plugin restoration cancelled')
      return this.openPlugin(pluginId, enter, opts)
    })
    const reloading = this.reloading.get(pluginId)
    if (reloading) return reloading.promise.then(() => this.openPlugin(pluginId, enter, opts))
    const closing = this.closing.get(pluginId)
    if (closing) return closing.then(() => this.openPlugin(pluginId, enter, opts))
    if (this.resourceOwners.get(pluginId)?.closing || this.retiringViews.has(pluginId) || this.closingEntries.has(pluginId)) {
      return Promise.reject(new Error('plugin resource cleanup is still pending; retry stopping resources first'))
    }
    const opening = this.opening.get(pluginId)
    if (opening) {
      if (opening.cancelled) return opening.promise.catch(() => undefined).then(() => this.openPlugin(pluginId, enter, opts))
      return opening.promise.then(() => this.openPlugin(pluginId, enter, opts))
    }
    // Fence the entire cold attempt, including dev resources allocated before the first View.
    if (!this.entries.has(pluginId)) this.resourceOwners.set(pluginId, { closing: false })
    const operation: PluginOpeningOperation = { cancelled: false, promise: Promise.resolve(pluginId) }
    this.opening.set(pluginId, operation)
    if (this.lazyDetached.has(pluginId)) this.publishTabs()
    operation.promise = this.createPlugin(pluginId, enter, opts, operation).finally(() => {
      if (this.opening.get(pluginId) === operation) this.opening.delete(pluginId)
      this.publishTabs()
    })
    return operation.promise
  }

  /**
   * 打开插件：已存在则激活（可带新的 enter 载荷；容器不同则先迁移），
   * 已休眠则唤醒（loadSessionSnapshot 灌回 sessionBag 后冷启动重建），
   * 否则创建独立 partition 的 WebContentsView 并加载入口。
   * enter.code 优先进 URL query，完整载荷在 did-finish-load 后经 plugin:lifecycle 下发。
   * container：quick = 挂 Quick 小窗（mini 插件内嵌）；缺省 shell 主窗 Tab。
   * 唤醒 / crash 重启路径经 placements 与 layoutModes 恢复呈现。
   */
  private async createPlugin(
    pluginId: string,
    enter?: PluginEnterPayload,
    opts?: PluginOpenOptions,
    operation?: PluginOpeningOperation
  ): Promise<string> {
    const resumeIdentity = this.hibernated.get(pluginId)
    const existing = this.entries.get(pluginId)
    if (existing) {
      if (opts?.resumePlacement) return pluginId
      if (opts?.backgroundExecution || opts?.activationContext) {
        if (existing.presentationPending && existing.pendingLoadUrl) throw new Error('MCP plugin presentation is busy')
        return pluginId
      }
      if (opts?.deferPresentation) return pluginId
      if (this.getPlacement(pluginId).kind === 'detached') {
        if (opts?.layoutMode !== undefined) this.setLayoutMode(pluginId, this.modeFor(pluginId, opts.layoutMode))
        this.activateDetached(pluginId, enter)
        this.startEntryLoad(existing)
        return pluginId
      }
      // 悬浮窗内再次打开 = 聚焦悬浮窗（不迁回主窗、不重建）。
      const floatingPlacement = this.getPlacement(pluginId)
      if (floatingPlacement.kind === 'float') {
        showFloatWindow(floatingPlacement.windowId)
        if (enter) this.pendingEnter.set(pluginId, enter)
        this.sendEnter(pluginId)
        existing.view.webContents.focus()
        return pluginId
      }
      // 容器切换（quick ↔ shell）：显式指定即迁移（同 webContents 不重载）。
      // 主窗入口缺省进入 shell；Quick 入口显式指定，避免激活隐藏的小窗。
      const target = opts?.container ?? 'shell'
      this.migrateContainer(pluginId, target, opts?.layoutMode)
      if (target === 'quick') {
        this.showQuickPlugin(pluginId, enter)
      } else {
        this.activatePlugin(pluginId, enter)
      }
      this.startEntryLoad(existing)
      this.enforceAliveLimit()
      return pluginId
    }

    // 已显式禁用的插件拒绝打开（Quick / 市场 / IPC 均走此路径）
    if (!isEnabledSync(pluginId)) {
      throw new Error(`plugin disabled: ${pluginId}`)
    }
    const resourceOwner = this.resourceOwners.get(pluginId)
    const currentOpening = () => !operation?.cancelled && !this.shuttingDown && !this.barriers.has(pluginId)
      && this.resourceOwners.get(pluginId) === resourceOwner && opts?.guard?.() !== false

    // 唤醒休眠插件：先把快照灌回内存 sessionBag，再走全新冷启动。
    // 休眠已释放 resident bag，因此新 renderer 加载前恢复业务快照。
    // 状态机转移（hibernated --open--> opening）由下方统一的 applyTransition('open') 完成。
    if (this.hibernated.has(pluginId)) {
      loadSessionSnapshot(pluginId, { buildRevision: pluginRegistry.getBuildRevision(pluginId), tabSessionId: resumeIdentity?.tabSessionId ?? '' })
      logInfo('lifecycle', `${pluginId}: waking from hibernation`)
    }

    const silent = Boolean(opts?.backgroundExecution || opts?.activationContext)
    let summary = silent || opts?.resumePlacement ? pluginRegistry.get(pluginId) : await pluginRegistry.ensureInstalled(pluginId)
    if (!summary || silent && (!summary.installed || summary.enabled === false || !summary.rootPath)) {
      throw new Error(`MCP plugin is not installed or enabled: ${pluginId}`)
    }
    if (!currentOpening() || !isEnabledSync(pluginId)) throw new Error('plugin opening cancelled')
    if (summary.dev) {
      try {
        const { prepareDevPluginRuntime } = await import('@main/dev/DevConsole')
        summary = await prepareDevPluginRuntime(pluginId, currentOpening,
          opts?.activationContext ? 'activation' : opts?.backgroundExecution ? 'mcp' : opts?.container === 'quick' ? 'quick' : 'open')
      } catch (error) {
        if (!currentOpening() && !operation?.preserveDevServer) stopDevServer(pluginId)
        throw error
      }
    }
    if (opts?.guard && !opts.guard()) throw new Error('plugin launch cancelled')
    if (!currentOpening() || !isEnabledSync(pluginId)) throw new Error('plugin opening cancelled')
    const rootPath = summary.rootPath
    if (!rootPath) throw new Error(`plugin not installed: ${pluginId}`)

    const manifest = pluginRegistry.getManifest(pluginId)
    const ui = resolvePluginUi(manifest?.ui ?? summary.ui)

    // 用户入口默认桌面；Quick 与内部恢复明确传入目标容器。
    const previousPlacement = this.placements.get(pluginId)
    const detached = previousPlacement?.kind === 'detached'
    // 悬浮窗内的实例重建（重载/崩溃自愈）必须留在悬浮窗，不能悄悄回到主窗 Tab。
    const floating = previousPlacement?.kind === 'float'
    const resumeRequested = silent || (detached && !opts?.deferPresentation) || (floating && !opts?.deferPresentation)
    const requested: PluginContainer = opts?.container ?? 'shell'
    const retainedPlacement = opts?.resumePlacement || opts?.deferPresentation || silent || detached || floating ? previousPlacement : undefined
    const mode = this.modeFor(pluginId, opts?.layoutMode ?? (resumeRequested ? this.getLayoutMode(pluginId) : requested))
    const container: PluginContainer = opts?.layoutMode !== undefined ? requested : resumeRequested
      ? (mode === 'quick' ? 'quick' : 'shell')
      : (requested === 'quick' && mode === 'quick' ? 'quick' : 'shell')
    const placement: PluginPlacement = retainedPlacement ?? { kind: container }

    const partition = pluginPartition(pluginId) // 每插件独立 partition，隔离 cookie/storage
    const ses = session.fromPartition(partition)
    configurePluginSession(ses, { pluginId, devUrl: summary.devUrl })
    // 新建的插件 session 需继承当前应用代理（直连时 no-op）
    await applyProxyToPluginPartition(pluginId)
    if (opts?.guard && !opts.guard()) throw new Error('plugin launch cancelled')
    if (!currentOpening()) throw new Error('plugin opening cancelled')
    if (opts?.preparation) opts.preparation.source = {
      placement: this.placements.get(pluginId), layoutMode: this.layoutModes.get(pluginId),
      revision: this.getPlacementRevision(pluginId), state: this.states.get(pluginId),
      hibernated: this.hibernated.get(pluginId), lazyDetached: this.lazyDetached.has(pluginId)
    }
    this.hibernated.delete(pluginId)
    this.setLayoutMode(pluginId, mode)
    this.placements.set(pluginId, placement)
    if (!opts?.deferPresentation && !silent && placement.kind === 'shell' && !this.logicalTabs.has(pluginId)) {
      this.logicalTabs.set(pluginId, { title: summary.name, tabSessionId: randomUUID() })
    }
    if (!summary.devUrl) {
      registerPluginProtocolForSession(ses, pluginId, rootPath)
    }

    const view = new WebContentsView({
      webPreferences: {
        preload: resolvePreload('pluginPreload.js'),
        partition,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: !summary.devUrl,
        sandbox: true // self-contained CJS preload only exposes the capability bridge
      }
    })

    view.setBorderRadius(0)
    // Keep the shell's loading state visible until this native surface has loaded.
    view.setVisible(false)

    // background=transparent：View 底色透明，透出壳子背景（Canvas/WebGL 场景）
    // 注意：setBackgroundColor 挂在 View 上（非 webContents），hex 含 alpha 用 AARRGGBB
    if (ui.background === 'transparent') {
      view.setBackgroundColor('#00000000')
    }

    const mainFromManifest = manifest?.main ?? 'index.html'
    const base = summary.devUrl
      ? withPid(summary.devUrl, pluginId)
      : withPid(pluginProtocolUrl(pluginId, mainFromManifest), pluginId)
    // code/mode 走 query，便于插件在首个脚本同步读取；payload 体积不定，走 IPC。
    let url = withMode(
      enter?.code ? withCode(base, enter.code) : base,
      mode
    )
    if (opts?.activationContext) { const target = new URL(url); target.searchParams.set('activation', opts.activationContext); url = target.toString() }

    this.applyTransition(pluginId, 'open')
    if (enter && (enter.code !== undefined || enter.payload !== undefined || enter.input !== undefined)) {
      this.pendingEnter.set(pluginId, enter)
    }

    view.webContents.on('render-process-gone', (_e, details) => {
      if (this.entries.get(pluginId)?.view === view) this.handleRenderProcessGone(pluginId, details.reason)
    })
    view.webContents.on('did-start-navigation', details => {
      if (!details.isMainFrame || details.isSameDocument || this.entries.get(pluginId)?.view !== view || entry.scope.isClosing) return
      if (!entry.documentStarted) { entry.documentStarted = true; return }
      entry.documentEpoch++
      retireInteractionEpoch(entry.scope)
      this.retireMcpRuntime(pluginId, 'navigation')
    })
    if (summary.dev) {
      view.webContents.on('console-message', (details) => {
        if (this.entries.get(pluginId)?.view !== view || entry.scope.isClosing) return
        sendShellEvent({ type: 'plugin-log', pluginId, level: details.level === 'error' || details.level === 'warning' ? 'warn' : 'info', message: details.message.slice(0, 4000) })
      })
    }

    // 外链引流：window.open 与站外导航都不在插件页内打开，
    // 经 routeExternal 门禁（声明 + grant 弹窗）后交给默认浏览器
    view.webContents.setWindowOpenHandler(({ url }) => {
      void routeExternal(pluginId, url)
      return { action: 'deny' }
    })
    view.webContents.on('will-navigate', (e, url) => {
      if (isInternalNavigation(url, pluginId)) return
      e.preventDefault()
      void routeExternal(pluginId, url)
    })

    // quick 容器：拦截插件区域键盘事件（插件持焦时渲染层收不到 Esc/⌘Enter）
    this.hookQuickInput(pluginId, view.webContents, manifest?.permissions?.includes('launcher.access') === true)
    // dev 插件：浏览器同款调试快捷键（F12/⌘⌥I DevTools、⌘R 重载）
    if (summary.dev) this.hookDevShortcuts(pluginId, view.webContents)

    // 加载完成后注入主题 Token（themeAware 时）；透明背景在 load 后再设一次确保生效；
    // 同时推进状态机 ready → （若 active）enter
    let finishingDocumentEpoch = 0
    view.webContents.on('did-finish-load', async () => {
      if (this.entries.get(pluginId) !== entry || entry.scope.isClosing || !entry.documentStarted) return
      const documentEpoch = entry.documentEpoch
      if (finishingDocumentEpoch === documentEpoch) return
      finishingDocumentEpoch = documentEpoch
      if (ui.background === 'transparent') {
        view.setBackgroundColor('#00000000')
      }
      if (ui.themeAware) {
        await this.injectThemeInto(view, ui)
      }
      if (this.entries.get(pluginId) !== entry || entry.scope.isClosing || entry.documentEpoch !== documentEpoch) return
      const state = this.getState(pluginId)
      if (state === 'opening') this.applyTransition(pluginId, 'load-ok')
      else if (state !== 'ready' && state !== 'active' && state !== 'background') return
      const presented = this.isPresented(pluginId)
      view.setVisible(presented)
      // 首次加载完成且已是目标 active（shell Tab 或 quick 挂载中）→ 立刻 enter
      if (presented) {
        this.sendEnter(pluginId)
      } else {
        if (state !== 'background') this.applyTransition(pluginId, 'deactivate')
        this.scheduleHibernate(pluginId)
      }
      sendShellEvent({ type: 'plugin-ready', pluginId, generation: entry.generation })
      if (summary.dev) sendShellEvent({ type: 'plugin-log', pluginId, level: 'info', message: `启动完成：${summary.devUrl ?? rootPath}` })
      this.publishTabs()
      this.enforceAliveLimit()

    })

    const generation = ++this.generation
    const scope = createRuntimeScope({ pluginId, generation, wcId: view.webContents.id })
    if (opts?.backgroundExecution) this.mcpBackgroundPlugins.add(pluginId)
    if (this.mcpBackgroundPlugins.has(pluginId)) setBackgroundNonInteractive(scope, true)
    if (opts?.activationContext) { setActivationContext(scope, opts.activationContext); setBackgroundNonInteractive(scope, true) }
    scope.onActivityChanged(() => { this.scheduleHibernate(pluginId); this.enforceAliveLimit() })
    scope.addDisposer(() => releasePluginEndpoints(pluginId))
    scope.addDisposer(() => ses.closeAllConnections())
    scope.addDisposer(() => releasePluginHotkeys(pluginId))
    scope.addDisposer(() => { contributionRegistry.releaseQuickProviders(pluginId) })
    scope.addDisposer(() => releasePluginActivities(pluginId))
    scope.addDisposer(() => { this.inputContexts.delete(pluginId) })
    scope.addDisposer(() => { if (readQuickEnterInput(pluginId, generation)) forgetQuickEnterInput(pluginId) })
    scope.addDisposer(() => stopPluginProcesses(pluginId, generation))
    scope.addDisposer(() => releaseSockets(pluginId, generation))
    scope.addDisposer(() => releaseLocalFiles(pluginId))
    scope.addDisposer(() => { if (!releasePluginStorage(pluginId)) throw new Error('pending local storage writes retained for retry') })
    const entry: PluginEntry = {
      view, scope, generation, documentEpoch: 1, documentStarted: false,
      buildRevision: pluginRegistry.getBuildRevision(pluginId),
      tabSessionId: resumeIdentity?.tabSessionId ?? this.logicalTabs.get(pluginId)?.tabSessionId ?? randomUUID(),
      pluginId,
      partition,
      rootPath,
      ui,
      layoutMode: mode,
      presentationPending: opts?.deferPresentation || silent,
      pendingLoadUrl: url,
      dirty: false,
      lastActivatedAt: Date.now()
    }
    this.entries.set(pluginId, entry)
    if (operation) operation.entry = entry
    if (opts?.preparation) opts.preparation.entry = entry
    this.lazyDetached.delete(pluginId)
    this.byWcId.set(view.webContents.id, pluginId)

    if (silent && !previousPlacement && !this.logicalTabs.has(pluginId)) {
      // A silent activation has no native parent until a guarded view launch commits.
    } else if (placement.kind === 'detached') {
      const parent = getDetachedParent(pluginId)
      if (!parent) {
        // Prepared launches restore their dormant source through the caller's rollback.
        if (!opts?.preparation) {
          this.entries.delete(pluginId)
          entry.scope.markClosing()
          await this.disposeEntry(entry)
        }
        throw new Error(`${placement.kind} window no longer exists`)
      }
      parent.addChildView(view)
      view.setBounds(getDetachedPluginBounds(pluginId))
    } else if (placement.kind === 'float') {
      const parent = getFloatParent(pluginId)
      if (!parent) {
        if (!opts?.preparation) {
          this.entries.delete(pluginId)
          entry.scope.markClosing()
          await this.disposeEntry(entry)
        }
        throw new Error(`${placement.kind} window no longer exists`)
      }
      parent.addChildView(view)
      view.setBounds(getFloatPluginBounds(pluginId))
      view.setVisible(true)
    } else if (placement.kind === 'quick') {
      // Quick 小窗懒创建：呼出 mini 插件时确保容器存在再挂载
      if (!getQuickWindow()) ensureQuickWindow()
      getQuickPluginParent()?.addChildView(view)
      view.setBounds(getQuickPluginBounds())
    } else {
      const win = getMainWindow()
      if (win) {
        win.contentView.addChildView(view)
        view.setBounds(getPluginContentBounds(pluginChromeBarHeight(ui.chrome)))
        // 插件视图置顶后，圆轨/设置钮视图需要重新放回最顶层
        raiseOrbRailViews()
      }
    }

    raiseTransientViews()
    this.hookNativeTheme()
    if (silent || opts?.resumePlacement) {
      this.startEntryLoad(entry)
    } else if (opts?.deferPresentation) {
      // Keep the old surface and logical tab until the guarded destination commits.
    } else if (detached) {
      this.activateDetached(pluginId, enter)
    } else if (container === 'quick') {
      // quick 挂载即激活语义：立即可见、状态机推进并应用建议尺寸
      this.showQuickPlugin(pluginId)
    } else {
      // 立即激活视图（显示）；enter 事件等 did-finish-load 后再发，避免插件尚未就绪
      this.activatePlugin(pluginId)
    }
    if (!opts?.deferPresentation) this.startEntryLoad(entry)
    // 源码预览的 dev 插件：监听文件变更自动重载；devUrl 模式由框架 HMR 负责；
    // 产物目录预览不挂 watcher，避免构建中途的半成品产物触发重载
    if (summary.dev && summary.devSource) startDevWatch(pluginId, rootPath)
    this.publishTabs()
    // LRU：超限立即驱逐最久未激活的 background 插件
    this.enforceAliveLimit()
    return pluginId
  }

  private startEntryLoad(entry: PluginEntry): void {
    if (!entry.pendingLoadUrl) return
    const url = withMode(entry.pendingLoadUrl, entry.layoutMode)
    entry.pendingLoadUrl = undefined
    void entry.view.webContents.loadURL(url).catch((err: Error) => {
      if (this.entries.get(entry.pluginId) !== entry || entry.scope.isClosing) return
      this.handleRenderProcessGone(entry.pluginId, err.message)
    })
  }

  /**
   * 关闭插件：立即摘除视图和逻辑 Tab，再在共享期限内通知并回收资源。
   * reason 决定 beforeClose 载荷；日常关 Tab 用 tab-close，卸载用 uninstall，退出用 app-quit。
   * 休眠中的插件也可被关闭（无 entry，直接落 closed 语义）。
   * preserveSharedResources 由宿主在同 ID 的 Workspace 仍存活时指定，不停止共享开发服或无代际归属的进程。
   */
  closePlugin(tabId: string, reason: PluginCloseReason = 'tab-close', preserveSession = false, preserveSharedResources = false): Promise<void> {
    const pluginId = toPluginId(tabId)
    const replacing = reason === 'update'
    if (!preserveSharedResources) cancelDevPluginPreparation(pluginId)
    const resourceOwner = this.ensureResourceOwner(pluginId)
    resourceOwner.closing = true
    const quickWasVisible = this.quickPluginId === pluginId
    if (!preserveSession) { this.releaseQuickSession(pluginId); clearQuickInput(pluginId); forgetQuickEnterInput(pluginId) }
    else if (quickWasVisible && !replacing) this.quickSession.hide()
    this.setResidentLease(pluginId, false)
    this.retireMcpRuntime(pluginId, `close:${reason}`)
    if (!preserveSession) this.mcpBackgroundPlugins.delete(pluginId)
    if (!preserveSession) this.closeRevisions.set(pluginId, (this.closeRevisions.get(pluginId) ?? 0) + 1)
    if (!preserveSession) this.restoredSessionIds.add(pluginId)
    this.cancelDetachedRestore(pluginId)
    if (!preserveSession) this.lazyDetached.delete(pluginId)
    this.bumpPlacement(pluginId)
    if (!preserveSession) this.windowSession.remove(pluginId)
    if (!preserveSession || replacing) {
      const reload = this.reloading.get(pluginId)
      if (reload) { reload.cancelled = true; this.reloading.delete(pluginId) }
    }
    const pending = this.closing.get(pluginId)
    const final = this.finalClosing.get(pluginId)
    if (pending && final) {
      if ((!preserveSession || replacing) && !preserveSharedResources) this.stopAllPluginResources(pluginId, final)
      if (!preserveSession && final.preserveSession) {
        final.preserveSession = false
        this.logicalTabs.delete(pluginId)
        if (this.activeTabId === pluginId) this.activeTabId = null
        if (this.getPlacement(pluginId).kind === 'detached') destroyDetachedWindow(pluginId)
        if (this.getPlacement(pluginId).kind === 'float') destroyFloatWindow(pluginId)
        this.placements.delete(pluginId)
        this.detachedVisible.delete(pluginId)
        this.detachedStateSignatures.delete(pluginId)
        sendShellEvent({ type: 'tab-closed', tabId: toTabId(pluginId) })
        this.publishTabs()
      }
      return pending
    }
    const closeOptions: PluginClosingOperation = { preserveSession }
    this.finalClosing.set(pluginId, closeOptions)
    this.suspending.delete(pluginId)
    this.pendingAcks.get(pluginId)?.resolve()
    const deadline = Date.now() + BEFORE_CLOSE_ACK_TIMEOUT
    const opening = this.opening.get(pluginId)
    if (opening) {
      opening.cancelled = true
      if (preserveSharedResources) opening.preserveDevServer = true
    }
    this.clearHibernateTimer(pluginId)
    permissionService.cancelFor(pluginId)
    const entry = this.entries.get(pluginId) ?? this.closingEntries.get(pluginId) ?? this.retiringViews.get(pluginId)
    entry?.scope.markClosing()
    const instanceOnly = preserveSession && !replacing || preserveSharedResources
    // A missing ordinary instance must not release a still-live Workspace's shared resources.
    const stopping = instanceOnly
      ? Promise.allSettled(entry ? [stopPluginProcesses(pluginId, entry.generation)] : [])
      : this.stopAllPluginResources(pluginId, closeOptions)
    const ids = [...this.logicalTabs.keys()]
    const index = ids.indexOf(pluginId)
    const next = ids[index + 1] ?? ids[index - 1]
    if (!preserveSession) this.logicalTabs.delete(pluginId)
    if (!replacing) this.hibernated.delete(pluginId)
    if (entry) {
      this.closingEntries.set(pluginId, entry)
      entry.scope.markClosing()
      this.detachView(entry)
      this.entries.delete(pluginId)
      stopDevWatch(pluginId)
    }
    if (!preserveSession) {
      if (this.getPlacement(pluginId).kind === 'detached') destroyDetachedWindow(pluginId)
      if (this.getPlacement(pluginId).kind === 'float') destroyFloatWindow(pluginId)
      this.placements.delete(pluginId)
      this.detachedVisible.delete(pluginId)
      this.detachedStateSignatures.delete(pluginId)
    }
    if (quickWasVisible && !replacing) {
      setQuickContentSize({ height: QUICK_HOME_HEIGHT })
      sendShellEvent({ type: 'quick-plugin-mode', mode: null })
    }
    const wasActive = this.activeTabId === pluginId
    if (wasActive && !replacing) this.activeTabId = null
    this.applyTransition(pluginId, 'close', reason)
    if (!preserveSession) sendShellEvent({ type: 'tab-closed', tabId: toTabId(pluginId) })
    this.publishTabs()
    let cleanupComplete = false
    const operation = Promise.resolve().then(async () => {
      let failure: unknown
      try {
        if (pending) await pending
        if (entry) {
          try {
            const operationId = randomUUID()
            const ack = this.waitForBeforeCloseAck(pluginId, entry.view.webContents, operationId, deadline - 300)
            this.sendToPlugin(entry.view.webContents, { event: 'beforeClose', reason, operationId })
            await ack
            this.sendToPlugin(entry.view.webContents, { event: 'destroy' })
          } finally {
            await this.disposeEntry(entry, deadline)
            this.byWcId.delete(entry.scope.owner.wcId)
          }
        }
      } catch (error) { failure = error }
      const stops = await stopping
      if (entry) invalidatePluginFileCache(entry.rootPath)
      else {
        const root = pluginRegistry.getRootPath(pluginId)
        if (root) invalidatePluginFileCache(root)
      }
      const rejected = stops.find((result): result is PromiseRejectedResult => result.status === 'rejected')
      if (failure || rejected) throw failure ?? rejected?.reason
      cleanupComplete = true
    }).finally(async () => {
      // A final close may upgrade an instance-only close even after its body resolves.
      // Drain that upgrade before retiring the owner; all later joiners share this promise.
      const fullStops = closeOptions.fullStop ? await closeOptions.fullStop : undefined
      const fullFailure = fullStops?.find((result): result is PromiseRejectedResult => result.status === 'rejected')
      const lateFailure = cleanupComplete && fullFailure
      if (fullFailure) cleanupComplete = false
      // A native destruction failure keeps its retiring guard, but must not keep
      // closed logical-session payloads or queued UI state alive.
      if (!closeOptions.preserveSession) {
        clearPluginSession(pluginId)
        deleteSessionSnapshot(pluginId)
        this.layoutModes.delete(pluginId)
        this.tabPresentation.delete(pluginId)
      }
      this.enterSent.delete(pluginId)
      this.pendingEnter.delete(pluginId)
      this.states.delete(pluginId)
      sendShellEvent({ type: 'plugins-changed' })
      if (this.closing.get(pluginId) === operation) this.closing.delete(pluginId)
      this.finalClosing.delete(pluginId)
      if (cleanupComplete && this.closingEntries.get(pluginId) === entry) this.closingEntries.delete(pluginId)
      else if (!cleanupComplete && entry) this.closingEntries.set(pluginId, entry)
      if (cleanupComplete && this.resourceOwners.get(pluginId) === resourceOwner) this.resourceOwners.delete(pluginId)
      if (entry) this.byWcId.delete(entry.scope.owner.wcId)
      if (lateFailure) throw lateFailure.reason
    })
    this.closing.set(pluginId, operation)
    if (wasActive && !preserveSession && !this.shuttingDown) {
      if (next) this.activatePlugin(next)
      else sendShellEvent({ type: 'plugin-active', tabId: null })
    }
    return operation
  }

  async prepareBuildReplacement(id: string): Promise<(restorable: boolean) => void> {
    const restoring = this.restoringDetached.get(id)
    if (restoring) await restoring.promise
    const release = this.blockPlugin(id, 'replaced')
    try {
      const { releasePluginBackgroundResources } = await import('@main/plugin/pluginBackgroundRuntime')
      releasePluginBackgroundResources(id, 'plugin package replacement')
      const placement = this.getPlacement(id), layoutMode = this.getLayoutMode(id)
      const previousBuild = pluginRegistry.getBuildRevision(id)
      const pathsGeneration = getAppPathsGeneration()
      const closeRevision = this.closeRevisions.get(id), quickRevision = getQuickShowRevision()
      const wasLazy = this.lazyDetached.has(id) || this.hibernated.has(id)
      const close = this.closePlugin(id, 'update', true)
      const revision = this.getPlacementRevision(id)
      await close
      if (placement.kind === 'detached' && getDetachedWindow(id)) this.lazyDetached.add(id)
      return restorable => {
        const build = pluginRegistry.getBuildRevision(id)
        if (restorable && build !== previousBuild) { clearPluginSession(id); deleteSessionSnapshot(id) }
        const current = () => restorable && !this.shuttingDown && !this.barriers.has(id) && pluginRegistry.isEnabled(id) && getAppPathsGeneration() === pathsGeneration
          && !pluginRegistry.get(id)?.dev && pluginRegistry.getBuildRevision(id) === build && this.closeRevisions.get(id) === closeRevision
          && this.getPlacementRevision(id) === revision
        const presented = () => current() && (placement.kind === 'shell' ? this.isShellActive(id)
          : placement.kind === 'quick' ? this.quickPluginId === id && isQuickVisible() && getQuickShowRevision() === quickRevision
          : placement.kind === 'detached' && !wasLazy && !!getDetachedWindow(id)?.isVisible() && this.detachedVisible.get(id) === true)
        const restore = () => {
          release()
          if (!current()) return
          const resume = presented() ? this.openPlugin(id, undefined, { resumePlacement: true, layoutMode, guard: presented }) : undefined
          void resume?.catch(error => { if (current()) logWarn('install', `${id}: restore placement: ${String(error)}`) })
          this.publishTabs()
        }
        void withInstallLock(id, async () => restore()).catch(error => logWarn('install', `${id}: ${String(error)}`))
      }
    } catch (error) { release(); throw error }
  }

  /** 关闭后接班的候选：仅 shell 容器插件（quick 容器的归 quickPluginId 管，不抢主窗激活） */
  /**
   * 激活指定插件（仅 shell 容器语义）：仅显示目标 view，其余隐藏，
   * 并按该插件 chrome 模式更新布局。休眠插件先唤醒重建（openPlugin 冷启动）。
   * 对已加载的插件发送 out（旧 active）/ enter（新 active）对，便于 pause/resume。
   * quick 容器的插件不参与本循环（由 quickPluginId 单独管理可见性），
   * 但 quick 当前挂载的 mini 插件会收到 out（退居 quick 后台）。
   * z-order 优化：activate 不再重复 addChildView + raiseOrbRailViews（由 openPlugin
   * 新增 view 时执行一次）；这里只 setVisible + setBounds，避免每次切换 Tab 重排。
   */
  activatePlugin(tabId: string, enter?: PluginEnterPayload, trustedUserNavigation = false): void {
    const pluginId = toPluginId(tabId)
    if (trustedUserNavigation) this.acceptTrustedNavigation(pluginId)
    const entry = this.entries.get(pluginId)
    if (!entry) {
      if (this.getPlacement(pluginId).kind === 'detached') {
        void this.activateDetachedPlugin(pluginId).catch(error => logWarn('window', String(error)))
        return
      }
      // 唤醒路径：activate 拦截休眠插件 → openPlugin 重建（fire-and-forget，错误走 plugin-error）
      if (this.logicalTabs.has(pluginId) && !this.barriers.has(pluginId)) {
        logInfo('lifecycle', `${pluginId}: hibernated, wake on activate`)
        void this.openPlugin(pluginId, enter, { trustedUserNavigation }).catch((err: Error) => {
          sendShellEvent({ type: 'plugin-error', pluginId, message: err.message })
        })
      }
      return
    }

    entry.presentationPending = false
    const activatingPlacement = this.getPlacement(pluginId)
    if (activatingPlacement.kind === 'detached') { this.activateDetached(pluginId, enter); return }
    if (activatingPlacement.kind === 'float') { showFloatWindow(activatingPlacement.windowId); if (enter) this.pendingEnter.set(pluginId, enter); this.sendEnter(pluginId); return }
    if (activatingPlacement.kind === 'quick') this.migrateContainer(pluginId, 'shell')
    this.suspending.delete(pluginId)
    this.clearHibernateTimer(pluginId)
    entry.lastActivatedAt = Date.now()

    // 旧 active 退后台：先 out 再隐藏；进入 background 后启动空闲休眠计时。
    // 状态已非 active（如 hideAllViews 已置 background）时跳过重复 out，仅刷新计时
    const prevId = this.activeTabId
    this.activeTabId = pluginId
    if (prevId && prevId !== pluginId) {
      const prev = this.entries.get(prevId)
      if (prev && this.getState(prevId) === 'active') {
        this.sendToPlugin(prev.view.webContents, { event: 'out', isKill: false })
      }
      if (this.getState(prevId) === 'active' || this.getState(prevId) === 'ready') this.applyTransition(prevId, 'deactivate')
      this.scheduleHibernate(prevId)
    }

    for (const [id, e] of this.entries) {
      const placement = this.getPlacement(id)
      // quick 容器 view 的可见性由 quickPluginId 管理（quick 挂载不受主窗 Tab 切换影响）
      if (placement.kind === 'detached' || placement.kind === 'float') continue
      if (placement.kind === 'quick') {
        e.view.setVisible(id === this.quickPluginId && this.getState(id) !== 'opening')
        continue
      }
      e.view.setVisible(this.shellVisible && id === pluginId && this.getState(id) !== 'opening')
    }

    if (this.getPlacement(pluginId).kind === 'shell') {
      const win = getMainWindow()
      if (win) {
        entry.view.setBounds(getPluginContentBounds(pluginChromeBarHeight(entry.ui.chrome)))
      }
    }

    // 新 enter 载荷覆盖 pending（显式带 code/payload 时）
    if (enter && (enter.code !== undefined || enter.payload !== undefined)) {
      this.pendingEnter.set(pluginId, enter)
    }

    // 已加载完成才发 enter；opening 态等 did-finish-load 回调里发
    const state = this.getState(pluginId)
    if (state === 'ready' || state === 'active' || state === 'background') {
      if (this.shellVisible) this.sendEnter(pluginId)
      else {
        if (state !== 'background') this.applyTransition(pluginId, 'deactivate')
        this.scheduleHibernate(pluginId)
      }
    }

    sendShellEvent({ type: 'plugin-active', tabId: toTabId(pluginId) })
    this.publishTabs()
  }

  /** 窗口 resize：按容器分流布局（shell 走主窗 bounds；quick 走 quick bounds） */
  layoutAll(): void {
    for (const entry of this.entries.values()) {
      const placement = this.getPlacement(entry.pluginId)
      if (placement.kind === 'detached' || placement.kind === 'float') continue
      if (entry.pluginId !== this.activeTabId && entry.pluginId !== this.quickPluginId) continue
      if (placement.kind === 'quick') {
        entry.view.setBounds(getQuickPluginBounds())
      } else {
        entry.view.setBounds(getPluginContentBounds(pluginChromeBarHeight(entry.ui.chrome)))
      }
    }
  }

  /**
   * 隐藏全部插件视图：回首页/设置/开发者时调用，避免原生层盖住壳子 Tab 与内容。
   * 仅作用于 shell 容器——quick 容器的 view 挂在小窗上，主窗逻辑不得误伤
   * （小窗隐藏时其 contentView 整体不可见，view 自动跟随）。
   * 隐藏后没有可见插件：当前 active 语义上退后台（插件收到 out），activeTabId 置空，
   * 并照常进入空闲休眠计时；再次可见需经 activatePlugin 重新激活。
   */
  hideAllViews(): void {
    for (const entry of this.entries.values()) {
      if (this.getPlacement(entry.pluginId).kind !== 'shell') continue
      try {
        entry.view.setVisible(false)
      } catch {
        // view 可能已销毁
      }
    }
    if (this.activeTabId) {
      const prevId = this.activeTabId
      this.activeTabId = null
      if (this.getState(prevId) === 'active') {
        const prev = this.entries.get(prevId)
        if (prev) {
          this.sendToPlugin(prev.view.webContents, { event: 'out', isKill: false })
        }
        this.applyTransition(prevId, 'deactivate')
      }
      this.scheduleHibernate(prevId)
    }
    this.publishTabs()
  }

  reloadPlugin(tabId: string): void {
    const pluginId = toPluginId(tabId)
    const previous = this.reloading.get(pluginId)
    if (previous) previous.cancelled = true
    const operation = { cancelled: false, promise: Promise.resolve() }
    this.reloading.set(pluginId, operation)
    const layoutMode = this.getLayoutMode(pluginId)
    const reloadPlacement = this.getPlacement(pluginId)
    const summary = pluginRegistry.get(pluginId)
    const rootPath = summary?.rootPath
    if (rootPath) invalidatePluginFileCache(rootPath)
    pluginRegistry.invalidateBuildRevision(pluginId)
    // 换代后，上一代遗留的辅助窗口（桌面悬浮球、画布等）既不能收发消息也不属于
    // 新实例，留着就是点不动也关不掉的僵尸窗口。这里同步收掉，让新实例重建。
    closeStaleAuxiliaryWindows(pluginId)
    // 上一代打开的登录窗口同理：它的结果只属于旧实例，留着只会让用户白登录一次
    closeWebLoginWindows(pluginId)
    const prepare = summary?.dev && summary.sourcePath
      ? import('@main/dev/DevConsole').then(module => module.prepareDevPluginReload(summary,
        () => !operation.cancelled && !this.shuttingDown && !this.barriers.has(pluginId) && isEnabledSync(pluginId)))
      : null
    const close = prepare ? prepare.then(async prepared => {
      if (operation.cancelled) return
      await this.closePlugin(pluginId, 'tab-close', true)
      if (!operation.cancelled && prepared?.isCurrent()) pluginRegistry.addDevPlugin(prepared.summary, prepared.manifest)
    }) : this.closePlugin(pluginId, 'tab-close', true)
    operation.promise = close.then(async () => {
      if (operation.cancelled) return
      const revision = this.getPlacementRevision(pluginId)
      const current = () => !operation.cancelled && !this.shuttingDown && !this.barriers.has(pluginId)
        && this.getPlacementRevision(pluginId) === revision
      await clearCompiledCache(pluginId)
      if (!current()) return
      if (this.reloading.get(pluginId) === operation) this.reloading.delete(pluginId)
      await this.openPlugin(pluginId, undefined, { container: reloadPlacement.kind === 'quick' ? 'quick' : 'shell', layoutMode, guard: current })
    }).finally(() => {
      if (this.reloading.get(pluginId) === operation) this.reloading.delete(pluginId)
    })
    void operation.promise.catch((err: Error) => sendShellEvent({ type: 'plugin-error', pluginId, message: err.message }))
  }

  async openDevTools(tabId: string, mode: 'detach' | 'right' = 'detach'): Promise<void> {
    const pluginId = toPluginId(tabId)
    if (!this.entries.has(pluginId)) await this.openPlugin(pluginId)
    const entry = this.entries.get(pluginId)
    if (!entry || entry.scope.isClosing || entry.view.webContents.isDestroyed()) throw new Error('插件尚未启动，请重试')
    entry.view.webContents.openDevTools({ mode, activate: true })
    if (entry.view.webContents.devToolsWebContents && !entry.view.webContents.devToolsWebContents.isDestroyed()) entry.view.webContents.devToolsWebContents.focus()
  }

  // —— quick 容器：mini 插件内嵌 Quick 小窗 ——

  private publishQuickPresentation(pluginId: string, entering = false): void {
    const token = this.quickSession.capture(), entry = this.entries.get(pluginId)
    if (token?.pluginId !== pluginId || !entry) return
    const revision = ++this.quickPresentationRevision
    const presentation = this.getWindowPresentation(pluginId)
    if (entering) sendShellEvent({ type: 'quick-plugin-mode', mode: { pluginId, ...presentation, loading: this.getState(pluginId) === 'opening' } })
    else sendQuickEvent({ type: 'quick-plugin-presentation', pluginId, presentation })
    if (!presentation.packageIcon) return
    void getCatalogPluginIcon(pluginId).catch(() => undefined).then(icon => {
      if (!icon || revision !== this.quickPresentationRevision || !this.quickSession.matches(token) || this.entries.get(pluginId) !== entry || entry.scope.isClosing) return
      sendQuickEvent({ type: 'quick-plugin-presentation', pluginId, presentation: { ...presentation, icon } })
    })
  }

  /**
   * 在 Quick 小窗挂载 mini 插件（挂载即激活语义）：
   * 若另一插件正占用 quick 容器，先让它退场（out + background + 休眠计时）；
   * 随后显示目标 view、置顶（叠在 quick 渲染层之上）、推 plugin-active，
   * 并按 Quick 固定容器的实际可用区域布局插件。
   */
  showQuickPlugin(pluginId: string, enter?: PluginEnterPayload): void {
    const entry = this.entries.get(pluginId)
    if (!entry) return
    entry.presentationPending = false

    // 换插件：旧 quick 插件退场（保留进程，走休眠策略）
    const previous = this.quickSession.pluginId
    if (previous && previous !== pluginId) {
      this.dismissQuickPluginInternal(previous, false)
    }

    this.suspending.delete(pluginId)
    this.clearHibernateTimer(pluginId)
    this.quickSession.show(pluginId)
    entry.lastActivatedAt = Date.now()

    setQuickContentSize({ height: QUICK_HEIGHT })
    finishQuickPluginReveal()

    for (const candidate of this.entries.values()) {
      if (this.getPlacement(candidate.pluginId).kind === 'quick') candidate.view.setVisible(candidate.pluginId === pluginId && this.getState(candidate.pluginId) !== 'opening')
    }
    // 置顶：摘下重挂到 quick contentView 顶端（叠在 quick 渲染层 view 之上）
    const quickWin = getQuickWindow()
    if (quickWin) {
      try {
        getQuickPluginParent()?.removeChildView(entry.view)
        getQuickPluginParent()?.addChildView(entry.view)
      } catch {
        /* 已不在父视图 */
      }
      entry.view.setBounds(getQuickPluginBounds())
      raiseTransientViews(getQuickWindow() ?? undefined)
    }

    // 新 enter 载荷覆盖 pending（呼出关键词的 code）
    if (enter && (enter.code !== undefined || enter.payload !== undefined || enter.input !== undefined)) {
      this.pendingEnter.set(pluginId, enter)
    }

    const state = this.getState(pluginId)
    // ready/background/active → 立即 enter；opening 等 did-finish-load
    if (state === 'ready' || state === 'active' || state === 'background') {
      this.sendEnter(pluginId)
    }

    // 插件页是原生 view，抢焦点后渲染层收不到 Esc——激活后把焦点还给 quick 渲染层输入框
    if (this.inputContexts.has(pluginId)) this.focusPlugin(pluginId)
    else this.focusQuickShell()

    this.publishQuickPresentation(pluginId, true)
  }

  /**
   * Quick 插件退场回列表态（Esc / 清空输入 / 打开其它命令）：
   * view 隐藏但保留进程（退 background + 启动休眠计时），推 out，
   * 并通知 quick 渲染层回到列表 UI。参数校验防误关 shell 容器插件。
   */
  dismissQuickPlugin(pluginId: string): void {
    clearQuickInput(pluginId)
    if (this.getPlacement(pluginId).kind !== 'quick') return
    this.dismissQuickPluginInternal(pluginId, true)
  }

  /** 退场实现；notify 决定是否推送 quick-plugin-mode(null)（换插件时由新挂载覆盖，跳过） */
  private dismissQuickPluginInternal(pluginId: string, notify: boolean): void {
    clearQuickInput(pluginId)
    const entry = this.entries.get(pluginId)
    if (!this.releaseQuickSession(pluginId)) return
    this.pendingEnter.delete(pluginId)
    finishQuickPluginReveal()
    if (notify) setQuickContentSize({ height: QUICK_HOME_HEIGHT })

    try {
      entry?.view.setVisible(false)
    } catch {
      /* view 可能已销毁 */
    }
    // out + background + 休眠计时（quick 可见期间不得休眠：quickPluginId 恒 null 之后才计时）
    if (entry && this.getState(pluginId) === 'active') {
      this.sendToPlugin(entry.view.webContents, { event: 'out', isKill: false })
      this.applyTransition(pluginId, 'deactivate')
    }
    this.scheduleHibernate(pluginId)

    if (notify) {
      sendShellEvent({ type: 'quick-plugin-mode', mode: null })
    }
    this.focusQuickShell()
  }

  /**
   * 固定到主窗（⌘Enter / UI 按钮）：quick 插件 view 同 webContents 摘下重挂主窗
   * （不重载、不丢状态），Quick 回列表态并收起，主窗前置并激活该插件 Tab。
   * 主窗 Tab 由 plugin-active 事件桥同步；迁移保留原 webContents 与页面状态。
   */
  pinToShell(pluginId: string): void {
    const entry = this.entries.get(pluginId)
    if (!entry || this.getPlacement(pluginId).kind === 'shell') return
    this.migrateContainer(pluginId, 'shell')
    this.activatePlugin(pluginId)
    hideQuickWindow()
    const win = getMainWindow()
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
    }
    logInfo('lifecycle', `${pluginId}: pinned quick → shell`)
  }

  /** Native relocation commits only after attachment succeeds; no runtime ownership changes. */
  private moveEntry(entry: PluginEntry, target: PluginPlacement, mode: PluginLaunchMode): void {
    const id = entry.pluginId, source = this.getPlacement(id)
    if (this.hasWindowInteraction(id) || this.hasPlacementInteraction(target)) throw new Error('finish the native dialog before moving this plugin')
    const parent = (placement: PluginPlacement) => placement.kind === 'detached' ? getDetachedParent(id)
      : placement.kind === 'float' ? getFloatParent(id)
      : placement.kind === 'quick' ? getQuickPluginParent() : getMainWindow()?.contentView
    if (target.kind === 'quick') ensureQuickWindow()
    const sourceParent = parent(source), targetParent = parent(target)
    if (!targetParent) throw new Error('target plugin window is unavailable')
    const oldBounds = entry.view.getBounds()
    const bounds = target.kind === 'detached' ? getDetachedPluginBounds(id)
      : target.kind === 'float' ? getFloatPluginBounds(id)
      : target.kind === 'quick' ? getQuickPluginBounds() : getPluginContentBounds(pluginChromeBarHeight(entry.ui.chrome))
    try {
      sourceParent?.removeChildView(entry.view)
      targetParent.addChildView(entry.view)
      entry.view.setBounds(bounds)
      raiseTransientViews()
    } catch (error) {
      try { targetParent.removeChildView(entry.view); sourceParent?.addChildView(entry.view); entry.view.setBounds(oldBounds) } catch { /* renderer/parent may have closed */ }
      throw error
    }
    this.suspending.delete(id)
    this.clearHibernateTimer(id)
    const previousQuick = this.quickSession.pluginId
    if (target.kind === 'quick' && previousQuick && previousQuick !== id) {
      this.dismissQuickPluginInternal(previousQuick, false)
    }
    this.placements.set(id, target)
    this.bumpPlacement(id)
    this.setLayoutMode(id, mode)
    if (target.kind === 'shell') { clearQuickInput(id); forgetQuickEnterInput(id) }
    // 迁出 quick（固定到主窗 / 分离 / 悬浮）后，呼出不再把它拽回小窗
    if (source.kind === 'quick' && target.kind !== 'quick' && this.releaseQuickSession(id)) {
      finishQuickPluginReveal()
      setQuickContentSize({ height: QUICK_HOME_HEIGHT })
      sendShellEvent({ type: 'quick-plugin-mode', mode: null })
    }
    // Commit Quick ownership before publishing any other detached snapshots. Their
    // input reads prune abandoned owners, so an intermediate null would lose query state.
    if (target.kind === 'quick') this.quickSession.show(id)
    const oldTabIds = [...this.logicalTabs.keys()]
    if (target.kind === 'shell') {
      if (!this.logicalTabs.has(id)) this.logicalTabs.set(id, { title: pluginRegistry.get(id)?.name ?? id, tabSessionId: entry.tabSessionId })
      raiseOrbRailViews()
    } else this.logicalTabs.delete(id)
    if (target.kind === 'shell' || target.kind === 'detached') this.windowSession.retain(id, this.tabPresentation.get(id)?.title ?? pluginRegistry.get(id)?.name ?? id)
    if (target.kind === 'detached') {
      const history = getDetachedWindowSession(id)
      if (history) this.windowSession.setDetached(id, history)
    } else this.windowSession.clearDetached(id)
    if (source.kind === 'shell' && this.activeTabId === id && target.kind !== 'shell') {
      this.activeTabId = null
      const index = oldTabIds.indexOf(id), next = oldTabIds[index + 1] ?? oldTabIds[index - 1]
      if (next) this.activatePlugin(next)
      else sendShellEvent({ type: 'plugin-active', tabId: null })
    }
    if (source.kind === 'detached' && target.kind !== 'detached') {
      this.detachedVisible.delete(id)
      this.detachedStateSignatures.delete(id)
      destroyDetachedWindow(id)
    }
    // 离开悬浮窗：收掉空窗并恢复主窗 Tab。浮窗期间 Tab 条上没有它，这里补回并激活。
    if (source.kind === 'float' && target.kind !== 'float') {
      destroyFloatWindow(id)
      if (target.kind === 'shell') {
        this.windowSession.retain(id, this.tabPresentation.get(id)?.title ?? pluginRegistry.get(id)?.name ?? id)
        this.activatePlugin(id)
        const win = getMainWindow()
        if (win && !win.isDestroyed()) { if (win.isMinimized()) win.restore(); win.show(); win.focus() }
      }
    }
    this.sendPlacementChange(id)
    this.publishTabs()
  }

  /** 当前挂载位置（enest.ui.onPlacementChange / getPlacementKind 消费） */
  getPlacementKind(pluginId: string): PluginPlacementKind {
    return this.getPlacement(pluginId).kind
  }

  private sendPlacementChange(pluginId: string): void {
    const entry = this.entries.get(pluginId)
    if (!entry) return
    const placement = this.getPlacement(pluginId)
    const payload: PluginEventPayload = {
      type: 'placement-change', placement: placement.kind,
      ...(placement.kind === 'float' ? { alwaysOnTop: getFloatWindow(placement.windowId)?.isAlwaysOnTop() ?? false } : {})
    }
    try {
      if (!entry.view.webContents.isDestroyed()) entry.view.webContents.send(IpcChannels.PluginEvent, payload)
    } catch {
      // webContents 可能正在销毁
    }
  }

  /**
   * 把插件现有视图迁入悬浮窗（不重载、不重建实例）。权限在 IPC 分发层校验。
   * 已在悬浮窗时只应用置顶变化；在 Quick 小窗时迁出。
   */
  async floatPlugin(pluginId: string, rawOptions: unknown): Promise<boolean> {
    pluginId = toPluginId(pluginId)
    if (!this.entries.has(pluginId)) await this.openPlugin(pluginId)
    let entered = false
    await this.transfer(pluginId, async () => {
      const entry = this.entries.get(pluginId)
      if (!entry || entry.scope.isClosing || this.shuttingDown || this.barriers.has(pluginId)) throw new Error('plugin is unavailable')
      if (this.hasWindowInteraction(pluginId)) throw new Error('finish the native dialog before moving this plugin')
      const options = normalizeFloatOptions(rawOptions)
      const current = this.getPlacement(pluginId)
      if (current.kind === 'float') { setFloatAlwaysOnTop(current.windowId, options.alwaysOnTop); return }
      const revision = this.getPlacementRevision(pluginId)
      const win = createFloatWindow(pluginId, options, this.windowSession.get(pluginId)?.float)
      if (this.entries.get(pluginId) !== entry || entry.scope.isClosing || this.shuttingDown || this.getPlacementRevision(pluginId) !== revision || this.hasWindowInteraction(pluginId)) {
        destroyFloatWindow(pluginId)
        throw new Error('plugin move was cancelled')
      }
      try {
        this.moveEntry(entry, { kind: 'float', windowId: win.id }, this.getLayoutMode(pluginId))
        showFloatWindow(win.id)
        entry.view.webContents.focus()
      } catch (error) {
        if (this.getPlacement(pluginId).kind !== 'float') destroyFloatWindow(pluginId)
        throw error
      }
      entered = true
    })
    return entered
  }

  /** 退出悬浮窗：视图迁回主窗 Tab 并激活（不重载）；非悬浮挂载时为无操作。 */
  async exitFloat(pluginId: string): Promise<boolean> {
    pluginId = toPluginId(pluginId)
    if (this.getPlacement(pluginId).kind !== 'float') return false
    let exited = false
    await this.transfer(pluginId, async () => {
      const entry = this.entries.get(pluginId)
      if (!entry || this.getPlacement(pluginId).kind !== 'float') return
      if (this.hasWindowInteraction(pluginId)) throw new Error('finish the native dialog before moving this plugin')
      this.moveEntry(entry, { kind: 'shell' }, this.getLayoutMode(pluginId))
      exited = true
    })
    return exited
  }

  /** Float window host callback: the user closed the chrome-less window. */
  async leaveFloatByHost(pluginId: string): Promise<void> {
    try { await this.exitFloat(pluginId) } catch (error) { logWarn('window', `${pluginId}: leave float failed: ${String(error)}`) }
  }

  /**
   * `pin.create` revoked while floating: drop below other applications but keep
   * the window, so a running playback is not interrupted.
   */
  revokeFloatTopmost(pluginId: string): void {
    const placement = this.getPlacement(pluginId)
    if (placement.kind !== 'float') return
    setFloatAlwaysOnTop(placement.windowId, false)
    this.sendPlacementChange(pluginId)
  }

  /** Float window host callback: bounds or topmost state settled. */
  persistFloatGeometry(pluginId: string): void {
    if (this.getPlacement(pluginId).kind !== 'float') return
    const geometry = getFloatGeometry(pluginId)
    if (geometry) this.windowSession.setFloat(pluginId, geometry)
    this.sendPlacementChange(pluginId)
  }

  private migrateContainer(pluginId: string, container: PluginContainer, layoutMode: PluginLaunchMode = container): void {
    const entry = this.entries.get(pluginId)
    if (!entry) return
    const mode = this.modeFor(pluginId, layoutMode)
    if (this.getPlacement(pluginId).kind === container && !(entry.presentationPending && container === 'shell' && !this.logicalTabs.has(pluginId))) {
      this.setLayoutMode(pluginId, mode)
      return
    }
    // 目标容器布局未适配时按默认视图渲染（入口级回退在 pluginLauncher 已先行分流）。
    this.moveEntry(entry, { kind: container }, mode)
  }

  /** Retire only an uncommitted renderer still owned by this preparation, never an adopted runtime. */
  private async rollbackPreparedPresentation({ entry, source }: PluginPreparation): Promise<void> {
    if (!entry?.pendingLoadUrl || !entry.presentationPending || !source) return
    const pluginId = entry.pluginId
    if (this.entries.get(pluginId) !== entry || this.getPlacementRevision(pluginId) !== source.revision) return
    this.detachView(entry)
    this.entries.delete(pluginId)
    stopDevWatch(pluginId)
    entry.scope.markClosing()
    this.pendingEnter.delete(pluginId)
    if (source.placement) this.placements.set(pluginId, source.placement)
    else this.placements.delete(pluginId)
    const mode = source.layoutMode
    if (mode) this.setLayoutMode(pluginId, mode)
    else this.layoutModes.delete(pluginId)
    if (source.state) this.states.set(pluginId, source.state)
    else this.states.delete(pluginId)
    if (source.hibernated) { this.hibernated.set(pluginId, source.hibernated); releaseSessionMemory(pluginId) }
    if (source.lazyDetached) this.lazyDetached.add(pluginId)
    const cleanup = this.disposeEntry(entry).finally(() => { if (this.closing.get(pluginId) === cleanup) this.closing.delete(pluginId) })
    this.closing.set(pluginId, cleanup)
    await cleanup.catch(error => logWarn('lifecycle', `cancelled presentation cleanup failed: ${String(error)}`))
    this.publishTabs()
  }

  private transfer(pluginId: string, action: () => Promise<void>): Promise<void> {
    const previous = this.transfers.get(pluginId)
    const operation = (previous ? previous.catch(() => {}) : Promise.resolve()).then(action)
    this.transfers.set(pluginId, operation)
    void operation.finally(() => { if (this.transfers.get(pluginId) === operation) this.transfers.delete(pluginId) }).catch(() => {})
    return operation
  }

  async detachPlugin(pluginId: string, position?: { x: number; y: number }, guard?: () => boolean): Promise<void> {
    pluginId = toPluginId(pluginId)
    if (guard && !guard()) throw new Error('plugin move was cancelled')
    if (!this.entries.has(pluginId)) await this.openPlugin(pluginId)
    return this.transfer(pluginId, async () => {
      if (guard && !guard()) throw new Error('plugin move was cancelled')
      const entry = this.entries.get(pluginId)
      if (!entry || entry.scope.isClosing || this.shuttingDown || this.barriers.has(pluginId)) throw new Error('plugin is unavailable')
      if (this.hasWindowInteraction(pluginId)) throw new Error('finish the native dialog before moving this plugin')
      if (this.getPlacement(pluginId).kind === 'detached') { this.activateDetached(pluginId); return }
      const revision = this.getPlacementRevision(pluginId)
      const bounds = entry.view.getBounds()
      const win = await createDetachedWindow(pluginId, entry.layoutMode, bounds, position)
      if (this.entries.get(pluginId) !== entry || entry.scope.isClosing || this.shuttingDown || this.getPlacementRevision(pluginId) !== revision || this.hasWindowInteraction(pluginId) || guard && !guard()) {
        destroyDetachedWindow(pluginId)
        throw new Error('plugin move was cancelled')
      }
      try {
        this.moveEntry(entry, { kind: 'detached', windowId: win.id }, entry.layoutMode)
        this.activateDetached(pluginId)
      } catch (error) {
        if (this.getPlacement(pluginId).kind !== 'detached') destroyDetachedWindow(pluginId)
        throw error
      }
    })
  }

  /** Reuse the runtime at a native destination without re-deriving an already resolved layout. */
  async launchPluginIn(
    pluginId: string,
    target: PluginContainer,
    enter?: PluginEnterPayload,
    guard: () => boolean = () => true,
    layoutMode: PluginLaunchMode = target,
    trustedNavigation = true
  ): Promise<void> {
    pluginId = toPluginId(pluginId)
    const closeRevision = this.closeRevisions.get(pluginId) ?? 0
    const current = () => guard() && (this.closeRevisions.get(pluginId) ?? 0) === closeRevision
      && !this.shuttingDown && !this.barriers.has(pluginId)
    const check = () => {
      if (!current()) throw new Error('plugin launch cancelled')
      if (!isEnabledSync(pluginId)) throw new Error(`plugin disabled: ${pluginId}`)
      if (this.hasWindowInteraction(pluginId) || this.hasPlacementInteraction({ kind: target })) {
        throw new Error('请先完成窗口中的文件选择或系统对话框，再启动插件')
      }
    }
    check()
    const reloading = this.reloading.get(pluginId)
    if (reloading) {
      await reloading.promise
      if (reloading.cancelled) throw new Error('plugin launch cancelled')
    }
    check()
    let launchEntry: PluginEntry | undefined
    return this.transfer(pluginId, async () => {
      const checkAvailable = () => {
        check()
        if (this.reloading.has(pluginId)) throw new Error('插件正在重新加载，请稍后重试')
      }
      checkAvailable()
      const restoring = this.restoringDetached.get(pluginId)
      if (restoring) { await restoring.promise; if (restoring.cancelled) throw new Error('plugin launch cancelled') }
      checkAvailable()
      const closing = this.closing.get(pluginId)
      if (closing) await closing
      checkAvailable()
      const opening = this.opening.get(pluginId)
      if (opening) await opening.promise
      checkAvailable()
      const preparation: PluginPreparation = {}
      const revision = this.getPlacementRevision(pluginId)
      const sourceEntry = this.entries.get(pluginId)
      // Ordinary opens do not use the transfer queue, so retain ownership across every async preparation.
      const presentationCurrent = () => current() && !this.reloading.has(pluginId)
        && this.getPlacementRevision(pluginId) === revision
        && this.entries.get(pluginId) === (sourceEntry ?? preparation.entry)
      const checkPresentation = () => {
        checkAvailable()
        if (!presentationCurrent()) throw new Error('plugin launch cancelled')
      }
      try {
        if (target === 'quick' && !await prepareQuickWindowForPlugin(presentationCurrent)) throw new Error('Quick window preparation was cancelled or failed')
        checkPresentation()
        if (!this.entries.has(pluginId)) {
          if (!trustedNavigation) throw new Error('MCP runtime is no longer available')
          await this.openPlugin(pluginId, enter, { container: target, layoutMode, deferPresentation: true, guard: presentationCurrent, preparation })
        }
        checkPresentation()
        const entry = this.entries.get(pluginId)
        if (!entry || entry.scope.isClosing || entry.view.webContents.isDestroyed()) throw new Error('插件尚未就绪，请重试')
        launchEntry = entry
        const commit = () => {
          // Presentation increments Quick's show revision; all external guards were
          // checked immediately before this synchronous native attachment transaction.
          if (this.entries.get(pluginId) !== entry || entry.scope.isClosing
            || this.getPlacementRevision(pluginId) !== revision || this.reloading.has(pluginId)) throw new Error('plugin launch cancelled')
          if (trustedNavigation) this.acceptTrustedNavigation(pluginId)
          else {
            const runtime = this.getMcpRuntime(pluginId)
            if (!runtime || hasNonInteractiveLease(runtime.scope)) throw new Error('Plugin is busy')
            this.restrictMcpInteraction(pluginId, runtime)
            setActivationContext(runtime.scope, 'view')
          }
          const placement = this.getPlacement(pluginId)
          const mode = this.modeFor(pluginId, layoutMode)
          if (placement.kind !== target || target === 'shell' && !this.logicalTabs.has(pluginId)) {
            this.moveEntry(entry, { kind: target }, mode)
          } else this.setLayoutMode(pluginId, mode)
          if (target === 'quick') this.showQuickPlugin(pluginId, enter)
          else this.activatePlugin(pluginId, enter)
          this.startEntryLoad(entry)
        }
        if (target === 'quick') {
          if (!presentQuickWindowForPlugin(commit)) throw new Error('Quick window could not be presented')
        } else commit()
        this.enforceAliveLimit()
      } catch (error) {
        await this.rollbackPreparedPresentation(preparation)
        throw error
      }
    }).finally(() => {
      if (launchEntry?.presentationPending && this.entries.get(pluginId) === launchEntry) this.pendingEnter.delete(pluginId)
      this.scheduleHibernate(pluginId)
      this.enforceAliveLimit()
    })
  }

  async dockPlugin(pluginId: string, target: 'shell' | 'quick', index?: number, guard?: () => boolean): Promise<void> {
    pluginId = toPluginId(pluginId)
    if (guard && !guard()) throw new Error('plugin move was cancelled')
    if (target !== 'shell' && target !== 'quick') throw new Error('invalid plugin target')
    const restoring = this.restoringDetached.get(pluginId)
    if (restoring) {
      await restoring.promise
      if (restoring.cancelled || guard && !guard()) throw new Error('plugin move was cancelled')
    }
    const lazySource = this.lazyDetached.has(pluginId) ? this.placements.get(pluginId) : undefined
    return this.transfer(pluginId, async () => {
      if (this.shuttingDown || this.barriers.has(pluginId) || guard && !guard()) throw new Error('plugin move was cancelled')
      if (lazySource && this.placements.get(pluginId) !== lazySource) throw new Error('plugin move was cancelled')
      const revision = this.getPlacementRevision(pluginId)
      // An activation can start before this transfer, or while it is queued. It
      // already owns a destination even before its WebContents is allocated.
      // Never tear down that native window until the creation attempt settles.
      const opening = this.opening.get(pluginId)
      if (opening) await opening.promise
      const allowed = () => !this.shuttingDown && !this.barriers.has(pluginId) && this.getPlacementRevision(pluginId) === revision && (!guard || guard())
      if (opening?.cancelled || !allowed()) throw new Error('plugin move was cancelled')
      if (target === 'shell' && this.lazyDetached.has(pluginId) && !this.entries.has(pluginId)) {
        if (this.getPlacement(pluginId).kind !== 'detached') throw new Error('plugin move was cancelled')
        if (this.hasWindowInteraction(pluginId) || this.hasPlacementInteraction({ kind: 'shell' })) throw new Error('finish the native dialog before moving this plugin')
        this.placements.set(pluginId, { kind: 'shell' })
        this.setLayoutMode(pluginId, this.modeFor(pluginId, 'shell'))
        this.bumpPlacement(pluginId)
        this.lazyDetached.delete(pluginId)
        this.detachedVisible.delete(pluginId)
        this.detachedStateSignatures.delete(pluginId)
        this.logicalTabs.set(pluginId, { title: pluginRegistry.get(pluginId)?.name ?? pluginId, tabSessionId: randomUUID() })
        this.windowSession.clearDetached(pluginId)
        destroyDetachedWindow(pluginId)
        if (index !== undefined) this.reorderPlugin(pluginId, index)
        else this.publishTabs()
        const win = getMainWindow()
        if (win && !win.isDestroyed()) { if (win.isMinimized()) win.restore(); win.show(); win.focus() }
        return
      }
      if (!this.entries.has(pluginId)) await this.openPlugin(pluginId)
      if (!allowed()) throw new Error('plugin move was cancelled')
      const entry = this.entries.get(pluginId)
      if (!entry || entry.scope.isClosing || this.shuttingDown || this.barriers.has(pluginId)) throw new Error('plugin is unavailable')
      if (this.hasWindowInteraction(pluginId) || this.hasPlacementInteraction({ kind: target })) throw new Error('finish the native dialog before moving this plugin')
      const current = () => this.entries.get(pluginId) === entry && !entry.scope.isClosing && !this.shuttingDown && !this.barriers.has(pluginId) && !this.hasWindowInteraction(pluginId) && !this.hasPlacementInteraction({ kind: target }) && this.getPlacementRevision(pluginId) === revision && (!guard || guard())
      if (target === 'quick' && !await prepareQuickWindowForPlugin(current)) throw new Error('Quick window preparation was cancelled or failed')
      if (!current()) throw new Error('plugin move was cancelled')
      if (target === 'quick') {
        if (!presentQuickWindowForPlugin(() => this.migrateContainer(pluginId, target))) throw new Error('Quick window could not be presented')
        this.showQuickPlugin(pluginId)
      }
      else {
        this.migrateContainer(pluginId, target)
        if (index !== undefined) this.reorderPlugin(pluginId, index)
        this.activatePlugin(pluginId)
        const win = getMainWindow()
        if (win && !win.isDestroyed()) { if (win.isMinimized()) win.restore(); win.show(); win.focus() }
      }
    })
  }

  reorderPlugin(pluginId: string, index: number): void {
    pluginId = toPluginId(pluginId)
    if (!Number.isFinite(index) || this.getPlacement(pluginId).kind !== 'shell') return
    const tab = this.logicalTabs.get(pluginId)
    if (!tab) return
    const entries = [...this.logicalTabs].filter(([id]) => id !== pluginId)
    entries.splice(Math.max(0, Math.min(entries.length, Math.floor(index))), 0, [pluginId, tab])
    this.logicalTabs = new Map(entries)
    this.windowSession.orderShell([...this.logicalTabs.keys()])
    this.publishTabs()
  }

  /**
   * 拦截 quick 容器插件区域键盘：Esc → 回列表（quickHandlers 消费），
   * ⌘/Ctrl+Enter → 固定到主窗。插件 view 抢焦后渲染层收不到按键，必须在此拦。
   * 直接调本类 dismiss/pin，与渲染层按钮同一入口，行为一致。
   */
  private hookQuickInput(pluginId: string, wc: WebContents, usesLauncher: boolean): void {
    const acceptInput = () => {
      const entry = this.entries.get(pluginId)
      if (usesLauncher && entry?.view.webContents === wc && wc.isFocused() && this.isPresented(pluginId) && !hasNonInteractiveLease(entry.scope)) {
        this.launcherInput.set(wc, { epoch: entry.documentEpoch, until: Date.now() + 2000 })
      }
      if (this.mcpBackgroundPlugins.has(pluginId) && entry?.view.webContents === wc
        && this.isPresented(pluginId) && wc.isFocused()) this.acceptTrustedNavigation(pluginId)
    }
    wc.on('before-mouse-event', (_event, input) => { if (input.type === 'mouseDown') acceptInput() })
    wc.on('before-input-event', (_e, input) => {
      if (input.type === 'keyDown' && !input.isAutoRepeat) acceptInput()
      if (!this.isQuickInputOwner(pluginId)) return
      const action = quickInputAction(input, this.inputContexts.get(pluginId) ?? 'workbench')
      if (action === 'search') {
        _e.preventDefault()
        this.focusSearch(pluginId)
      } else if (action === 'dismiss') {
        _e.preventDefault()
        if (!input.isAutoRepeat) {
          if (this.getPlacement(pluginId).kind === 'detached') {
            if (!escapeQuickInput(pluginId)) this.focusPlugin(pluginId)
          }
          else this.dismissQuickPlugin(pluginId)
        }
      } else if (action === 'pin') {
        _e.preventDefault()
        this.pinToShell(pluginId)
      }
    })
  }

  /**
   * dev 插件调试快捷键（仅 dev 插件挂载）：F12/⌘⌥I/Ctrl+Shift+I toggle DevTools，
   * ⌘/Ctrl+R 重载（重跑入口解析，开发服务掉线时会自动重新拉起）。
   * 插件 view 抢焦后渲染层收不到按键，必须主进程拦截。
   */
  private hookDevShortcuts(pluginId: string, wc: WebContents): void {
    wc.on('before-input-event', (event, input) => {
      const action = devShortcutAction(input)
      if (!action) return
      event.preventDefault()
      if (action === 'devtools') toggleDevTools(wc)
      else this.reloadPlugin(pluginId)
    })
  }

  /** 把键盘焦点还给 Quick 渲染层（挂载/退场后输入条立即可输入） */
  private focusQuickShell(): void {
    const wc = getQuickWebContents()
    if (wc && !wc.isDestroyed()) {
      try {
        wc.focus()
      } catch {
        /* ignore */
      }
    }
  }

  /** 兼容 ui.resize/setHeight；Quick 固定尺寸、桌面由用户调整，插件请求不改变窗体。 */
  resizePlugin(_pluginId: string, _size: { width?: number; height?: number }): void {}

  /** 是否已有打开的插件 View（开发加载前判断是否需要强制重建） */
  isOpen(pluginId: string): boolean {
    return this.entries.has(pluginId)
  }

  /** 取插件存活 webContents（未打开/已销毁返回 null）：pluginHandlers / quickProviders 消费 */
  getWebContents(pluginId: string): WebContents | null {
    const wc = this.entries.get(pluginId)?.view.webContents
    if (!wc) return null
    try {
      if (wc.isDestroyed()) return null
    } catch {
      return null
    }
    return wc
  }

  /** 向指定插件推送 plugin:event 负载（找不到/已销毁静默丢弃） */
  sendEvent(pluginId: string, payload: PluginEventPayload): void {
    if (payload.type === 'mode-change' && payload.mode === 'shell') clearQuickInput(pluginId)
    const wc = this.getWebContents(pluginId)
    if (!wc) return
    try {
      wc.send(IpcChannels.PluginEvent, payload)
    } catch {
      // webContents 可能正在销毁
    }
  }

  /** 向所有已打开插件广播 plugin:event 负载（locale-change 等全量通知） */
  broadcastEvent(payload: PluginEventPayload): void {
    for (const entry of this.entries.values()) {
      this.sendEvent(entry.pluginId, payload)
    }
  }

  /** 插件上报未保存标记（plugin:call state.setDirty）；休眠插件无活动渲染进程，忽略 */
  setPluginDirty(pluginId: string, dirty: boolean): void {
    const entry = this.entries.get(pluginId)
    if (!entry) return
    entry.dirty = dirty === true
  }

  /** 运行中插件的脏状态快照（名称优先 Tab 标题，兜底 manifest 名 / id） */
  getDirtySnapshot(): Array<{ pluginId: string; name: string; dirty: boolean }> {
    return [...this.entries.values()].map((entry) => ({
      pluginId: entry.pluginId,
      name: this.getPluginName(entry.pluginId),
      dirty: entry.dirty
    }))
  }

  /**
   * 一键保存：向所有运行中插件定向发送 save.requested 通知（operationId 逐插件唯一），
   * 复用 beforeClose 的 ack 通道等待插件持久化完成；ack 成功清除 dirty。
   * 超时 / 无监听器不阻塞汇总（与退出加固的放行语义一致，由调用方决定是否继续）。
   */
  async requestSaveAll(reason: ShellSaveReason): Promise<PluginSaveSummary> {
    const deadlineMs = SAVE_REQUEST_ACK_TIMEOUT_MS
    const deadline = Date.now() + deadlineMs
    const entries = [...this.entries.values()]
    const dirtyBefore = entries.filter((entry) => entry.dirty).length
    const results = await Promise.all(
      entries.map(async (entry) => {
        const operationId = `save:${randomUUID()}`
        const ack = this.waitForBeforeCloseAck(entry.pluginId, entry.view.webContents, operationId, deadline - 300)
        this.sendEvent(entry.pluginId, {
          type: 'shell-notice',
          notice: createShellNotice('save.requested', { reason, operationId, deadlineMs })
        })
        const ok = await ack
        if (ok) entry.dirty = false
        return ok
      })
    )
    const acked = results.filter(Boolean).length
    return { total: entries.length, acked, timedOut: entries.length - acked, dirtyBefore }
  }

  /** 插件展示名：Tab 演示态 → manifest → id */
  private getPluginName(pluginId: string): string {
    return (
      this.tabPresentation.get(pluginId)?.title ||
      this.logicalTabs.get(pluginId)?.title ||
      pluginRegistry.get(pluginId)?.name ||
      pluginId
    )
  }

  /** 向所有已打开的 themeAware 插件广播当前主题（壳子 setTheme / nativeTheme 变化时调用） */
  broadcastTheme(): void {
    broadcastAuxiliaryTheme()
    for (const entry of this.entries.values()) {
      if (!entry.ui.themeAware) continue
      const resolved = resolveThemeTokens(entry.ui.preferredColorScheme)
      const payload: PluginEventPayload = {
        type: 'theme-change',
        mode: resolved.mode,
        tokens: resolved.tokens
      }
      try {
        if (!entry.view.webContents.isDestroyed()) {
          // CSS 变量即时写入 + IPC 事件供插件 enest.ui.onThemeChange 订阅
          void entry.view.webContents.executeJavaScript(
            themeTokensToInjectScript(resolved, {
              transparent: entry.ui.background === 'transparent'
            }),
            true
          ).catch(() => { /* renderer may close during theme injection */ })
          entry.view.webContents.send(IpcChannels.PluginEvent, payload)
          const appearance = appearanceService.getAppearance(entry.ui.preferredColorScheme)
          entry.view.webContents.send(IpcChannels.PluginEvent, {
            type: 'appearance-change',
            appearance
          } satisfies PluginEventPayload)
        }
      } catch {
        // view 可能正在销毁
      }
    }
  }

  /** 首次加载完成后向单个 view 注入主题 Token */
  private async injectThemeInto(view: WebContentsView, ui: PluginUiConfig): Promise<void> {
    try {
      if (view.webContents.isDestroyed()) return
      const resolved = resolveThemeTokens(ui.preferredColorScheme)
      await view.webContents.executeJavaScript(
        themeTokensToInjectScript(resolved, { transparent: ui.background === 'transparent' }),
        true
      )
    } catch {
      // 页面可能尚未 ready 或已销毁
    }
  }

  /** 挂载 nativeTheme 监听：shell 模式为 system 时，OS 主题切换触发广播 */
  private hookNativeTheme(): void {
    if (this.nativeThemeHooked) return
    this.nativeThemeHooked = true
    nativeTheme.on('updated', () => {
      this.broadcastTheme()
    })
  }

  /** 关闭所有插件，清空状态（窗口关闭或应用退出时调用；等待全部 close 闭环） */
  async destroyAll(reason: PluginCloseReason = 'app-quit'): Promise<void> {
    this.prepareSessionShutdown()
    this.shuttingDown = true
    this.activeTabId = null
    this.releaseQuickSession()
    // 清掉全部休眠计时器（含后台插件）
    for (const pluginId of [...this.hibernateTimers.keys()]) {
      this.clearHibernateTimer(pluginId)
    }
    const closes = await Promise.allSettled([...new Set([
      ...this.restoringDetached.keys(), ...this.placements.keys(), ...this.logicalTabs.keys(), ...this.hibernated.keys(),
      ...this.entries.keys(), ...this.opening.keys(), ...this.closing.keys(), ...this.reloading.keys(),
      ...this.closingEntries.keys(), ...this.retiringViews.keys(), ...this.resourceOwners.keys()
    ])].map((id) => this.closePlugin(id, reason)))
    // 休眠记录随退出清空（快照仍在 enest.db，但下次启动不自动恢复休眠 Tab 的进程）
    await Promise.allSettled([...this.transfers.values()])
    await Promise.allSettled([...this.restoringDetached.values()].map(operation => operation.promise))
    this.hibernated.clear()
    this.layoutModes.clear()
    this.placements.clear()
    this.lazyDetached.clear()
    this.mcpBackgroundPlugins.clear()
    const failures = closes.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'Plugin resource cleanup incomplete during shutdown')
  }

  // —— 内部：状态机 + 事件发送 ——

  /** 推进状态机；非法转移只记日志，不抛出（避免拖垮关闭/卸载主路径） */
  private applyTransition(
    pluginId: string,
    action: PluginLifecycleAction,
    detail?: string
  ): void {
    const from = this.getState(pluginId)
    const to = nextState(from, action)
    if (!to) {
      logWarn('lifecycle', `${pluginId}: illegal transition ${from} --${action}--> (ignored)`)
      return
    }
    this.states.set(pluginId, to)
    logInfo(
      'lifecycle',
      `${pluginId}: ${from} → ${to} (${action}${detail ? `: ${detail}` : ''})`
    )
  }

  /**
   * 发送 enter。
   * 性能约定：首次 enter 带完整 code/payload；之后的 activate 若无新载荷，
   * 仍发 enter（与 out 成对，插件可 resume）但不重放原始载荷。
   */
  private sendEnter(pluginId: string): void {
    const entry = this.entries.get(pluginId)
    if (!entry) return
    const pending = this.pendingEnter.get(pluginId)
    const isFirst = !this.enterSent.has(pluginId)

    const message: PluginLifecycleMessage = {
      event: 'enter',
      tabId: toTabId(pluginId),
      // 启动方式随 enter 下发：插件可据此（或 getLaunchMode）选择入口样式
      mode: entry.layoutMode,
      ...(isFirst || pending
        ? { code: pending?.code, type: pending?.type, payload: pending?.payload, input: pending?.input }
        : {})
    }

    if (pending) this.pendingEnter.delete(pluginId)
    if (isFirst || pending) {
      // Publish before onEnter can synchronously request its context; resume does not replay or clear it.
      rememberQuickEnterInput(pluginId, entry.generation, this.isQuickInputOwner(pluginId) ? pending?.input : undefined)
    }
    this.enterSent.add(pluginId)
    this.windowSession.focus(pluginId)
    this.sendToPlugin(entry.view.webContents, message)
    if (this.getState(pluginId) !== 'active') this.applyTransition(pluginId, 'activate')
  }

  /**
   * 等待插件 ack，最多 BEFORE_CLOSE_ACK_TIMEOUT；无插件在听也照常超时放行。
   * webContents 已销毁时 ack 永远不会来，直接放行（避免向死目标空等 1500ms）。
   */
  private waitForBeforeCloseAck(pluginId: string, wc: WebContents | undefined, operationId: string, deadline: number): Promise<boolean> {
    this.pendingAcks.get(pluginId)?.resolve(false)
    return new Promise((resolve) => {
      if (!wc || wc.isDestroyed()) return resolve(false)
      const finish = (success = false) => {
        clearTimeout(timer)
        wc.removeListener('destroyed', finish)
        if (this.pendingAcks.get(pluginId)?.operationId === operationId) this.pendingAcks.delete(pluginId)
        resolve(success === true)
      }
      const timer = setTimeout(finish, Math.max(0, deadline - Date.now()))
      wc.once('destroyed', finish)
      this.pendingAcks.set(pluginId, { wcId: wc.id, operationId, resolve: finish })
    })
  }

  /** 向插件 webContents 推送生命周期消息；已销毁则静默忽略 */
  private sendToPlugin(wc: WebContents | undefined, message: PluginLifecycleMessage): void {
    try {
      if (!wc || wc.isDestroyed()) return
      wc.send(IpcChannels.PluginLifecycle, message)
    } catch {
      // webContents 可能正在销毁
    }
  }

  /** 启动方式变更事件（quick ↔ shell 迁移后；enest.onModeChange / getLaunchMode 消费） */
  private sendModeChange(entry: PluginEntry, mode: PluginLaunchMode): void {
    try {
      if (entry.view.webContents.isDestroyed()) return
      const payload: PluginEventPayload = { type: 'mode-change', mode }
      entry.view.webContents.send(IpcChannels.PluginEvent, payload)
    } catch {
      // webContents 可能正在销毁
    }
  }

  // —— 内部：休眠 / LRU / crash 自愈 ——

  /**
   * dev 插件休眠守卫：默认永不休眠 / 不参与 LRU 驱逐（保 HMR 稳定）；
   * 开了「退出即杀」（对齐 uTools）的 dev 插件除外——退后台立即休眠。
   */
  private isDevPlugin(pluginId: string): boolean {
    return pluginRegistry.get(pluginId)?.dev === true && !this.killOnHidePlugins.has(pluginId)
  }

  /** 启动（或重置）空闲休眠计时；active/dev/quick 挂载中插件不计时 */
  private scheduleHibernate(pluginId: string, retry = false): void {
    this.clearHibernateTimer(pluginId)
    if (this.isPresented(pluginId) || this.quickSession.retains(pluginId) || this.transfers.has(pluginId)) return
    if (!this.entries.has(pluginId)) return
    // 「退出即杀」（对齐 uTools「退出到后台立即结束运行」）：不计时，退后台立即休眠
    if (hasPluginActivity(pluginId) || this.entries.get(pluginId)?.scope.activityCount) return
    if (this.killOnHidePlugins.has(pluginId) && !retry) {
      this.hibernatePlugin(pluginId)
      return
    }
    if (this.isDevPlugin(pluginId)) return
    const timer = setTimeout(() => {
      this.hibernateTimers.delete(pluginId)
      this.hibernatePlugin(pluginId)
    }, PLUGIN_HIBERNATE_DELAY_MS)
    this.hibernateTimers.set(pluginId, timer)
  }

  /** 清除插件的休眠计时器（activate/crash/close 时调用，避免泄漏） */
  private clearHibernateTimer(pluginId: string): void {
    const timer = this.hibernateTimers.get(pluginId)
    if (timer) {
      clearTimeout(timer)
      this.hibernateTimers.delete(pluginId)
    }
  }

  /**
   * 休眠插件：saveSessionSnapshot → destroy 通知（尽力）→ 摘 view 销毁渲染进程。
   * 快照提交成功后释放会话内存，保留快照预算与逻辑 Tab。
   */
  private hibernatePlugin(pluginId: string): void {
    const entry = this.entries.get(pluginId)
    if (!entry || this.suspending.has(pluginId) || this.getState(pluginId) !== 'background' || this.isPresented(pluginId) || this.quickSession.retains(pluginId) || this.transfers.has(pluginId) || this.isDevPlugin(pluginId) || hasPluginActivity(pluginId) || entry.scope.activityCount) return
    const suspension = Symbol(pluginId)
    this.suspending.set(pluginId, suspension)
    let retry = false
    this.clearHibernateTimer(pluginId)
    void (async () => {
      const operationId = randomUUID()
      const ack = this.waitForBeforeCloseAck(pluginId, entry.view.webContents, operationId, Date.now() + 1000)
      this.sendToPlugin(entry.view.webContents, { event: 'beforeSuspend', operationId })
      const saved = await ack
      if (!saved) { retry = true; return }
      if (this.suspending.get(pluginId) !== suspension || this.entries.get(pluginId) !== entry || this.getState(pluginId) !== 'background' || this.isPresented(pluginId) || this.quickSession.retains(pluginId) || this.transfers.has(pluginId) || entry.scope.activityCount || hasPluginActivity(pluginId)) return
      const revision = getSessionRevision(pluginId)
      if (!saveSessionSnapshot(pluginId, entry) || revision !== getSessionRevision(pluginId)) {
        retry = true
        return
      }
      this.entries.delete(pluginId)
      this.detachView(entry)
      stopDevWatch(pluginId)
      entry.scope.markClosing()
      this.retireMcpRuntime(pluginId, 'hibernated')
      this.sendToPlugin(entry.view.webContents, { event: 'destroy' })
      this.applyTransition(pluginId, 'hibernate')
      this.hibernated.set(pluginId, { pluginId, title: pluginRegistry.get(pluginId)?.name ?? pluginId, ui: entry.ui, hibernatedAt: Date.now(), tabSessionId: entry.tabSessionId, buildRevision: entry.buildRevision })
      releaseSessionMemory(pluginId)
      this.enterSent.delete(pluginId)
      const cleanup = this.disposeEntry(entry).then(() => { this.byWcId.delete(entry.scope.owner.wcId) })
        .finally(() => { if (this.closing.get(pluginId) === cleanup) this.closing.delete(pluginId) })
      this.closing.set(pluginId, cleanup)
      this.publishTabs()
      await cleanup
    })().catch((error) => logWarn('lifecycle', String(error))).finally(() => {
      if (this.suspending.get(pluginId) !== suspension) return
      this.suspending.delete(pluginId)
      if (retry && this.entries.get(pluginId) === entry) this.scheduleHibernate(pluginId, true)
    })
  }

  /**
   * LRU 保活上限：存活（非 hibernated）entry 数 > PLUGIN_ALIVE_LIMIT 时，
   * 把最久未激活的 background 插件立即休眠；active、quick 挂载中与 dev 白名单除外。
   */
  private enforceAliveLimit(): void {
    const candidates = [...this.entries.values()]
      .filter(
        (e) =>
          !this.isPresented(e.pluginId) && !this.quickSession.retains(e.pluginId) && !this.transfers.has(e.pluginId) &&
          this.getState(e.pluginId) === 'background' &&
          !hasPluginActivity(e.pluginId) && !e.scope.activityCount &&
          !this.isDevPlugin(e.pluginId)
      )
      .sort((a, b) => a.lastActivatedAt - b.lastActivatedAt)
    // A checkpoint removes its entry before native/resource disposal finishes. Count only
    // suspensions whose entries are still resident, otherwise the same victim is subtracted twice.
    const pendingResident = [...this.suspending.keys()].filter((id) => this.entries.has(id)).length
    const excess = Math.max(0, this.entries.size - PLUGIN_ALIVE_LIMIT - pendingResident)
    for (const victim of candidates.filter((entry) => !this.suspending.has(entry.pluginId)).slice(0, excess)) this.hibernatePlugin(victim.pluginId)
  }

  /**
   * crash：清理 entry、原生视图与资源；保留错误 Tab，点击后显式重试。
   * 注意：closePlugin/uninstall 摘除 entry 后 teardown 触发的 render-process-gone
   * 不再走 crash 语义（entry 不在即视为主动关闭）。
   */
  private handleRenderProcessGone(pluginId: string, reason: string): void {
    const entry = this.entries.get(pluginId)
    if (!entry || entry.scope.isClosing) return
    this.retireMcpRuntime(pluginId, 'crash')
    this.clearHibernateTimer(pluginId)
    this.entries.delete(pluginId)
    this.detachView(entry)
    stopDevWatch(pluginId)
    entry.scope.markClosing()
    permissionService.cancelFor(pluginId)
    this.states.set(pluginId, 'crash')
    sendShellEvent({ type: 'plugin-error', pluginId, message: reason })
    this.publishTabs()
    const cleanup = this.disposeEntry(entry).then(() => {
      this.byWcId.delete(entry.scope.owner.wcId)
      this.enterSent.delete(pluginId)
    }).finally(() => { if (this.closing.get(pluginId) === cleanup) this.closing.delete(pluginId) })
    this.closing.set(pluginId, cleanup)
    void cleanup.catch((error) => logWarn('lifecycle', String(error)))
  }

  private detachView(entry: PluginEntry): void {
    try { entry.view.setVisible(false) } catch { /* already destroyed */ }
    if (this.getPlacement(entry.pluginId).kind === 'quick' && this.quickPluginId === entry.pluginId) finishQuickPluginReveal()
    const placement = this.getPlacement(entry.pluginId)
    const parent = placement.kind === 'detached' ? getDetachedParent(entry.pluginId)
      : placement.kind === 'float' ? getFloatParent(entry.pluginId)
      : placement.kind === 'quick' ? getQuickPluginParent() : getMainWindow()?.contentView
    try { parent?.removeChildView(entry.view) } catch { /* already detached */ }
  }

  private async disposeEntry(entry: PluginEntry, deadline = Date.now() + BEFORE_CLOSE_ACK_TIMEOUT): Promise<void> {
    this.closingEntries.set(entry.pluginId, entry)
    const results = await Promise.allSettled([entry.scope.dispose(deadline), this.teardownView(entry)])
    this.byWcId.delete(entry.scope.owner.wcId)
    if (entry.scope.failures.length) logWarn('lifecycle', `${entry.pluginId}/${entry.generation}: resource cleanup: ${entry.scope.failures.join('; ')}`)
    const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
    if (failed) throw failed.reason
    if (entry.scope.failures.length) throw new Error(`Plugin resource cleanup incomplete: ${entry.scope.failures.join('; ')}`)
    if (this.closingEntries.get(entry.pluginId) === entry) this.closingEntries.delete(entry.pluginId)
  }

  private teardownView(entry: PluginEntry): Promise<void> {
    this.detachView(entry)
    const wc = entry.view.webContents
    if (!wc || wc.isDestroyed()) return Promise.resolve()
    this.retiringViews.set(entry.pluginId, entry)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`WebContents destruction not confirmed: ${entry.pluginId}/${entry.generation}`))
      }, 300)
      const done = () => {
        clearTimeout(timer)
        if (this.retiringViews.get(entry.pluginId) === entry) this.retiringViews.delete(entry.pluginId)
        resolve()
      }
      wc.once('destroyed', done)
      try { wc.close({ waitForBeforeUnload: false }) }
      catch (error) { clearTimeout(timer); reject(error) }
    })
  }

}

/** 在 URL 查询参数中附加 pid，供 pluginPreload 识别自身插件身份 */
function withPid(url: string, pluginId: string): string {
  try {
    const u = new URL(url)
    u.searchParams.set('pid', pluginId)
    return u.toString()
  } catch {
    const sep = url.includes('?') ? '&' : '?'
    return `${url}${sep}pid=${encodeURIComponent(pluginId)}`
  }
}

/** 在 URL 查询参数中附加 code，供插件首个脚本同步读取 feature 指令 */
function withCode(url: string, code: string): string {
  try {
    const u = new URL(url)
    u.searchParams.set('code', code)
    return u.toString()
  } catch {
    const sep = url.includes('?') ? '&' : '?'
    return `${url}${sep}code=${encodeURIComponent(code)}`
  }
}

/** 在 URL 查询参数中附加启动方式（mode=quick|shell），供插件首个脚本同步读取 */
function withMode(url: string, mode: PluginLaunchMode): string {
  try {
    const u = new URL(url)
    u.searchParams.set('mode', mode)
    return u.toString()
  } catch {
    const sep = url.includes('?') ? '&' : '?'
    return `${url}${sep}mode=${mode}`
  }
}

export const pluginHost = new PluginHost()

bindDetachedWindowHost({
  close: id => pluginHost.closePlugin(id),
  visibility: (id, visible) => pluginHost.setDetachedVisible(id, visible),
  layout: id => pluginHost.layoutDetachedPlugin(id),
  snapshot: id => pluginHost.getDetachedState(id),
  activate: id => pluginHost.activateDetachedPlugin(id),
  history: (id, session) => pluginHost.updateDetachedHistory(id, session)
})
bindFloatWindowHost({
  exit: id => pluginHost.leaveFloatByHost(id),
  changed: id => pluginHost.persistFloatGeometry(id)
})

/** Explicit refresh/replacement invalidates compiled scripts; cache failures do not undo a published build. */
async function clearCompiledCache(pluginId: string): Promise<void> {
  try { await invalidatePluginCodeCache(pluginId) }
  catch (error) { logWarn('lifecycle', `${pluginId}: code cache invalidation failed: ${String(error)}`) }
}

// —— createQuickWindow 联动注入（直接 import 会成模块环：Host → quickWindow → Host）——
// 以下注册同样处于环内（quickWindow 可经其它路径反向可达 Host），模块体先后顺序
// 由打包器决定，统一微任务注册避开 createQuickWindow 内 hook let 的 TDZ。

/** quick 尺寸变化时联动布局 quick 容器中的插件 view */
queueMicrotask(() => {
  setQuickPluginRelayout(() => pluginHost.layoutQuickPlugins())

  /** 自动隐藏保留当前 Quick 会话；显式退出后才恢复普通资源策略。 */
  setQuickPluginHiddenHook(() => pluginHost.onQuickHidden())

  /**
   * quick 呼出编排：未 Esc 退场的上次插件优先恢复，否则回空搜索栏。
   */
  setQuickPluginSummonHook(guard => pluginHost.prepareQuickSummon(guard))
})

setPluginInstallLifecycleHooks({
  async beforeReplace(id, dest) {
    if (dirname(dest) !== join(getAppPaths().plugins, id)) throw new Error('Plugin installation data root changed')
    const releasePaths = retainAppPaths()
    try {
      await ownedPackageVersion(getAppPaths().plugins, id, basename(dest), await pluginRegistry.getDevSourcePaths())
      const previous = pluginRegistry.getInstalledPackage(id)
      if (pluginRegistry.get(id)?.dev || !previous || !selectsInstalledVersion(basename(dest), previous.version)) return releasePaths
      const resume = await pluginHost.prepareBuildReplacement(id)
      return restorable => {
        try {
          if (!restorable && previous.rootPath === dest) pluginRegistry.removeInstalledBuild(id)
          resume(restorable || previous.rootPath !== dest)
        } finally { releasePaths() }
      }
    }
    catch (error) { releasePaths(); throw error }
  },
  async afterReplace(id, rootPath) {
    invalidatePluginFileCache(rootPath)
    const previous = pluginRegistry.getInstalledPackage(id)
    if (pluginRegistry.get(id)?.dev || !selectsInstalledVersion(basename(rootPath), previous?.version)) return
    await clearCompiledCache(id)
  }
})
