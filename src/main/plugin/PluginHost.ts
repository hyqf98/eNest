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
 * 容器模型（container: 'shell' | 'quick'）：
 * - shell：插件 view 挂主窗 contentView（大插件 Tab，panel 形态），bounds 走
 *   getPluginContentBounds；激活语义 = activeTabId（全局唯一）
 * - quick：mini 插件 view 挂 Quick 小窗 contentView（叠在 quick 渲染层之上，
 *   顶部 QUICK_BAR_AREA_H 区域留给输入条），bounds 走 getQuickPluginBounds；
 *   挂载语义 = quickPluginId。两个容器各自的激活互不干扰（可同时各有一个激活插件）
 * - 迁移：openPlugin 传不同 container 会 migrateContainer（同 webContents 摘下重挂，
 *   不重载）；「固定到主窗」= pinToShell。上次容器记录在 containers map，
 *   crash 自动重启 / 唤醒路径据此回到原容器
 * - 输入拦截：quick 容器 view 注册 before-input-event，插件态 Esc 回列表、
 *   ⌘/Ctrl+Enter 固定到主窗（插件区域持焦时渲染层收不到键盘事件，必须主进程拦截）
 * - 高度自适应：quick 挂载后优先 enest.ui.setHeight 上报（pluginHandlers 记录），
 *   无上报则前几轮 executeJavaScript 量 body scrollHeight 兜底；窗高 = 输入条 + 钳制后的插件高度
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
 * - crash 自愈：render-process-gone 清理 entry 后首次自动重启（reopen 一次）；
 *   连续第二次 crash 保留逻辑 Tab 但不再自动重启（渲染层经 plugin-error 显示崩溃态）
 * - dev 插件（summary.dev === true）永不休眠 / 不参与 LRU 驱逐
 *
 * 向插件推送的事件（通道 plugin:lifecycle）：
 *   enter       — 首次 did-finish-load 后 + 每次 activate（与 out 成对，便于 pause/resume）
 *   out         — 其它 Tab 成为 active / quick 退场（本视图隐藏），isKill 固定 false
 *   beforeClose — 销毁前，reason: tab-close | uninstall | app-quit；可选等 ack，最多 1500ms
 *   destroy     — 关闭开始后的尽力通知
 */
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
  QUICK_BAR_AREA_H,
  QUICK_MAX_HEIGHT,
  QUICK_PLUGIN_DEFAULT_HEIGHT,
  QUICK_PLUGIN_MIN_HEIGHT
} from '@shared/constants'
import type {
  PluginCloseReason,
  PluginEnterPayload,
  PluginLifecycleMessage
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
  getQuickWebContents,
  getQuickWindow,
  setQuickContentHeight,
  setQuickPluginHiddenHook,
  setQuickPluginRelayout,
  setQuickPluginRestoreHook
} from '@main/window/createQuickWindow'
import { raiseOrbRailViews } from '@main/window/orbRailViews'
import { logInfo, logWarn } from '@main/logs/logService'
import {
  clearPluginSession,
  deleteSessionSnapshot,
  loadSessionSnapshot,
  saveSessionSnapshot,
  sessionBag
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
  invalidatePluginFileCache
} from '@main/plugin/pluginProtocol'
import {
  setPluginHotReloadHandler,
  stopWatchingPlugin,
  watchPluginForHotReload
} from '@main/plugin/pluginHotReload'
import { getPluginDesiredHeight, releasePluginHotkeys, releasePluginContribs } from '@main/ipc/pluginHandlers'
import { releaseSshSessions } from '@main/ssh/sshSessionManager'
import { releaseDbSessions } from '@main/database/dbSessionManager'
import { resolveThemeTokens, themeTokensToInjectScript } from '@main/theme/resolveThemeCss'

/** beforeClose 等待插件 ack 的上限；超时直接销毁，避免挂死关闭流程 */
const BEFORE_CLOSE_ACK_TIMEOUT_MS = 1500

/** crash 自动重启计数重置的稳定窗口：加载完成后存活超过该时长才视为“已恢复” */
const CRASH_RECOVERY_STABLE_MS = 10 * 1000

/** quick 高度自适应观察窗：挂载后持续检查 setHeight 迟到上报的总时长 */
const QUICK_HEIGHT_WATCH_MS = 3000
/** scrollHeight 兜底探测窗口（spec：max 300ms 轮询几次） */
const QUICK_HEIGHT_PROBE_MS = 1200
/** 观察轮询间隔 */
const QUICK_HEIGHT_TICK_MS = 300

/** 量插件文档内容高度的表达式（body 与 documentElement 取大） */
const QUICK_SCROLL_PROBE_EXPR =
  '(function(){var b=document.body,d=document.documentElement;' +
  'return Math.ceil(Math.max(b?b.scrollHeight:0,d?d.scrollHeight:0))})()'

/** 插件所在容器：shell 主窗 Tab / quick Quick 小窗内嵌（mini） */
export type PluginContainer = 'shell' | 'quick'

interface PluginEntry {
  view: WebContentsView
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
}

