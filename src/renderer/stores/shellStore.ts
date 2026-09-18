/**
 * shellStore — 壳子全局状态（zustand）
 * 管理视图切换、插件列表、Tab 生命周期、搜索/筛选条件、插件就绪/错误与开发者日志。
 * 异步动作通过 shellApi 与 main/preload 交互；Toast 经 toastStore 推送。
 * Tab 会话：打开/关闭/激活后 debounce 写入 settings.sessionTabs，启动时 hydrateSessionTabs 恢复
 * （惰性：仅上次 active 插件真正孵化，其余 Tab 以占位条目进入列表，点击时再 openPlugin）。
 * 崩溃态：plugin-error 事件标记 tab.crashed，Tab 按钮显示重试样式，点击重新 openPlugin。
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
  tabs: ShellTab[]
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
  tabs: ShellTab[]
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

/**
 * 壳子内 Tab 的扩展态（PluginTab 字段归 @shared/types/plugin.ts，此处仅扩展）：
 * - lazy：惰性会话恢复的占位 Tab，渲染进程未孵化，点击时才 openPlugin
 * - crashed：插件渲染进程崩溃（且主进程不再自动重启），Tab 显示重试样式，点击重新 openPlugin
 */
export type ShellTab = PluginTab & { lazy?: boolean; crashed?: boolean }

interface ShellState {
  view: ShellView
  tabs: ShellTab[]
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
  /** 启动时从 settings.sessionTabs 惰性恢复 Tab 列表（仅上次 active 真正孵化） */
  hydrateSessionTabs: () => Promise<void>
  appendLog: (level: 'info' | 'dim' | 'warn', text: string) => void

