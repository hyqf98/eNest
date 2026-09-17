/**
 * PluginHost — 插件运行时宿主
 * 职责：为每个打开的插件创建独立 WebContentsView / session partition，
 * 管理激活、关闭（立即销毁）、窗口缩放时的布局；
 * 负责 UI 标准落地：chrome 高度、背景透明、主题 Token 注入与变更广播；
 * 负责完整生命周期事件（enter/out/beforeClose/destroy）与状态机推进。
 * 被 createShellWindow / shellHandlers 调用。
 * 关键依赖：PluginRegistry、pluginProtocol、PluginLifecycle（状态机）、
 * createShellWindow（窗口引用与事件推送）、resolveThemeCss（主题 Token 解析）、logService。
 *
 * 生命周期（见 PluginLifecycle.ts 头注释）：
 *   installed → opening → ready → active ⇄ background → closing → closed
 *                                 ↘ crash
 *   uninstall: any → clearing-storage → uninstalled
 *
 * 向插件推送的事件（通道 plugin:lifecycle）：
 *   enter       — 首次 did-finish-load 后 + 每次 activate（与 out 成对，便于 pause/resume）
 *   out         — 其它 Tab 成为 active（本视图隐藏），isKill 固定 false
 *   beforeClose — 销毁前，reason: tab-close | uninstall | app-quit；可选等 ack，最多 300ms
 *   destroy     — 关闭开始后的尽力通知
 */
import { nativeTheme, session, WebContentsView, type WebContents } from 'electron'
import {
  IpcChannels,
  type PluginEventPayload
} from '@shared/types/ipc'
import { pluginPartition, pluginProtocolUrl, pluginChromeBarHeight, toTabId, toPluginId } from '@shared/constants'
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
import { logInfo, logWarn } from '@main/logs/logService'
import { clearPluginSession } from '@main/plugin/PluginSessionStore'
import {
  INITIAL_LIFECYCLE_STATE,
  nextState,
  type PluginLifecycleAction,
  type PluginLifecycleState
} from '@main/plugin/PluginLifecycle'
import { pluginRegistry } from '@main/plugin/PluginRegistry'
import { isEnabledSync } from '@main/plugin/pluginEnabledStore'
import { applyProxyToPluginPartition } from '@main/proxy/proxyService'
import { registerPluginProtocolForSession } from '@main/plugin/pluginProtocol'
import { resolveThemeTokens, themeTokensToInjectScript } from '@main/theme/resolveThemeCss'

/** beforeClose 等待插件 ack 的上限；超时直接销毁，避免挂死关闭流程 */
const BEFORE_CLOSE_ACK_TIMEOUT_MS = 300

interface PluginEntry {
  view: WebContentsView
  pluginId: string
  partition: string
  rootPath: string
  /** 已归一的 UI 配置（来自 manifest.ui） */
  ui: PluginUiConfig
}

/** 管理插件 WebContentsView 的生命周期、分区与激活状态 */
export class PluginHost {
  private entries = new Map<string, PluginEntry>()
  private byWcId = new Map<number, string>()
  private activeTabId: string | null = null
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

  /** 读取已打开插件的 UI 配置（未打开返回 null） */
  getUiConfig(pluginId: string): PluginUiConfig | null {
    return this.entries.get(pluginId)?.ui ?? null
  }

  /** 插件是否有存活 entry（View 仍在） */
  isOpened(pluginId: string): boolean {
    return this.entries.has(pluginId)
  }

  /** 当前生命周期状态（未打开返回 installed） */
  getState(pluginId: string): PluginLifecycleState {
    return this.states.get(pluginId) ?? INITIAL_LIFECYCLE_STATE
  }

  /** 卸载开始：任意 → clearing-storage（由 PluginUninstaller 调用） */
  beginUninstall(pluginId: string): void {
    this.applyTransition(pluginId, 'uninstall')
  }

  /** 卸载完成：clearing-storage → uninstalled */
  finishUninstall(pluginId: string): void {
    this.applyTransition(pluginId, 'uninstalled')
    this.states.delete(pluginId)
    this.enterSent.delete(pluginId)
    this.pendingEnter.delete(pluginId)
  }

  /** 插件对 beforeClose 的确认（由 pluginHandlers 转发） */
  ackBeforeClose(pluginId: string): void {
    const resolve = this.pendingAcks.get(pluginId)
    if (resolve) resolve()
  }

