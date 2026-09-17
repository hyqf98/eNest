/**
 * shellStore — 壳子全局状态（zustand）
 * 管理视图切换、插件列表、Tab 生命周期、搜索/筛选条件、插件就绪/错误与开发者日志。
 * 异步动作通过 shellApi 与 main/preload 交互；Toast 经 toastStore 推送。
 * Tab 会话：打开/关闭/激活后 debounce 写入 settings.sessionTabs，启动时 hydrateSessionTabs 恢复。
 * 依赖：shellApi、toastStore。
 */
import { create } from 'zustand'
import type { PluginSummary, PluginTab, ShellView, TabStyle } from '@shared/types/plugin'
import { shellApi } from '@renderer/services/shellApi'
import { toastStore } from '@renderer/hooks/useToast'

/** 将当前 Tab 状态推送到主进程，供左侧悬浮窗渲染 */
function pushOrbState(state: {
  view: ShellView
  tabStyle: TabStyle
  activeTabId: string | null
  tabs: PluginTab[]
}): void {
  void shellApi.syncOrbState?.({
    view: state.view,
    tabStyle: state.tabStyle,
    activeTabId: state.activeTabId,
    tabs: state.tabs
  }).catch(() => undefined)
}

/** Tab 会话持久化 debounce（ms）；避免连续开关 Tab 时刷 IPC */
const SESSION_PERSIST_MS = 400
let sessionPersistTimer: ReturnType<typeof setTimeout> | null = null

/** debounce 将当前 tabs / active 写入 settings.sessionTabs（仅插件，不含壳子页） */
function scheduleSessionPersist(state: {
  tabs: PluginTab[]
  activeTabId: string | null
}): void {
  if (sessionPersistTimer) clearTimeout(sessionPersistTimer)
  sessionPersistTimer = setTimeout(() => {
    sessionPersistTimer = null
    const sessionTabs = state.tabs.map((t) => ({ pluginId: t.pluginId, title: t.title }))
    const active = state.tabs.find((t) => t.id === state.activeTabId)
    void shellApi
      .setSettings({
        general: {
          sessionTabs,
          sessionActivePluginId: active?.pluginId ?? ''
        }
      })
      .catch(() => undefined)
  }, SESSION_PERSIST_MS)
}

/** 市场分段：浏览全部 vs 已安装 */
export type Seg = 'browse' | 'installed'

interface ShellState {
  view: ShellView
  tabs: PluginTab[]
  activeTabId: string | null
  plugins: PluginSummary[]
  query: string
  category: string
  seg: Seg
  settingsTab: string
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
  setPluginReady: (ready: boolean) => void
  setPluginError: (msg: string | null) => void
  setTabStyle: (style: TabStyle) => void
  hydrateTabStyle: () => Promise<void>
  /** 启动时从 settings.sessionTabs 恢复已安装插件 Tab；失败静默跳过 */
  hydrateSessionTabs: () => Promise<void>
  appendLog: (level: 'info' | 'dim' | 'warn', text: string) => void

  refreshPlugins: () => Promise<void>
  openPlugin: (id: string) => Promise<void>
  closeTab: (tabId: string) => Promise<void>
  activateTab: (tabId: string) => Promise<void>
  goHome: () => void
  updateTabTitle: (tabId: string, title: string) => void
  removeTabLocal: (tabId: string) => void
  loadDevPlugin: (dirPath: string) => Promise<void>
  reloadActivePlugin: () => Promise<void>
  openDevToolsActive: () => Promise<void>
}

