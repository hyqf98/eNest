/**
 * Main entry — Electron 主进程入口
 * 职责：ready 前按设置决策硬件加速；ready 后创建数据目录、执行迁移、加载设置/KV 库/主题包，
 * 初始化插件协议与插件注册表，创建壳子窗口并注册 IPC 处理器。
 * 被 Electron 运行时直接加载，是整个主进程的启动点。
 * 关键依赖：hardwareAcceleration、pathsService、migrate、sqliteService、themePacks、
 * PluginRegistry、PluginHost、SettingsStore、createShellWindow。
 */
import { app, BaseWindow } from 'electron'
import { registerSchemesAsPrivileged, initPluginProtocol } from './plugin/pluginProtocol'
import { applyHardwareAccelerationBeforeReady } from './hardwareAcceleration'
import { ensureAppDirs } from './paths/pathsService'
import { migrateToDataRoot } from './paths/migrate'
import { initLogService, logError, logInfo } from './logs/logService'
import { kvStore } from './db/sqliteService'
import { themePackRegistry } from './theme/themePacks'
import { createShellWindow } from './window/createShellWindow'
import { destroyQuickWindow } from './window/createQuickWindow'
import { pluginHost } from './plugin/PluginHost'
import { pluginRegistry } from './plugin/PluginRegistry'
import { settingsStore } from './settings/SettingsStore'
import { registerShellHandlers } from './ipc/shellHandlers'
import { registerPluginHandlers } from './ipc/pluginHandlers'
import { registerQuickHandlers } from './ipc/quickHandlers'
import { initQuickHotkeys, disposeQuickHotkeys } from './hotkey/quickHotkey'
import { scanApplications } from './launcher/appScanner'
import { initUpdateService } from './update/updateService'

registerSchemesAsPrivileged()

// 硬件加速必须在 app ready 之前根据 settings.json 决策
applyHardwareAccelerationBeforeReady()

// 自动化：ENEST_REMOTE_DEBUG=9222 时开启 CDP
const remoteDebug = process.env.ENEST_REMOTE_DEBUG
if (remoteDebug && /^\d+$/.test(remoteDebug)) {
  app.commandLine.appendSwitch('remote-debugging-port', remoteDebug)
}

void app.whenReady().then(async () => {
  try {
    ensureAppDirs()
    // 日志服务在数据目录就绪后立刻初始化，后续 boot / install 全部落盘
    initLogService()
    logInfo('main', 'ready')
    await migrateToDataRoot()
    logInfo('main', 'migrate ok')
    await settingsStore.load()
    ensureAppDirs()
    const backend = await kvStore.initDatabase()
    logInfo('main', `kv backend=${backend}`)
    await themePackRegistry.load()
    logInfo('main', 'theme packs ok')
    await pluginRegistry.scan()
    logInfo('main', 'registry ok')
    initPluginProtocol()
    logInfo('main', 'protocol ok')

    const win: BaseWindow = createShellWindow()
    logInfo('main', 'window ok')
    win.on('resize', () => pluginHost.layoutAll())
    win.on('closed', () => pluginHost.destroyAll())

    registerShellHandlers()
    registerPluginHandlers()
    registerQuickHandlers()
    logInfo('main', 'ipc ok')

    // 快捷启动：注册全局热键 + 后台扫描；小窗懒创建（首次呼出时）
    initQuickHotkeys()
    void scanApplications(false)
    logInfo('main', 'quick launcher ok')

    // GitHub Release 自动更新（仅打包环境真正启用）
    initUpdateService()
    logInfo('main', 'update service ok')

    app.on('activate', () => {
      if (!win.isDestroyed()) win.show()
    })
  } catch (err) {
    logError('main', `boot failed: ${(err as Error).stack || String(err)}`)
  }
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  pluginHost.destroyAll()
  disposeQuickHotkeys()
  destroyQuickWindow()
  kvStore.close()
})
