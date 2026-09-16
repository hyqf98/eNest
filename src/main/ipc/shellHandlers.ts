/**
 * shellHandlers — 壳子 IPC 处理器
 * 职责：注册壳子渲染层所有 invoke/on 通道（插件列表、打开/关闭/激活、主题、设置、
 * 路径、文件选择、README、KV 库、硬件加速、窗口控制等）。
 * 被 index.ts 在 app.whenReady 后调用 registerShellHandlers 注册。
 * 关键依赖：PluginHost、PluginRegistry、SettingsStore、pathsService、sqliteService、
 * themePacks、createShellWindow、DevConsole。
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { dialog, ipcMain } from 'electron'
import { IpcChannels } from '@shared/types/ipc'
import type { ThemeTokens } from '@shared/types/plugin'
import { pickAndLoadDevPlugin } from '../dev/DevConsole'
import { kvDelete, kvGet, kvSet } from '../db/sqliteService'
import { logInfo, logWarn } from '../logs/logService'
import { getAppPaths } from '../paths/pathsService'
import { pluginHost } from '../plugin/PluginHost'
import { pluginRegistry } from '../plugin/PluginRegistry'
import { enqueueInstall, getInstallQueueState } from '../plugin/installQueue'
import { uninstallPlugin } from '../plugin/PluginUninstaller'
import { settingsStore } from '../settings/SettingsStore'
import { themePackRegistry } from '../theme/themePacks'
import {
  checkForUpdates,
  downloadUpdate,
  getUpdateState,
  quitAndInstallUpdate
} from '../update/updateService'
import {
  getMainWindow,
  getShellBounds,
  getShellWebContents,
  sendShellEvent
} from '../window/createShellWindow'

/** shell:pick-file 支持的媒体过滤器 */
const PICK_FILTERS: Record<'image' | 'video' | 'media', { name: string; extensions: string[] }> = {
  image: { name: '图片', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] },
  video: { name: '视频', extensions: ['mp4', 'webm'] },
  media: { name: '媒体', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'mp4', 'webm'] }
}

type PickFilterKey = keyof typeof PICK_FILTERS

/** 读取插件根目录 README（README.md / readme.md） */
async function readPluginReadme(pluginId: string): Promise<string> {
  const root = pluginRegistry.getRootPath(pluginId)
  if (!root) return ''
  for (const name of ['README.md', 'readme.md', 'Readme.md']) {
    try {
      return await readFile(join(root, name), 'utf-8')
    } catch {
      // try next
    }
  }
  return ''
}

