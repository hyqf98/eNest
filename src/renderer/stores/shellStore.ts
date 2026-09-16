/**
 * shellStore — 壳子全局状态（zustand）
 * 管理视图切换、插件列表、Tab 生命周期、搜索/筛选条件、插件就绪/错误与开发者日志。
 * 异步动作通过 shellApi 与 main/preload 交互；Toast 经 toastStore 推送。
 * 依赖：shellApi、toastStore。
 */
import { create } from 'zustand'
import type { PluginSummary, PluginTab, ShellView } from '@shared/types/plugin'
import { shellApi } from '../services/shellApi'
import { toastStore } from '../hooks/useToast'

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
  devLogs: { level: 'info' | 'dim' | 'warn'; text: string }[]

  setView: (view: ShellView) => void
  setQuery: (q: string) => void
  setCategory: (c: string) => void
  setSeg: (s: Seg) => void
  setSettingsTab: (t: string) => void
  setPluginReady: (ready: boolean) => void
  setPluginError: (msg: string | null) => void
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
  devLogs: [
    { level: 'dim', text: '[enest] shell ready' },
    { level: 'info', text: '[host] renderer boot' },
  ],

  setView: (view) => set({ view }),
  setQuery: (query) => set({ query }),
  setCategory: (category) => set({ category }),
  setSeg: (seg) => set({ seg }),
  setSettingsTab: (settingsTab) => set({ settingsTab }),
  setPluginReady: (pluginReady) => set({ pluginReady }),
  setPluginError: (pluginError) => set({ pluginError }),
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
    toastStore.getState().push(`已关闭「${gone.title}」`)
    get().appendLog('info', `[host] close ${gone.pluginId}`)
  },

  activateTab: async (tabId) => {
    await shellApi.activatePlugin(tabId)
    set({ activeTabId: tabId, view: 'plugin', pluginReady: false, pluginError: null })
    window.setTimeout(() => {
      if (get().activeTabId === tabId) set({ pluginReady: true })
    }, 300)
  },

  goHome: () => set({ view: 'home', pluginReady: false, pluginError: null }),

  updateTabTitle: (tabId, title) =>
    set((s) => ({ tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, title } : t)) })),

  removeTabLocal: (tabId) => {
    const { tabs, activeTabId } = get()
    const remaining = tabs.filter((t) => t.id !== tabId)
    const nextId = pickNextTab(tabs, tabId, activeTabId)
    set({ tabs: remaining, activeTabId: nextId, view: nextId ? 'plugin' : 'home' })
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
