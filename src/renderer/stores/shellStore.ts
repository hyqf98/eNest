import type { DevPluginLoadOptions } from '@shared/types/plugin'
/**
 * shellStore — 壳子全局状态（zustand）
 * 管理视图切换、插件列表、Tab 生命周期、搜索/筛选条件、插件就绪/错误与开发者日志。
 * 异步动作通过 shellApi 与 main/preload 交互；Toast 经 toastStore 推送。
 * Tab 会话由主进程统一持久化，启动时 hydrateSessionTabs 恢复
 * （惰性：仅上次 active 插件真正孵化，其余 Tab 以占位条目进入列表，点击时再 openPlugin）。
 * 崩溃态：plugin-error 事件标记 tab.crashed，Tab 按钮显示重试样式，点击重新 openPlugin。
 * 依赖：shellApi、toastStore。
 */
import { create } from 'zustand'
import type { PluginSummary, PluginTab, ShellView, TabStyle } from '@shared/types/plugin'
import { PLUGIN_CATEGORY_COLOR_DEFAULT } from '@shared/constants'
import { shellApi } from '@renderer/services/shellApi'
import { toastStore } from '@renderer/hooks/useToast'

/** 将当前 Tab 状态推送到主进程，供左侧悬浮窗渲染 */
function pushOrbState(state: {
  view: ShellView
  tabStyle: TabStyle
  activeTabId: string | null
  tabs: ShellTab[]
}): void {
  void shellApi.syncOrbState?.({
    view: state.view,
    tabStyle: state.tabStyle,
    activeTabId: state.activeTabId,
    tabs: state.tabs
  }).catch(() => undefined)
}

/** 开发页后台启动仍会收到宿主的激活事件；该请求不切走当前壳子页面。 */
const backgroundDebugStarts = new Set<string>()
const closingTabs = new Set<string>()
let lastTabRevision = -1
let sessionRestore: Promise<void> | null = null
/** 市场分段：浏览全部 vs 已安装 */
export type Seg = 'browse' | 'installed'

/**
 * 壳子内 Tab 的扩展态（PluginTab 字段归 @shared/types/plugin.ts，此处仅扩展）：
 * - lazy：惰性会话恢复的占位 Tab，渲染进程未孵化，点击时才 openPlugin
 * - crashed：插件渲染进程崩溃（且主进程不再自动重启），Tab 显示重试样式，点击重新 openPlugin
 */
export type ShellTab = PluginTab & { lazy?: boolean; crashed?: boolean; status?: 'loading' | 'ready' | 'error' | 'hibernated' }

interface ShellState {
  view: ShellView
  tabs: ShellTab[]
  activeTabId: string | null
  plugins: PluginSummary[]
  query: string
  category: string
  seg: Seg
  settingsTab: string
  shortcutPluginFilter: string | null
  pluginReady: boolean
  pluginError: string | null
  /** Tab 呈现方式：classic 顶栏 / orb 左侧悬浮圆轨 */
  tabStyle: TabStyle
  devLogs: { level: 'info' | 'dim' | 'warn'; text: string }[]

  setView: (view: ShellView) => void
  setQuery: (q: string) => void
  setCategory: (c: string) => void
  setSeg: (s: Seg) => void
  setSettingsTab: (t: string) => void
  setShortcutPluginFilter: (pluginId: string | null) => void
  setPluginError: (msg: string | null) => void
  setTabStyle: (style: TabStyle) => void
  hydrateTabStyle: () => Promise<void>
  /** 启动时恢复 Tab 与独立窗外壳，用户主动打开后才加载插件。 */
  hydrateSessionTabs: () => Promise<void>
  appendLog: (level: 'info' | 'dim' | 'warn', text: string) => void

