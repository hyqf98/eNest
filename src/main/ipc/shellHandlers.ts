import { getAccountState, loginAccount, cancelAccountLogin, logoutAccount } from '@main/auth/accountAuthService'
import { getTrustedSurfaceRole, handleShellIpc, onShellIpc } from '@main/ipc/ipcSecurity'
import { registerShortcutHandlers } from '@main/ipc/shortcutHandlers'
/**
 * shellHandlers — 壳子 IPC 处理器
 * 职责：注册壳子渲染层所有 invoke/on 通道（插件列表、打开/关闭/激活、主题、设置、
 * 路径、文件选择、README、KV 库、硬件加速、窗口控制等）。
 * 被 index.ts 在 app.whenReady 后调用 registerShellHandlers 注册。
 * 关键依赖：PluginHost、PluginRegistry、SettingsStore、pathsService、sqliteService、
 * themePacks、createShellWindow、DevConsole。
 */
import { getPluginDiagnostics } from '@main/plugin/pluginDiagnostics'
import { getPluginMemorySnapshot, refreshPluginMemoryAfterClose } from '@main/plugin/pluginMemoryMonitor'
import { startPerformanceCapture, getPerformanceCaptureState, stopPerformanceCapture, exportPerformanceCapture } from '@main/plugin/pluginPerformanceCapture'
import { showNotification } from '@main/window/notificationOverlay'
import { copyFile, mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { dialog, Notification, shell, type IpcMainInvokeEvent } from 'electron'
import { IpcChannels, type OrbRailSyncRequest } from '@shared/types/ipc'
import type { ResolvedAppearance, ThemeProfilePatch } from '@shared/types/appearance'
import { APP_NAME, FONTS_DIR, toPluginId, toTabId } from '@shared/constants'
import type { DevPluginLoadOptions, PluginLaunchPatch, ThemeTokens } from '@shared/types/plugin'
import { forgetDevPlugin, pickAndLoadDevPlugin } from '@main/dev/DevConsole'
import { setDevPluginKillOnHide } from '@main/dev/devPluginsStore'
import { logInfo, logWarn } from '@main/logs/logService'
import { getAppPaths, getAppPathsRoot } from '@main/paths/pathsService'
import { openLocalPath } from '@main/paths/openLocalPath'
import { pluginHost } from '@main/plugin/PluginHost'
import { trackNativeInteraction } from '@main/plugin/pluginInteractionPolicy'
import { broadcastNotice } from '@main/plugin/shellNotices'
import { associationService } from '@main/openWith/associationService'
import { resumeDeferredOpen } from '@main/openWith/openWithRouter'
import type { OpenWithKey, OpenWithSetRequest } from '@shared/types/openWith'
import { OPEN_WITH_EXT_RE, OPEN_WITH_SCHEME_RE } from '@shared/types/openWith'
import {
  startGithubLogin,
  cancelGithubLogin,
  logoutGithub,
  getProfileUser,
  hasGithubToken,
  isLoginPolling
} from '@main/auth/githubAuthService'
import { resolvePluginFile } from '@main/plugin/pluginPaths'
import { fetchMarketReadme } from '@main/plugin/marketClient'
import { pluginRegistry } from '@main/plugin/PluginRegistry'
import {
  enqueueInstall,
  enqueueInstallFromUrl,
  getInstallQueueState
} from '@main/plugin/installQueue'
import { uninstallPlugin } from '@main/plugin/PluginUninstaller'
import { cancelPluginDeadlineTasks } from '@main/timer/deadlineTaskService'
import { refreshPluginBackgrounds, stopPluginBackground } from '@main/plugin/pluginBackgroundRuntime'
import { applyAppearanceToPanels, syncFreePanelSetting } from '@main/panel/PanelManager'
import { applyPanelHotkeys } from '@main/hotkey/panelHotkey'
import { stopPluginBackend } from '@main/plugin/pluginBackendRpc'
import { broadcastPluginLocale, getPluginCallTrace } from '@main/ipc/pluginHandlers'
import {
  setPluginLaunch,
  releasePluginLaunchHotkey,
  clearPluginLaunch,
  applyPluginLaunchHotkeys
} from '@main/hotkey/pluginLaunchHotkeys'
import { settingsStore } from '@main/settings/SettingsStore'
import { pluginSettingsBridge } from '@main/settings/PluginSettingsBridge'
import {
  applyProxy,
  getActiveProxy,
  normalizeProxy,
  testProxyConnectivity
} from '@main/proxy/proxyService'
import { themePackRegistry } from '@main/theme/themePacks'
import { appearanceService } from '@main/theme/appearanceService'
import { importAppearanceFont, pickAppearanceMedia, removeAppearanceFont, resolveAppearanceResource } from '@main/theme/appearanceResources'
import { homeSurfaceManager, prewarmHomeSurface, retryHomeSurface, setHomeSurfaceVisible } from '@main/home/HomeSurfaceManager'
import { normalizeWorkspaceRoute } from '@main/home/workspaceRoute'
import type { WorkspaceRoute } from '@shared/types/workspace'
import {
  checkForUpdates,
  downloadUpdate,
  getUpdateState,
  quitAndInstallUpdate
} from '@main/update/updateService'
import {
  getMainWindow,
  getShellWebContents,
  sendShellEvent,
  setPluginLeftInset,
  setPluginTopInset
} from '@main/window/createShellWindow'
import {
  applyOrbRailVisibility,
  getOrbRailState,
  layoutOrbRailViews,
  setOrbAnimationLevel,
  setOrbRailExpandedView,
  setOrbRailState,
  setOrbTheme
} from '@main/window/orbRailViews'

/** shell:pick-file 支持的媒体过滤器 */
const PICK_FILTERS: Record<'image' | 'video' | 'media' | 'font', { name: string; extensions: string[] }> = {
  image: { name: '图片', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] },
  video: { name: '视频', extensions: ['mp4', 'webm'] },
  media: { name: '媒体', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'mp4', 'webm'] },
  font: { name: '字体', extensions: ['ttf', 'otf', 'woff', 'woff2'] }
}