/** 管理插件 WebContentsView 的生命周期、分区与激活状态 */
export class PluginHost {
  private entries = new Map<string, PluginEntry>()
  private byWcId = new Map<number, string>()
  private activeTabId: string | null = null
  /** quick 容器当前挂载的 mini 插件 id（挂载即激活语义，无值 = 列表态） */
  private quickPluginId: string | null = null
  /** quick 高度自适应轮询句柄（切插件/退出 quick 插件态时清除） */
  private quickHeightTimer: ReturnType<typeof setInterval> | null = null
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
  private pendingAcks = new Map<string, () => void>()

  /** hibernated 插件的轻量记录（entry 已摘除，逻辑 Tab 仍存在） */
  private hibernated = new Map<string, HibernatedInfo>()
  /** 空闲休眠计时器：插件进入 background 后启动，activate/crash/close 清除 */
  private hibernateTimers = new Map<string, ReturnType<typeof setTimeout>>()
  /** crash 后自动重启次数：仅首次自动 reopen，连续第二次 crash 停止 */
  private restartAttempts = new Map<string, number>()

  getActive(): string | null {
    return this.activeTabId
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

  /** 联动布局：把 quick 容器挂载中的插件 view bounds 对齐当前 quick 窗（tween/resize 每帧调用） */
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

  /**
   * quick 呼出时恢复插件挂载：清休眠计时、刷新 LRU 时间、重推 quick-plugin-mode
   * （渲染层切回插件 UI）。返回目标窗高（无挂载返回 null，列表态）。
   */
  notifyQuickRestore(): number | null {
    const pid = this.quickPluginId
    if (!pid) return null
    const entry = this.entries.get(pid)
    if (!entry || entry.container !== 'quick') return null
    this.clearHibernateTimer(pid)
    entry.lastActivatedAt = Date.now()
    // enter 不重放（呼出 ≠ 新进入）；但 active 语义需要维持——若中途被退 background 则重激活
    if (this.getState(pid) === 'background') {
      this.sendEnter(pid)
    }
    sendShellEvent({
      type: 'quick-plugin-mode',
      mode: {
        pluginId: pid,
        title: pluginRegistry.getManifest(pid)?.name ?? pid
      }
    })
    const reported = getPluginDesiredHeight(pid)
    const maxPluginH = QUICK_MAX_HEIGHT - QUICK_BAR_AREA_H
    const clamped = Math.min(
      maxPluginH,
      Math.max(
        QUICK_PLUGIN_MIN_HEIGHT,
        Math.round(reported ?? QUICK_PLUGIN_DEFAULT_HEIGHT)
      )
    )
    return QUICK_BAR_AREA_H + clamped
  }

  /**
   * quick 小窗隐藏（失焦/热键收起）时：挂载中的插件退 background + 启动休眠计时。
   * view 保持挂在 quick contentView（窗口整体不可见即插件不可见），不摘除不销毁；
   * 休眠到期后正常走 hibernatePlugin（快照 + 销毁），再次呼出经 openPlugin 冷启动恢复。
   */
  onQuickHidden(): void {
    const pid = this.quickPluginId
    if (!pid) return
    const entry = this.entries.get(pid)
    if (!entry) return
    if (this.getState(pid) === 'active') {
      this.sendToPlugin(entry.view.webContents, { event: 'out', isKill: false })
      this.applyTransition(pid, 'deactivate')
    }
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
    this.restartAttempts.delete(pluginId)
    this.containers.delete(pluginId)
    if (this.quickPluginId === pluginId) {
      this.quickPluginId = null
      this.stopQuickHeightWatch()
    }
    this.clearHibernateTimer(pluginId)
  }

  /** 插件对 beforeClose 的确认（由 pluginHandlers 转发） */
  ackBeforeClose(pluginId: string): void {
    const resolve = this.pendingAcks.get(pluginId)
    if (resolve) resolve()
  }

  /**
   * 打开插件：已存在则激活（可带新的 enter 载荷；容器不同则先迁移），
   * 已休眠则唤醒（loadSessionSnapshot 灌回 sessionBag 后冷启动重建），
   * 否则创建独立 partition 的 WebContentsView 并加载入口。
   * enter.code 优先进 URL query，完整载荷在 did-finish-load 后经 plugin:lifecycle 下发。
   * container：quick = 挂 Quick 小窗（mini 插件内嵌）；缺省 shell 主窗 Tab。
   * 唤醒 / crash 重启路径经 containers 记录回到上次容器。
   */
  async openPlugin(
    pluginId: string,
    enter?: PluginEnterPayload,
    opts?: { container?: PluginContainer }
  ): Promise<string> {
    const existing = this.entries.get(pluginId)
    if (existing) {
      // 容器切换（quick ↔ shell）：显式指定即迁移（同 webContents 不重载）。
      // 缺省 opts 时维持现有容器——主窗打开已在 quick 的 mini 插件 = 呼出语义。
      const target: PluginContainer = opts?.container ?? existing.container
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
    // PluginSessionStore 仅在 closePlugin 时清 bag，休眠路径不经过它，
    // 因此这里必须先灌回，否则插件重开后 storage.session 读到空。
    // 状态机转移（hibernated --open--> opening）由下方统一的 applyTransition('open') 完成。
    if (this.hibernated.has(pluginId)) {
      const snapshot = loadSessionSnapshot(pluginId)
      if (snapshot) {
        const bag = sessionBag(pluginId)
        for (const [k, v] of Object.entries(snapshot)) bag.set(k, v)
      }
      this.hibernated.delete(pluginId)
      logInfo('lifecycle', `${pluginId}: waking from hibernation`)
    }

    const summary = await pluginRegistry.ensureInstalled(pluginId)
    const rootPath = summary.rootPath
    if (!rootPath) throw new Error(`plugin not installed: ${pluginId}`)

    const manifest = pluginRegistry.getManifest(pluginId)
    const ui = resolvePluginUi(manifest?.ui ?? summary.ui)

    // 容器决策：显式指定 > 上次容器（唤醒/crash 重启回落）> shell
    const container: PluginContainer = opts?.container ?? this.containers.get(pluginId) ?? 'shell'
    this.containers.set(pluginId, container)

    const partition = pluginPartition(pluginId) // 每插件独立 partition，隔离 cookie/storage
    const ses = session.fromPartition(partition)
    // 新建的插件 session 需继承当前应用代理（直连时 no-op）
    void applyProxyToPluginPartition(pluginId)
    if (!summary.devUrl) {
      registerPluginProtocolForSession(ses, pluginId, rootPath)
    }

    const view = new WebContentsView({
      webPreferences: {
        preload: resolvePreload('pluginPreload.js'),
        partition,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false // preload 需要访问 ipcRenderer，故不启用沙箱
      }
    })

    // background=transparent：View 底色透明，透出壳子背景（Canvas/WebGL 场景）
    // 注意：setBackgroundColor 挂在 View 上（非 webContents），hex 含 alpha 用 AARRGGBB
    if (ui.background === 'transparent') {
      view.setBackgroundColor('#00000000')
    }

    const mainFromManifest = manifest?.main ?? 'index.html'
    const base = summary.devUrl
      ? withPid(summary.devUrl, pluginId)
      : withPid(pluginProtocolUrl(pluginId, mainFromManifest), pluginId)
    // code 走 query，便于插件在首个脚本同步读取；payload 体积不定，走 IPC
    const url = enter?.code ? withCode(base, enter.code) : base

    this.applyTransition(pluginId, 'open')
    if (enter && (enter.code !== undefined || enter.payload !== undefined)) {
      this.pendingEnter.set(pluginId, enter)
    }

    void view.webContents.loadURL(url).catch((err: Error) => {
      this.applyTransition(pluginId, 'load-fail')
      sendShellEvent({
        type: 'plugin-error',
        pluginId,
        message: err.message
      })
    })

    view.webContents.on('render-process-gone', (_e, details) => {
      this.handleRenderProcessGone(pluginId, details.reason)
    })

    // quick 容器：拦截插件区域键盘事件（插件持焦时渲染层收不到 Esc/⌘Enter）
    if (container === 'quick') {
      this.hookQuickInput(pluginId, view.webContents)
    }

    // 加载完成后注入主题 Token（themeAware 时）；透明背景在 load 后再设一次确保生效；
    // 同时推进状态机 ready → （若 active）enter
    view.webContents.on('did-finish-load', () => {
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
      if (this.activeTabId === pluginId || this.quickPluginId === pluginId) {
        this.sendEnter(pluginId)
      }
      // crash 后的自动重启若存活到稳定窗口，视为已恢复，重置自动重启额度
      if (this.restartAttempts.has(pluginId)) {
        const t = setTimeout(() => {
          if (this.entries.get(pluginId) && this.getState(pluginId) !== 'crash') {
            this.restartAttempts.delete(pluginId)
            logInfo('lifecycle', `${pluginId}: crash recovery stable, attempts reset`)
          }
        }, CRASH_RECOVERY_STABLE_MS)
        t.unref?.()
      }
    })

    const entry: PluginEntry = {
      view,
      pluginId,
      partition,
      rootPath,
      ui,
      container,
      lastActivatedAt: Date.now()
    }
    this.entries.set(pluginId, entry)
    this.byWcId.set(view.webContents.id, pluginId)

    // 文件型插件：监视 rootPath，变更自动热重载（dev / 已安装本地目录）
    if (rootPath) {
      watchPluginForHotReload(pluginId, rootPath)
    }

    if (container === 'quick') {
      // Quick 小窗懒创建：呼出 mini 插件时确保容器存在再挂载
      const quickWin = getQuickWindow() ?? ensureQuickWindow()
      quickWin.contentView.addChildView(view)
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
      // quick 挂载即激活语义：立即可见 + 状态机推进 + 高度自适应启动
      this.showQuickPlugin(pluginId)
    } else {
      // 立即激活视图（显示）；enter 事件等 did-finish-load 后再发，避免插件尚未就绪
      this.activatePlugin(pluginId)
    }
    // LRU：超限立即驱逐最久未激活的 background 插件
    this.enforceAliveLimit()
    return pluginId
  }

  /**
   * 关闭插件：beforeClose（可选等 ack ≤1500ms）→ destroy → 移除视图并回收。
   * reason 决定 beforeClose 载荷；日常关 Tab 用 tab-close，卸载用 uninstall，退出用 app-quit。
   * 休眠中的插件也可被关闭（无 entry，直接落 closed 语义）。
   */
  async closePlugin(
    tabId: string,
    reason: PluginCloseReason = 'tab-close'
  ): Promise<void> {
    const pluginId = toPluginId(tabId)
    this.clearHibernateTimer(pluginId)
    this.restartAttempts.delete(pluginId)
    stopWatchingPlugin(pluginId)

    // 休眠插件关闭：无渲染进程可通知，直接摘记录、落 closed
    if (this.hibernated.has(pluginId)) {
      this.hibernated.delete(pluginId)
      // 休眠期间注册的热键一并注销（进程已销毁，事件无处投递）
      releasePluginHotkeys(pluginId)
      releasePluginContribs(pluginId)
      releaseSshSessions(pluginId)
      releaseDbSessions(pluginId)
      this.applyTransition(pluginId, 'close', reason)
      // 休眠期间 bag 已快照落库，Tab 关闭即整段会话废弃：内存 bag 与快照一并清理
      clearPluginSession(pluginId)
      deleteSessionSnapshot(pluginId)
      this.states.delete(pluginId)
      this.enterSent.delete(pluginId)
      this.pendingEnter.delete(pluginId)
      this.containers.delete(pluginId)
      if (this.activeTabId === pluginId) {
        this.activeTabId = null
        const next = this.firstShellEntryId()
        if (next) this.activatePlugin(next)
        else sendShellEvent({ type: 'plugin-active', tabId: null })
      }
      sendShellEvent({ type: 'tab-closed', tabId: toTabId(pluginId) })
      sendShellEvent({ type: 'plugins-changed' })
      logInfo('lifecycle', `${pluginId}: hibernated → closed (${reason})`)
      return
    }

    const entry = this.entries.get(pluginId)
    if (!entry) return

    // 先从 entries 摘除，防止 beforeClose 期间又被 activate / 重复 close；
    // byWcId 保留到 ack 等待结束——beforeClose 期间插件的 flush 写（plugin:call）
    // 与 ack 转发都依赖 sender → pluginId 映射，提前删会导致 ack 永远丢失
    // （表现为每次关闭都等满 1500ms 超时）
    this.entries.delete(pluginId)

    // quick 挂载中的插件被关闭：先退场（quick 渲染层回列表态）再走销毁
    if (this.quickPluginId === pluginId) {
      this.quickPluginId = null
      this.stopQuickHeightWatch()
      sendShellEvent({ type: 'quick-plugin-mode', mode: null })
    }

    this.applyTransition(pluginId, 'close', reason)

    // beforeClose：给插件 flush 草稿 / 停轮询的窗口；ack 可选，超时兜底
    this.sendToPlugin(entry.view.webContents, { event: 'beforeClose', reason })
    await this.waitForBeforeCloseAck(pluginId)

    // destroy：尽力而为，此时视图可能已在销毁中
    this.sendToPlugin(entry.view.webContents, { event: 'destroy' })
    this.applyTransition(pluginId, 'destroyed')

    this.byWcId.delete(entry.view.webContents.id)
    this.teardownView(entry)

    // 销毁时清空会话态 storage.session（不落盘，不跨关闭保留）
    clearPluginSession(pluginId)
    // 注销该插件注册的全局热键与 Quick provider，释放键位与查询派发
    releasePluginHotkeys(pluginId)
    releasePluginContribs(pluginId)
    // 回收 SSH / DB 会话与监控定时器
    releaseSshSessions(pluginId)
    releaseDbSessions(pluginId)
    // 关闭该插件创建的贴图窗，避免孤儿置顶窗口
    try {
      closeAllPins(pluginId)
    } catch {
      // pin service 可能尚未初始化
    }
    this.enterSent.delete(pluginId)
    this.pendingEnter.delete(pluginId)
    this.states.delete(pluginId)
    this.containers.delete(pluginId)

    if (this.activeTabId === pluginId) {
      this.activeTabId = null
      const next = this.firstShellEntryId()
      if (next) this.activatePlugin(next)
      else sendShellEvent({ type: 'plugin-active', tabId: null })
    }
    sendShellEvent({ type: 'tab-closed', tabId: toTabId(pluginId) })
    sendShellEvent({ type: 'plugins-changed' })
    logInfo('lifecycle', `${pluginId}: closing → closed (${reason})`)
  }

  /** 关闭后接班的候选：仅 shell 容器插件（quick 容器的归 quickPluginId 管，不抢主窗激活） */
  private firstShellEntryId(): string | undefined {
    for (const e of this.entries.values()) {
      if (e.container === 'shell') return e.pluginId
    }
    return undefined
  }

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
      if (this.hibernated.has(pluginId)) {
        logInfo('lifecycle', `${pluginId}: hibernated, wake on activate`)
        void this.openPlugin(pluginId, enter).catch((err: Error) => {
          sendShellEvent({ type: 'plugin-error', pluginId, message: err.message })
        })
      }
      return
    }

    this.clearHibernateTimer(pluginId)
    entry.lastActivatedAt = Date.now()

    // 旧 active 退后台：先 out 再隐藏；进入 background 后启动空闲休眠计时。
    // 状态已非 active（如 hideAllViews 已置 background）时跳过重复 out，仅刷新计时
    if (this.activeTabId && this.activeTabId !== pluginId) {
      const prevId = this.activeTabId
      const prev = this.entries.get(prevId)
      if (prev && this.getState(prevId) === 'active') {
        this.sendToPlugin(prev.view.webContents, { event: 'out', isKill: false })
      }
      this.applyTransition(prevId, 'deactivate')
      this.scheduleHibernate(prevId)
    }

    this.activeTabId = pluginId

    for (const [id, e] of this.entries) {
      // quick 容器 view 的可见性由 quickPluginId 管理（quick 挂载不受主窗 Tab 切换影响）
      if (e.container === 'quick') {
        e.view.setVisible(id === this.quickPluginId)
        continue
      }
      e.view.setVisible(id === pluginId)
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
      this.sendEnter(pluginId)
    }

    sendShellEvent({ type: 'plugin-active', tabId: toTabId(pluginId) })
  }