  refreshPlugins: () => Promise<void>
  openPlugin: (id: string, enter?: { code?: string; payload?: unknown }) => Promise<void>
  closeTab: (tabId: string) => Promise<void>
  activateTab: (tabId: string) => Promise<void>
  goHome: () => void
  removeTabLocal: (tabId: string) => void
  loadDevPlugin: (dirPath: string, options?: DevPluginLoadOptions) => Promise<void>
  startDebugPlugin: (pluginId: string) => Promise<void>
  stopDebugPlugin: (pluginId: string) => Promise<void>
  removeDevPlugin: (pluginId: string) => Promise<void>
  reloadActivePlugin: () => Promise<void>
  openDevToolsActive: () => Promise<void>
}

/** 关闭 Tab 后优先选右侧邻居，否则左侧；非激活 Tab 关闭时保持原 active */
function pickNextTab(tabs: ShellTab[], closedId: string, activeTabId: string | null): string | null {
  if (activeTabId !== closedId) return activeTabId
  const i = tabs.findIndex((t) => t.id === closedId)
  const next = tabs[i + 1] ?? tabs[i - 1] ?? null
  return next?.id ?? null
}

/** 壳子全局 store：视图、Tab、插件市场筛选与插件宿主就绪状态 */
export const useShellStore = create<ShellState>((set, get) => ({
  view: 'home',
  tabs: [],
  activeTabId: null,
  plugins: [],
  query: '',
  category: '全部',
  seg: 'browse',
  settingsTab: 'general',
  shortcutPluginFilter: null,
  pluginReady: false,
  pluginError: null,
  tabStyle: 'classic',
  devLogs: [
    { level: 'dim', text: '[enest] shell ready' },
    { level: 'info', text: '[host] renderer boot' },
  ],

  setView: (view) => {
    if (view !== 'plugin') {
      void shellApi.hidePlugins?.().catch(() => undefined)
    }
    set({ view })
    const s = get()
    pushOrbState(s)
  },
  setQuery: (query) => set({ query }),
  setCategory: (category) => set({ category }),
  setSeg: (seg) => set({ seg }),
  setSettingsTab: (settingsTab) => set({ settingsTab }),
  setShortcutPluginFilter: (shortcutPluginFilter) => set({ shortcutPluginFilter }),
  setPluginError: (msg) => set({ pluginError: msg }),

  setTabStyle: (style) => {
    set({ tabStyle: style })
    document.documentElement.dataset.tabStyle = style
    // overlay 模式：插件全宽 inset=0；悬浮窗由主进程显示/隐藏
    void shellApi.setPluginInset?.(0).catch(() => undefined)
    void shellApi
      .setSettings({ general: { tabStyle: style } })
      .catch(() => undefined)
    pushOrbState(get())
  },

  hydrateTabStyle: async () => {
    try {
      const settings = await shellApi.getSettings()
      const raw = settings.general?.tabStyle
      const style: TabStyle = raw === 'orb' ? 'orb' : 'classic'
      set({ tabStyle: style })
      document.documentElement.dataset.tabStyle = style
      void shellApi.setPluginInset?.(0).catch(() => undefined)
      pushOrbState(get())
    } catch {
      document.documentElement.dataset.tabStyle = 'classic'
    }
  },

  /**
   * 主进程按会话历史恢复逻辑 Tab 和独立窗外壳。包括上次激活的插件，
   * 全部等待用户主动打开才创建内容 WebContents，避免多插件启动风暴。
   * 依赖 refreshPlugins 先完成（App 在 splash 后调用）。
   */
  hydrateSessionTabs: () => {
    if (sessionRestore) return sessionRestore
    sessionRestore = (async () => {
      try {
        const settings = await shellApi.getSettings()
        if (get().plugins.length === 0) await get().refreshPlugins()
        const ids = (settings.general?.sessionTabs ?? []).map((tab) => tab.pluginId).filter(Boolean)
        // 主进程验证窗口归属；恢复仅创建必要的轻量标题栏，不加载插件。
        await shellApi.restoreTabs(ids)
      } catch (error) {
        get().appendLog('warn', `[host] session restore failed: ${String(error)}`)
      }
    })()
    return sessionRestore
  },

  appendLog: (level, text) =>
    set((s) => ({ devLogs: [...s.devLogs, { level, text }].slice(-200) })),

  refreshPlugins: async () => {
    const plugins = await shellApi.getPlugins()
    set({ plugins })
  },

  openPlugin: async (id, enter) => {
    const plugin = get().plugins.find((item) => item.id === id)
    if (!plugin) return
    try {
      await shellApi.openPlugin(id, enter)
      if (!plugin.installed) {
        await get().refreshPlugins()
        toastStore.getState().push(`已安装「${plugin.name}」`)
      }
      // Tab、active 和 ready 均由宿主快照推进，IPC 返回不代表页面加载完成。
      get().appendLog('info', `[host] open ${id}`)
    } catch (error) {
      toastStore.getState().push(`启动失败：${error instanceof Error ? error.message : String(error)}`, 'error')
    }
  },

  closeTab: async (tabId) => {
    const gone = get().tabs.find((tab) => tab.id === tabId)
    if (!gone || closingTabs.has(tabId)) return
    closingTabs.add(tabId)
    // 点击即反馈；真正的顺序/接班项以紧随其后的宿主快照为准。
    get().removeTabLocal(tabId)
    try {
      await shellApi.closePlugin(tabId)
      get().appendLog('info', `[host] close ${gone.pluginId}`)
    } catch (error) {
      toastStore.getState().push(`关闭失败：${error instanceof Error ? error.message : String(error)}`, 'error')
    } finally {
      closingTabs.delete(tabId)
    }
  },

  activateTab: async (tabId) => {
    if (!get().tabs.some((tab) => tab.id === tabId) || closingTabs.has(tabId)) return
    try {
      // 宿主负责 lazy/crashed/hibernated 的唤醒，所有入口共用同一流程。
      await shellApi.activatePlugin(tabId)
    } catch (error) {
      toastStore.getState().push(`切换失败：${error instanceof Error ? error.message : String(error)}`, 'error')
    }
  },

  goHome: () => {
    void shellApi.hidePlugins?.().catch(() => undefined)
    set({ view: 'home', pluginReady: false, pluginError: null })
    pushOrbState(get())
  },

  removeTabLocal: (tabId) => {
    const { tabs, activeTabId, view } = get()
    if (!tabs.some((tab) => tab.id === tabId)) return
    const remaining = tabs.filter((t) => t.id !== tabId)
    const nextId = pickNextTab(tabs, tabId, activeTabId)
    set({
      tabs: remaining,
      activeTabId: nextId,
      view: view === 'plugin' ? (nextId ? 'plugin' : 'home') : view,
      pluginReady: remaining.find((tab) => tab.id === nextId)?.status === 'ready',
      pluginError: nextId === activeTabId ? get().pluginError : null,
    })
    pushOrbState(get())
    // 卸载 / 主进程关 Tab 也会走到这里，保证 sessionTabs 同步移除
  },

  loadDevPlugin: async (dirPath, options) => {
    try {
      // Empty path opens the source picker; successful registration immediately opens the plugin.
      const plugin = await shellApi.loadDevPlugin(dirPath.trim(), options)
      get().appendLog('info', `[dev] loaded ${plugin.id} from ${plugin.rootPath ?? dirPath}`)
      toastStore.getState().push(`已加载本地插件「${plugin.name}」`)
      await get().refreshPlugins()
      await get().openPlugin(plugin.id)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (msg === 'cancelled') {
        get().appendLog('info', '[dev] load cancelled')
        return
      }
      get().appendLog('warn', `[dev] load failed: ${msg}`)
      toastStore.getState().push(`加载本地插件失败：${msg}`)
    }
  },

  /** 开发调试：启动（在主进程打开插件 View；若当前不在 plugin 视图则保持开发者页，View 后台运行） */
  startDebugPlugin: async (pluginId) => {
    if (get().view !== 'plugin') backgroundDebugStarts.add(pluginId)
    try {
      await shellApi.openPlugin(pluginId)
      if (get().view !== 'plugin') await shellApi.hidePlugins()
      get().appendLog('info', `[dev] debug start ${pluginId}`)
      toastStore.getState().push('调试已启动', 'success')
      pushOrbState(get())
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      get().appendLog('warn', `[dev] debug start failed: ${msg}`)
      toastStore.getState().push(`启动调试失败：${msg}`)
    } finally {
      backgroundDebugStarts.delete(pluginId)
    }
  },

  /** 开发调试：停止（关闭插件 View） */
  stopDebugPlugin: async (pluginId) => {
    try {
      const tabId = `t-${pluginId}`
      await shellApi.closePlugin(tabId)
      get().appendLog('info', `[dev] debug stop ${pluginId}`)
      toastStore.getState().push('调试已停止')
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      toastStore.getState().push(`停止调试失败：${msg}`)
    }
  },

  /** 开发态卸载：移出 dev 注册表并关闭视图（不删源码目录） */
  removeDevPlugin: async (pluginId) => {
    try {
      const tabId = `t-${pluginId}`
      await shellApi.closePlugin(tabId).catch(() => undefined)
      await shellApi.forgetDevPlugin(pluginId)
      await get().refreshPlugins()
      get().appendLog('info', `[dev] removed ${pluginId}`)
      toastStore.getState().push('已从开发列表移除', 'success')
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      toastStore.getState().push(`移除失败：${msg}`)
    }
  },

  reloadActivePlugin: async () => {
    const { activeTabId, tabs } = get()
    const tab = tabs.find((t) => t.id === activeTabId)
    if (!tab) {
      toastStore.getState().push('没有打开的插件可重载')
      return
    }
    await shellApi.reloadPlugin(tab.pluginId)
    get().appendLog('info', `[host] reload ${tab.pluginId}`)
    toastStore.getState().push('插件已热重载')
  },

  openDevToolsActive: async () => {
    const { activeTabId, tabs } = get()
    const tab = tabs.find((t) => t.id === activeTabId)
    const id = tab?.pluginId
    if (!id) {
      toastStore.getState().push('请先打开一个插件')
      return
    }
    await shellApi.openDevTools(id)
    toastStore.getState().push('已打开 DevTools')
  },
}))