/** 自定义字体允许的扩展名 */
const FONT_EXTS = new Set(['.ttf', '.otf', '.woff', '.woff2'])

/** 自定义字体落盘目录：{dataRoot}/fonts */
function fontsDir(): string {
  return join(getAppPathsRoot(), FONTS_DIR)
}

/** 清洗字体文件名，防止路径穿越；非法时回落 custom-font */
function sanitizeFontFileName(raw: string): string {
  const base = basename(String(raw ?? '')).replace(/[^\w.\-]+/g, '_')
  const ext = extname(base).toLowerCase()
  if (!FONT_EXTS.has(ext) || base.startsWith('.')) return ''
  return base
}

type PickFilterKey = keyof typeof PICK_FILTERS

/** Details are version-matched package resources, including source-preview's fixed mapping. */
async function readPluginReadme(pluginId: string): Promise<string> {
  const root = pluginRegistry.getAssetRootPath(pluginId)
  const path = pluginRegistry.getAssetManifest(pluginId)?.market?.readme
  if (!root || !path) {
    const summary = pluginRegistry.get(pluginId)
    const resource = pluginRegistry.getCatalogResources(pluginId).readme
    return !summary?.installed && resource?.source === 'remote' ? fetchMarketReadme(resource) : ''
  }
  const file = await resolvePluginFile(root, path, pluginRegistry.get(pluginId)?.devSource === true)
  if (!file) return ''
  const info = await import('node:fs/promises').then(fs => fs.stat(file))
  if (info.size > 512 * 1024) throw new Error('插件说明超过 512 KiB')
  return readFile(file, 'utf-8')
}

let workspaceNavigationIntent = 0

export async function navigateWorkspace(input: WorkspaceRoute): Promise<void> {
  const route = normalizeWorkspaceRoute(input)
  const intent = ++workspaceNavigationIntent
  const recoveryEpoch = homeSurfaceManager.recoveryEpoch
  pluginHost.hideAllViews()
  // Startup handoff includes a paired fallback, not just the first provider's ACK.
  await prewarmHomeSurface()
  if (homeSurfaceManager.recoveryEpoch !== recoveryEpoch) throw new Error('Workspace navigation was cancelled by recovery')
  if (intent !== workspaceNavigationIntent) throw new Error('Workspace navigation was replaced')
  sendShellEvent({ type: 'set-view', view: 'home' })
  await homeSurfaceManager.navigate(route)
}

/** One host-owned transition, shared by shell controls and constrained theme actions. */
export function openShellSettings(): void {
  workspaceNavigationIntent++
  setHomeSurfaceVisible(false)
  pluginHost.hideAllViews()
  sendShellEvent({ type: 'set-view', view: 'settings' })
}

function captureForShell<T>(event: IpcMainInvokeEvent, action: () => T): T {
  if (getTrustedSurfaceRole(event.sender.id) !== 'shell') throw new Error('Performance capture requires the native shell settings surface')
  return action()
}

