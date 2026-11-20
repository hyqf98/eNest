import { quickControllerBridge } from './quickControllerBridge'
import { railBridge } from './railBridge'
import { expectOk, unwrapOk } from './shellIpcResult'
import type { NativeShellApi } from '@shared/types/shellApi'
import type { ShellSettingsData } from '@shared/types/shellSettings'
import { ipcRenderer, webUtils } from 'electron'
import * as IpcChannels from '@shared/types/ipc'
import type {
  InstallJobInfo, PluginCallTraceEntry, PluginDirtyState, PluginSaveSummary,
  GithubLoginSessionPayload, GithubProfileState, ShellEventPayload, UpdateStatePayload, ProxyTestResult
} from '@shared/types/ipc'
import type {
  AppPaths, DevPluginLoadOptions, MarketInstallResult, PluginPermission, PluginPermissionGrant, PluginSummary, ProxyConfig
} from '@shared/types/plugin'
import type {
  HardwareAccelSetResult,
  HardwareAccelState,
  LoginItemSetResult,
  LoginItemState,
  PickFileOptions,
  PluginLaunchSetResult,
  ProxySetResult,
  ShellSettingsSection,
  ShellThemeResult
} from '@shared/types/shell'
import type { AppearanceSnapshot } from '@shared/types/appearance'
import type { PluginMemorySnapshot } from '@shared/types/pluginMemory'
import type { ApplicationScanResult, QuickHotkeyApplyResult, QuickHotkeyConfig, QuickHotkeyPatch } from '@shared/types/quick'
import type { Unsubscribe } from '@shared/types/pluginApi'