  /**
   * 打开插件：已存在则激活（可带新的 enter 载荷），
   * 否则创建独立 partition 的 WebContentsView 并加载入口。
   * enter.code 优先进 URL query，完整载荷在 did-finish-load 后经 plugin:lifecycle 下发。
   */
  async openPlugin(pluginId: string, enter?: PluginEnterPayload): Promise<string> {
    const existing = this.entries.get(pluginId)
    if (existing) {
      this.activatePlugin(pluginId, enter)
      return pluginId
    }

    // 已显式禁用的插件拒绝打开（Quick / 市场 / IPC 均走此路径）
    if (!isEnabledSync(pluginId)) {
      throw new Error(`plugin disabled: ${pluginId}`)
    }

    const summary = await pluginRegistry.ensureInstalled(pluginId)
    const rootPath = summary.rootPath
    if (!rootPath) throw new Error(`plugin not installed: ${pluginId}`)

    const manifest = pluginRegistry.getManifest(pluginId)
    const ui = resolvePluginUi(manifest?.ui ?? summary.ui)

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
      this.applyTransition(pluginId, 'crash', details.reason)
      sendShellEvent({
        type: 'plugin-error',
        pluginId,
        message: details.reason
      })
    })

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
      // 首次加载完成且当前已是目标 active Tab → 立刻 enter
      if (this.activeTabId === pluginId) {
        this.sendEnter(pluginId)
      }
    })

    const entry: PluginEntry = { view, pluginId, partition, rootPath, ui }
    this.entries.set(pluginId, entry)
    this.byWcId.set(view.webContents.id, pluginId)

    const win = getMainWindow()
    if (win) {
      win.contentView.addChildView(view)
      view.setBounds(getPluginContentBounds(pluginChromeBarHeight(ui.chrome)))
    }

    this.hookNativeTheme()
    // 立即激活视图（显示）；enter 事件等 did-finish-load 后再发，避免插件尚未就绪
    this.activatePlugin(pluginId)
    logInfo('lifecycle', `${pluginId}: installed → opening (open)`)
    return pluginId
  }

  /**
   * 关闭插件：beforeClose（可选等 ack ≤300ms）→ destroy → 移除视图并回收。
   * reason 决定 beforeClose 载荷；日常关 Tab 用 tab-close，卸载用 uninstall，退出用 app-quit。
   */
  async closePlugin(
    tabId: string,
    reason: PluginCloseReason = 'tab-close'
  ): Promise<void> {
    const pluginId = toPluginId(tabId)
    const entry = this.entries.get(pluginId)
    if (!entry) return

    // 先从 map 摘除，防止 beforeClose 期间又被 activate / 重复 close
    this.entries.delete(pluginId)
    this.byWcId.delete(entry.view.webContents.id)

    this.applyTransition(pluginId, 'close', reason)

    // beforeClose：给插件 flush 草稿 / 停轮询的窗口；ack 可选，超时兜底
    this.sendToPlugin(entry.view.webContents, { event: 'beforeClose', reason })
    await this.waitForBeforeCloseAck(pluginId)

    // destroy：尽力而为，此时视图可能已在销毁中
    this.sendToPlugin(entry.view.webContents, { event: 'destroy' })
    this.applyTransition(pluginId, 'destroyed')

    try {
      const win = getMainWindow()
      // 从父 contentView 摘掉 child，避免残留已销毁引用
      if (win && typeof win.contentView.removeChildView === 'function') {
        try {
          win.contentView.removeChildView(entry.view)
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

    // 销毁时清空会话态 storage.session（不落盘，不跨关闭保留）
    clearPluginSession(pluginId)
    this.enterSent.delete(pluginId)
    this.pendingEnter.delete(pluginId)
    this.states.delete(pluginId)

    if (this.activeTabId === pluginId) {
      this.activeTabId = null
      const next = [...this.entries.keys()][0]
      if (next) this.activatePlugin(next)
      else sendShellEvent({ type: 'plugin-active', tabId: null })
    }
    sendShellEvent({ type: 'tab-closed', tabId: toTabId(pluginId) })
    sendShellEvent({ type: 'plugins-changed' })
    logInfo('lifecycle', `${pluginId}: closing → closed (${reason})`)
  }

  /**
   * 激活指定插件：仅显示目标 view，其余隐藏，并按该插件 chrome 模式更新布局。
   * 对已加载的插件发送 out（旧 active）/ enter（新 active）对，便于 pause/resume。
   */
  activatePlugin(tabId: string, enter?: PluginEnterPayload): void {
    const pluginId = toPluginId(tabId)
    const entry = this.entries.get(pluginId)
    if (!entry) return

    // 旧 active 退后台：先 out 再隐藏
    if (this.activeTabId && this.activeTabId !== pluginId) {
      const prevId = this.activeTabId
      const prev = this.entries.get(prevId)
      if (prev) {
        this.sendToPlugin(prev.view.webContents, { event: 'out', isKill: false })
      }
      this.applyTransition(prevId, 'deactivate')
    }

    this.activeTabId = pluginId

    for (const [id, e] of this.entries) {
      e.view.setVisible(id === pluginId)
    }

    const win = getMainWindow()
    if (win) {
      win.contentView.addChildView(entry.view)
      entry.view.setBounds(getPluginContentBounds(pluginChromeBarHeight(entry.ui.chrome)))
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

  /** 窗口 resize：按各插件自身 chrome 高度分别布局（不同插件条高可共存） */
  layoutAll(): void {
    for (const entry of this.entries.values()) {
      entry.view.setBounds(getPluginContentBounds(pluginChromeBarHeight(entry.ui.chrome)))
    }
  }

  /** 隐藏全部插件视图：回首页/设置/开发者时调用，避免原生层盖住壳子 Tab 与内容 */
  hideAllViews(): void {
    for (const entry of this.entries.values()) {
      try {
        entry.view.setVisible(false)
      } catch {
        // view 可能已销毁
      }
    }
  }

  reloadPlugin(tabId: string): void {
    const pluginId = toPluginId(tabId)
    // 重载 = 冷启动语义：清 enterSent，下次 did-finish-load 重新 enter
    this.enterSent.delete(pluginId)
    this.applyTransition(pluginId, 'reload')
    this.entries.get(pluginId)?.view.webContents.reload()
  }

  openDevTools(tabId: string, mode: 'detach' | 'right' = 'detach'): void {
    const pluginId = toPluginId(tabId)
    const entry = this.entries.get(pluginId)
    if (!entry) return
    entry.view.webContents.openDevTools({ mode })
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
    await Promise.all([...this.entries.keys()].map((id) => this.closePlugin(id, reason)))
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
