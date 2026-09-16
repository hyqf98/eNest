/**
 * shellPreload — 壳子渲染层预加载脚本
 * 职责：通过 contextBridge 向壳子渲染层暴露 window.enestShell API，
 * 将渲染层调用桥接到主进程 shellHandlers（含路径、文件选择、README、硬件加速）。
 * 被 createShellWindow 指定为 shell WebContentsView 的 preload。
 * 关键依赖：@shared/types/ipc（通道名与类型）、contextBridge、ipcRenderer。
 */
import { contextBridge, ipcRenderer, webUtils } from 'electron'
import {
  IpcChannels,
  type InstallJobInfo,
  type OrbRailState,
  type ShellEventPayload,
  type UpdateStatePayload
} from '@shared/types/ipc'
import type {
  AppPaths,
  PluginSummary,
  ProxyConfig,
  ThemeMode,
  ThemePack,
  ThemeTokens
} from '@shared/types/plugin'
import type { ProxyTestResult } from '@shared/types/ipc'

type Unsubscribe = () => void

/** shell:get-theme 返回：ThemeTokens + 主题包列表 */
export type ShellThemeResult = ThemeTokens & { packs: ThemePack[] }

export interface ShellSettingsData {
  theme?: ThemeTokens
  general?: Record<string, unknown>
  plugins?: Record<string, Record<string, unknown>>
  [key: string]: unknown
}

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

/** 解包 ok/data/error 结构，失败时抛出 Error */
async function unwrapOk<T>(promise: Promise<{ ok: boolean; data?: T; error?: string }>): Promise<T> {
  const result = await promise
  if (!result?.ok) throw new Error(result?.error || 'ipc failed')
  return result.data as T
}

/** 校验 ok 标志，失败时抛出 Error（无 data 场景） */
async function expectOk(promise: Promise<{ ok: boolean; error?: string }>): Promise<void> {
  const result = await promise
  if (!result?.ok) throw new Error(result?.error || 'ipc failed')
}

export interface EnestShellApi {
  getPlugins(): Promise<PluginSummary[]>
  openPlugin(id: string, enter?: { code?: string; payload?: unknown }): Promise<void>
  closePlugin(tabId: string): Promise<void>
  activatePlugin(tabId: string): Promise<void>
  /** 隐藏全部插件原生视图（回首页/设置时） */
  hidePlugins(): Promise<void>
  /** 设置插件内容区左侧 inset（orb 圆轨通道） */
  setPluginInset(left: number): Promise<void>
  /** 回首页 */
  goHome(): Promise<void>
  /** 主壳切换视图 */
  setShellView(view: string): Promise<void>
  /** 同步圆轨状态到悬浮窗 */
  syncOrbState(state: {
    view: string
    tabStyle: string
    activeTabId: string | null
    tabs: unknown[]
  }): Promise<void>
  getOrbState(): Promise<{
    view: string
    tabStyle: string
    activeTabId: string | null
    tabs: unknown[]
  }>
  /** 卸载插件：关 Tab → 清 storage → 删文件 → 重扫；结果经 uninstall-result 事件 */
  uninstallPlugin(pluginId: string): Promise<void>
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
  /** 读取当前代理配置（settings.general.proxy） */
  getProxy(): Promise<ProxyConfig>
  /** 写入并即时 session.setProxy；needRestart 恒为 false */
  setProxy(config: ProxyConfig): Promise<ProxySetResult>
  /** TCP 探测代理连通性；省略 config 时测已保存配置 */
  testProxy(config?: ProxyConfig): Promise<ProxyTestResult>
  /** 复制/写入自定义字体到 ~/eNest/fonts/，返回落盘路径 */
  saveCustomFont(payload: {
    sourcePath?: string
    dataBase64?: string
    fileName: string
  }): Promise<{ ok: boolean; path?: string; fileName?: string; error?: string }>
  /** 读取自定义字体文件为 base64 */
  readCustomFont(fileName: string): Promise<{ ok: boolean; dataBase64?: string; error?: string }>
  /** 删除自定义字体文件 */
  deleteCustomFont(fileName: string): Promise<{ ok: boolean; error?: string }>
  /** 将本地文件夹 / .enestplugin 路径入队安装；进度经 onEvent / onInstallProgress 推送 */
  installPlugin(sourcePath: string): Promise<InstallJobInfo>
  getInstallQueue(): Promise<{ active: InstallJobInfo[]; waiting: InstallJobInfo[] }>
  /** Electron 13+：File → 绝对路径（file.path 在部分环境不可用） */
  getPathForFile(file: File): string
  /** 检查 GitHub Release 更新；返回最新状态快照 */
  checkForUpdates(): Promise<UpdateStatePayload>
  /** 下载已发现的更新包；进度经 update-status 事件推送 */
  downloadUpdate(): Promise<UpdateStatePayload>
  /** 安装已下载的更新并重启应用 */
  installUpdate(): Promise<UpdateStatePayload>
  getUpdateState(): Promise<UpdateStatePayload>
  /** 系统级通知（Electron Notification） */
  systemNotify(title: string, body?: string): Promise<void>
  /** 仅订阅 install-progress 事件 */
  onInstallProgress(
    cb: (payload: { jobId: string; name: string; progress: number; step?: string }) => void
  ): Unsubscribe
  onEvent(cb: (payload: ShellEventPayload) => void): Unsubscribe

