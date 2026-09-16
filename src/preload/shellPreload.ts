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
  type ShellEventPayload,
  type UpdateStatePayload
} from '@shared/types/ipc'
import type {
  AppPaths,
  PluginSummary,
  ThemeMode,
  ThemePack,
  ThemeTokens
} from '@shared/types/plugin'

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
  filters?: 'image' | 'video' | 'media'
}

export interface HardwareAccelState {
  enabled: boolean
}

export interface HardwareAccelSetResult {
  needRestart: boolean
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
  /** 仅订阅 install-progress 事件 */
  onInstallProgress(
    cb: (payload: { jobId: string; name: string; progress: number; step?: string }) => void
  ): Unsubscribe
  onEvent(cb: (payload: ShellEventPayload) => void): Unsubscribe
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

  minimizeWindow: () => ipcRenderer.send(IpcChannels.WindowMinimize),
  maximizeWindow: () => ipcRenderer.send(IpcChannels.WindowMaximize),
  closeWindow: () => ipcRenderer.send(IpcChannels.WindowClose)
}

contextBridge.exposeInMainWorld('enestShell', api)
