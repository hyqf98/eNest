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
 * 容器模型（container: 'shell' | 'quick'，即「启动方式」）：
 * - shell：插件 view 挂主窗 contentView（大窗 Tab，桌面适配样式），bounds 走
 *   getPluginContentBounds；激活语义 = activeTabId（全局唯一）
 * - quick：插件 view 挂 Quick 小窗 contentView（叠在 quick 渲染层之上，渲染在
 *   输入条下方，小窗适配样式），bounds 走 getQuickPluginBounds；
 *   挂载语义 = quickPluginId。两个容器各自的激活互不干扰（可同时各有一个激活插件）
 * - 迁移：openPlugin 传不同 container 会 migrateContainer（同 webContents 摘下重挂，
 *   不重载）；「固定到主窗」= pinToShell。上次容器记录在 containers map，
 *   crash 自动重启 / 唤醒路径据此回到原容器；迁移后推 mode-change 事件，
 *   插件经 getLaunchMode()/onModeChange 切换两套入口样式
 * - 输入拦截：quick 容器 view 注册 before-input-event，插件态 Esc 回列表、
 *   ⌘/Ctrl+Enter 固定到主窗（插件区域持焦时渲染层收不到键盘事件，必须主进程拦截）
 * - 尺寸自适应：manifest.window 提供起始建议，ui.resize/setHeight 即时更新 Quick 容器；
 *   插件自身响应 viewport resize，不测量/改写它的 DOM 或内部布局
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
 *   quick 容器同样适用：Esc 回列表 / 小窗失焦隐藏即退 background 并计时，
 *   被驱逐后再次呼出走 openPlugin 冷启动 + session 快照恢复（自动覆盖）
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
import { configurePluginSession, releasePluginEndpoints } from '@main/plugin/pluginSessionPolicy'
import { createRuntimeScope, type PluginRuntimeScope } from '@main/plugin/PluginRuntimeScope'
import { permissionService } from '@main/plugin/PermissionService'
import { releasePluginStorage } from '@main/db/pluginStorage'
import { setPluginInstallLifecycleHooks } from '@main/plugin/PluginInstaller'
import { nativeTheme, session, WebContentsView, type WebContents } from 'electron'
import {
  IpcChannels,
  type PluginEventPayload
} from '@shared/types/ipc'
import {
  pluginPartition,
  pluginProtocolUrl,
  pluginChromeBarHeight,
  toTabId,
  toPluginId,
  PLUGIN_HIBERNATE_DELAY_MS,
  PLUGIN_ALIVE_LIMIT,
  BEFORE_CLOSE_ACK_TIMEOUT_MS,
  QUICK_BAR_AREA_H,
  QUICK_BORDER_WIDTH,
  QUICK_WIDTH,
  QUICK_HOME_HEIGHT,
  QUICK_PLUGIN_DEFAULT_HEIGHT,
  QUICK_PLUGIN_MIN_HEIGHT
} from '@shared/constants'
import type {
  PluginCloseReason,
  PluginEnterPayload,
  PluginLifecycleMessage,
  PluginLaunchMode
} from '@shared/types/plugin'
import { resolvePluginUi, type PluginUiConfig } from '@shared/types/plugin'
import {
  getMainWindow,
  getPluginContentBounds,
  resolvePreload,
  sendShellEvent
} from '@main/window/createShellWindow'
import {
  ensureQuickWindow,
  getQuickPluginBounds,
  getQuickPluginParent,
  revealQuickPlugin,
  finishQuickPluginReveal,
  getQuickWebContents,
  getQuickWindow,
  setQuickContentSize,
  hideQuickWindow,
  setQuickPluginHiddenHook,
  setQuickPluginRelayout,
  setQuickPluginResetHook
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
import { closeAllPins } from '@main/pin/pinService'
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
import { releaseSshSessions } from '@main/ssh/sshSessionManager'
import { releaseDbSessions } from '@main/database/dbSessionManager'
import { releaseSockets } from '@main/net/socketBridge'
import { releaseLanShares } from '@main/net/lanShareService'
import { releaseDshRuntime } from '@main/dsh/dshRuntimeService'
import { hasPluginActivity, onPluginActivityIdle, releasePluginActivities } from '@main/plugin/activityRegistry'
import { quickInputAction } from '@main/plugin/quickInputPolicy'
import { clearQuickInput } from '@main/plugin/quickInputService'
import type { PluginInputContext } from '@shared/types/local-files'
import { releaseLocalFiles } from '@main/plugin/localFiles'
import { resolveThemeTokens, themeTokensToInjectScript } from '@main/theme/resolveThemeCss'
import { routeExternal, isInternalNavigation } from '@main/plugin/externalLinks'

/** beforeClose 等待插件 ack 的上限；超时直接销毁，避免挂死关闭流程 */
const BEFORE_CLOSE_ACK_TIMEOUT = BEFORE_CLOSE_ACK_TIMEOUT_MS

/** 插件所在容器（= 启动方式）：shell 主窗 Tab / quick Quick 小窗内嵌 */
export type PluginContainer = PluginLaunchMode

interface PluginEntry {
  view: WebContentsView
  scope: PluginRuntimeScope
  generation: number
  buildRevision: string
  tabSessionId: string
  pluginId: string
  partition: string
  rootPath: string
  /** 已归一的 UI 配置（来自 manifest.ui） */
  ui: PluginUiConfig
  /** 当前挂载容器；bounds 计算与激活语义按此分流 */
  container: PluginContainer
  /** 最近一次成为 active 的时间戳（LRU 驱逐依据） */
  lastActivatedAt: number
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

/** 管理插件 WebContentsView 的生命周期、分区与激活状态 */
export class PluginHost {
  private generation = 0
  private shuttingDown = false
  private barriers = new Map<string, number>()
  private opening = new Map<string, { cancelled: boolean; promise: Promise<string> }>()
  private finalClosing = new Map<string, { preserveSession: boolean }>()
  private closing = new Map<string, Promise<void>>()
  private reloading = new Map<string, { cancelled: boolean; promise: Promise<void> }>()
  private retiringViews = new Map<string, PluginEntry>()
  private suspending = new Map<string, symbol>()
  private logicalTabs = new Map<string, { title: string; tabSessionId: string }>()
  /** Runtime presentation survives suspend and container migration, but not final close. */
  private tabPresentation = new Map<string, { title?: string; glyph?: string; badge?: string }>()
  private tabRevision = 0
  private entries = new Map<string, PluginEntry>()
  private byWcId = new Map<number, string>()
  private activeTabId: string | null = null
  private shellVisible = true
  /** quick 容器当前挂载的 mini 插件 id（挂载即激活语义，无值 = 列表态） */
  private quickPluginId: string | null = null
  /** 插件主动上报的视口建议；桌面保持用户窗体尺寸，Quick 按建议调整。 */
  private desiredSizes = new Map<string, { width?: number; height?: number }>()
  /** 插件上次（或期望）所在容器；crash 重启 / 唤醒路径据此回原容器 */
  private containers = new Map<string, PluginContainer>()
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
    return this.entries.get(pluginId)?.container === 'quick' ? getQuickWindow() : getMainWindow()
  }

  setInputContext(pluginId: string, context: PluginInputContext): void {
    if (!['workbench', 'terminal', 'editor', 'overlay'].includes(context)) throw new Error('invalid input context')
    this.inputContexts.set(pluginId, context)
  }

  focusPlugin(pluginId: string): boolean {
    const entry = this.entries.get(pluginId)
    if (!entry || entry.view.webContents.isDestroyed()) return false
    if (entry.container === 'quick' ? this.quickPluginId !== pluginId : this.activeTabId !== pluginId) return false
    entry.view.webContents.focus()
    return true
  }

  focusSearch(pluginId: string): boolean {
    if (this.quickPluginId !== pluginId) return false
    this.focusQuickShell()
    sendShellEvent({ type: 'quick-focus-search' })
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
      if (this.entries.has(pluginId) && !this.isShellActive(pluginId) && this.quickPluginId !== pluginId) {
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
    if (entry?.container === 'shell') {
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
    return this.shellVisible && this.activeTabId === pluginId
  }

  getActive(): string | null {
    return this.activeTabId
  }

  /** Main-process diagnostics contain immutable metadata, never native handles or plugin state. */
  getDiagnostics() {
    return {
      opening: this.opening.size,
      closing: this.closing.size,
      hibernated: this.hibernated.size,
      logicalTabs: this.logicalTabs.size,
      tabPresentations: this.tabPresentation.size,
      retiring: this.retiringViews.size,
      entries: [...this.entries.values()].map((entry) => ({
        pluginId: entry.pluginId, generation: entry.generation, buildRevision: entry.buildRevision,
        tabSessionId: entry.tabSessionId, wcId: entry.scope.owner.wcId,
        state: this.getState(entry.pluginId), container: entry.container
      }))
    }
  }

  getPluginIdByWebContentsId(wcId: number): string | undefined {
    return this.byWcId.get(wcId)
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

  /** quick 容器当前挂载的 mini 插件 id（无 = 列表态）；quickHandlers 交互用 */
  getQuickPlugin(): string | null {
    return this.quickPluginId
  }

  /** 插件当前（或上次）所在容器：entry 在取 entry.container，否则取历史记录，缺省 shell */
  getContainer(pluginId: string): PluginContainer {
    return this.entries.get(pluginId)?.container ?? this.containers.get(pluginId) ?? 'shell'
  }

  /** 联动布局：把 quick 容器挂载中的插件 view bounds 对齐当前 quick 窗（尺寸变化时调用） */
  layoutQuickPlugins(): void {
    const pid = this.quickPluginId
    if (!pid) return
    const entry = this.entries.get(pid)
    if (!entry || entry.container !== 'quick') return
    try {
      entry.view.setBounds(getQuickPluginBounds())
    } catch {
      // view 可能正在销毁
    }
  }

  /** 每次呼出显示常用网格，保留后台插件进程供下次显式打开。 */
  resetQuickSession(): void {
    this.onQuickHidden()
    for (const entry of this.entries.values()) {
      if (entry.container === 'quick') entry.view.setVisible(false)
    }
    sendShellEvent({ type: 'quick-plugin-mode', mode: null })
  }

  /**
   * quick 小窗隐藏（失焦/热键收起）时：挂载中的插件退 background + 启动休眠计时。
   * view 隐藏但保持挂载，不摘除不销毁；再次搜索打开时复用，休眠仍遵循资源策略。
   */
  onQuickHidden(): void {
    finishQuickPluginReveal()
    clearQuickInput()
    const pid = this.quickPluginId
    if (!pid) return
    this.quickPluginId = null
    const entry = this.entries.get(pid)
    if (!entry) return
    entry.view.setVisible(false)
    if (this.getState(pid) === 'active') {
      this.sendToPlugin(entry.view.webContents, { event: 'out', isKill: false })
      this.applyTransition(pid, 'deactivate')
    }
    // 窗口已整体不可见，挂载语义不再阻止休眠：先清 quickPluginId 再计时，
    // 否则 scheduleHibernate 的 quickPluginId 守卫会让渲染进程常驻直到下次呼出
    this.scheduleHibernate(pid)
  }

  /** 插件当前是否处于休眠态（渲染进程已销毁，逻辑 Tab 保留） */
  isHibernated(pluginId: string): boolean {
    return this.getState(pluginId) === 'hibernated'
  }

  /** 当前生命周期状态（未打开返回 installed） */
  getState(pluginId: string): PluginLifecycleState {
    return this.states.get(pluginId) ?? INITIAL_LIFECYCLE_STATE
  }

  /** 卸载开始：任意 → clearing-storage（由 PluginUninstaller 调用） */
  beginUninstall(pluginId: string): void {
    this.clearHibernateTimer(pluginId)
    this.applyTransition(pluginId, 'uninstall')
  }

  /** 卸载完成：clearing-storage → uninstalled */
  finishUninstall(pluginId: string): void {
    this.applyTransition(pluginId, 'uninstalled')
    this.states.delete(pluginId)
    this.enterSent.delete(pluginId)
    this.pendingEnter.delete(pluginId)
    this.hibernated.delete(pluginId)
    this.logicalTabs.delete(pluginId)
    this.containers.delete(pluginId)
    this.desiredSizes.delete(pluginId)
    if (this.quickPluginId === pluginId) {
      this.quickPluginId = null
    }
    this.clearHibernateTimer(pluginId)
  }

  /** ACKs are tied to both renderer incarnation and operation. */
  ackBeforeClose(pluginId: string, wcId: number, operationId?: string, success = true): void {
    const ack = this.pendingAcks.get(pluginId)
    if (ack?.wcId === wcId && ack.operationId === operationId) ack.resolve(success)
  }

  blockPlugin(pluginId: string): () => void {
    this.barriers.set(pluginId, (this.barriers.get(pluginId) ?? 0) + 1)
    let released = false
    return () => {
      if (released) return
      released = true
      const count = (this.barriers.get(pluginId) ?? 1) - 1
      if (count) this.barriers.set(pluginId, count)
      else this.barriers.delete(pluginId)
    }
  }

  restoreTabs(ids: string[]): void {
    for (const id of ids) {
      const pluginId = toPluginId(id)
      const summary = pluginRegistry.get(pluginId)
      if (!summary?.rootPath || !isEnabledSync(pluginId) || this.logicalTabs.has(pluginId)) continue
      this.logicalTabs.set(pluginId, { title: summary.name, tabSessionId: randomUUID() })
    }
    this.publishTabs()
  }

  private publishTabs(): void {
    sendShellEvent({ type: 'plugin-tabs', revision: ++this.tabRevision,
      activeTabId: this.activeTabId,
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
    this.tabPresentation.set(pluginId, { ...this.tabPresentation.get(pluginId), ...patch })
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

  openPlugin(pluginId: string, enter?: PluginEnterPayload, opts?: { container?: PluginContainer }): Promise<string> {
    pluginId = toPluginId(pluginId)
    if (this.shuttingDown || this.barriers.has(pluginId)) return Promise.reject(new Error('plugin unavailable during shutdown or replacement'))
    const reloading = this.reloading.get(pluginId)
    if (reloading) return reloading.promise.then(() => this.openPlugin(pluginId, enter, opts))
    const closing = this.closing.get(pluginId)
    if (closing) return closing.then(() => this.openPlugin(pluginId, enter, opts))
    if (this.retiringViews.has(pluginId)) return Promise.reject(new Error('plugin renderer destruction is still pending'))
    const opening = this.opening.get(pluginId)
    if (opening) {
      if (opening.cancelled) return opening.promise.catch(() => undefined).then(() => this.openPlugin(pluginId, enter, opts))
      return opening.promise.then(() => this.openPlugin(pluginId, enter, opts))
    }
    const operation = { cancelled: false, promise: Promise.resolve(pluginId) }
    this.opening.set(pluginId, operation)
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
   * 唤醒 / crash 重启路径经 containers 记录回到上次容器。
   */
  private async createPlugin(
    pluginId: string,
    enter?: PluginEnterPayload,
    opts?: { container?: PluginContainer },
    operation?: { cancelled: boolean }
  ): Promise<string> {
    const resumeIdentity = this.hibernated.get(pluginId)
    const existing = this.entries.get(pluginId)
    if (existing) {
      // 容器切换（quick ↔ shell）：显式指定即迁移（同 webContents 不重载）。
      // 主窗入口缺省进入 shell；Quick 入口显式指定，避免激活隐藏的小窗。
      const target: PluginContainer = opts?.container ?? 'shell'
      if (target !== existing.container) {
        this.migrateContainer(pluginId, target)
      }
      if (target === 'quick') {
        this.showQuickPlugin(pluginId, enter)
      } else {
        this.activatePlugin(pluginId, enter)
      }
      this.enforceAliveLimit()
      return pluginId
    }

    // 已显式禁用的插件拒绝打开（Quick / 市场 / IPC 均走此路径）
    if (!isEnabledSync(pluginId)) {
      throw new Error(`plugin disabled: ${pluginId}`)
    }

    // 唤醒休眠插件：先把快照灌回内存 sessionBag，再走全新冷启动。
    // 休眠已释放 resident bag，因此新 renderer 加载前恢复业务快照。
    // 状态机转移（hibernated --open--> opening）由下方统一的 applyTransition('open') 完成。
    if (this.hibernated.has(pluginId)) {
      loadSessionSnapshot(pluginId, { buildRevision: pluginRegistry.getBuildRevision(pluginId), tabSessionId: resumeIdentity?.tabSessionId ?? '' })
      this.hibernated.delete(pluginId)
      logInfo('lifecycle', `${pluginId}: waking from hibernation`)
    }

    const summary = await pluginRegistry.ensureInstalled(pluginId)
    if (operation?.cancelled || this.shuttingDown || this.barriers.has(pluginId) || !isEnabledSync(pluginId)) throw new Error('plugin opening cancelled')
    if ((opts?.container ?? 'shell') === 'shell' && !this.logicalTabs.has(pluginId)) {
      this.logicalTabs.set(pluginId, { title: summary.name, tabSessionId: randomUUID() })
    }
    const rootPath = summary.rootPath
    if (!rootPath) throw new Error(`plugin not installed: ${pluginId}`)

    const manifest = pluginRegistry.getManifest(pluginId)
    const ui = resolvePluginUi(manifest?.ui ?? summary.ui)

    // 用户入口默认桌面；Quick 与内部恢复明确传入目标容器。
    const container: PluginContainer = opts?.container ?? 'shell'
    this.containers.set(pluginId, container)

    const partition = pluginPartition(pluginId) // 每插件独立 partition，隔离 cookie/storage
    const ses = session.fromPartition(partition)
    configurePluginSession(ses, { pluginId, devUrl: summary.devUrl })
    // 新建的插件 session 需继承当前应用代理（直连时 no-op）
    await applyProxyToPluginPartition(pluginId)
    if (operation?.cancelled || this.shuttingDown || this.barriers.has(pluginId)) throw new Error('plugin opening cancelled')
    if (!summary.devUrl) {
      registerPluginProtocolForSession(ses, pluginId, rootPath)
    }

    const view = new WebContentsView({
      webPreferences: {
        preload: resolvePreload('pluginPreload.js'),
        partition,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true // self-contained CJS preload only exposes the capability bridge
      }
    })

    view.setBorderRadius(0)

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
    // mode = 启动方式（quick 小窗 / shell 大窗），插件据此选择渲染哪套入口样式
    const url = withMode(
      enter?.code ? withCode(base, enter.code) : base,
      container
    )

    this.applyTransition(pluginId, 'open')
    if (enter && (enter.code !== undefined || enter.payload !== undefined)) {
      this.pendingEnter.set(pluginId, enter)
    }

    view.webContents.on('render-process-gone', (_e, details) => {
      if (this.entries.get(pluginId)?.view === view) this.handleRenderProcessGone(pluginId, details.reason)
    })

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
    this.hookQuickInput(pluginId, view.webContents)

    // 加载完成后注入主题 Token（themeAware 时）；透明背景在 load 后再设一次确保生效；
    // 同时推进状态机 ready → （若 active）enter
    view.webContents.on('did-finish-load', () => {
      if (this.entries.get(pluginId)?.view !== view || entry.scope.isClosing) return
      if (ui.background === 'transparent') {
        view.setBackgroundColor('#00000000')
      }
      if (ui.themeAware) {
        void this.injectThemeInto(view, ui)
      }
      const state = this.getState(pluginId)
      if (state === 'closed' || state === 'uninstalled' || state === 'clearing-storage') return
      this.applyTransition(pluginId, 'load-ok')
      // 首次加载完成且已是目标 active（shell Tab 或 quick 挂载中）→ 立刻 enter
      if (this.isShellActive(pluginId) || this.quickPluginId === pluginId) {
        this.sendEnter(pluginId)
      } else {
        this.applyTransition(pluginId, 'deactivate')
        this.scheduleHibernate(pluginId)
      }
      sendShellEvent({ type: 'plugin-ready', pluginId, generation: entry.generation })
      this.publishTabs()
      this.enforceAliveLimit()

    })

    const generation = ++this.generation
    const scope = createRuntimeScope({ pluginId, generation, wcId: view.webContents.id })
    scope.onActivityChanged(() => { this.scheduleHibernate(pluginId); this.enforceAliveLimit() })
    scope.addDisposer(() => releasePluginEndpoints(pluginId))
    scope.addDisposer(() => releasePluginHotkeys(pluginId))
    scope.addDisposer(() => { contributionRegistry.releaseQuickProviders(pluginId) })
    scope.addDisposer(() => releasePluginActivities(pluginId))
    scope.addDisposer(() => { this.inputContexts.delete(pluginId) })
    scope.addDisposer(() => { closeAllPins(pluginId) })
    scope.addDisposer(() => releaseSshSessions(pluginId, generation))
    scope.addDisposer(() => releaseDbSessions(pluginId))
    scope.addDisposer(() => releaseSockets(pluginId, generation))
    scope.addDisposer(() => releaseLanShares(pluginId, generation))
    scope.addDisposer(() => releaseDshRuntime(pluginId))
    scope.addDisposer(() => releaseLocalFiles(pluginId))
    scope.addDisposer(() => { if (!releasePluginStorage(pluginId)) throw new Error('pending local storage writes retained for retry') })
    const entry: PluginEntry = {
      view, scope, generation,
      buildRevision: pluginRegistry.getBuildRevision(pluginId),
      tabSessionId: resumeIdentity?.tabSessionId ?? this.logicalTabs.get(pluginId)?.tabSessionId ?? randomUUID(),
      pluginId,
      partition,
      rootPath,
      ui,
      container,
      lastActivatedAt: Date.now()
    }
    this.entries.set(pluginId, entry)
    this.byWcId.set(view.webContents.id, pluginId)

    if (container === 'quick') {
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

    this.hookNativeTheme()
    if (container === 'quick') {
      // quick 挂载即激活语义：立即可见、状态机推进并应用建议尺寸
      this.showQuickPlugin(pluginId)
    } else {
      // 立即激活视图（显示）；enter 事件等 did-finish-load 后再发，避免插件尚未就绪
      this.activatePlugin(pluginId)
    }
    void view.webContents.loadURL(url).catch((err: Error) => {
      if (this.entries.get(pluginId) !== entry || scope.isClosing) return
      this.handleRenderProcessGone(pluginId, err.message)
    })
    this.publishTabs()
    // LRU：超限立即驱逐最久未激活的 background 插件
    this.enforceAliveLimit()
    return pluginId
  }

  /**
   * 关闭插件：立即摘除视图和逻辑 Tab，再在共享期限内通知并回收资源。
   * reason 决定 beforeClose 载荷；日常关 Tab 用 tab-close，卸载用 uninstall，退出用 app-quit。
   * 休眠中的插件也可被关闭（无 entry，直接落 closed 语义）。
   */
  closePlugin(tabId: string, reason: PluginCloseReason = 'tab-close', preserveSession = false): Promise<void> {
    const pluginId = toPluginId(tabId)
    if (!preserveSession) {
      const reload = this.reloading.get(pluginId)
      if (reload) { reload.cancelled = true; this.reloading.delete(pluginId) }
    }
    const pending = this.closing.get(pluginId)
    const final = this.finalClosing.get(pluginId)
    if (pending && final) {
      if (!preserveSession && final.preserveSession) {
        final.preserveSession = false
        this.logicalTabs.delete(pluginId)
        sendShellEvent({ type: 'tab-closed', tabId: toTabId(pluginId) })
        this.publishTabs()
      }
      return pending
    }
    const closeOptions = { preserveSession }
    this.finalClosing.set(pluginId, closeOptions)
    this.suspending.delete(pluginId)
    this.pendingAcks.get(pluginId)?.resolve()
    const deadline = Date.now() + BEFORE_CLOSE_ACK_TIMEOUT
    const opening = this.opening.get(pluginId)
    if (opening) opening.cancelled = true
    this.clearHibernateTimer(pluginId)
    permissionService.cancelFor(pluginId)
    const entry = this.entries.get(pluginId)
    const ids = [...this.logicalTabs.keys()]
    const index = ids.indexOf(pluginId)
    const next = ids[index + 1] ?? ids[index - 1]
    if (!preserveSession) this.logicalTabs.delete(pluginId)
    this.hibernated.delete(pluginId)
    if (entry) {
      entry.scope.markClosing()
      this.detachView(entry)
      this.entries.delete(pluginId)
    }
    if (this.quickPluginId === pluginId) {
      this.quickPluginId = null
      sendShellEvent({ type: 'quick-plugin-mode', mode: null })
    }
    const wasActive = this.activeTabId === pluginId
    if (wasActive) this.activeTabId = null
    this.applyTransition(pluginId, 'close', reason)
    if (!preserveSession) sendShellEvent({ type: 'tab-closed', tabId: toTabId(pluginId) })
    this.publishTabs()
    const operation = Promise.resolve().then(async () => {
      if (pending) await pending
      if (entry) {
        const operationId = randomUUID()
        const ack = this.waitForBeforeCloseAck(pluginId, entry.view.webContents, operationId, deadline - 300)
        this.sendToPlugin(entry.view.webContents, { event: 'beforeClose', reason, operationId })
        await ack
        this.sendToPlugin(entry.view.webContents, { event: 'destroy' })
        await this.disposeEntry(entry, deadline)
        this.byWcId.delete(entry.scope.owner.wcId)
      }
    }).finally(() => {
      // A native destruction failure keeps its retiring guard, but must not keep
      // closed logical-session payloads or queued UI state alive.
      if (!closeOptions.preserveSession) {
        clearPluginSession(pluginId)
        deleteSessionSnapshot(pluginId)
        this.containers.delete(pluginId)
        this.desiredSizes.delete(pluginId)
        this.tabPresentation.delete(pluginId)
      }
      this.enterSent.delete(pluginId)
      this.pendingEnter.delete(pluginId)
      this.states.delete(pluginId)
      sendShellEvent({ type: 'plugins-changed' })
      if (this.closing.get(pluginId) === operation) this.closing.delete(pluginId)
      this.finalClosing.delete(pluginId)
      if (entry) this.byWcId.delete(entry.scope.owner.wcId)
    })
    this.closing.set(pluginId, operation)
    if (wasActive && !preserveSession && !this.shuttingDown) {
      if (next) this.activatePlugin(next)
      else sendShellEvent({ type: 'plugin-active', tabId: null })
    }
    return operation
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
  activatePlugin(tabId: string, enter?: PluginEnterPayload): void {
    const pluginId = toPluginId(tabId)
    const entry = this.entries.get(pluginId)
    if (!entry) {
      // 唤醒路径：activate 拦截休眠插件 → openPlugin 重建（fire-and-forget，错误走 plugin-error）
      if (this.logicalTabs.has(pluginId) && !this.barriers.has(pluginId)) {
        logInfo('lifecycle', `${pluginId}: hibernated, wake on activate`)
        void this.openPlugin(pluginId, enter).catch((err: Error) => {
          sendShellEvent({ type: 'plugin-error', pluginId, message: err.message })
        })
      }
      return
    }

    if (entry.container === 'quick') this.migrateContainer(pluginId, 'shell')
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
      // quick 容器 view 的可见性由 quickPluginId 管理（quick 挂载不受主窗 Tab 切换影响）
      if (e.container === 'quick') {
        e.view.setVisible(id === this.quickPluginId)
        continue
      }
      e.view.setVisible(this.shellVisible && id === pluginId)
    }

    if (entry.container === 'shell') {
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
      if (entry.pluginId !== this.activeTabId && entry.pluginId !== this.quickPluginId) continue
      if (entry.container === 'quick') {
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
      if (entry.container === 'quick') continue
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
    const container = this.getContainer(pluginId)
    const rootPath = pluginRegistry.get(pluginId)?.rootPath
    if (rootPath) invalidatePluginFileCache(rootPath)
    pluginRegistry.invalidateBuildRevision(pluginId)
    operation.promise = this.closePlugin(pluginId, 'tab-close', true).then(async () => {
      if (operation.cancelled) return
      await clearCompiledCache(pluginId)
      if (operation.cancelled) return
      if (this.reloading.get(pluginId) === operation) this.reloading.delete(pluginId)
      await this.openPlugin(pluginId, undefined, { container })
    }).finally(() => {
      if (this.reloading.get(pluginId) === operation) this.reloading.delete(pluginId)
    })
    void operation.promise.catch((err: Error) => sendShellEvent({ type: 'plugin-error', pluginId, message: err.message }))
  }

  openDevTools(tabId: string, mode: 'detach' | 'right' = 'detach'): void {
    const pluginId = toPluginId(tabId)
    const entry = this.entries.get(pluginId)
    if (!entry) return
    entry.view.webContents.openDevTools({ mode })
  }

  // —— quick 容器：mini 插件内嵌 Quick 小窗 ——

  /**
   * 在 Quick 小窗挂载 mini 插件（挂载即激活语义）：
   * 若另一插件正占用 quick 容器，先让它退场（out + background + 休眠计时）；
   * 随后显示目标 view、置顶（叠在 quick 渲染层之上）、推 plugin-active，
   * 并按插件主动上报或 manifest 建议调整容器尺寸。
   */
  showQuickPlugin(pluginId: string, enter?: PluginEnterPayload): void {
    const entry = this.entries.get(pluginId)
    if (!entry) return
    const entering = this.quickPluginId !== pluginId

    // 换插件：旧 quick 插件退场（保留进程，走休眠策略）
    if (this.quickPluginId && this.quickPluginId !== pluginId) {
      this.dismissQuickPluginInternal(this.quickPluginId, false)
    }

    this.suspending.delete(pluginId)
    this.clearHibernateTimer(pluginId)
    this.quickPluginId = pluginId
    this.containers.set(pluginId, 'quick')
    entry.lastActivatedAt = Date.now()

    setQuickContentSize(this.getQuickPluginSize(pluginId))
    if (entering) revealQuickPlugin()

    for (const candidate of this.entries.values()) {
      if (candidate.container === 'quick') candidate.view.setVisible(candidate.pluginId === pluginId)
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
    }

    // 新 enter 载荷覆盖 pending（呼出关键词的 code）
    if (enter && (enter.code !== undefined || enter.payload !== undefined)) {
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

    sendShellEvent({
      type: 'quick-plugin-mode',
      mode: {
        pluginId,
        title: pluginRegistry.getManifest(pluginId)?.name ?? pluginId
      }
    })
  }

  /**
   * Quick 插件退场回列表态（Esc / 清空输入 / 打开其它命令）：
   * view 隐藏但保留进程（退 background + 启动休眠计时），推 out，
   * 并通知 quick 渲染层回到列表 UI。参数校验防误关 shell 容器插件。
   */
  dismissQuickPlugin(pluginId: string): void {
    clearQuickInput(pluginId)
    const entry = this.entries.get(pluginId)
    if (!entry || entry.container !== 'quick') return
    this.dismissQuickPluginInternal(pluginId, true)
  }

  /** 退场实现；notify 决定是否推送 quick-plugin-mode(null)（换插件时由新挂载覆盖，跳过） */
  private dismissQuickPluginInternal(pluginId: string, notify: boolean): void {
    clearQuickInput(pluginId)
    const entry = this.entries.get(pluginId)
    if (!entry) return
    if (this.quickPluginId !== pluginId) return
    this.quickPluginId = null
    finishQuickPluginReveal()
    if (notify) setQuickContentSize({ width: QUICK_WIDTH, height: QUICK_HOME_HEIGHT })

    try {
      entry.view.setVisible(false)
    } catch {
      /* view 可能已销毁 */
    }
    // out + background + 休眠计时（quick 可见期间不得休眠：quickPluginId 恒 null 之后才计时）
    if (this.getState(pluginId) === 'active') {
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
    if (!entry || entry.container !== 'quick') return
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

  /** 容器迁移（同 webContents 不重载）：quick ↔ shell 的摘挂 + bounds 切换 */
  private migrateContainer(pluginId: string, container: PluginContainer): void {
    const entry = this.entries.get(pluginId)
    if (!entry || entry.container === container) return
    if (container === 'quick') ensureQuickWindow()
    const win = getMainWindow()
    try {
      if (entry.container === 'quick') {
        getQuickPluginParent()?.removeChildView(entry.view)
      } else {
        win?.contentView.removeChildView(entry.view)
      }
    } catch {
      /* 已不在父视图 */
    }
    // 离开 quick 容器：挂载态复位，渲染层回列表态
    const wasQuickMounted = this.quickPluginId === pluginId && entry.container === 'quick'
    entry.container = container
    entry.view.setBorderRadius(0)
    this.containers.set(pluginId, container)
    if (container === 'quick' && this.activeTabId === pluginId) {
      this.activeTabId = null
      sendShellEvent({ type: 'plugin-active', tabId: null })
    }
    if (wasQuickMounted) {
      finishQuickPluginReveal()
      this.quickPluginId = null
      sendShellEvent({ type: 'quick-plugin-mode', mode: null })
    }
    if (container === 'quick') {
      getQuickPluginParent()?.addChildView(entry.view)
      entry.view.setBounds(getQuickPluginBounds())
    } else {
      win?.contentView.addChildView(entry.view)
      entry.view.setBounds(getPluginContentBounds(pluginChromeBarHeight(entry.ui.chrome)))
      raiseOrbRailViews()
    }
    // 启动方式变更：URL ?mode= 只是初始值（迁移不重载），经事件通知插件切换入口样式
    this.sendModeChange(entry, container)
    if (container === 'shell' && !this.logicalTabs.has(pluginId)) this.logicalTabs.set(pluginId, { title: pluginRegistry.get(pluginId)?.name ?? pluginId, tabSessionId: entry.tabSessionId })
    if (container === 'quick') this.logicalTabs.delete(pluginId)
    this.publishTabs()
  }

  /**
   * 拦截 quick 容器插件区域键盘：Esc → 回列表（quickHandlers 消费），
   * ⌘/Ctrl+Enter → 固定到主窗。插件 view 抢焦后渲染层收不到按键，必须在此拦。
   * 直接调本类 dismiss/pin，与渲染层按钮同一入口，行为一致。
   */
  private hookQuickInput(pluginId: string, wc: WebContents): void {
    wc.on('before-input-event', (_e, input) => {
      if (this.quickPluginId !== pluginId) return
      const action = quickInputAction(input, this.inputContexts.get(pluginId) ?? 'workbench')
      if (action === 'search') {
        _e.preventDefault()
        this.focusQuickShell()
        sendShellEvent({ type: 'quick-focus-search' })
      } else if (action === 'dismiss') {
        _e.preventDefault()
        if (!input.isAutoRepeat) this.dismissQuickPlugin(pluginId)
      } else if (action === 'pin') {
        _e.preventDefault()
        this.pinToShell(pluginId)
      }
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

  /** 插件请求的是内容视口尺寸；输入条和外边框由壳子补齐。 */
  private getQuickPluginSize(pluginId: string): { width: number; height: number } {
    const window = pluginRegistry.getManifest(pluginId)?.window
    const desired = this.desiredSizes.get(pluginId)
    const positive = (value: number | null | undefined, fallback: number): number =>
      Number.isFinite(value) && value! > 0 ? Math.round(value!) : fallback
    const height = Math.max(
      QUICK_PLUGIN_MIN_HEIGHT,
      positive(window?.minHeight, 0),
      positive(desired?.height, positive(window?.height, positive(window?.minHeight, QUICK_PLUGIN_DEFAULT_HEIGHT)))
    )
    return { width: QUICK_WIDTH, height: height + QUICK_BAR_AREA_H + QUICK_BORDER_WIDTH }
  }

  /** ui.resize/setHeight 事件驱动，无轮询和 DOM 高度探测；桌面视口由用户调整。 */
  resizePlugin(pluginId: string, size: { width?: number; height?: number }): void {
    const previous = this.desiredSizes.get(pluginId) ?? {}
    const next = { ...previous }
    if (Number.isFinite(size.width) && size.width! > 0) next.width = Math.round(size.width!)
    if (Number.isFinite(size.height) && size.height! > 0) next.height = Math.round(size.height!)
    this.desiredSizes.set(pluginId, next)
    if (this.entries.get(pluginId)?.container === 'quick' && this.quickPluginId === pluginId) {
      setQuickContentSize(this.getQuickPluginSize(pluginId))
    }
  }

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

  /** 向所有已打开的 themeAware 插件广播当前主题（壳子 setTheme / nativeTheme 变化时调用） */
  broadcastTheme(): void {
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
    this.shuttingDown = true
    this.activeTabId = null
    this.quickPluginId = null
    this.desiredSizes.clear()
    this.containers.clear()
    // 清掉全部休眠计时器（含后台插件）
    for (const pluginId of [...this.hibernateTimers.keys()]) {
      this.clearHibernateTimer(pluginId)
    }
    await Promise.all([...new Set([...this.logicalTabs.keys(), ...this.hibernated.keys(), ...this.entries.keys(), ...this.opening.keys(), ...this.closing.keys(), ...this.reloading.keys()])].map((id) => this.closePlugin(id, reason)))
    // 休眠记录随退出清空（快照仍在 enest.db，但下次启动不自动恢复休眠 Tab 的进程）
    this.hibernated.clear()
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
      mode: entry.container,
      ...(isFirst || pending
        ? { code: pending?.code, type: pending?.type, payload: pending?.payload }
        : {})
    }

    if (pending) this.pendingEnter.delete(pluginId)
    this.enterSent.add(pluginId)
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
  private sendModeChange(entry: PluginEntry, container: PluginContainer): void {
    try {
      if (entry.view.webContents.isDestroyed()) return
      const payload: PluginEventPayload = { type: 'mode-change', mode: container }
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
    if (this.isShellActive(pluginId)) return
    // quick 可见（挂载中）的插件不得休眠
    if (this.quickPluginId === pluginId) return
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
    if (!entry || this.suspending.has(pluginId) || this.getState(pluginId) !== 'background' || this.isShellActive(pluginId) || this.quickPluginId === pluginId || this.isDevPlugin(pluginId) || hasPluginActivity(pluginId) || entry.scope.activityCount) return
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
      if (this.suspending.get(pluginId) !== suspension || this.entries.get(pluginId) !== entry || this.getState(pluginId) !== 'background' || this.isShellActive(pluginId) || this.quickPluginId === pluginId || entry.scope.activityCount || hasPluginActivity(pluginId)) return
      const revision = getSessionRevision(pluginId)
      if (!saveSessionSnapshot(pluginId, entry) || revision !== getSessionRevision(pluginId)) {
        retry = true
        return
      }
      this.entries.delete(pluginId)
      this.detachView(entry)
      entry.scope.markClosing()
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
          !this.isShellActive(e.pluginId) &&
          e.pluginId !== this.quickPluginId &&
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
    this.clearHibernateTimer(pluginId)
    this.entries.delete(pluginId)
    this.detachView(entry)
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
    if (entry.container === 'quick' && this.quickPluginId === entry.pluginId) finishQuickPluginReveal()
    const parent = entry.container === 'quick' ? getQuickPluginParent() : getMainWindow()?.contentView
    try { parent?.removeChildView(entry.view) } catch { /* already detached */ }
  }

  private async disposeEntry(entry: PluginEntry, deadline = Date.now() + BEFORE_CLOSE_ACK_TIMEOUT): Promise<void> {
    const results = await Promise.allSettled([entry.scope.dispose(deadline), this.teardownView(entry)])
    this.byWcId.delete(entry.scope.owner.wcId)
    if (entry.scope.failures.length) logWarn('lifecycle', `${entry.pluginId}/${entry.generation}: resource cleanup: ${entry.scope.failures.join('; ')}`)
    const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
    if (failed) throw failed.reason
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

/** Explicit refresh/replacement invalidates compiled scripts; cache failures do not undo a published build. */
async function clearCompiledCache(pluginId: string): Promise<void> {
  try { await invalidatePluginCodeCache(pluginId) }
  catch (error) { logWarn('lifecycle', `${pluginId}: code cache invalidation failed: ${String(error)}`) }
}

// —— createQuickWindow 联动注入（直接 import 会成模块环：Host → quickWindow → Host）——

/** quick 尺寸变化时联动布局 quick 容器中的插件 view */
setQuickPluginRelayout(() => pluginHost.layoutQuickPlugins())

/** quick 小窗隐藏：挂载插件退 background + 休眠计时（view 留在不可见 contentView） */
setQuickPluginHiddenHook(() => pluginHost.onQuickHidden())

/**
 * quick 呼出前隐藏原生插件视图，renderer 回到空搜索栏。
 */
setQuickPluginResetHook(() => pluginHost.resetQuickSession())

setPluginInstallLifecycleHooks({
  async beforeReplace(id) {
    const release = pluginHost.blockPlugin(id)
    try {
      if (pluginRegistry.get(id)?.rootPath || pluginHost.isOpened(id)) await pluginHost.closePlugin(id, 'uninstall')
      return release
    }
    catch (error) { release(); throw error }
  },
  async afterReplace(id, rootPath) {
    invalidatePluginFileCache(rootPath)
    deleteSessionSnapshot(id)
    await clearCompiledCache(id)
  }
})