  /** 窗口 resize：按容器分流布局（shell 走主窗 bounds；quick 走 quick bounds） */
  layoutAll(): void {
    for (const entry of this.entries.values()) {
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
  }

  reloadPlugin(tabId: string): void {
    const pluginId = toPluginId(tabId)
    // 冷启动语义：清 enterSent，下次 did-finish-load 重新 enter
    this.enterSent.delete(pluginId)
    const entry = this.entries.get(pluginId)
    if (!entry) {
      // 休眠中的插件 reload = 唤醒重建
      if (this.hibernated.has(pluginId)) {
        void this.openPlugin(pluginId).catch((err: Error) => {
          sendShellEvent({ type: 'plugin-error', pluginId, message: err.message })
        })
      }
      return
    }
    this.applyTransition(pluginId, 'reload')
    this.clearHibernateTimer(pluginId)
    // 文件插件：重新绑定 enest:// → rootPath，保证开发者改路径后 reload 读到新目录
    const summary = pluginRegistry.get(pluginId)
    const rootPath = summary?.rootPath
    if (rootPath) {
      try {
        invalidatePluginFileCache(rootPath)
      } catch {
        /* cache miss 可忽略 */
      }
    }
    if (rootPath && !summary?.devUrl) {
      try {
        const ses = session.fromPartition(entry.partition)
        registerPluginProtocolForSession(ses, pluginId, rootPath)
      } catch {
        // protocol rebind 失败仍尝试 reload
      }
    }
    entry.view.webContents.reload()
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
   * 并启动高度自适应（setHeight 上报 > scrollHeight 探测 > manifest/缺省）。
   */
  showQuickPlugin(pluginId: string, enter?: PluginEnterPayload): void {
    const entry = this.entries.get(pluginId)
    if (!entry) return

    // 换插件：旧 quick 插件退场（保留进程，走休眠策略）
    if (this.quickPluginId && this.quickPluginId !== pluginId) {
      this.dismissQuickPluginInternal(this.quickPluginId, false)
    }

    this.clearHibernateTimer(pluginId)
    this.quickPluginId = pluginId
    this.containers.set(pluginId, 'quick')
    entry.lastActivatedAt = Date.now()

    entry.view.setVisible(true)
    // 置顶：摘下重挂到 quick contentView 顶端（叠在 quick 渲染层 view 之上）
    const quickWin = getQuickWindow()
    if (quickWin) {
      try {
        quickWin.contentView.removeChildView(entry.view)
        quickWin.contentView.addChildView(entry.view)
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
    this.focusQuickShell()

    this.startQuickHeightWatch(pluginId)
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
    const entry = this.entries.get(pluginId)
    if (!entry || entry.container !== 'quick') return
    this.dismissQuickPluginInternal(pluginId, true)
  }

  /** 退场实现；notify 决定是否推送 quick-plugin-mode(null)（换插件时由新挂载覆盖，跳过） */
  private dismissQuickPluginInternal(pluginId: string, notify: boolean): void {
    const entry = this.entries.get(pluginId)
    if (!entry) return
    if (this.quickPluginId !== pluginId) return
    this.quickPluginId = null
    this.stopQuickHeightWatch()

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
   * 主窗 Tab 同步：plugin-active 事件由 activatePlugin 发出，shellStore 事件桥据此
   * 清崩溃态；Tab 列表本身由渲染层在收到 plugin-active 时未感知（设计如此——
   * 主壳打开插件的唯一路径会补 Tab；quick 打开不补，固定后主窗若没有该 Tab，
   * 用户从市场/圆轨点开即可；sessionTabs 持久化在主壳渲染层自身打开时维护）。
   */
  pinToShell(pluginId: string): void {
    const entry = this.entries.get(pluginId)
    if (!entry) return
    // 仅 quick 容器在挂载中的插件可固定；shell 容器插件已在主窗（幂等 no-op）
    if (entry.container !== 'quick') return

    const wasQuickActive = this.quickPluginId === pluginId
    this.quickPluginId = null
    this.stopQuickHeightWatch()

    const win = getMainWindow()
    const quickWin = getQuickWindow()
    if (quickWin) {
      try {
        quickWin.contentView.removeChildView(entry.view)
      } catch {
        /* 已不在 */
      }
    }
    entry.container = 'shell'
    this.containers.set(pluginId, 'shell')
    if (win) {
      win.contentView.addChildView(entry.view)
      entry.view.setBounds(getPluginContentBounds(pluginChromeBarHeight(entry.ui.chrome)))
      entry.view.setVisible(true)
      raiseOrbRailViews()
    }

    if (wasQuickActive) {
      sendShellEvent({ type: 'quick-plugin-mode', mode: null })
    }
    // shell 激活语义（含 plugin-active 事件、enter 补发）
    this.activatePlugin(pluginId)
    logInfo('lifecycle', `${pluginId}: pinned quick → shell`)
  }

  /** 容器迁移（同 webContents 不重载）：quick ↔ shell 的摘挂 + bounds 切换 */
  private migrateContainer(pluginId: string, container: PluginContainer): void {
    const entry = this.entries.get(pluginId)
    if (!entry || entry.container === container) return
    const quickWin = getQuickWindow()
    const win = getMainWindow()
    try {
      if (entry.container === 'quick') {
        quickWin?.contentView.removeChildView(entry.view)
      } else {
        win?.contentView.removeChildView(entry.view)
      }
    } catch {
      /* 已不在父视图 */
    }
    // 离开 quick 容器：挂载态复位（高度观察停止 + 渲染层回列表态）
    const wasQuickMounted = this.quickPluginId === pluginId && entry.container === 'quick'
    entry.container = container
    this.containers.set(pluginId, container)
    if (wasQuickMounted) {
      this.quickPluginId = null
      this.stopQuickHeightWatch()
      sendShellEvent({ type: 'quick-plugin-mode', mode: null })
    }
    if (container === 'quick') {
      quickWin?.contentView.addChildView(entry.view)
      entry.view.setBounds(getQuickPluginBounds())
    } else {
      win?.contentView.addChildView(entry.view)
      entry.view.setBounds(getPluginContentBounds(pluginChromeBarHeight(entry.ui.chrome)))
      raiseOrbRailViews()
    }
  }

  /**
   * 拦截 quick 容器插件区域键盘：Esc → 回列表（quickHandlers 消费），
   * ⌘/Ctrl+Enter → 固定到主窗。插件 view 抢焦后渲染层收不到按键，必须在此拦。
   * 直接调本类 dismiss/pin，与渲染层按钮同一入口，行为一致。
   */
  private hookQuickInput(pluginId: string, wc: WebContents): void {
    wc.on('before-input-event', (_e, input) => {
      if (input.type !== 'keyDown') return
      if (this.quickPluginId !== pluginId) return
      if (input.key === 'Escape') {
        _e.preventDefault()
        this.dismissQuickPlugin(pluginId)
      } else if (input.key === 'Enter' && (input.control || input.meta)) {
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

  /**
   * Quick 高度自适应观察：
   * - 每 tick 读 enest.ui.setHeight 上报值（pluginHandlers 记录），
   *   观察窗前 QUICK_HEIGHT_PROBE_MS 内还做 executeJavaScript scrollHeight 兜底
   * - 高度优先级：setHeight 上报 > scrollHeight > manifest.window.minHeight > 默认 300
   * - 窗高 = QUICK_BAR_AREA_H + 钳制(插件高度)，setQuickContentHeight tween 生效
   */
  private startQuickHeightWatch(pluginId: string): void {
    this.stopQuickHeightWatch()
    const manifestMin = pluginRegistry.getManifest(pluginId)?.window?.minHeight
    const fallback =
      Number.isFinite(manifestMin) && (manifestMin as number) > 0
        ? (manifestMin as number)
        : QUICK_PLUGIN_DEFAULT_HEIGHT
    const startAt = Date.now()
    this.quickHeightTimer = setInterval(() => {
      const entry = this.entries.get(pluginId)
      // 挂载已切换 / entry 没了：停表
      if (this.quickPluginId !== pluginId || !entry) {
        this.stopQuickHeightWatch()
        return
      }
      const reported = getPluginDesiredHeight(pluginId)
      if (reported && reported > 0) {
        this.applyQuickHeight(reported)
        // 已知期望高度后仍保留观察窗（插件内容可变，setHeight 会再触发）；
        // 但 probe 阶段无需再执行 JS
        return
      }
      if (Date.now() - startAt <= QUICK_HEIGHT_PROBE_MS) {
        void entry.view.webContents
          .executeJavaScript(QUICK_SCROLL_PROBE_EXPR, true)
          .then((h: unknown) => {
            if (this.quickPluginId !== pluginId) return
            const n = Number(h)
            if (Number.isFinite(n) && n > 0) this.applyQuickHeight(n)
          })
          .catch(() => undefined)
      }
    }, QUICK_HEIGHT_TICK_MS)
  }

  private stopQuickHeightWatch(): void {
    if (this.quickHeightTimer) {
      clearInterval(this.quickHeightTimer)
      this.quickHeightTimer = null
    }
  }

  /** 应用插件期望高度：钳制到 [QUICK_PLUGIN_MIN_HEIGHT, 窗高上限内可容纳范围] 并 tween 窗高 */
  private applyQuickHeight(pluginHeight: number): void {
    const maxPluginH = QUICK_MAX_HEIGHT - QUICK_BAR_AREA_H
    const clamped = Math.min(
      maxPluginH,
      Math.max(QUICK_PLUGIN_MIN_HEIGHT, Math.round(pluginHeight))
    )
    setQuickContentHeight(QUICK_BAR_AREA_H + clamped, true)
  }

  /** 是否已有打开的插件 View（开发加载前判断是否需要强制重建） */
  isOpen(pluginId: string): boolean {
    return this.entries.has(pluginId)
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
          )
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
    this.activeTabId = null
    this.quickPluginId = null
    this.stopQuickHeightWatch()
    this.containers.clear()
    // 清掉全部休眠计时器（含后台插件）
    for (const pluginId of [...this.hibernateTimers.keys()]) {
      this.clearHibernateTimer(pluginId)
    }
    await Promise.all([...this.entries.keys()].map((id) => this.closePlugin(id, reason)))
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
      ...(isFirst || pending
        ? { code: pending?.code, payload: pending?.payload }
        : {})
    }

    if (pending) this.pendingEnter.delete(pluginId)
    this.enterSent.add(pluginId)
    this.sendToPlugin(entry.view.webContents, message)
    this.applyTransition(pluginId, 'activate')
  }

  /** 等待插件 ack，最多 BEFORE_CLOSE_ACK_TIMEOUT_MS；无插件在听也照常超时放行 */
  private waitForBeforeCloseAck(pluginId: string): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingAcks.delete(pluginId)
        resolve()
      }, BEFORE_CLOSE_ACK_TIMEOUT_MS)
      this.pendingAcks.set(pluginId, () => {
        clearTimeout(timer)
        this.pendingAcks.delete(pluginId)
        logInfo('lifecycle', `${pluginId}: beforeClose ack received`)
        resolve()
      })
    })
  }

  /** 向插件 webContents 推送生命周期消息；已销毁则静默忽略 */
  private sendToPlugin(wc: WebContents, message: PluginLifecycleMessage): void {
    try {
      if (wc.isDestroyed()) return
      wc.send(IpcChannels.PluginLifecycle, message)
    } catch {
      // webContents 可能正在销毁
    }
  }

  // —— 内部：休眠 / LRU / crash 自愈 ——

  /** dev 插件白名单：开发调试中的插件永不休眠、不参与 LRU 驱逐 */
  private isDevPlugin(pluginId: string): boolean {
    return pluginRegistry.get(pluginId)?.dev === true
  }

  /** 启动（或重置）空闲休眠计时；active/dev/quick 挂载中插件不计时 */
  private scheduleHibernate(pluginId: string): void {
    this.clearHibernateTimer(pluginId)
    if (this.isDevPlugin(pluginId)) return
    if (this.activeTabId === pluginId) return
    // quick 可见（挂载中）的插件不得休眠
    if (this.quickPluginId === pluginId) return
    if (!this.entries.has(pluginId)) return
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
   * 不清 sessionBag / 快照数据、不发 tab-closed、不移除逻辑 Tab；
   * entry 摘除但保留 HibernatedInfo 轻量记录。
   * 渲染层经 plugins-changed + plugin-error 之外的既有事件感知（当前复用
   * plugins-changed；独立 plugin-hibernated 事件待 ipc.ts 扩展，见任务报告）。
   */
  private hibernatePlugin(pluginId: string): void {
    const entry = this.entries.get(pluginId)
    if (!entry) return
    // 仅 background 态可休眠：opening（尚未加载完）/ active / crash 的一律不动，
    // 避免把状态机推入非法转移或误杀正在启动的渲染进程
    const state = this.getState(pluginId)
    if (state !== 'background') {
      logWarn('lifecycle', `${pluginId}: skip hibernate in state ${state}`)
      return
    }
    // active 插件被并发唤醒时不再休眠
    if (this.activeTabId === pluginId) return
    // quick 挂载中的插件不得休眠（呼出即激活语义）
    if (this.quickPluginId === pluginId) return
    // dev 插件白名单兜底
    if (this.isDevPlugin(pluginId)) return

    this.clearHibernateTimer(pluginId)
    // 无渲染进程：停掉文件监视；唤醒 openPlugin 会重新挂上
    stopWatchingPlugin(pluginId)

    const info: HibernatedInfo = {
      pluginId,
      title: pluginRegistry.getManifest(pluginId)?.name ?? pluginId,
      ui: entry.ui,
      hibernatedAt: Date.now()
    }

    // 1. sessionBag 快照落 enest.db（唤醒时灌回）
    saveSessionSnapshot(pluginId)

    // 2. 状态机：background --hibernate--> hibernated（非法转移只记日志）
    this.applyTransition(pluginId, 'hibernate')

    // 3. 摘除 entry、destroy 尽力通知、销毁渲染进程
    this.entries.delete(pluginId)
    this.byWcId.delete(entry.view.webContents.id)
    this.sendToPlugin(entry.view.webContents, { event: 'destroy' })
    this.teardownView(entry)
    // 休眠进程销毁，注册的热键与 provider 一并注销（唤醒后由插件自行重注册）
    releasePluginHotkeys(pluginId)
    releasePluginContribs(pluginId)
    releaseSshSessions(pluginId)
    releaseDbSessions(pluginId)
    // 休眠 ≠ 关闭：不清 sessionBag（clearPluginSession）、不发 tab-closed
    this.hibernated.set(pluginId, info)

    sendShellEvent({ type: 'plugins-changed' })
    logInfo('lifecycle', `${pluginId}: background → hibernated (idle ${PLUGIN_HIBERNATE_DELAY_MS}ms)`)
  }

  /**
   * LRU 保活上限：存活（非 hibernated）entry 数 > PLUGIN_ALIVE_LIMIT 时，
   * 把最久未激活的 background 插件立即休眠；active、quick 挂载中与 dev 白名单除外。
   */
  private enforceAliveLimit(): void {
    const candidates = [...this.entries.values()]
      .filter(
        (e) =>
          e.pluginId !== this.activeTabId &&
          e.pluginId !== this.quickPluginId &&
          !this.isDevPlugin(e.pluginId)
      )
      .sort((a, b) => a.lastActivatedAt - b.lastActivatedAt)
    for (const victim of candidates) {
      if (this.entries.size <= PLUGIN_ALIVE_LIMIT) break
      this.hibernatePlugin(victim.pluginId)
    }
  }

  /**
   * crash 自愈：清理 entry（removeChildView、销毁 webContents、删 timer）、
   * 状态置 crash；首次 crash 自动重启一次（openPlugin 重建），
   * 连续第二次 crash 保留逻辑 Tab 但不再自动重启（渲染层显示崩溃态，点击重试）。
   * 注意：closePlugin/uninstall 摘除 entry 后 teardown 触发的 render-process-gone
   * 不再走 crash 语义（entry 不在即视为主动关闭）；clean-exit 同样忽略。
   */
  private handleRenderProcessGone(pluginId: string, reason: string): void {
    // 主动关闭/卸载路径：entry 已摘除，忽略残余事件
    if (!this.entries.has(pluginId)) {
      logWarn('lifecycle', `${pluginId}: render-process-gone after teardown (${reason}), ignored`)
      return
    }
    if (reason === 'clean-exit') return

    this.clearHibernateTimer(pluginId)
    const entry = this.entries.get(pluginId)
    const wasQuickMounted = this.quickPluginId === pluginId
    if (entry) {
      this.entries.delete(pluginId)
      this.byWcId.delete(entry.view.webContents.id)
      this.teardownView(entry)
    }
    // quick 容器 crash：挂载态复位，quick 渲染层回列表态
    if (wasQuickMounted) {
      this.quickPluginId = null
      this.stopQuickHeightWatch()
      sendShellEvent({ type: 'quick-plugin-mode', mode: null })
    }
    this.applyTransition(pluginId, 'crash', reason)
    sendShellEvent({
      type: 'plugin-error',
      pluginId,
      message: reason
    })

    const attempts = this.restartAttempts.get(pluginId) ?? 0
    if (attempts >= 1) {
      logWarn('lifecycle', `${pluginId}: crashed again (${reason}), no auto restart`)
      return
    }
    this.restartAttempts.set(pluginId, attempts + 1)
    logInfo('lifecycle', `${pluginId}: auto restart after crash (${reason})`)
    // 自动重启 = openPlugin 重建（containers 记录带回原容器；quick 容器在
    // openPlugin 尾部已重新挂载）；稳定存活后重置额度
    void this.openPlugin(pluginId).catch((err: Error) => {
      sendShellEvent({ type: 'plugin-error', pluginId, message: err.message })
    })
  }

  /** 从父 contentView（主窗或 quick 容器）摘除 view 并销毁 webContents（close/hibernate/crash 共用） */
  private teardownView(entry: PluginEntry): void {
    try {
      // 按容器摘 child，避免残留已销毁引用
      const parent =
        entry.container === 'quick' ? getQuickWindow() : getMainWindow()
      if (parent && typeof parent.contentView.removeChildView === 'function') {
        try {
          parent.contentView.removeChildView(entry.view)
        } catch {
          // 已不在父视图中
        }
      }
      if (!entry.view.webContents.isDestroyed()) {
        entry.view.webContents.removeAllListeners()
        entry.view.webContents.close()
      }
    } catch {
      // already gone
    }
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

export const pluginHost = new PluginHost()

// 文件变更 → 自动热重载（开发者无需手点）；回调注入避免 pluginHotReload ↔ Host 环依赖
setPluginHotReloadHandler((pluginId) => {
  pluginHost.reloadPlugin(pluginId)
})

// —— createQuickWindow 联动注入（直接 import 会成模块环：Host → quickWindow → Host）——

/** quick 窗高 tween/resize 时联动布局 quick 容器中的插件 view */
setQuickPluginRelayout(() => pluginHost.layoutQuickPlugins())

/** quick 小窗隐藏：挂载插件退 background + 休眠计时（view 留在不可见 contentView） */
setQuickPluginHiddenHook(() => pluginHost.onQuickHidden())

/**
 * quick 呼出时恢复挂载中的插件态：重推 quick-plugin-mode（渲染层切插件 UI）、
 * 返回目标窗高（输入条 + 插件期望高度）；无挂载返回 null（列表态）。
 */
setQuickPluginRestoreHook(() => pluginHost.notifyQuickRestore())