export const shellBridge: NativeShellApi = {
  ...quickControllerBridge,
  ...railBridge,
  getMcpStatus: () => ipcRenderer.invoke(IpcChannels.ShellMcpStatus),
  configureMcp: input => ipcRenderer.invoke(IpcChannels.ShellMcpConfigure, input),
  copyMcpConnectionConfig: () => ipcRenderer.invoke(IpcChannels.ShellMcpCopyConnection),
  listMcpTools: query => ipcRenderer.invoke(IpcChannels.ShellMcpCatalog, query),
  openExternal: url => ipcRenderer.invoke(IpcChannels.ShellOpenExternal, url),
  getThemeSettingsConfig: () => ipcRenderer.invoke(IpcChannels.ThemeSettingsConfig),
  getThemeSettingsSnapshot: key => ipcRenderer.invoke(IpcChannels.ThemeSettingsSnapshot, key),
  setThemeSettingsActive: input => ipcRenderer.invoke(IpcChannels.ThemeSettingsActive, input),
  dispatchThemeSettingsAction: (key, action) => ipcRenderer.invoke(IpcChannels.ThemeSettingsAction, key, action),
  getPlugins: () => ipcRenderer.invoke(IpcChannels.ShellGetPlugins),
  getMarketStatus: (refresh = false) => ipcRenderer.invoke(IpcChannels.ShellGetMarketStatus, refresh),
  getPluginDiagnostics: () => ipcRenderer.invoke(IpcChannels.ShellGetPluginDiagnostics),
  getPluginMemorySnapshot: (force = false) => ipcRenderer.invoke(IpcChannels.ShellGetPluginMemorySnapshot, force) as Promise<PluginMemorySnapshot>,
  startPerformanceCapture: () => ipcRenderer.invoke(IpcChannels.ShellStartPerformanceCapture),
  getPerformanceCaptureState: () => ipcRenderer.invoke(IpcChannels.ShellGetPerformanceCaptureState),
  stopPerformanceCapture: () => ipcRenderer.invoke(IpcChannels.ShellStopPerformanceCapture),
  exportPerformanceCapture: () => ipcRenderer.invoke(IpcChannels.ShellExportPerformanceCapture),
  restoreTabs: (ids) => ipcRenderer.invoke(IpcChannels.ShellRestoreTabs, ids).then(() => undefined),

  openPlugin: (id: string, enter?: { code?: string; payload?: unknown }) =>
    expectOk(ipcRenderer.invoke(IpcChannels.ShellOpenPlugin, id, enter)),

  stopPluginResources: pluginId => expectOk(ipcRenderer.invoke(IpcChannels.ShellStopPluginResources, pluginId)),

  hidePlugins: () => expectOk(ipcRenderer.invoke(IpcChannels.ShellHidePlugins)),

  setPluginInset: (left: number) =>
    expectOk(ipcRenderer.invoke(IpcChannels.ShellSetPluginInset, left)),

  setPluginTopInset: (top: number) =>
    expectOk(ipcRenderer.invoke(IpcChannels.ShellSetPluginTopInset, top)),
  syncOrbState: (state) =>
    expectOk(ipcRenderer.invoke(IpcChannels.ShellSyncOrbState, state)),

  uninstallPlugin: (pluginId: string) =>
    expectOk(ipcRenderer.invoke(IpcChannels.ShellUninstallPlugin, pluginId)),

  setPluginEnabled: (pluginId: string, enabled: boolean) =>
    unwrapOk<PluginSummary>(
      ipcRenderer.invoke(IpcChannels.ShellSetPluginEnabled, pluginId, enabled)
    ),

  getPluginShortcuts: () => ipcRenderer.invoke(IpcChannels.ShellGetPluginShortcuts),
  savePluginShortcut: input => ipcRenderer.invoke(IpcChannels.ShellSavePluginShortcut, input),
  removePluginShortcut: id => ipcRenderer.invoke(IpcChannels.ShellRemovePluginShortcut, id),
  probePluginShortcut: (accelerator, excludeId) => ipcRenderer.invoke(IpcChannels.ShellProbePluginShortcut, accelerator, excludeId),
  launchPluginShortcut: id => ipcRenderer.invoke(IpcChannels.ShellLaunchPluginShortcut, id),
  beginShortcutCapture: () => ipcRenderer.invoke(IpcChannels.ShellBeginShortcutCapture),
  endShortcutCapture: token => ipcRenderer.invoke(IpcChannels.ShellEndShortcutCapture, token),
  setPluginLaunch: (pluginId, patch) =>
    ipcRenderer.invoke(IpcChannels.ShellSetPluginLaunch, pluginId, patch) as Promise<PluginLaunchSetResult>,

  installMarketPlugin: (pluginId: string, opts?: { force?: boolean }) =>
    unwrapOk<MarketInstallResult>(
      ipcRenderer.invoke(IpcChannels.ShellInstallMarketPlugin, pluginId, opts)
    ),

  getTheme: () => ipcRenderer.invoke(IpcChannels.ShellGetTheme) as Promise<ShellThemeResult>,
  updateThemeProfile: patch =>
    ipcRenderer.invoke(IpcChannels.ShellUpdateThemeProfile, patch) as Promise<AppearanceSnapshot>,
  activateTheme: identity =>
    ipcRenderer.invoke(IpcChannels.ShellActivateTheme, identity) as Promise<AppearanceSnapshot>,
  setAppearanceMode: mode =>
    ipcRenderer.invoke(IpcChannels.ShellSetAppearanceMode, mode) as Promise<AppearanceSnapshot>,
  setHomeVisible: visible => ipcRenderer.invoke(IpcChannels.ShellSetHomeVisible, visible) as Promise<void>,
  navigateWorkspace: route => ipcRenderer.invoke(IpcChannels.ShellNavigateWorkspace, route) as Promise<void>,
  retryHome: () => ipcRenderer.invoke(IpcChannels.ShellRetryHome) as Promise<void>,
  getHomeState: () => ipcRenderer.invoke(IpcChannels.ShellGetHomeState),
  pickAppearanceMedia: options => ipcRenderer.invoke(IpcChannels.ShellPickAppearanceMedia, options),
  importAppearanceFont: () => ipcRenderer.invoke(IpcChannels.ShellImportAppearanceFont),
  removeAppearanceFont: id => ipcRenderer.invoke(IpcChannels.ShellRemoveAppearanceFont, id),
  openNativeModal: request => ipcRenderer.invoke(IpcChannels.ModalOpen, request),
  setAppearancePerformanceLimited: limited => ipcRenderer.invoke(IpcChannels.ShellSetAppearancePerformanceLimited, limited),

  setTheme: async (mode, overrides, extra) => {
    const current = (await ipcRenderer.invoke(IpcChannels.ShellGetTheme)) as ShellThemeResult
    // renderer 已按 resolved(light|dark) 传入 overrides。
    // system 模式写入 system 键，由主进程 SettingsStore + nativeTheme 落到 light/dark
    //（preload 环境 matchMedia 不可靠，不能在渲染桥内解析）。
    const overrideKey = mode === 'system' ? ('system' as const) : mode
    await ipcRenderer.invoke(IpcChannels.ShellSetTheme, {
      mode,
      overrides: {
        ...(current?.overrides ?? {}),
        [overrideKey]: overrides ?? {}
      },
      // 始终带上 packId/background 键：显式 undefined 可清除（取消主题包/背景）
      ...(extra && 'packId' in extra ? { packId: extra.packId } : {}),
      ...(extra && 'background' in extra ? { background: extra.background } : {}),
      ...(extra && 'backgroundSource' in extra ? { backgroundSource: extra.backgroundSource } : {}),
      ...(extra && 'backgroundEffect' in extra ? { backgroundEffect: extra.backgroundEffect } : {})
    })
  },

  loadDevPlugin: (dirPath: string, options?: DevPluginLoadOptions) =>
    unwrapOk<PluginSummary>(ipcRenderer.invoke(IpcChannels.ShellLoadDevPlugin, dirPath, options)),

  forgetDevPlugin: (pluginId: string) =>
    expectOk(ipcRenderer.invoke(IpcChannels.ShellForgetDevPlugin, pluginId)),

  reloadPlugin: (pluginId: string) =>
    expectOk(ipcRenderer.invoke(IpcChannels.ShellReloadPlugin, pluginId)),

  setDevKillOnHide: (pluginId: string, enabled?: boolean) =>
    unwrapOk<boolean>(ipcRenderer.invoke(IpcChannels.ShellSetDevKillOnHide, pluginId, enabled)),

  openDevTools: (pluginId: string) =>
    expectOk(ipcRenderer.invoke(IpcChannels.ShellOpenDevTools, pluginId)),

  getPluginCallTrace: () =>
    ipcRenderer.invoke(IpcChannels.ShellGetPluginTrace) as Promise<PluginCallTraceEntry[]>,

  getSettings: () => ipcRenderer.invoke(IpcChannels.ShellGetSettings),

  setSettings: (settings: Partial<ShellSettingsData>) =>
    ipcRenderer.invoke(IpcChannels.ShellSetSettings, settings),

  getSettingsSections: () =>
    ipcRenderer.invoke(IpcChannels.ShellGetSettingsSections) as Promise<ShellSettingsSection[]>,

  setPluginSetting: async (pluginId: string, key: string, value: unknown) => {
    await expectOk(ipcRenderer.invoke(IpcChannels.ShellSetPluginSetting, pluginId, key, value))
  },

  getPaths: () => ipcRenderer.invoke(IpcChannels.ShellGetPaths) as Promise<AppPaths>,
  openPath: (path) => expectOk(ipcRenderer.invoke(IpcChannels.ShellOpenPath, path)),

  pickFile: (options?: PickFileOptions) =>
    ipcRenderer.invoke(IpcChannels.ShellPickFile, options) as Promise<string | null>,

  getPluginReadme: (pluginId: string) =>
    ipcRenderer.invoke(IpcChannels.ShellGetPluginReadme, pluginId) as Promise<string>,

  getHardwareAcceleration: () =>
    ipcRenderer.invoke(IpcChannels.ShellGetHardwareAccel) as Promise<HardwareAccelState>,

  setHardwareAcceleration: (enabled: boolean) =>
    ipcRenderer.invoke(IpcChannels.ShellSetHardwareAccel, enabled) as Promise<HardwareAccelSetResult>,

  getLoginItem: () =>
    ipcRenderer.invoke(IpcChannels.ShellGetLoginItem) as Promise<LoginItemState>,

  setLoginItem: (enabled: boolean) =>
    ipcRenderer.invoke(IpcChannels.ShellSetLoginItem, enabled) as Promise<LoginItemSetResult>,

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
  getPluginsDirty: () =>
    ipcRenderer.invoke(IpcChannels.ShellGetPluginsDirty) as Promise<PluginDirtyState>,
  saveAllPlugins: () =>
    ipcRenderer.invoke(IpcChannels.ShellSaveAllPlugins) as Promise<PluginSaveSummary>,

  getOpenWithList: (key?: string) =>
    ipcRenderer.invoke(IpcChannels.ShellOpenWithList, key) as Promise<
      import('@shared/types/openWith').OpenWithListResult
    >,
  setOpenWithDefault: (key: string, pluginId: string) =>
    ipcRenderer.invoke(IpcChannels.ShellOpenWithSetDefault, { key, pluginId }) as Promise<
      import('@shared/types/openWith').OpenWithActionResult
    >,
  clearOpenWithDefault: (key: string) =>
    ipcRenderer.invoke(IpcChannels.ShellOpenWithClearDefault, key) as Promise<
      import('@shared/types/openWith').OpenWithActionResult
    >,
  routeOpenWith: (key: string, pluginId: string) =>
    ipcRenderer.invoke(IpcChannels.ShellOpenWithRoute, { key, pluginId }) as Promise<
      import('@shared/types/openWith').OpenWithActionResult
    >,
  openOpenWithSystemSettings: () =>
    ipcRenderer.invoke(IpcChannels.ShellOpenWithOpenSystemSettings) as Promise<void>,
  getAccountState: () => ipcRenderer.invoke(IpcChannels.ShellAccountState),
  loginAccount: (providerId) => ipcRenderer.invoke(IpcChannels.ShellAccountLogin, providerId),
  cancelAccountLogin: (providerId) => ipcRenderer.invoke(IpcChannels.ShellAccountCancel, providerId),
  logoutAccount: (providerId) => ipcRenderer.invoke(IpcChannels.ShellAccountLogout, providerId),
  githubLogin: () =>
    ipcRenderer.invoke(IpcChannels.ShellGithubLogin) as Promise<{
      ok: true
      data: GithubLoginSessionPayload
    } | { ok: false; error: string }>,
  githubCancelLogin: () =>
    ipcRenderer.invoke(IpcChannels.ShellGithubCancelLogin) as Promise<{ ok: boolean }>,
  getGithubProfile: () =>
    ipcRenderer.invoke(IpcChannels.ShellGetProfile) as Promise<GithubProfileState>,
  githubLogout: () =>
    ipcRenderer.invoke(IpcChannels.ShellGithubLogout) as Promise<{ ok: boolean }>,

  systemNotify: async (title: string, body?: string) => {
    await expectOk(ipcRenderer.invoke(IpcChannels.ShellSystemNotify, title, body))
  },

  respondPermissionRequest: async (
    requestId: string,
    decision: 'once' | 'always' | 'deny'
  ) => {
    await expectOk(
      ipcRenderer.invoke(IpcChannels.PermissionResponse, { requestId, decision })
    )
  },

  getPluginPermissionGrants: (pluginId: string) =>
    unwrapOk<Partial<Record<PluginPermission, PluginPermissionGrant>>>(
      ipcRenderer.invoke(IpcChannels.PermissionGrantsGet, pluginId)
    ),

  setPluginPermissionGrant: async (
    pluginId: string,
    permission: PluginPermission,
    grant: PluginPermissionGrant
  ) => {
    await expectOk(
      ipcRenderer.invoke(IpcChannels.PermissionGrantsSet, {
        pluginId,
        permission,
        grant
      })
    )
  },

  openScreenCaptureSettings: async () => {
    await expectOk(ipcRenderer.invoke(IpcChannels.OsOpenScreenSettings))
  },

  onInstallProgress(cb): Unsubscribe {
    const handler = (_e: Electron.IpcRendererEvent, payload: ShellEventPayload) => {
      if (payload.type === 'install-progress') cb(payload)
    }
    ipcRenderer.on(IpcChannels.ShellEvent, handler)
    return () => ipcRenderer.removeListener(IpcChannels.ShellEvent, handler)
  },



  minimizeWindow: () => ipcRenderer.send(IpcChannels.WindowMinimize),
  maximizeWindow: () => ipcRenderer.send(IpcChannels.WindowMaximize),
  closeWindow: () => ipcRenderer.send(IpcChannels.WindowClose),

  quickToggle: () => ipcRenderer.invoke(IpcChannels.QuickToggle).then(() => undefined),
  quickScanApps: (force?: boolean) =>
    ipcRenderer.invoke(IpcChannels.QuickScanApps, { force }) as Promise<ApplicationScanResult>,
  quickGetConfig: () =>
    ipcRenderer.invoke(IpcChannels.QuickGetConfig) as Promise<QuickHotkeyConfig>,
  quickSetHotkeys: (payload: QuickHotkeyPatch) => ipcRenderer.invoke(IpcChannels.QuickSetHotkeys, payload) as Promise<QuickHotkeyApplyResult>,
  quickProbeHotkey: (acc: string) =>
    ipcRenderer.invoke(IpcChannels.QuickProbeHotkey, { acc }) as Promise<
      import('@shared/types/quick').QuickHotkeyProbeResult
    >,

  /** 自由面板：框选区域并创建面板（返回面板 id 与最终 bounds）。 */
  createPanel: () => ipcRenderer.invoke(IpcChannels.PanelCreate) as Promise<{ ok: boolean; cancelled?: boolean; id?: string; bounds?: import('@shared/types/panel').PanelBounds; error?: string }>,
  /** 自由面板：列出当前活动面板。 */
  listPanels: () => ipcRenderer.invoke(IpcChannels.PanelList) as Promise<Array<{ id: string; bounds: import('@shared/types/panel').PanelBounds; widgetCount: number }>>,
  /** 自由面板：关闭指定面板（释放其内插件）。 */
  closePanel: (panelId: string) => ipcRenderer.invoke(IpcChannels.PanelClose, panelId) as Promise<{ ok: boolean }>,
  /** 自由面板：保存呼出快捷键并立即重注册（返回注册结果）。 */
  setPanelHotkey: (accelerator: string) => ipcRenderer.invoke(IpcChannels.PanelSetHotkey, accelerator) as Promise<import('@shared/types/panel').PanelHotkeyApplyResult>,
}

