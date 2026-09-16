/**
 * shellApi — 渲染进程与主进程/preload 的桥接层
 * 统一暴露插件生命周期、主题、设置、路径、文件选择、README、硬件加速、DevTools 与窗口控制 API。
 * 存在 preload（window.enestShell）时合并真实实现；否则回退 localStorage mock。
 * 依赖：mockData（mockRegistry / theme / settings）、@shared types。
 */
import type {
  AppPaths,
  PluginSummary,
  PluginTab,
  ProxyConfig,
  ThemeMode,
  ThemePack,
  ThemeTokens
} from '@shared/types/plugin'
import type { ShellEventPayload, InstallJobInfo, ProxyTestResult, UpdateStatePayload } from '@shared/types/ipc'
import type {
  ApplicationScanResult,
  QuickCommand,
  QuickHotkeyApplyResult,
  QuickHotkeyConfig,
  QuickOpenRequest
} from '@shared/types/quick'
import {
  DEFAULT_SETTINGS,
  mockRegistry,
  readMockSettings,
  readMockTheme,
  writeMockSettings,
  writeMockTheme,
  type ShellSettingsData,
} from '@renderer/services/mockData'

/** shell:get-theme 返回：ThemeTokens + 主题包列表 */
export type ShellThemeResult = ThemeTokens & { packs: ThemePack[] }

export interface PickFileOptions {
  filters?: 'image' | 'video' | 'media' | 'font'
}

export interface HardwareAccelState {
  enabled: boolean
}

export interface HardwareAccelSetResult {
  needRestart: boolean
}

export interface ProxySetResult {
  needRestart: boolean
  proxy: ProxyConfig
}

/** preload 注入到渲染进程的完整 shell 能力面 */
export interface ShellApi {
  getPlugins(): Promise<PluginSummary[]>
  openPlugin(id: string): Promise<void>
  closePlugin(tabId: string): Promise<void>
  activatePlugin(tabId: string): Promise<void>
  /** 隐藏全部插件原生视图（回首页/设置/开发者时，避免遮挡壳子） */
  hidePlugins(): Promise<void>
  /** 设置插件内容区左侧 inset（px）；orb 悬浮窗模式恒为 0 */
  setPluginInset?(left: number): Promise<void>
  /** 回首页（隐藏插件 + 主壳 setView home） */
  goHome?(): Promise<void>
  /** 主壳切换视图 */
  setShellView?(view: string): Promise<void>
  syncOrbState?(state: {
    view: string
    tabStyle: string
    activeTabId: string | null
    tabs: unknown[]
  }): Promise<void>
  getOrbState?(): Promise<{
    view: string
    tabStyle: string
    activeTabId: string | null
    tabs: unknown[]
  }>
  getTheme(): Promise<ShellThemeResult>
  setTheme(
    mode: ThemeMode,
    overrides?: Record<string, string>,
    extra?: Partial<Pick<ThemeTokens, 'packId' | 'background'>>
  ): Promise<void>
  loadDevPlugin(dirPath: string): Promise<PluginSummary>
  reloadPlugin(pluginId: string): Promise<void>
  openDevTools(pluginId: string): Promise<void>
  getSettings(): Promise<ShellSettingsData>
  setSettings(settings: Partial<ShellSettingsData>): Promise<void>
  getPaths(): Promise<AppPaths>
  pickFile(options?: PickFileOptions): Promise<string | null>
  getPluginReadme(pluginId: string): Promise<string>
  getHardwareAcceleration(): Promise<HardwareAccelState>
  setHardwareAcceleration(enabled: boolean): Promise<HardwareAccelSetResult>
  /** 读取代理配置；浏览器 mock 读 localStorage */
  getProxy?(): Promise<ProxyConfig>
  /** 写入并即时应用；浏览器 mock 仅持久化 */
  setProxy?(config: ProxyConfig): Promise<ProxySetResult>
  /** 测试代理连通性；浏览器 mock 对 none 返回 ok */
  testProxy?(config?: ProxyConfig): Promise<ProxyTestResult>
  /** Electron：复制/写入自定义字体到 ~/eNest/fonts/；浏览器 mock 返回 not-available */
  saveCustomFont?(payload: {
    sourcePath?: string
    dataBase64?: string
    fileName: string
  }): Promise<{ ok: boolean; path?: string; fileName?: string; error?: string }>
  /** Electron：读取自定义字体 base64；浏览器 mock 走 localStorage */
  readCustomFont?(fileName: string): Promise<{ ok: boolean; dataBase64?: string; error?: string }>
  /** Electron：删除自定义字体文件 */
  deleteCustomFont?(fileName: string): Promise<{ ok: boolean; error?: string }>
  /** 将本地文件夹 / .enestplugin 路径入队安装；进度经 onEvent / onInstallProgress 推送 */
  installPlugin(sourcePath: string): Promise<InstallJobInfo>
  getInstallQueue?(): Promise<{ active: InstallJobInfo[]; waiting: InstallJobInfo[] }>
  /** Electron：File → 绝对路径；浏览器 mock 返回空串 */
  getPathForFile?(file: File): string
  checkForUpdates?(): Promise<UpdateStatePayload>
  downloadUpdate?(): Promise<UpdateStatePayload>
  installUpdate?(): Promise<UpdateStatePayload>
  getUpdateState?(): Promise<UpdateStatePayload>
  /** 系统级通知（Electron Notification）；浏览器 mock 用 Web Notification 兜底 */
  systemNotify?(title: string, body?: string): Promise<void>
  /** 仅订阅 install-progress 事件 */
  onInstallProgress?(
    cb: (payload: { jobId: string; name: string; progress: number; step?: string }) => void
  ): () => void
  onEvent(cb: (payload: ShellEventPayload) => void): () => void
  /** orb 悬浮窗订阅 Tab 状态推送 */
  onOrbEvent?(
    cb: (payload: { type: 'orb-state'; state: import('@shared/types/ipc').OrbRailState }) => void
  ): () => void
  minimizeWindow?(): void
  maximizeWindow?(): void
  closeWindow?(): void
  /** 在系统中打开路径；不可用时 UI 回退为复制剪贴板 */
  openPath?(path: string): Promise<void>