/** 关闭 Tab 后优先选右侧邻居，否则左侧；非激活 Tab 关闭时保持原 active */
function pickNextTab(tabs: PluginTab[], closedId: string, activeTabId: string | null): string | null {
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
  setPluginReady: (ready) => set({ pluginReady: ready }),
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
   * 启动恢复：仅恢复 settings.sessionTabs 中「当前已安装」的插件 Tab。
   * 未安装/打开失败的静默跳过；activePluginId 无匹配则回首页。
   * 依赖 refreshPlugins 先完成（App 在 splash 后调用）。
   */
  hydrateSessionTabs: async () => {
    try {
      const settings = await shellApi.getSettings()
      const saved = settings.general?.sessionTabs
      if (!Array.isArray(saved) || saved.length === 0) return
      // 确保插件列表就绪（openPlugin 依赖 plugins.find）
      if (get().plugins.length === 0) {
        await get().refreshPlugins()
      }
      const plugins = get().plugins
      const restoredIds = new Set<string>()
      for (const item of saved) {
        const pid = item?.pluginId
        if (!pid || restoredIds.has(pid)) continue
        const plugin = plugins.find((p) => p.id === pid)
        // 仅恢复已安装插件；未安装/不存在静默跳过
        if (!plugin?.installed) continue
        try {
          await get().openPlugin(pid)
          restoredIds.add(pid)
        } catch {
          /* 单个失败不影响其它恢复 */
        }
      }
      if (restoredIds.size === 0) return
      const activePid = settings.general?.sessionActivePluginId
      const activeTab = activePid
        ? get().tabs.find((t) => t.pluginId === activePid)
        : undefined
      if (activeTab) {
        await get().activateTab(activeTab.id)
      } else {
        // active 缺失或未恢复成功 → 首页（Tab 仍保留，可手动点开）
        get().goHome()
      }
    } catch {
      /* 设置读取失败：保持空会话 */
    }
  },

  appendLog: (level, text) =>
    set((s) => ({ devLogs: [...s.devLogs, { level, text }].slice(-200) })),

  refreshPlugins: async () => {
    const plugins = await shellApi.getPlugins()
    set({ plugins })
  },

  openPlugin: async (id) => {
    const { plugins, tabs } = get()
    const plugin = plugins.find((p) => p.id === id)
    if (!plugin) return
    if (!plugin.installed) {
      await shellApi.openPlugin(id)
      await get().refreshPlugins()
      const fresh = get().plugins.find((p) => p.id === id)
      toastStore.getState().push(`已安装「${fresh?.name ?? plugin.name}」`)
    } else {
      await shellApi.openPlugin(id)
    }
    const target = get().plugins.find((p) => p.id === id) ?? plugin
    let tab = tabs.find((t) => t.pluginId === id)
    if (!tab) {
      tab = {
        id: `t-${id}`,
        pluginId: id,
        title: target.name,
        color: target.color,
        glyph: target.glyph,
      }
      set((s) => ({ tabs: [...s.tabs, tab as PluginTab] }))
    }
    set({
      activeTabId: tab.id,
      view: 'plugin',
      pluginReady: false,
      pluginError: null,
    })
    pushOrbState(get())
    scheduleSessionPersist(get())
    void get().appendLog('info', `[host] open ${id}`)
    window.setTimeout(() => {
      if (get().activeTabId === tab!.id) set({ pluginReady: true })
    }, 400)
  },

  closeTab: async (tabId) => {
    const { tabs, activeTabId } = get()
    const gone = tabs.find((t) => t.id === tabId)
    if (!gone) return
    await shellApi.closePlugin(tabId)
    const remaining = tabs.filter((t) => t.id !== tabId)
    const nextId = pickNextTab(tabs, tabId, activeTabId)
    set({
      tabs: remaining,
      activeTabId: nextId,
      view: nextId ? 'plugin' : 'home',
      pluginReady: false,
      pluginError: null,
    })
    pushOrbState(get())
    scheduleSessionPersist(get())
    toastStore.getState().push(`已关闭「${gone.title}」`)
    get().appendLog('info', `[host] close ${gone.pluginId}`)
  },

  activateTab: async (tabId) => {
    await shellApi.activatePlugin(tabId)
    set({ activeTabId: tabId, view: 'plugin', pluginReady: false, pluginError: null })
    pushOrbState(get())
    scheduleSessionPersist(get())
    window.setTimeout(() => {
      if (get().activeTabId === tabId) set({ pluginReady: true })
    }, 300)
  },

  goHome: () => {
    void shellApi.hidePlugins?.().catch(() => undefined)
    set({ view: 'home', pluginReady: false, pluginError: null })
    pushOrbState(get())
  },

  updateTabTitle: (tabId, title) =>
    set((s) => ({ tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, title } : t)) })),

  removeTabLocal: (tabId) => {
    const { tabs, activeTabId } = get()
    const remaining = tabs.filter((t) => t.id !== tabId)
    const nextId = pickNextTab(tabs, tabId, activeTabId)
    set({ tabs: remaining, activeTabId: nextId, view: nextId ? 'plugin' : 'home' })
    pushOrbState(get())
    // 卸载 / 主进程关 Tab 也会走到这里，保证 sessionTabs 同步移除
    scheduleSessionPersist(get())
  },

  loadDevPlugin: async (dirPath) => {
    if (!dirPath.trim()) return
    try {
      const plugin = await shellApi.loadDevPlugin(dirPath.trim())
      get().appendLog('info', `[dev] loaded ${plugin.id} from ${dirPath}`)
      toastStore.getState().push(`已加载本地插件「${plugin.name}」`)
      await get().refreshPlugins()
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      get().appendLog('warn', `[dev] load failed: ${msg}`)
      toastStore.getState().push('加载本地插件失败')
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