  /** orb 悬浮窗：订阅主进程推送的 Tab 状态 */
  onOrbEvent(cb: (payload: { type: 'orb-state'; state: OrbRailState }) => void): Unsubscribe

  minimizeWindow(): void
  maximizeWindow(): void
  closeWindow(): void
}

const api: EnestShellApi = {
  getPlugins: () => ipcRenderer.invoke(IpcChannels.ShellGetPlugins),

  openPlugin: (id: string, enter?: { code?: string; payload?: unknown }) =>
    expectOk(ipcRenderer.invoke(IpcChannels.ShellOpenPlugin, id, enter)),

  closePlugin: (tabId: string) =>
    expectOk(ipcRenderer.invoke(IpcChannels.ShellClosePlugin, tabId)),

  activatePlugin: (tabId: string) =>
    expectOk(ipcRenderer.invoke(IpcChannels.ShellActivatePlugin, tabId)),

  hidePlugins: () => expectOk(ipcRenderer.invoke(IpcChannels.ShellHidePlugins)),

  setPluginInset: (left: number) =>
    expectOk(ipcRenderer.invoke(IpcChannels.ShellSetPluginInset, left)),

  goHome: () => expectOk(ipcRenderer.invoke(IpcChannels.ShellGoHome)),

  setShellView: (view: string) =>
    expectOk(ipcRenderer.invoke(IpcChannels.ShellSetView, view)),

  syncOrbState: (state) =>
    expectOk(ipcRenderer.invoke(IpcChannels.ShellSyncOrbState, state)),

  getOrbState: () =>
    ipcRenderer.invoke(IpcChannels.ShellGetOrbState) as Promise<{
      view: string
      tabStyle: string
      activeTabId: string | null
      tabs: unknown[]
    }>,

  uninstallPlugin: (pluginId: string) =>
    expectOk(ipcRenderer.invoke(IpcChannels.ShellUninstallPlugin, pluginId)),

  getTheme: () => ipcRenderer.invoke(IpcChannels.ShellGetTheme) as Promise<ShellThemeResult>,

  setTheme: async (mode, overrides, extra) => {
    const current = (await ipcRenderer.invoke(IpcChannels.ShellGetTheme)) as ShellThemeResult
    await ipcRenderer.invoke(IpcChannels.ShellSetTheme, {
      mode,
      overrides: {
        ...(current?.overrides ?? {}),
        [mode]: overrides ?? {}
      },
      ...(extra?.packId !== undefined ? { packId: extra.packId } : {}),
      ...(extra?.background !== undefined ? { background: extra.background } : {})
    })
  },

  loadDevPlugin: (dirPath: string) =>
    unwrapOk<PluginSummary>(ipcRenderer.invoke(IpcChannels.ShellLoadDevPlugin, dirPath)),

  reloadPlugin: (pluginId: string) =>
    expectOk(ipcRenderer.invoke(IpcChannels.ShellReloadPlugin, pluginId)),

  openDevTools: (pluginId: string) =>
    expectOk(ipcRenderer.invoke(IpcChannels.ShellOpenDevTools, pluginId)),

  getSettings: () => ipcRenderer.invoke(IpcChannels.ShellGetSettings),

  setSettings: (settings: Partial<ShellSettingsData>) =>
    ipcRenderer.invoke(IpcChannels.ShellSetSettings, settings),

  getPaths: () => ipcRenderer.invoke(IpcChannels.ShellGetPaths) as Promise<AppPaths>,

  pickFile: (options?: PickFileOptions) =>
    ipcRenderer.invoke(IpcChannels.ShellPickFile, options) as Promise<string | null>,

  getPluginReadme: (pluginId: string) =>
    ipcRenderer.invoke(IpcChannels.ShellGetPluginReadme, pluginId) as Promise<string>,

  getHardwareAcceleration: () =>
    ipcRenderer.invoke(IpcChannels.ShellGetHardwareAccel) as Promise<HardwareAccelState>,

  setHardwareAcceleration: (enabled: boolean) =>
    ipcRenderer.invoke(IpcChannels.ShellSetHardwareAccel, enabled) as Promise<HardwareAccelSetResult>,

  getProxy: () => ipcRenderer.invoke(IpcChannels.ShellGetProxy) as Promise<ProxyConfig>,

  setProxy: (config: ProxyConfig) =>
    ipcRenderer.invoke(IpcChannels.ShellSetProxy, config) as Promise<ProxySetResult>,

  testProxy: (config?: ProxyConfig) =>
    ipcRenderer.invoke(IpcChannels.ShellTestProxy, config) as Promise<ProxyTestResult>,

  saveCustomFont: (payload) =>
    ipcRenderer.invoke(IpcChannels.ShellSaveCustomFont, payload) as Promise<{
      ok: boolean
      path?: string
      fileName?: string
      error?: string
    }>,

  readCustomFont: (fileName: string) =>
    ipcRenderer.invoke(IpcChannels.ShellReadCustomFont, fileName) as Promise<{
      ok: boolean
      dataBase64?: string
      error?: string
    }>,

  deleteCustomFont: (fileName: string) =>
    ipcRenderer.invoke(IpcChannels.ShellDeleteCustomFont, fileName) as Promise<{
      ok: boolean
      error?: string
    }>,

  installPlugin: (sourcePath: string) =>
    unwrapOk<InstallJobInfo>(ipcRenderer.invoke(IpcChannels.ShellInstallPlugin, sourcePath)),

  getInstallQueue: () =>
    ipcRenderer.invoke(IpcChannels.ShellGetInstallQueue) as Promise<{
      active: InstallJobInfo[]
      waiting: InstallJobInfo[]
    }>,

  getPathForFile: (file: File) => {
    try {
      return webUtils.getPathForFile(file)
    } catch {
      return ''
    }
  },

  checkForUpdates: () =>
    ipcRenderer.invoke(IpcChannels.ShellCheckUpdate) as Promise<UpdateStatePayload>,
  downloadUpdate: () =>
    ipcRenderer.invoke(IpcChannels.ShellDownloadUpdate) as Promise<UpdateStatePayload>,
  installUpdate: () =>
    ipcRenderer.invoke(IpcChannels.ShellInstallUpdate) as Promise<UpdateStatePayload>,
  getUpdateState: () =>
    ipcRenderer.invoke(IpcChannels.ShellGetUpdateState) as Promise<UpdateStatePayload>,

  systemNotify: async (title: string, body?: string) => {
    await expectOk(ipcRenderer.invoke(IpcChannels.ShellSystemNotify, title, body))
  },

  onInstallProgress(cb): Unsubscribe {
    const handler = (_e: Electron.IpcRendererEvent, payload: ShellEventPayload) => {
      if (payload.type === 'install-progress') cb(payload)
    }
    ipcRenderer.on(IpcChannels.ShellEvent, handler)
    return () => ipcRenderer.removeListener(IpcChannels.ShellEvent, handler)
  },

  onEvent(cb: (payload: ShellEventPayload) => void): Unsubscribe {
    const handler = (_e: Electron.IpcRendererEvent, payload: ShellEventPayload) => cb(payload)
    ipcRenderer.on(IpcChannels.ShellEvent, handler)
    return () => ipcRenderer.removeListener(IpcChannels.ShellEvent, handler)
  },

  onOrbEvent(cb): Unsubscribe {
    const handler = (
      _e: Electron.IpcRendererEvent,
      payload: { type: 'orb-state'; state: OrbRailState }
    ) => cb(payload)
    ipcRenderer.on(IpcChannels.ShellOrbEvent, handler)
    return () => ipcRenderer.removeListener(IpcChannels.ShellOrbEvent, handler)
  },

  minimizeWindow: () => ipcRenderer.send(IpcChannels.WindowMinimize),
  maximizeWindow: () => ipcRenderer.send(IpcChannels.WindowMaximize),
  closeWindow: () => ipcRenderer.send(IpcChannels.WindowClose)
}

contextBridge.exposeInMainWorld('enestShell', api)