/** 注册壳子渲染层所有 IPC 通道处理器 */
export function registerShellHandlers(): void {
  handleShellIpc(IpcChannels.ShellOpenExternal, async (_event, value: unknown) => {
    if (typeof value !== 'string' || value.length > 8192) throw new Error('Invalid external URL')
    const url = new URL(value)
    if (!['https:', 'http:', 'mailto:'].includes(url.protocol) || url.username || url.password) throw new Error('Unsupported external URL')
    await shell.openExternal(url.href)
  })
  registerShortcutHandlers()
  handleShellIpc(IpcChannels.ShellGetPluginDiagnostics, () => getPluginDiagnostics())
  handleShellIpc(IpcChannels.ShellGetPluginMemorySnapshot, (_event, force?: boolean) => getPluginMemorySnapshot(force === true))
  handleShellIpc(IpcChannels.ShellStartPerformanceCapture, event => captureForShell(event, startPerformanceCapture))
  handleShellIpc(IpcChannels.ShellGetPerformanceCaptureState, event => captureForShell(event, getPerformanceCaptureState))
  handleShellIpc(IpcChannels.ShellStopPerformanceCapture, event => captureForShell(event, stopPerformanceCapture))
  handleShellIpc(IpcChannels.ShellExportPerformanceCapture, event => captureForShell(event, exportPerformanceCapture))
  handleShellIpc(IpcChannels.ShellRestoreTabs, (_e, ids: string[]) => pluginHost.restoreTabs(Array.isArray(ids) ? ids.filter((id) => typeof id === 'string') : []))
  handleShellIpc(IpcChannels.ShellGetPlugins, () => pluginRegistry.list())
  handleShellIpc(IpcChannels.ShellGetMarketStatus, (_event, refresh?: boolean) => pluginRegistry.getMarketStatus(refresh === true))

  handleShellIpc(
    IpcChannels.ShellOpenPlugin,
    async (_e, pluginId: string, enter?: { code?: string; payload?: unknown }) => {
      try {
        const tabId = await pluginHost.openPlugin(pluginId, enter, { trustedUserNavigation: true })
        logInfo('plugin', `open ${pluginId} tab=${tabId}${enter?.code ? ` code=${enter.code}` : ''}`)
        return { ok: true, data: tabId }
      } catch (err) {
        logWarn('plugin', `open failed ${pluginId}: ${(err as Error).message}`)
        return { ok: false, error: (err as Error).message }
      }
    }
  )

  handleShellIpc(IpcChannels.ShellClosePlugin, async (_e, tabId: string) => {
    try {
      if (typeof tabId !== 'string' || tabId.length > 300) throw new Error('Invalid plugin identifier')
      const hasWorkspace = homeSurfaceManager.getMemoryOwners().some(owner => owner.pluginId === toPluginId(tabId))
      // 普通 Tab 与同 ID 的 Workspace 是不同实例；仅拒绝释放仍被 Workspace 独占的插件。
      if (hasWorkspace && !pluginHost.hasShellTab(tabId)) {
        return { ok: false, error: settingsStore.getAll().general.locale === 'en-US'
          ? 'Switch themes before releasing this workspace plugin' : '请先切换主题，再释放正在使用的首页插件' }
      }
      await pluginHost.closePlugin(tabId, 'tab-close', false, hasWorkspace)
      await refreshPluginMemoryAfterClose()
      return { ok: true }
    } catch (error) {
      logWarn('lifecycle', String(error))
      const en = settingsStore.getAll().general.locale === 'en-US'
      try {
        showNotification(getMainWindow(), {
          title: en ? 'Plugin cleanup incomplete' : '插件资源回收未完成', level: 'error', duration: 12000,
          body: en ? 'Some plugin resources could not be confirmed as released. Check Settings > General for remaining processes.'
            : '部分资源尚未确认释放，请在“设置 → 通用”查看剩余进程。'
        }, { owner: pluginHost, source: 'eNest' })
      } catch { /* The closing window may no longer have a notification surface. */ }
      return { ok: false, error: en ? 'Plugin cleanup incomplete' : '插件资源回收未完成' }
    }
  })

  handleShellIpc(IpcChannels.ShellStopPluginResources, async (_e, pluginId: string) => {
    if (typeof pluginId !== 'string' || !pluginId || pluginId.length > 256) throw new Error('Invalid plugin identifier')
    if (homeSurfaceManager.getMemoryOwners().some(owner => owner.pluginId === pluginId)) throw new Error('Switch themes before releasing this workspace plugin')
    const release = pluginHost.blockPlugin(pluginId)
    try {
      stopPluginBackground(pluginId, 'user stopped plugin resources')
      await pluginHost.closePlugin(pluginId)
      await stopPluginBackend(pluginId)
      await refreshPluginMemoryAfterClose()
      return { ok: true }
    } finally { release() }
  })

  handleShellIpc(IpcChannels.ShellActivatePlugin, (_e, tabId: string) => {
    pluginHost.activatePlugin(tabId, undefined, true)
    return { ok: true }
  })

  handleShellIpc(IpcChannels.ShellHidePlugins, () => {
    pluginHost.hideAllViews()
    return { ok: true }
  })

  handleShellIpc(IpcChannels.ShellSetPluginInset, (_e, left: number) => {
    setPluginLeftInset(Number(left) || 0)
    pluginHost.layoutAll()
    return { ok: true }
  })

  handleShellIpc(IpcChannels.ShellSetPluginTopInset, (event, top: number) => {
    const win = getMainWindow()
    if (!win || win.isDestroyed() || event.sender !== getShellWebContents()) throw new Error('Main shell required')
    if (typeof top !== 'number' || !Number.isFinite(top)) throw new Error('Invalid titlebar inset')
    const layout = appearanceService.getAppearance().layout
    setPluginTopInset(layout.tabStyle !== 'orb' && layout.tabAutoHide === true ? top : 0)
    layoutOrbRailViews()
    pluginHost.layoutAll()
    homeSurfaceManager.layout()
    return { ok: true }
  })

  handleShellIpc(IpcChannels.ShellSyncOrbState, (event, state: OrbRailSyncRequest) => {
    if (event.sender !== getShellWebContents()) throw new Error('Main shell required')
    const tabStyle = appearanceService.getAppearance().layout.tabStyle === 'orb' ? 'orb' : 'classic'
    const { chromeVisible, ...projection } = state
    setOrbRailState({ ...projection, tabStyle })
    // Only App opens this gate; orb uses the rail and classic uses the fixed settings dock.
    applyOrbRailVisibility(tabStyle, chromeVisible === true)
    return { ok: true }
  })

  handleShellIpc(IpcChannels.ShellGetOrbState, () => getOrbRailState())

  handleShellIpc(IpcChannels.ShellGoHome, async () => {
    await navigateWorkspace({ page: 'catalog' })
    return { ok: true }
  })

  handleShellIpc(IpcChannels.ShellSetView, async (event, view: string) => {
    if (getTrustedSurfaceRole(event.sender.id) === 'dock' && view !== 'settings') throw new Error('Settings dock action required')
    if (view === 'settings') {
      openShellSettings()
    } else if (view === 'plugin') sendShellEvent({ type: 'set-view', view })
    else await navigateWorkspace({ page: 'catalog' })
    return { ok: true }
  })

  handleShellIpc(IpcChannels.ShellNavigateWorkspace, (_event, route: WorkspaceRoute) => navigateWorkspace(route))

  /** 圆轨 rail 视图展开/收起：renderer CSS 动画先行，主进程跟进切换视图宽度 */
  handleShellIpc(IpcChannels.ShellSetOrbRailExpanded, (_e, expanded: boolean) => {
    setOrbRailExpandedView(expanded === true)
    return { ok: true }
  })

  /**
   * shell:uninstall-plugin — 完整卸载：关 Tab → 清 partition storage →
   * 删插件目录与 storage JSON → 重扫注册表。结果经 uninstall-result 事件推送。
   */
  handleShellIpc(IpcChannels.ShellUninstallPlugin, async (_e, pluginId: string) => {
    try {
      const id = String(pluginId ?? '').trim()
      if (!id) return { ok: false, error: 'plugin id required' }
      logInfo('ipc', `shell:uninstall-plugin ${id}`)
      const result = await uninstallPlugin(id)
      // A failed uninstall must retain the user's bindings and preferences.
      if (result.ok) await clearPluginLaunch(id)
      // Refresh declarative background subscriptions after installed state changes.
      refreshPluginBackgrounds()
      return result.ok ? { ok: true } : { ok: false, error: result.error }
    } catch (err) {
      logWarn('ipc', `shell:uninstall-plugin failed: ${(err as Error).message}`)
      return { ok: false, error: (err as Error).message }
    }
  })

  /**
   * shell:set-plugin-enabled — 启用/禁用已安装插件。
   * 持久化到 ~/.eNest/plugins/disabled.json；成功返回更新后的 summary。
   */
  handleShellIpc(
    IpcChannels.ShellSetPluginEnabled,
    async (_e, pluginId: string, enabled: boolean) => {
      try {
        const id = String(pluginId ?? '').trim()
        if (!id) return { ok: false, error: 'plugin id required' }
        logInfo('ipc', `shell:set-plugin-enabled ${id} → ${enabled !== false}`)
        const release = enabled === false ? pluginHost.blockPlugin(id) : () => {}
        let summary
        try {
          if (enabled === false) {
            stopPluginBackground(id, 'plugin disabled')
            await cancelPluginDeadlineTasks(id)
            await pluginHost.closePlugin(id)
          }
          summary = await pluginRegistry.setPluginEnabled(id, enabled !== false)
        } finally { release() }
        // Update generic background subscriptions after enable/disable.
        refreshPluginBackgrounds()
        // 快捷启动热键随启停释放/重注册（apply 内部跳过禁用插件）
        if (enabled === false) releasePluginLaunchHotkey(id)
        else applyPluginLaunchHotkeys()
        return { ok: true, data: summary }
      } catch (err) {
        logWarn('ipc', `shell:set-plugin-enabled failed: ${(err as Error).message}`)
        return { ok: false, error: (err as Error).message }
      }
    }
  )

  /** Quick 搜索的启动方式与触发词；全局快捷键由独立接口管理。 */
  handleShellIpc(
    IpcChannels.ShellSetPluginLaunch,
    async (
      _e,
      pluginId: string,
      patch: PluginLaunchPatch
    ) => {
      try {
        const id = String(pluginId ?? '').trim()
        if (!id) return { ok: false, error: 'plugin id required' }
        return await setPluginLaunch(id, patch ?? {})
      } catch (err) {
        logWarn('ipc', `shell:set-plugin-launch failed: ${(err as Error).message}`)
        return { ok: false, error: (err as Error).message }
      }
    }
  )

  /**
   * shell:install-market-plugin — 从市场安装/更新插件。
   * 策略：开发态本地预览产物优先；否则远程 assetUrl 入队下载（进度经 install-progress）。
   * force=true 时已安装也会走远程更新（需 latestVersion 更高）。
   */
  handleShellIpc(
    IpcChannels.ShellInstallMarketPlugin,
    async (_e, pluginId: string, opts?: { force?: boolean }) => {
      try {
        const id = String(pluginId ?? '').trim()
        if (!id) return { ok: false, error: 'plugin id required' }
        const force = opts?.force === true
        const existing = pluginRegistry.get(id)
        if (!existing) return { ok: false, error: `plugin not found: ${id}` }

        // 已安装且非强制 → 直接返回（幂等）
        if (existing.installed && !force) {
          return { ok: true, data: { ok: true, mode: 'already', name: existing.name } }
        }

        // 未安装：先试开发态本地预览产物，失败再远程
        if (!existing.installed) {
          try {
            const summary = await pluginRegistry.installLocalPreview(id)
            logInfo('ipc', `shell:install-market-plugin ${id} via local preview`)
            sendShellEvent({
              type: 'install-result',
              jobId: `sample-${id}`,
              name: summary.name,
              ok: true
            })
            sendShellEvent({ type: 'plugins-changed' })
            // Update generic background declarations after installation.
            refreshPluginBackgrounds()
            // Keep the existing IPC result tag for preview clients; this is not bundled plugin content.
            return { ok: true, data: { ok: true, mode: 'sample', name: summary.name } }
          } catch (previewError) {
            logInfo(
              'ipc',
              `local preview unavailable ${id}: ${(previewError as Error).message} → try remote`
            )
          }
        }

        // 远程下载入队
        const remote = pluginRegistry.getRemoteEntry(id)
        if (!remote?.assetUrl) {
          return {
            ok: false,
            error: force
              ? `no remote asset to update: ${id}`
              : `plugin not installable: ${id}（无本地预览产物且远程无资产）`
          }
        }
        const job = enqueueInstallFromUrl(remote.assetUrl, {
          name: remote.name || id,
          sha256: remote.assetSha256,
          identity: { id, version: remote.version }
        })
        logInfo('ipc', `shell:install-market-plugin ${id} queued remote job=${job.id}`)
        return {
          ok: true,
          data: { ok: true, mode: 'remote', jobId: job.id, name: remote.name }
        }
      } catch (err) {
        logWarn('ipc', `shell:install-market-plugin failed: ${(err as Error).message}`)
        return { ok: false, error: (err as Error).message }
      }
    }
  )

  /** 返回 ThemeTokens + 已注册主题包列表 */
  handleShellIpc(IpcChannels.ShellGetTheme, () => ({
    ...settingsStore.getTheme(),
    packs: themePackRegistry.list()
  }))

  handleShellIpc(IpcChannels.ShellSetTheme, async (_e, theme: Partial<ThemeTokens>) => {
    const saved = await settingsStore.setTheme(theme)
    appearanceService.invalidate()
    return saved
  })

  handleShellIpc(IpcChannels.ShellGetAppearance, () => appearanceService.getAppearanceSnapshot())

  handleShellIpc(IpcChannels.ShellUpdateThemeProfile, async (_e, patch: ThemeProfilePatch) => {
    for (const value of Object.values(patch?.values ?? {})) {
      if (!value || typeof value !== 'object' || !('value' in value) || typeof value.value !== 'string' || !value.value.startsWith('enest://appearance/')) continue
      const id = value.value.slice('enest://appearance/media/'.length)
      if (!value.value.startsWith('enest://appearance/media/') || !await resolveAppearanceResource('media', id)) throw new Error('背景资源未获授权或已失效')
    }
    const snapshot = appearanceService.updateThemeProfile(patch)
    return snapshot
  })

  handleShellIpc(IpcChannels.ShellActivateTheme, async (_e, identity: { source?: unknown; id?: unknown }) => {
    if (!identity || typeof identity !== 'object' || typeof identity.source !== 'string' || typeof identity.id !== 'string') {
      throw new Error('Invalid theme identity')
    }
    return appearanceService.activateTheme({ source: identity.source, id: identity.id })
  })

  handleShellIpc(IpcChannels.ShellSetAppearanceMode, async (_e, mode: unknown) => {
    if (mode !== 'light' && mode !== 'dark' && mode !== 'system') throw new Error('Invalid appearance mode')
    return appearanceService.setAppearanceMode(mode)
  })

  handleShellIpc(IpcChannels.ShellSetHomeVisible, (_e, visible: unknown) => {
    if (typeof visible !== 'boolean') throw new Error('Invalid home visibility')
    setHomeSurfaceVisible(visible)
  })

  handleShellIpc(IpcChannels.ShellRetryHome, () => retryHomeSurface(true))
  handleShellIpc(IpcChannels.ShellGetHomeState, () => homeSurfaceManager.getState())
  handleShellIpc(IpcChannels.ShellPickAppearanceMedia, (event, options?: { imageOnly?: boolean }) => {
    if (options !== undefined && (!options || typeof options !== 'object' || Array.isArray(options)
      || Object.keys(options).some(key => key !== 'imageOnly') || (options.imageOnly !== undefined && typeof options.imageOnly !== 'boolean'))) throw new Error('Invalid media options')
    return pickAppearanceMedia(() => !event.sender.isDestroyed(), options)
  })
  handleShellIpc(IpcChannels.ShellRemoveAppearanceFont, async (event, id: string) => {
    if (typeof id !== 'string' || !id || id.length > 200) throw new Error('Invalid font identity')
    await removeAppearanceFont(id, () => !event.sender.isDestroyed())
    appearanceService.invalidate()
  })
  handleShellIpc(IpcChannels.ShellImportAppearanceFont, async () => {
    const font = await importAppearanceFont()
    if (font) {
      appearanceService.invalidate()
      sendShellEvent({ type: 'settings-changed', generalKeys: ['customFonts'] })
    }
    return font
  })
  handleShellIpc(IpcChannels.ShellSetAppearancePerformanceLimited, (_e, limited: unknown) => {
    if (typeof limited !== 'boolean') throw new Error('Invalid runtime performance limit')
    return appearanceService.setPerformanceLimited(limited)
  })

  const broadcastAppearance = (revision: number, appearance: ResolvedAppearance): void => {
    sendShellEvent({ type: 'appearance-changed', revision, appearance })
    pluginHost.broadcastTheme()
    setOrbTheme()
    broadcastNotice('appearance.changed', { kind: 'theme' })
  }

  appearanceService.subscribeAppearance(({ revision, appearance }) => broadcastAppearance(revision, appearance))

  handleShellIpc(IpcChannels.ShellLoadDevPlugin, async (_e, dirPath?: string, options: DevPluginLoadOptions = {}) => {
    try {
      if (options && (typeof options !== 'object' || Array.isArray(options))) throw new Error('Invalid development options')
      const summary = await pickAndLoadDevPlugin(dirPath, options)
      if (!summary) return { ok: false, error: 'cancelled' }
      // 已打开的同 id 插件先关掉：rootPath / development.main 可能已变，必须重建 View
      if (pluginHost.isOpen(summary.id)) {
        await pluginHost.closePlugin(toTabId(summary.id), 'tab-close')
      }
      sendShellEvent({ type: 'plugins-changed' })
      // Refresh declarative backgrounds for development plugins.
      refreshPluginBackgrounds()
      return { ok: true, data: summary }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  handleShellIpc(IpcChannels.ShellReloadPlugin, (_e, tabId: string) => {
    pluginHost.reloadPlugin(tabId)
    return { ok: true }
  })

  handleShellIpc(IpcChannels.ShellForgetDevPlugin, async (_e, pluginId: string) => {
    if (typeof pluginId !== 'string' || !pluginRegistry.get(pluginId)?.dev) return { ok: false, error: '开发插件不存在' }
    try {
      await forgetDevPlugin(pluginId)
      await pluginRegistry.scan()
      refreshPluginBackgrounds()
      return { ok: true }
    } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } }
  })

  /** dev 插件「退出即杀」开关：内存生效 + 持久化 dev.json；enabled 省略时仅查询当前状态 */
  handleShellIpc(IpcChannels.ShellSetDevKillOnHide, (_e, pluginId: string, enabled?: boolean) => {
    try {
      if (typeof pluginId !== 'string' || !pluginId) return { ok: false, error: 'pluginId required' }
      if (enabled !== undefined) {
        pluginHost.setKillOnHide(pluginId, enabled === true)
        void setDevPluginKillOnHide(pluginId, enabled === true)
      }
      return { ok: true, data: pluginHost.getKillOnHide(pluginId) }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  /** plugin:call 调用跟踪环形缓冲读取（DevConsole「调用跟踪」面板轮询用） */
  handleShellIpc(IpcChannels.ShellGetPluginTrace, () => getPluginCallTrace())

  handleShellIpc(IpcChannels.ShellOpenDevTools, async (_e, tabId?: string) => {
    const target = tabId ?? pluginHost.getActive()
    if (target) {
      try { await pluginHost.openDevTools(target, 'detach') }
      catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } }
    } else {
      getShellWebContents()?.openDevTools({ mode: 'detach' })
    }
    return { ok: true }
  })

  handleShellIpc(IpcChannels.ShellGetSettings, () => settingsStore.getAll())

  handleShellIpc(IpcChannels.ShellSetSettings, async (_e, partial) => {
    if (partial && typeof partial === 'object' && ('mcp' in partial || 'mcpToken' in partial
      || partial.general && typeof partial.general === 'object' && ('mcp' in partial.general || 'mcpToken' in partial.general))) {
      throw new Error('MCP security settings require the dedicated native API')
    }
    // A renderer only sees its own tab projection; it cannot overwrite the global session.
    // panels 是主进程独占的布局快照，renderer 只能读（写入走 panel:* 通道）。
    if (partial && typeof partial === 'object' && 'panels' in partial) {
      const { panels: _panels, ...rest } = partial
      partial = rest
    }
    if (partial?.general && typeof partial.general === 'object') {
      const { sessionTabs: _tabs, sessionActivePluginId: _active, mainWindowState: _window, ...general } = partial.general
      if (general.quickLauncher && typeof general.quickLauncher === 'object') {
        const { enabled: _enabled, hotkeys: _hotkeys, activeHotkey: _hotkey, ...preferences } = general.quickLauncher
        general.quickLauncher = { ...settingsStore.getQuickLauncherSettings(), ...preferences }
      }
      partial = { ...partial, general }
    }
    // locale 变更检测：变化时向所有已打开插件广播 locale-change
    // （preload → enest.i18n.onLocaleChange）
    const prevLocale = settingsStore.getAll().general.locale
    const nextLocale = (
      partial as { general?: { locale?: unknown } } | undefined
    )?.general?.locale
    const result = await settingsStore.setAll(partial)
    if (
      (nextLocale === 'zh-CN' || nextLocale === 'en-US') &&
      nextLocale !== prevLocale
    ) {
      broadcastPluginLocale(nextLocale)
    }
    // 动画档位变更即时推给 orb 悬浮窗（独立文档，不随主壳 data-anim 联动）
    const lvl = (partial as { general?: { animationLevel?: unknown } } | undefined)?.general
      ?.animationLevel
    if (lvl === 'low' || lvl === 'medium' || lvl === 'high') {
      setOrbAnimationLevel(lvl)
      pluginHost.broadcastTheme()
      broadcastNotice('appearance.changed', { kind: 'animation' })
    }
    const generalPatch = (partial as { general?: Record<string, unknown> } | undefined)?.general
    if (generalPatch && ['fontFamily', 'fontFamilyEn', 'fontSizeScale', 'animationLevel', 'customFonts'].some(key => key in generalPatch)) {
      appearanceService.invalidate()
    }
    if (generalPatch && ['fontFamily', 'fontFamilyEn', 'fontSizeScale', 'customFonts'].some(key => key in generalPatch)) {
      pluginHost.broadcastTheme()
      broadcastNotice('appearance.changed', { kind: 'font' })
    }
    // 自由面板开关/快捷键变更：重注册热键；开启时恢复布局，关闭时释放面板内插件（保留布局记录）。
    if (generalPatch && ('freePanel' in generalPatch || 'panelHotkey' in generalPatch)) {
      const enabled = settingsStore.getAll().general.freePanel?.enabled === true
      applyPanelHotkeys()
      if ('freePanel' in generalPatch) {
        void syncFreePanelSetting(enabled).catch(error => logWarn('panel', `sync setting failed: ${String(error)}`))
      }
    }
    // 面板材质变更：立即应用到已开面板。
    if (generalPatch && 'panelAppearance' in generalPatch) applyAppearanceToPanels()
    return result
  })

  // —— 「打开方式」：壳统一能力（插件只声明，系统写入与路由在主进程）——

  const parseOpenWithKey = (raw: unknown): OpenWithKey | null => {
    const key = String(raw ?? '')
    if (key.startsWith('ext:') && OPEN_WITH_EXT_RE.test(key.slice(4))) return key as OpenWithKey
    if (key.startsWith('scheme:') && OPEN_WITH_SCHEME_RE.test(key.slice(7))) return key as OpenWithKey
    return null
  }

  handleShellIpc(IpcChannels.ShellOpenWithList, () => associationService.list())

  handleShellIpc(IpcChannels.ShellOpenWithSetDefault, (_e, req: OpenWithSetRequest) => {
    const key = parseOpenWithKey(req?.key)
    const pluginId = String(req?.pluginId ?? '')
    if (!key || !pluginId) return { ok: false, error: 'invalid openWith request' }
    return associationService.setDefault(key, pluginId)
  })

  handleShellIpc(IpcChannels.ShellOpenWithClearDefault, (_e, rawKey: unknown) => {
    const key = parseOpenWithKey(rawKey)
    if (!key) return { ok: false, error: 'invalid openWith key' }
    return associationService.clearDefault(key)
  })

  handleShellIpc(IpcChannels.ShellOpenWithRoute, async (_e, req: OpenWithSetRequest) => {
    const key = parseOpenWithKey(req?.key)
    const pluginId = String(req?.pluginId ?? '')
    if (!key || !pluginId) return { ok: false, error: 'invalid openWith request' }
    return (await resumeDeferredOpen(key, pluginId))
      ? { ok: true }
      : { ok: false, error: '该插件未声明此类型或已停用' }
  })

  handleShellIpc(IpcChannels.ShellOpenWithOpenSystemSettings, () => associationService.openSystemSettings())

  /** 设置页插件分组：已注册 section 列表 */
  handleShellIpc(IpcChannels.ShellGetSettingsSections, () => pluginSettingsBridge.listAll())

  /** 设置页插件分组：写入单项，同步 Bridge 与 settings.json */
  handleShellIpc(
    IpcChannels.ShellSetPluginSetting,
    async (_e, pluginId: string, key: string, value: unknown) => {
      const id = String(pluginId ?? '')
      const k = String(key ?? '')
      if (!id || !k) return { ok: false, error: 'pluginId and key required' }
      if (!pluginSettingsBridge.isWritableKey(id, k)) return { ok: false, error: 'Unknown or read-only plugin settings key' }
      await settingsStore.setPluginSetting(id, k, value)
      pluginSettingsBridge.set(id, k, value)
      refreshPluginBackgrounds()
      pluginHost.sendEvent(id, { type: 'settings-change', key: k, value })
      sendShellEvent({ type: 'plugin-settings-changed', pluginId: id })
      return { ok: true }
    }
  )

  // —— 路径与数据 ——

  handleShellIpc(IpcChannels.ShellGetPaths, () => getAppPaths())
  handleShellIpc(IpcChannels.ShellOpenPath, async (_e, path: string) => {
    await openLocalPath(path)
    return { ok: true }
  })

  handleShellIpc(
    IpcChannels.ShellPickFile,
    async (_e, options?: { filters?: PickFilterKey }): Promise<string | null> => {
      const key: PickFilterKey = options?.filters && PICK_FILTERS[options.filters]
        ? options.filters
        : 'media'
      const win = getMainWindow()
      const result = await trackNativeInteraction(win
        ? dialog.showOpenDialog(win as never, {
            properties: ['openFile'],
            filters: [PICK_FILTERS[key]]
          })
        : dialog.showOpenDialog({
            properties: ['openFile'],
            filters: [PICK_FILTERS[key]]
          }))
      if (result.canceled || result.filePaths.length === 0) return null
      return result.filePaths[0]
    }
  )

  handleShellIpc(IpcChannels.ShellGetPluginReadme, (_e, pluginId: string) =>
    readPluginReadme(String(pluginId ?? ''))
  )

  // —— 系统级通知 ——

  /** shell:system-notify — 弹出 OS 通知（Electron Notification） */
  handleShellIpc(
    IpcChannels.ShellSystemNotify,
    (_e, title?: string, body?: string): { ok: boolean; error?: string } => {
      try {
        if (!Notification.isSupported()) return { ok: false, error: 'notification unsupported' }
        new Notification({
          title: String(title ?? APP_NAME).slice(0, 120),
          body: String(body ?? '').slice(0, 500)
        }).show()
        return { ok: true }
      } catch (err) {
        logWarn('ipc', `shell:system-notify failed: ${(err as Error).message}`)
        return { ok: false, error: (err as Error).message }
      }
    }
  )

  // —— 硬件加速 ——

  handleShellIpc(IpcChannels.ShellGetHardwareAccel, () => ({
    enabled: settingsStore.getAll().general.hardwareAcceleration !== false
  }))

  handleShellIpc(IpcChannels.ShellSetHardwareAccel, async (_e, enabled: boolean) => {
    const all = settingsStore.getAll()
    await settingsStore.setAll({
      general: { ...all.general, hardwareAcceleration: enabled !== false }
    })
    return { needRestart: true as const }
  })

  // —— 网络代理 ——

  handleShellIpc(IpcChannels.ShellGetProxy, () => {
    const fromSettings = (settingsStore.getAll().general as { proxy?: unknown }).proxy
    return fromSettings ? normalizeProxy(fromSettings) : getActiveProxy()
  })

  /** 写入 settings.general.proxy 并即时 session.setProxy；返回是否需要重启（否） */
  handleShellIpc(IpcChannels.ShellSetProxy, async (_e, config) => {
    const next = normalizeProxy(config)
    const all = settingsStore.getAll()
    await settingsStore.setAll({
      general: { ...all.general, proxy: next }
    })
    await applyProxy(next)
    return { needRestart: false, proxy: next }
  })

  /** TCP 探测代理 host:port（5s 超时）；未传 config 时测当前已保存配置 */
  handleShellIpc(IpcChannels.ShellTestProxy, (_e, config?) =>
    testProxyConnectivity(config ? normalizeProxy(config) : undefined)
  )

  // —— 自定义字体 ——

  /**
   * shell:save-custom-font — 将本地字体复制到 ~/.eNest/fonts/（或直接写 base64）。
   * payload: { sourcePath?: string; dataBase64?: string; fileName: string }
   * 返回落盘后的绝对路径。
   */
  handleShellIpc(
    IpcChannels.ShellSaveCustomFont,
    async (
      _e,
      payload: { sourcePath?: string; dataBase64?: string; fileName: string }
    ): Promise<{ ok: boolean; path?: string; fileName?: string; error?: string }> => {
      try {
        const fileName = sanitizeFontFileName(payload?.fileName ?? '')
        if (!fileName) return { ok: false, error: 'invalid font file name' }
        const dir = fontsDir()
        await mkdir(dir, { recursive: true })
        const dest = join(dir, fileName)
        if (payload?.sourcePath) {
          await copyFile(payload.sourcePath, dest)
        } else if (payload?.dataBase64) {
          await writeFile(dest, Buffer.from(payload.dataBase64, 'base64'))
        } else {
          return { ok: false, error: 'sourcePath or dataBase64 required' }
        }
        return { ok: true, path: dest, fileName }
      } catch (err) {
        return { ok: false, error: (err as Error).message }
      }
    }
  )

  /** shell:read-custom-font — 读 ~/.eNest/fonts/{fileName} 为 base64，供 FontFace 加载 */
  handleShellIpc(
    IpcChannels.ShellReadCustomFont,
    async (_e, fileName: string): Promise<{ ok: boolean; dataBase64?: string; error?: string }> => {
      try {
        const safe = sanitizeFontFileName(fileName)
        if (!safe) return { ok: false, error: 'invalid font file name' }
        const file = join(fontsDir(), safe)
        if (!existsSync(file)) return { ok: false, error: 'font not found' }
        const buf = await readFile(file)
        return { ok: true, dataBase64: buf.toString('base64') }
      } catch (err) {
        return { ok: false, error: (err as Error).message }
      }
    }
  )

  /** shell:delete-custom-font — 删除 ~/.eNest/fonts/{fileName}（文件不存在视为成功） */
  handleShellIpc(
    IpcChannels.ShellDeleteCustomFont,
    async (_e, fileName: string): Promise<{ ok: boolean; error?: string }> => {
      try {
        const safe = sanitizeFontFileName(fileName)
        if (!safe) return { ok: false, error: 'invalid font file name' }
        const file = join(fontsDir(), safe)
        if (existsSync(file)) await unlink(file)
        return { ok: true }
      } catch (err) {
        return { ok: false, error: (err as Error).message }
      }
    }
  )

  // —— 插件安装（拖拽 / 路径）——

  /**
   * shell:install-plugin — 将本地文件夹或 .enestplugin 入队安装。
   * 立即返回任务摘要；进度与结果经 shell:event（install-progress / install-queue / install-result）推送。
   */
  handleShellIpc(IpcChannels.ShellInstallPlugin, (_e, sourcePath: string) => {
    try {
      const path = String(sourcePath ?? '').trim()
      if (!path) return { ok: false, error: 'source path required' }
      logInfo('ipc', `shell:install-plugin ${path}`)
      const job = enqueueInstall(path)
      return { ok: true, data: job }
    } catch (err) {
      logWarn('ipc', `shell:install-plugin failed: ${(err as Error).message}`)
      return { ok: false, error: (err as Error).message }
    }
  })

  /** shell:get-install-queue — 查询当前 active / waiting 列表 */
  handleShellIpc(IpcChannels.ShellGetInstallQueue, () => getInstallQueueState())

  // —— 应用更新（GitHub Release）——

  handleShellIpc(IpcChannels.ShellCheckUpdate, () => checkForUpdates())
  handleShellIpc(IpcChannels.ShellDownloadUpdate, () => downloadUpdate())
  handleShellIpc(IpcChannels.ShellInstallUpdate, () => quitAndInstallUpdate())
  handleShellIpc(IpcChannels.ShellGetUpdateState, () => getUpdateState())

  /** 更新重启前：插件未保存数据快照 / 一键保存（save.requested 通知 + ack 等待） */
  handleShellIpc(IpcChannels.ShellGetPluginsDirty, () => ({ items: pluginHost.getDirtySnapshot() }))
  handleShellIpc(IpcChannels.ShellSaveAllPlugins, () => pluginHost.requestSaveAll('update'))

  // Provider-based account bridge; legacy GitHub endpoints remain compatible.
  handleShellIpc(IpcChannels.ShellAccountState, () => getAccountState())
  handleShellIpc(IpcChannels.ShellAccountLogin, (_event, providerId: unknown) => loginAccount(providerId))
  handleShellIpc(IpcChannels.ShellAccountCancel, (_event, providerId: unknown) => cancelAccountLogin(providerId))
  handleShellIpc(IpcChannels.ShellAccountLogout, (_event, providerId: unknown) => logoutAccount(providerId))

  // —— GitHub 个人资料 ——

  handleShellIpc(
    IpcChannels.ShellGithubLogin,
    async () => {
      try {
        const session = await startGithubLogin()
        return { ok: true, data: session }
      } catch (err) {
        return { ok: false, error: (err as Error).message }
      }
    }
  )
  handleShellIpc(IpcChannels.ShellGithubCancelLogin, () => {
    cancelGithubLogin()
    return { ok: true }
  })
  handleShellIpc(IpcChannels.ShellGetProfile, async () => {
    const hasToken = await hasGithubToken()
    return { user: getProfileUser(), hasToken, polling: isLoginPolling() }
  })
  handleShellIpc(IpcChannels.ShellGithubLogout, () => {
    logoutGithub()
    return { ok: true }
  })

  onShellIpc(IpcChannels.WindowMinimize, () => getMainWindow()?.minimize())
  onShellIpc(IpcChannels.WindowMaximize, () => {
    const win = getMainWindow()
    if (!win) return
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
  })
  onShellIpc(IpcChannels.WindowClose, () => getMainWindow()?.close())
}