/** 注册壳子渲染层所有 IPC 通道处理器 */
export function registerShellHandlers(): void {
  ipcMain.handle(IpcChannels.ShellGetPlugins, () => pluginRegistry.list())

  ipcMain.handle(
    IpcChannels.ShellOpenPlugin,
    async (_e, pluginId: string, enter?: { code?: string; payload?: unknown }) => {
      try {
        await pluginRegistry.ensureInstalled(pluginId)
        const tabId = await pluginHost.openPlugin(pluginId, enter)
        logInfo('plugin', `open ${pluginId} tab=${tabId}${enter?.code ? ` code=${enter.code}` : ''}`)
        return { ok: true, data: tabId }
      } catch (err) {
        logWarn('plugin', `open failed ${pluginId}: ${(err as Error).message}`)
        return { ok: false, error: (err as Error).message }
      }
    }
  )

  ipcMain.handle(IpcChannels.ShellClosePlugin, async (_e, tabId: string) => {
    await pluginHost.closePlugin(tabId, 'tab-close')
    return { ok: true }
  })

  ipcMain.handle(IpcChannels.ShellActivatePlugin, (_e, tabId: string) => {
    pluginHost.activatePlugin(tabId)
    return { ok: true }
  })

  /**
   * shell:uninstall-plugin — 完整卸载：关 Tab → 清 partition storage →
   * 删插件目录与 storage JSON → 重扫注册表。结果经 uninstall-result 事件推送。
   */
  ipcMain.handle(IpcChannels.ShellUninstallPlugin, async (_e, pluginId: string) => {
    try {
      const id = String(pluginId ?? '').trim()
      if (!id) return { ok: false, error: 'plugin id required' }
      logInfo('ipc', `shell:uninstall-plugin ${id}`)
      const result = await uninstallPlugin(id)
      return result.ok ? { ok: true } : { ok: false, error: result.error }
    } catch (err) {
      logWarn('ipc', `shell:uninstall-plugin failed: ${(err as Error).message}`)
      return { ok: false, error: (err as Error).message }
    }
  })

  ipcMain.handle(IpcChannels.ShellGetBounds, () => getShellBounds())

  /** 返回 ThemeTokens + 已注册主题包列表 */
  ipcMain.handle(IpcChannels.ShellGetTheme, () => ({
    ...settingsStore.getTheme(),
    packs: themePackRegistry.list()
  }))

  ipcMain.handle(IpcChannels.ShellSetTheme, async (_e, theme: Partial<ThemeTokens>) => {
    const saved = await settingsStore.setTheme(theme)
    // 壳子主题变更后，向所有已打开的 themeAware 插件广播新 Token
    pluginHost.broadcastTheme()
    return saved
  })

  ipcMain.handle(IpcChannels.ShellLoadDevPlugin, async (_e, dirPath?: string) => {
    try {
      const summary = await pickAndLoadDevPlugin(dirPath)
      if (!summary) return { ok: false, error: 'cancelled' }
      sendShellEvent({ type: 'plugins-changed' })
      return { ok: true, data: summary }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  ipcMain.handle(IpcChannels.ShellReloadPlugin, (_e, tabId: string) => {
    pluginHost.reloadPlugin(tabId)
    return { ok: true }
  })

  ipcMain.handle(IpcChannels.ShellOpenDevTools, (_e, tabId?: string) => {
    const target = tabId ?? pluginHost.getActive()
    if (target) {
      pluginHost.openDevTools(target, 'detach')
    } else {
      getShellWebContents()?.openDevTools({ mode: 'detach' })
    }
    return { ok: true }
  })

  ipcMain.handle(IpcChannels.ShellGetSettings, () => settingsStore.getAll())

  ipcMain.handle(IpcChannels.ShellSetSettings, async (_e, partial) => {
    return settingsStore.setAll(partial)
  })

  // —— 路径与数据 ——

  ipcMain.handle(IpcChannels.ShellGetPaths, () => getAppPaths())

  ipcMain.handle(
    IpcChannels.ShellPickFile,
    async (_e, options?: { filters?: PickFilterKey }): Promise<string | null> => {
      const key: PickFilterKey = options?.filters && PICK_FILTERS[options.filters]
        ? options.filters
        : 'media'
      const win = getMainWindow()
      const result = win
        ? await dialog.showOpenDialog(win as never, {
            properties: ['openFile'],
            filters: [PICK_FILTERS[key]]
          })
        : await dialog.showOpenDialog({
            properties: ['openFile'],
            filters: [PICK_FILTERS[key]]
          })
      if (result.canceled || result.filePaths.length === 0) return null
      return result.filePaths[0]
    }
  )

  ipcMain.handle(IpcChannels.ShellGetPluginReadme, (_e, pluginId: string) =>
    readPluginReadme(String(pluginId ?? ''))
  )

  /** 共享 KV 库：get / set / delete */
  ipcMain.handle(
    IpcChannels.ShellQueryDb,
    (
      _e,
      request: { op: 'get' | 'set' | 'delete'; key: string; value?: string }
    ): { ok: boolean; data?: string | null; error?: string } => {
      try {
        const key = String(request?.key ?? '')
        if (!key) return { ok: false, error: 'key required' }
        if (request.op === 'get') return { ok: true, data: kvGet(key) }
        if (request.op === 'set') {
          kvSet(key, String(request.value ?? ''))
          return { ok: true, data: null }
        }
        if (request.op === 'delete') {
          kvDelete(key)
          return { ok: true, data: null }
        }
        return { ok: false, error: `unknown op: ${String(request.op)}` }
      } catch (err) {
        return { ok: false, error: (err as Error).message }
      }
    }
  )

  // —— 硬件加速 ——

  ipcMain.handle(IpcChannels.ShellGetHardwareAccel, () => ({
    enabled: settingsStore.getAll().general.hardwareAcceleration !== false
  }))

  ipcMain.handle(IpcChannels.ShellSetHardwareAccel, async (_e, enabled: boolean) => {
    const all = settingsStore.getAll()
    await settingsStore.setAll({
      general: { ...all.general, hardwareAcceleration: enabled !== false }
    })
    return { needRestart: true as const }
  })

  // —— 插件安装（拖拽 / 路径）——

  /**
   * shell:install-plugin — 将本地文件夹或 .enestplugin 入队安装。
   * 立即返回任务摘要；进度与结果经 shell:event（install-progress / install-queue / install-result）推送。
   */
  ipcMain.handle(IpcChannels.ShellInstallPlugin, (_e, sourcePath: string) => {
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
  ipcMain.handle(IpcChannels.ShellGetInstallQueue, () => getInstallQueueState())

  // —— 应用更新（GitHub Release）——

  ipcMain.handle(IpcChannels.ShellCheckUpdate, () => checkForUpdates())
  ipcMain.handle(IpcChannels.ShellDownloadUpdate, () => downloadUpdate())
  ipcMain.handle(IpcChannels.ShellInstallUpdate, () => quitAndInstallUpdate())
  ipcMain.handle(IpcChannels.ShellGetUpdateState, () => getUpdateState())

  ipcMain.on(IpcChannels.WindowMinimize, () => getMainWindow()?.minimize())
  ipcMain.on(IpcChannels.WindowMaximize, () => {
    const win = getMainWindow()
    if (!win) return
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
  })
  ipcMain.on(IpcChannels.WindowClose, () => getMainWindow()?.close())
}
