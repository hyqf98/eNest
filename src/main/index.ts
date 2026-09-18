/**
 * Main entry — Electron 主进程入口
 * 职责：ready 前按设置决策硬件加速；ready 后创建数据目录、执行迁移、加载设置/KV 库/主题包，
 * 初始化插件协议与插件注册表，创建壳子窗口并注册 IPC 处理器。
 * 被 Electron 运行时直接加载，是整个主进程的启动点。
 * 关键依赖：hardwareAcceleration、pathsService、migrate、sqliteService、themePacks、
 * PluginRegistry、PluginHost、SettingsStore、createShellWindow。
 */
import { app, BaseWindow, globalShortcut } from 'electron'
import { registerSchemesAsPrivileged, initPluginProtocol } from '@main/plugin/pluginProtocol'
import { applyHardwareAccelerationBeforeReady } from '@main/hardwareAcceleration'
import { ensureAppDirs } from '@main/paths/pathsService'
import { migrateToDataRoot } from '@main/paths/migrate'
import { initLogService, logError, logInfo } from '@main/logs/logService'
import { kvStore } from '@main/db/sqliteService'
import { flushAll } from '@main/db/pluginStorage'
import { themePackRegistry } from '@main/theme/themePacks'
import { createShellWindow } from '@main/window/createShellWindow'
import {
  destroyOrbRailViews,
  layoutOrbRailViews
} from '@main/window/orbRailViews'
import { destroyQuickWindow } from '@main/window/createQuickWindow'
import { pluginHost } from '@main/plugin/PluginHost'
import { pluginRegistry } from '@main/plugin/PluginRegistry'
import { settingsStore } from '@main/settings/SettingsStore'
import { applyProxyFromSettings } from '@main/proxy/proxyService'
import { restoreDevPlugins } from '@main/dev/DevConsole'
import { registerShellHandlers } from '@main/ipc/shellHandlers'
import { registerPluginHandlers } from '@main/ipc/pluginHandlers'
import { registerQuickHandlers } from '@main/ipc/quickHandlers'
import { initQuickHotkeys, disposeQuickHotkeys } from '@main/hotkey/quickHotkey'
import { stopAllPluginWatchers } from '@main/plugin/pluginHotReload'
import { scanApplications } from '@main/launcher/appScanner'
import { initUpdateService } from '@main/update/updateService'
import {
  revalidateClipboardPolling,
  stopClipboardHistory
} from '@main/clipboard/clipboardHistory'
import { disposeScreenService } from '@main/screen/screenService'
import { disposePinService } from '@main/pin/pinService'

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
    // 代理需在创建窗口/启动 updater 前应用，确保首批网络请求走代理
    await applyProxyFromSettings()
    logInfo('main', 'proxy ok')
    ensureAppDirs()
    const backend = await kvStore.initDatabase()
    logInfo('main', `kv backend=${backend}`)
    await themePackRegistry.load()
    logInfo('main', 'theme packs ok')
    await pluginRegistry.scan()
    logInfo('main', 'registry ok')
    // 恢复上次加载过的开发态插件（dev.json → 源码目录仍存在则重新挂进 registry）
    await restoreDevPlugins()
    logInfo('main', 'dev plugins restored')
    initPluginProtocol()
    logInfo('main', 'protocol ok')

    const win: BaseWindow = createShellWindow()
    logInfo('main', 'window ok')
    win.on('resize', () => {
      pluginHost.layoutAll()
      layoutOrbRailViews()
    })

    /**
     * 关闭行为（settings.general.closeBehavior）：
     * - minimize-tray（默认）：窗口隐藏、进程保留；全局热键仍可用（后台呼出 mini）
     * - quit：真正退出，before-quit 里 unregisterAll，Alt+Space 不再响应
     * macOS 上关窗不会自动 quit，必须在此显式分支，否则「以为退出了」热键仍在。
     */
    let appQuitting = false
    win.on('close', (e) => {
      if (appQuitting) return
      const behavior = settingsStore.getAll().general?.closeBehavior ?? 'minimize-tray'
      if (behavior === 'minimize-tray') {
        e.preventDefault()
        try {
          win.hide()
        } catch {
          /* already gone */
        }
        logInfo('main', 'close → hide (closeBehavior=minimize-tray)，热键仍可用')
        return
      }
      // quit：放行 close；closed 后 app.quit()
      logInfo('main', 'close → quit (closeBehavior=quit)')
    })
    win.on('closed', () => {
      pluginHost.destroyAll()
      destroyOrbRailViews()
      const behavior = settingsStore.getAll().general?.closeBehavior ?? 'minimize-tray'
      if (behavior === 'quit') {
        appQuitting = true
        app.quit()
      }
    })

    // 圆轨/设置钮视图：不在冷启动/ Splash 阶段显示；
    // 由壳子 splash 结束后 syncOrbState(tabStyle) → applyOrbRailVisibility 懒创建

    registerShellHandlers()
    registerPluginHandlers()
    registerQuickHandlers()
    logInfo('main', 'ipc ok')

    // 快捷启动：注册全局热键 + 后台扫描；小窗懒创建（首次呼出时）
    initQuickHotkeys()
    void scanApplications(false)
    logInfo('main', 'quick launcher ok')

    revalidateClipboardPolling()
    logInfo('main', 'clipboard history ok')

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
  // macOS：窗口全关≠退出；是否退出由 closeBehavior / before-quit 决定
  if (process.platform !== 'darwin') app.quit()
})

// Electron 文档推荐：退出前注销全部全局快捷键
app.on('will-quit', () => {
  try {
    globalShortcut.unregisterAll()
  } catch {
    /* ignore */
  }
})

let quitting = false
app.on('before-quit', (event) => {
  if (quitting) return
  quitting = true
  event.preventDefault()
  disposeQuickHotkeys()
  try {
    globalShortcut.unregisterAll()
  } catch {
    /* ignore */
  }
  stopAllPluginWatchers()
  destroyQuickWindow()
  stopClipboardHistory()
  disposeScreenService()
  disposePinService()
  void pluginHost
    .destroyAll()
    .catch(() => {})
    .finally(() => {
      // 落盘顺序：插件存储与设置防抖写队列先 flush，再关 SQLite 连接
      try {
        flushAll()
        settingsStore.flushNow()
      } catch {
        /* 退出路径尽力而为 */
      }
      kvStore.close()
      app.quit()
    })
})
