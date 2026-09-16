/**
 * shellHandlers — 壳子 IPC 处理器
 * 职责：注册壳子渲染层所有 invoke/on 通道（插件列表、打开/关闭/激活、主题、设置、
 * 路径、文件选择、README、KV 库、硬件加速、窗口控制等）。
 * 被 index.ts 在 app.whenReady 后调用 registerShellHandlers 注册。
 * 关键依赖：PluginHost、PluginRegistry、SettingsStore、pathsService、sqliteService、
 * themePacks、createShellWindow、DevConsole。
 */
import { copyFile, mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { dialog, ipcMain, Notification } from 'electron'
import { IpcChannels } from '@shared/types/ipc'
import type { ThemeTokens } from '@shared/types/plugin'
import { pickAndLoadDevPlugin } from '@main/dev/DevConsole'
import { kvDelete, kvGet, kvSet } from '@main/db/sqliteService'
import { logInfo, logWarn } from '@main/logs/logService'
import { getAppPaths, getAppPathsRoot } from '@main/paths/pathsService'
import { pluginHost } from '@main/plugin/PluginHost'
import { pluginRegistry } from '@main/plugin/PluginRegistry'
import { enqueueInstall, getInstallQueueState } from '@main/plugin/installQueue'
import { uninstallPlugin } from '@main/plugin/PluginUninstaller'
import { settingsStore } from '@main/settings/SettingsStore'
import {
  applyProxy,
  getActiveProxy,
  normalizeProxy,
  testProxyConnectivity
} from '@main/proxy/proxyService'
import { themePackRegistry } from '@main/theme/themePacks'
import {
  checkForUpdates,
  downloadUpdate,
  getUpdateState,
  quitAndInstallUpdate
} from '@main/update/updateService'
import {
  getMainWindow,
  getShellBounds,
  getShellWebContents,
  sendShellEvent,
  setPluginLeftInset
} from '@main/window/createShellWindow'
import {
  applyOrbOverlayVisibility,
  getOrbRailState,
  setOrbRailState
} from '@main/window/orbOverlayWindow'

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
  return join(getAppPathsRoot(), 'fonts')
}

/** 清洗字体文件名，防止路径穿越；非法时回落 custom-font */
function sanitizeFontFileName(raw: string): string {
  const base = basename(String(raw ?? '')).replace(/[^\w.\-]+/g, '_')
  const ext = extname(base).toLowerCase()
  if (!FONT_EXTS.has(ext) || base.startsWith('.')) return ''
  return base
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

  ipcMain.handle(IpcChannels.ShellHidePlugins, () => {
    pluginHost.hideAllViews()
    return { ok: true }
  })

  ipcMain.handle(IpcChannels.ShellSetPluginInset, (_e, left: number) => {
    setPluginLeftInset(Number(left) || 0)
    pluginHost.layoutAll()
    return { ok: true }
  })

  ipcMain.handle(IpcChannels.ShellSyncOrbState, (_e, state) => {
    setOrbRailState(state)
    if (state?.tabStyle) applyOrbOverlayVisibility(state.tabStyle)
    return { ok: true }
  })

  ipcMain.handle(IpcChannels.ShellGetOrbState, () => getOrbRailState())

  ipcMain.handle(IpcChannels.ShellGoHome, () => {
    pluginHost.hideAllViews()
    sendShellEvent({ type: 'go-home' })
    return { ok: true }
  })

  ipcMain.handle(IpcChannels.ShellSetView, (_e, view: string) => {
    if (view !== 'plugin') pluginHost.hideAllViews()
    sendShellEvent({
      type: 'set-view',
      view: (['home', 'settings', 'plugin', 'dev'] as const).includes(view as 'home')
        ? (view as 'home' | 'settings' | 'plugin' | 'dev')
        : 'home'
    })
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

  // —— 系统级通知 ——

  /** shell:system-notify — 弹出 OS 通知（Electron Notification） */
  ipcMain.handle(
    IpcChannels.ShellSystemNotify,
    (_e, title?: string, body?: string): { ok: boolean; error?: string } => {
      try {
        if (!Notification.isSupported()) return { ok: false, error: 'notification unsupported' }
        new Notification({
          title: String(title ?? 'eNest').slice(0, 120),
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

  // —— 网络代理 ——

  ipcMain.handle(IpcChannels.ShellGetProxy, () => {
    const fromSettings = (settingsStore.getAll().general as { proxy?: unknown }).proxy
    return fromSettings ? normalizeProxy(fromSettings) : getActiveProxy()
  })

  /** 写入 settings.general.proxy 并即时 session.setProxy；返回是否需要重启（否） */
  ipcMain.handle(IpcChannels.ShellSetProxy, async (_e, config) => {
    const next = normalizeProxy(config)
    const all = settingsStore.getAll()
    await settingsStore.setAll({
      general: { ...all.general, proxy: next }
    })
    await applyProxy(next)
    return { needRestart: false, proxy: next }
  })

  /** TCP 探测代理 host:port（5s 超时）；未传 config 时测当前已保存配置 */
  ipcMain.handle(IpcChannels.ShellTestProxy, (_e, config?) =>
    testProxyConnectivity(config ? normalizeProxy(config) : undefined)
  )

  // —— 自定义字体 ——

  /**
   * shell:save-custom-font — 将本地字体复制到 ~/eNest/fonts/（或直接写 base64）。
   * payload: { sourcePath?: string; dataBase64?: string; fileName: string }
   * 返回落盘后的绝对路径。
   */
  ipcMain.handle(
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

  /** shell:read-custom-font — 读 ~/eNest/fonts/{fileName} 为 base64，供 FontFace 加载 */
  ipcMain.handle(
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

  /** shell:delete-custom-font — 删除 ~/eNest/fonts/{fileName}（文件不存在视为成功） */
  ipcMain.handle(
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
