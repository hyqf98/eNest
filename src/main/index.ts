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
import { initLogService, logError, logInfo, logWarn } from '@main/logs/logService'
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

/** 同步注销全部全局快捷键（信号退出 / 进程 exit 必调，避免 npm run dev 退出后 Alt+Space 仍生效） */
function releaseAllGlobalShortcutsSync(): void {
  try {
    globalShortcut.unregisterAll()
  } catch {
    /* 进程已在退出中 */
  }
}

/**
 * 退出中标记：一旦置位，窗口 close 不得再走「最小化到后台」分支。
 * Ctrl+C / SIGTERM 时 electron-vite 会尝试关窗，若被 minimize-tray 拦截
 * 会 hide 窗口并把进程留在后台，热键继续生效——这就是「控制台退出没退干净」。
 */
let shuttingDown = false

function beginShutdown(reason: string): void {
  if (!shuttingDown) {
    shuttingDown = true
    logInfo('main', `shutdown begin (${reason})`)
  }
  // 无论是否重复触发，都立刻释放热键
  releaseAllGlobalShortcutsSync()
}

/**
 * 终端 Ctrl+C / kill（electron-vite dev）：
 * 1) 置 shuttingDown，禁止 close→hide
 * 2) 同步注销热键
 * 3) app.exit 立即退出（不走 before-quit 异步清理，避免被 hide/挂起）
 */
function handleFatalSignal(sig: NodeJS.Signals | string): void {
  beginShutdown(String(sig))
  try {
    disposeQuickHotkeys()
  } catch {
    /* ignore */
  }
  try {
    flushAll()
    settingsStore.flushNow()
  } catch {
    /* 尽力落盘 */
  }
  try {
    stopAllPluginWatchers()
  } catch {
    /* ignore */
  }
  try {
    destroyQuickWindow()
  } catch {
    /* ignore */
  }
  logInfo('main', `${sig} → shortcuts released, app.exit(0)`)
  app.exit(0)
}

process.once('SIGINT', () => handleFatalSignal('SIGINT'))
process.once('SIGTERM', () => handleFatalSignal('SIGTERM'))
process.once('SIGHUP', () => handleFatalSignal('SIGHUP'))
process.once('exit', () => {
  releaseAllGlobalShortcutsSync()
})

/** 开发态：父进程（electron-vite）死亡时子 Electron 必须退出，防止孤儿进程占着热键 */
function watchDevParentProcess(): void {
  if (app.isPackaged) return
  const ppid = process.ppid
  if (!ppid || ppid <= 1) return
  const timer = setInterval(() => {
    try {
      process.kill(ppid, 0)
    } catch {
      clearInterval(timer)
      handleFatalSignal(`parent-exit:ppid=${ppid}`)
    }
  }, 800)
  timer.unref?.()
}

// 单实例：避免多次 npm run dev / 重复启动叠热键与窗口
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  logInfo('main', 'another instance holds the lock → quit')
  beginShutdown('second-instance')
  app.quit()
}

void app.whenReady().then(async () => {
  if (!gotLock) return
  try {
    ensureAppDirs()
    // 日志服务在数据目录就绪后立刻初始化，后续 boot / install 全部落盘
    initLogService()
    logInfo('main', 'ready')
    watchDevParentProcess()
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
     * - minimize-tray（默认）：仅「用户点关闭」时隐藏窗口，进程保留、热键可用
     * - quit / 退出中（Ctrl+C、SIGTERM、before-quit）：放行 close 并真正退出
     */
    let appQuitting = false
    win.on('close', (e) => {
      // 退出路径（控制台 Ctrl+C / 信号 / quit）绝不允许 hide 拦截
      if (shuttingDown || appQuitting || quitting) {
        logInfo('main', 'close → allow (shutting down)')
        return
      }
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
      logInfo('main', 'close → quit (closeBehavior=quit)')
    })
    win.on('closed', () => {
      pluginHost.destroyAll()
      destroyOrbRailViews()
      if (shuttingDown || quitting) return
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
      if (shuttingDown || quitting) return
      if (!win.isDestroyed()) win.show()
    })
  } catch (err) {
    logError('main', `boot failed: ${(err as Error).stack || String(err)}`)
  }
})

app.on('window-all-closed', () => {
  if (shuttingDown || quitting) {
    app.quit()
    return
  }
  // macOS：窗口全关≠退出；是否退出由 closeBehavior / before-quit 决定
  if (process.platform !== 'darwin') app.quit()
})

// Electron 文档推荐：退出前注销全部全局快捷键
app.on('will-quit', () => {
  releaseAllGlobalShortcutsSync()
})

let quitting = false
app.on('before-quit', (event) => {
  beginShutdown('before-quit')
  if (quitting) return
  quitting = true
  event.preventDefault()
  // 异步清理最长 2s，超时强制退出并注销热键
  const forceTimer = setTimeout(() => {
    logWarn('main', 'before-quit cleanup timeout → force exit')
    releaseAllGlobalShortcutsSync()
    app.exit(0)
  }, 2000)
  forceTimer.unref?.()

  disposeQuickHotkeys()
  releaseAllGlobalShortcutsSync()
  stopAllPluginWatchers()
  destroyQuickWindow()
  stopClipboardHistory()
  disposeScreenService()
  disposePinService()
  void pluginHost
    .destroyAll()
    .catch(() => {})
    .finally(() => {
      clearTimeout(forceTimer)
      try {
        flushAll()
        settingsStore.flushNow()
      } catch {
        /* 退出路径尽力而为 */
      }
      try {
        kvStore.close()
      } catch {
        /* ignore */
      }
      releaseAllGlobalShortcutsSync()
      app.quit()
    })
})