  // —— 快捷启动 Quick（Electron preload 提供；mock 可省略）——
  quickToggle?(): Promise<void>
  quickHide?(): void
  quickSearch?(query: string, limit?: number): Promise<{ items: QuickCommand[] }>
  quickOpen?(req: QuickOpenRequest): Promise<{ ok: boolean; error?: string }>
  quickScanApps?(force?: boolean): Promise<ApplicationScanResult>
  quickGetConfig?(): Promise<QuickHotkeyConfig>
  quickSetHotkeys?(payload: {
    enabled?: boolean
    hotkeys?: string[]
  }): Promise<QuickHotkeyApplyResult>
  onQuickShown?(cb: () => void): () => void
}

type EventCb = (payload: ShellEventPayload) => void

/** 无 Electron preload 时的浏览器 mock：内存 Tab + localStorage 主题/设置 */
function createMockApi(): ShellApi {
  const listeners = new Set<EventCb>()
  let theme = readMockTheme()
  let settings = readMockSettings()
  const openTabs = new Map<string, PluginTab>()
  let hwAccel = true

  const emit = (payload: ShellEventPayload): void => {
    for (const cb of listeners) cb(payload)
  }

  const mockPaths: AppPaths = {
    root: '~/eNest',
    plugins: '~/eNest/plugins',
    data: '~/eNest/data',
    themes: '~/eNest/themes',
    settings: '~/eNest/settings.json',
    database: '~/eNest/data/enest.db'
  }

  return {
    async getPlugins() {
      return mockRegistry.getPlugins()
    },
    async openPlugin(id) {
      const plugin = mockRegistry.getById(id)
      if (!plugin) return
      if (!plugin.installed) {
        mockRegistry.install(id)
        emit({ type: 'plugins-changed' })
      }
      const installed = mockRegistry.getById(id)
      if (!installed) return
      openTabs.set(id, {
        id: `t-${id}`,
        pluginId: id,
        title: installed.name,
        color: installed.color,
        glyph: installed.glyph,
      })
    },
    async closePlugin(tabId) {
      for (const [key, tab] of openTabs) {
        if (tab.id === tabId) {
          openTabs.delete(key)
          break
        }
      }
    },
    async activatePlugin() {
      /* mock no-op */
    },
    async hidePlugins() {
      /* mock no-op */
    },
    async setPluginInset() {
      /* mock no-op */
    },
    async goHome() {
      window.location.hash = ''
    },
    async setShellView() {
      /* mock */
    },
    async syncOrbState() {
      /* mock */
    },
    async getOrbState() {
      return { view: 'home', tabStyle: 'classic', activeTabId: null, tabs: [] }
    },
    async getTheme() {
      theme = readMockTheme()
      return {
        mode: theme.mode,
        overrides: theme.overrides,
        packId: theme.packId,
        background: theme.background,
        packs: [],
      }
    },
    async setTheme(mode, overrides, extra) {
      const resolvedKey =
        mode === 'system'
          ? typeof window !== 'undefined' &&
            typeof window.matchMedia === 'function' &&
            window.matchMedia('(prefers-color-scheme: dark)').matches
            ? 'dark'
            : 'light'
          : mode
      if (overrides) theme.overrides[resolvedKey] = overrides
      theme.mode = mode
      if (extra && 'packId' in extra) theme.packId = extra.packId ?? undefined
      if (extra && 'background' in extra) theme.background = extra.background ?? undefined
      writeMockTheme(theme)
      emit({ type: 'theme-changed', mode })
      if (extra?.packId !== undefined || extra?.background !== undefined) {
        emit({ type: 'theme-packs-changed' })
      }
    },
    async loadDevPlugin(dirPath) {
      const id = `dev.local.${dirPath.split(/[/\\]/).filter(Boolean).pop() ?? 'plugin'}`
      const existing = mockRegistry.getById(id)
      if (existing) return existing
      const dev: PluginSummary = {
        id,
        name: id.split('.').pop() ?? id,
        version: '0.0.1-dev',
        description: `本地开发插件 · ${dirPath}`,
        author: 'dev',
        category: '开发',
        installs: 'dev',
        color: '#38bdf8',
        glyph: '⚙',
        permissions: [],
        installed: true,
        rootPath: dirPath,
        devUrl: 'http://127.0.0.1:5173',
        ui: { chrome: 'default', themeAware: true, background: 'opaque', preferredColorScheme: 'auto' },
      }
      return dev
    },
    async reloadPlugin() {
      /* mock no-op */
    },
    async openDevTools() {
      /* mock no-op */
    },
    async getSettings() {
      settings = readMockSettings()
      return { ...settings }
    },
    async setSettings(partial) {
      settings = {
        ...settings,
        ...partial,
        general: {
          ...settings.general,
          ...partial.general,
        },
      }
      writeMockSettings(settings)
    },
    async getPaths() {
      return { ...mockPaths }
    },
    async pickFile(options?: PickFileOptions) {
      // 浏览器 mock：隐藏 input[type=file]，返回 object URL 供预览
      const acceptMap: Record<string, string> = {
        image: 'image/*',
        video: 'video/*',
        media: 'image/*,video/*',
        font: '.ttf,.otf,.woff,.woff2,font/ttf,font/otf,font/woff,font/woff2',
      }
      return new Promise<string | null>((resolve) => {
        const input = document.createElement('input')
        input.type = 'file'
        input.accept = acceptMap[options?.filters ?? 'media'] ?? 'image/*,video/*'
        input.style.display = 'none'
        const cleanup = () => input.remove()
        input.addEventListener('change', () => {
          const file = input.files?.[0]
          cleanup()
          resolve(file ? URL.createObjectURL(file) : null)
        })
        input.addEventListener('cancel', () => {
          cleanup()
          resolve(null)
        })
        document.body.appendChild(input)
        input.click()
      })
    },
    async getPluginReadme(pluginId) {
      const p = mockRegistry.getById(pluginId)
      const name = p?.name ?? pluginId
      const author = p?.author ?? '未知作者'
      return [
        `# ${name}`,
        '',
        p?.description ?? '这是一个 eNest 桌面插件。',
        '',
        '## 功能亮点',
        '',
        '- **本地优先**：数据默认只保存在本机',
        '- *开箱即用*：安装后即可在多 Tab 中并行运行',
        '- 快捷操作：面板内提供常用命令与搜索',
        '',
        '## 快速开始',
        '',
        '1. 点击「安装」将插件加入壳子',
        '2. 从顶部 Tab 或市场卡片打开',
        '3. 在插件设置中按需调整权限与快捷键',
        '',
        '---',
        '',
        `维护者：${author}　·　欢迎在反馈区提交问题。`,
        '',
        '```ts',
        '// 示例：与壳子桥接',
        'const shell = window.enestShell',
        'await shell?.getPlugins()',
        '```',
        '',
        '更多说明见 [eNest 开发文档](https://example.com/enest/docs)。',
      ].join('\n')
    },
    async getHardwareAcceleration() {
      return { enabled: hwAccel }
    },
    async setHardwareAcceleration(enabled) {
      hwAccel = enabled !== false
      return { needRestart: true }
    },
    async getProxy() {
      settings = readMockSettings()
      return (settings.general?.proxy as ProxyConfig | undefined) ?? { type: 'none' }
    },
    async setProxy(config) {
      const proxy: ProxyConfig = config && config.type ? config : { type: 'none' }
      settings = {
        ...settings,
        general: { ...settings.general, proxy },
      }
      writeMockSettings(settings)
      return { needRestart: false, proxy }
    },
    async testProxy(config) {
      const c = config ?? (await this.getProxy?.()) ?? { type: 'none' }
      if (!c.type || c.type === 'none') return { ok: true, latencyMs: 0 }
      // 浏览器环境无法 TCP 探测，仅做格式校验
      if (c.type === 'custom') {
        try {
          new URL(c.url ?? '')
          return { ok: true, latencyMs: 0 }
        } catch {
          return { ok: false, error: 'invalid proxy url' }
        }
      }
      if (!c.host || !c.port) return { ok: false, error: 'host/port required' }
      return { ok: true, latencyMs: 0 }
    },
    async installPlugin(sourcePath) {
      // 浏览器 mock：无法读真实文件系统，用文件名模拟一条 0→100 的进度流水
      const name = sourcePath.split(/[/\\]/).filter(Boolean).pop() ?? sourcePath
      const job: InstallJobInfo = {
        id: `mock-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        name,
        progress: 0,
        status: 'queued'
      }
      emit({ type: 'install-queue', active: [], waiting: [job] })
      window.setTimeout(() => {
        let p = 0
        const timer = window.setInterval(() => {
          p = Math.min(100, p + 25)
          emit({
            type: 'install-progress',
            jobId: job.id,
            name,
            progress: p,
            step: p < 100 ? '安装中' : '完成'
          })
          if (p >= 100) {
            window.clearInterval(timer)
            emit({ type: 'install-result', jobId: job.id, name, ok: true })
            emit({ type: 'install-queue', active: [], waiting: [] })
            emit({ type: 'plugins-changed' })
          }
        }, 180)
      }, 50)
      return { ...job, status: 'active' }
    },
    async getInstallQueue() {
      return { active: [], waiting: [] }
    },
    getPathForFile() {
      return ''
    },
    async checkForUpdates() {
      const state = {
        status: 'not-available' as const,
        currentVersion: '0.0.0-dev',
        packaged: false
      }
      emit({ type: 'update-status', state })
      return state
    },
    async downloadUpdate() {
      return {
        status: 'error' as const,
        currentVersion: '0.0.0-dev',
        error: 'not packaged',
        packaged: false
      }
    },
    async installUpdate() {
      return {
        status: 'error' as const,
        currentVersion: '0.0.0-dev',
        error: 'not packaged',
        packaged: false
      }
    },
    async getUpdateState() {
      return {
        status: 'idle' as const,
        currentVersion: '0.0.0-dev',
        packaged: false
      }
    },
    async systemNotify(title, body) {
      // 浏览器 mock：尝试 Web Notification，失败静默
      try {
        if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
          new Notification(title, { body: body ?? '' })
        }
      } catch {
        /* ignore */
      }
    },
    onInstallProgress(cb) {
      const wrapped = (payload: ShellEventPayload): void => {
        if (payload.type === 'install-progress') cb(payload)
      }
      listeners.add(wrapped)
      return () => listeners.delete(wrapped)
    },
    onEvent(cb) {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    minimizeWindow() {
      /* mock no-op */
    },
    maximizeWindow() {
      /* mock no-op */
    },
    closeWindow() {
      window.close()
    },
    async openPath(path) {
      try {
        await navigator.clipboard?.writeText(path)
      } catch {
        /* 浏览器 mock 下剪贴板可能不可用 */
      }
    },
    async quickSearch() {
      return { items: [] }
    },
    async quickOpen() {
      return { ok: false, error: 'mock' }
    },
    async quickScanApps() {
      return { apps: [], complete: false, errors: ['mock'] }
    },
    async quickGetConfig() {
      return { enabled: false, hotkeys: [], platform: 'darwin' as const }
    },
    async quickSetHotkeys() {
      return {
        ok: false,
        enabled: false,
        hotkeys: [],
        registered: [],
        failed: [],
        error: 'mock'
      }
    },
  }
}

const mockApi = createMockApi()
const rawShell = window.enestShell

/** 单例 API：有 preload 用真实实现（mock 兜底），否则纯 mock */
export const shellApi: ShellApi = rawShell
  ? {
      ...mockApi,
      ...rawShell,
      getPaths: () => {
        if (rawShell.getPaths) return rawShell.getPaths()
        return mockApi.getPaths()
      },
      pickFile: (options) => {
        if (rawShell.pickFile) return rawShell.pickFile(options)
        return mockApi.pickFile(options)
      },
      saveCustomFont: (payload) => {
        if (rawShell.saveCustomFont) return rawShell.saveCustomFont(payload)
        return Promise.resolve({ ok: false, error: 'not-available' })
      },
      readCustomFont: (fileName) => {
        if (rawShell.readCustomFont) return rawShell.readCustomFont(fileName)
        return Promise.resolve({ ok: false, error: 'not-available' })
      },
      deleteCustomFont: (fileName) => {
        if (rawShell.deleteCustomFont) return rawShell.deleteCustomFont(fileName)
        return Promise.resolve({ ok: false, error: 'not-available' })
      },
      getPluginReadme: (pluginId) => {
        if (rawShell.getPluginReadme) return rawShell.getPluginReadme(pluginId)
        return mockApi.getPluginReadme(pluginId)
      },
      getHardwareAcceleration: () => {
        if (rawShell.getHardwareAcceleration) return rawShell.getHardwareAcceleration()
        return mockApi.getHardwareAcceleration()
      },
      setHardwareAcceleration: (enabled) => {
        if (rawShell.setHardwareAcceleration) return rawShell.setHardwareAcceleration(enabled)
        return mockApi.setHardwareAcceleration(enabled)
      },
      getProxy: () => {
        if (rawShell.getProxy) return rawShell.getProxy()
        return mockApi.getProxy?.() ?? Promise.resolve({ type: 'none' as const })
      },
      setProxy: (config) => {
        if (rawShell.setProxy) return rawShell.setProxy(config)
        return (
          mockApi.setProxy?.(config) ??
          Promise.resolve({ needRestart: false, proxy: { type: 'none' as const } })
        )
      },
      testProxy: (config) => {
        if (rawShell.testProxy) return rawShell.testProxy(config)
        return mockApi.testProxy?.(config) ?? Promise.resolve({ ok: true, latencyMs: 0 })
      },
      getTheme: () => {
        if (rawShell.getTheme) return rawShell.getTheme()
        return mockApi.getTheme()
      },
      setTheme: (mode, overrides, extra) => {
        if (rawShell.setTheme) return rawShell.setTheme(mode, overrides, extra)
        return mockApi.setTheme(mode, overrides, extra)
      },
      minimizeWindow: () => {
        if (rawShell.minimizeWindow) rawShell.minimizeWindow()
        else mockApi.minimizeWindow?.()
      },
      maximizeWindow: () => {
        if (rawShell.maximizeWindow) rawShell.maximizeWindow()
        else mockApi.maximizeWindow?.()
      },
      closeWindow: () => {
        if (rawShell.closeWindow) rawShell.closeWindow()
        else window.close()
      },
    }
  : mockApi

/** 当前是否运行在无 preload 的 mock shell（纯浏览器预览） */
export const isMockShell = !rawShell

export type { ShellSettingsData }
export { DEFAULT_SETTINGS }