/** 唯一的 Tab 投影入口：旧 plugin-active 事件不能覆盖更新后的宿主快照。 */
const unsubscribeTabEvents = shellApi.onEvent((payload) => {
  if (payload.type !== 'plugin-tabs' || payload.revision <= lastTabRevision) return
  lastTabRevision = payload.revision
  const store = useShellStore.getState()
  // 新一代实例可能在旧 close IPC 回包之前出现；完整快照始终胜过本地关闭占位。
  const tabs: ShellTab[] = payload.tabs.map((tab) => {
    const pluginId = tab.id.startsWith('t-') ? tab.id.slice(2) : tab.id
    const plugin = store.plugins.find((item) => item.id === pluginId)
    const previous = store.tabs.find((item) => item.id === tab.id)
    return { ...tab, pluginId, color: tab.color ?? plugin?.color ?? previous?.color ?? PLUGIN_CATEGORY_COLOR_DEFAULT,
      icon: tab.icon === null ? null : tab.icon ?? plugin?.icon ?? previous?.icon,
      glyph: tab.glyph ?? plugin?.glyph ?? previous?.glyph ?? '⌥',
      lazy: tab.status === 'hibernated', crashed: tab.status === 'error' }
  })
  const active = tabs.find((tab) => tab.id === payload.activeTabId)
  const keepShellView = store.view !== 'plugin' && !!active && backgroundDebugStarts.has(active.pluginId)
  useShellStore.setState({
    tabs,
    activeTabId: active?.id ?? null,
    view: keepShellView ? store.view : active ? 'plugin' : store.view === 'plugin' ? 'home' : store.view,
    pluginReady: active?.status === 'ready' && !keepShellView,
    pluginError: active?.status === 'error' ? store.pluginError ?? '插件启动失败，请重试。' : null,
  })
  if (keepShellView) void shellApi.hidePlugins().catch(() => undefined)
  pushOrbState(useShellStore.getState())
})
if (import.meta.hot) import.meta.hot.dispose(unsubscribeTabEvents)