  refreshPlugins: () => Promise<void>
  openPlugin: (id: string, enter?: { code?: string; payload?: unknown }) => Promise<void>
  closeTab: (tabId: string) => Promise<void>
  activateTab: (tabId: string) => Promise<void>
  goHome: () => void
  updateTabTitle: (tabId: string, title: string) => void
  removeTabLocal: (tabId: string) => void
  /** plugin-error 事件桥：标记指定插件 Tab 为崩溃态（二次 crash 不自动重启时使用） */
  markTabCrashed: (pluginId: string) => void
  /** Tab 从崩溃态恢复（重新 openPlugin 成功后清除标记） */
  clearTabCrashed: (pluginId: string) => void
  /** 惰性会话恢复：新增占位 Tab（不孵化渲染进程） */
  addPlaceholderTab: (pluginId: string, cachedTitle: string | undefined, plugin: PluginSummary) => void
  loadDevPlugin: (dirPath: string) => Promise<void>
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
   * 启动惰性恢复：sessionTabs 全量回填 Tab 列表（保持顺序），但仅对
   * sessionActivePluginId 对应插件真正 openPlugin 孵化渲染进程；
   * 其余 Tab 以「占位条目」进入列表（lazy 标记，点击时才 openPlugin），
   * 避免 10+ 插件时启动一次性孵化全部进程。未安装的静默跳过；
   * active 插件缺失/打开失败则回首页（占位 Tab 仍保留，可手动点开）。
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
      const activePid = settings.general?.sessionActivePluginId
      let addedAny = false
      for (const item of saved) {
        const pid = item?.pluginId
        if (!pid) continue
        const plugin = plugins.find((p) => p.id === pid)
        // 仅恢复已安装插件；未安装/不存在静默跳过
        if (!plugin?.installed) continue
        // 去重：同一插件只占一个 Tab
        if (get().tabs.some((t) => t.pluginId === pid)) continue
        if (pid === activePid) {
          // 上次 active 的插件真正孵化（单个失败不阻断其余占位 Tab 恢复）
          try {
            await get().openPlugin(pid)
          } catch {
            /* 禁用/打开失败：回落占位 Tab，可手动点开 */
            get().addPlaceholderTab(pid, item?.title, plugin)
          }
        } else {
          // 占位条目：不孵化渲染进程，点击时经 activateTab 唤醒
          get().addPlaceholderTab(pid, item?.title, plugin)
        }
        addedAny = true
      }
      if (!addedAny) return
      const activeTab = activePid
        ? get().tabs.find((t) => t.pluginId === activePid)
        : undefined
      if (activeTab && !activeTab.lazy) {
        await get().activateTab(activeTab.id)
      } else {
        // active 缺失或未恢复成功 → 首页（Tab 仍保留，可手动点开）
        get().goHome()
      }
      pushOrbState(get())
    } catch {
      /* 设置读取失败：保持空会话 */
    }
  },

  /** 新增占位 Tab（惰性会话恢复用）：lazy 标记 + 缓存显示名兜底 */
  addPlaceholderTab(pluginId: string, cachedTitle: string | undefined, plugin: PluginSummary): void {
    set((s) => {
      if (s.tabs.some((t) => t.pluginId === pluginId)) return s
      const tab: ShellTab = {
        id: `t-${pluginId}`,
        pluginId,
        title: plugin.name ?? cachedTitle ?? pluginId,
        color: plugin.color,
        glyph: plugin.glyph,
        lazy: true
      }
      return { tabs: [...s.tabs, tab] }
    })
    scheduleSessionPersist(get())
  },

  appendLog: (level, text) =>
    set((s) => ({ devLogs: [...s.devLogs, { level, text }].slice(-200) })),

  refreshPlugins: async () => {
    const plugins = await shellApi.getPlugins()
    set({ plugins })
  },

  openPlugin: async (id, enter) => {
    const { plugins } = get()
    const plugin = plugins.find((p) => p.id === id)
    if (!plugin) return
    if (!plugin.installed) {
      await shellApi.openPlugin(id, enter)
      await get().refreshPlugins()
      const fresh = get().plugins.find((p) => p.id === id)
      toastStore.getState().push(`已安装「${fresh?.name ?? plugin.name}」`)
    } else {
      await shellApi.openPlugin(id, enter)
    }
    const target = get().plugins.find((p) => p.id === id) ?? plugin
    // 必须重读当前 tabs：await 期间 plugin-active 事件桥可能已为 pin/迁移场景
    // 补过 Tab（旧快照查不到会导致重复添加——同 id 双 Tab、关闭时一起消失）
    let tab = get().tabs.find((t) => t.pluginId === id)
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
    // 真正孵化成功：占位 / 崩溃标记一并清除
    if (tab.lazy || tab.crashed) {
      const tabId = tab.id
      set((s) => ({
        tabs: s.tabs.map((t) =>
          t.id === tabId ? { ...t, lazy: false, crashed: false } : t
        )
      }))
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
    const tab = get().tabs.find((t) => t.id === tabId)
    // 占位 Tab（惰性恢复）或崩溃 Tab（点击重试）：先 openPlugin 唤醒/重建
    if (tab && (tab.lazy || tab.crashed)) {
      try {
        await get().openPlugin(tab.pluginId)
        // openPlugin 已完成激活与状态清理，直接返回
        return
      } catch {
        /* 打开失败：openPlugin 内部不抛出（走 plugin-error），回落常规激活 */
      }
    }
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

  /** plugin-error 事件桥：标记 Tab 崩溃态（Tab 保留，显示重试样式） */
  markTabCrashed: (pluginId) => {
    const tabId = `t-${pluginId}`
    set((s) => ({
      tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, crashed: true } : t))
    }))
    // 当前激活 Tab 崩溃时立即呈现错误面板（pluginError 由事件桥写入）
    if (get().activeTabId === tabId) {
      pushOrbState(get())
    }
  },

  /** Tab 从崩溃态恢复（重新 openPlugin 成功后清除标记） */
  clearTabCrashed: (pluginId) => {
    const tabId = `t-${pluginId}`
    set((s) => ({
      tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, crashed: false } : t))
    }))
  },

  loadDevPlugin: async (dirPath) => {
    try {
      // 空路径 → 主进程弹系统目录选择框；加载后停留在开发者页，不跳插件 Tab
      const plugin = await shellApi.loadDevPlugin(dirPath.trim())
      get().appendLog('info', `[dev] loaded ${plugin.id} from ${plugin.rootPath ?? dirPath}`)
      toastStore.getState().push(`已加载本地插件「${plugin.name}」`)
      await get().refreshPlugins()
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
    try {
      await shellApi.openPlugin(pluginId)
      const { plugins, tabs, activeTabId, view } = get()
      const target = plugins.find((p) => p.id === pluginId)
      let tab = tabs.find((t) => t.pluginId === pluginId)
      if (!tab) {
        tab = {
          id: `t-${pluginId}`,
          pluginId,
          title: target?.name ?? pluginId,
          color: target?.color ?? '#f5a524',
          glyph: target?.glyph ?? '⌥'
        }
        set((s) => ({ tabs: [...s.tabs, tab as PluginTab] }))
      }
      // 保持当前壳子视图（开发者/设置）；插件 View 在后台可热更/DevTools
      set({ activeTabId: tab.id })
      if (view !== 'plugin') {
        void shellApi.hidePlugins?.().catch(() => undefined)
      }
      get().appendLog('info', `[dev] debug start ${pluginId}`)
      toastStore.getState().push('调试已启动', 'success')
      pushOrbState(get())
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      get().appendLog('warn', `[dev] debug start failed: ${msg}`)
      toastStore.getState().push(`启动调试失败：${msg}`)
    }
  },

  /** 开发调试：停止（关闭插件 View） */
  stopDebugPlugin: async (pluginId) => {
    try {
      const tabId = `t-${pluginId}`
      await shellApi.closePlugin(tabId)
      get().removeTabLocal(tabId)
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
      get().removeTabLocal(tabId)
      // 主进程卸载会 removeDevPlugin + 重扫；对纯 dev 插件源码目录保留
      if (shellApi.uninstallPlugin) {
        await shellApi.uninstallPlugin(pluginId)
      }
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

/**
 * 自包含事件桥：
 * - plugin-error：把对应插件 Tab 标记为崩溃态（Tab 保留，显示重试样式）。
 * - plugin-active：主进程已（重新）激活/重建该插件——crash 自愈或唤醒完成，
 *   清除崩溃标记；若该 Tab 当前正展示错误面板，同步清掉 pluginError。
 * useShellEvents 仍负责全局 plugin-error 的 toast/日志，这里只补 Tab 态
 * （不改 useShellEvents.ts，保持本 store 对崩溃 UI 的自洽）。
 */
shellApi.onEvent?.((payload) => {
  if (payload.type === 'plugin-error') {
    useShellStore.getState().markTabCrashed(payload.pluginId)
    return
  }
  if (payload.type === 'plugin-active' && payload.tabId) {
    const store = useShellStore.getState()
    const pid = payload.tabId.startsWith('t-') ? payload.tabId.slice(2) : payload.tabId
    store.clearTabCrashed(pid)
    // 主窗激活但 Tab 列表缺项（Quick「固定到主窗」迁移 / crash 重建）→ 补 Tab；
    // 视图已在主窗挂载，补后立即摘掉 lazy 标记（非「点击加载」占位）
    if (!store.tabs.some((t) => t.pluginId === pid)) {
      const summary = store.plugins.find((p) => p.id === pid)
      if (summary) {
        store.addPlaceholderTab(pid, summary.name, summary)
        useShellStore.setState((s) => ({
          tabs: s.tabs.map((t) => (t.pluginId === pid ? { ...t, lazy: false } : t))
        }))
      }
    }
    // 自动重启完成：当前 Tab 的崩溃/错误面板让位给内容
    if (store.activeTabId === payload.tabId) {
      store.setPluginError(null)
    }
  }
})
