import { registerNotificationHandlers } from '@main/window/notificationOverlay'
import { registerInstallSurfaceHandlers } from '@main/window/installSurface'
import { registerModalSurfaceHandlers } from '@main/window/modalSurface'
import { disposeNativeClipboard } from '@main/clipboard/nativeClipboard'
/**
 * Main entry — Electron 主进程入口
 * 职责：ready 前按设置决策硬件加速；ready 后创建数据目录、执行迁移、加载设置/KV 库/主题包，
 * 初始化插件协议与插件注册表，创建壳子窗口并注册 IPC 处理器。
 * 被 Electron 运行时直接加载，是整个主进程的启动点。
 * 关键依赖：hardwareAcceleration、pathsService、migrate、sqliteService、themePacks、
 * PluginRegistry、PluginHost、SettingsStore、createShellWindow。
 */
import { app, BaseWindow, globalShortcut, Notification } from 'electron'
import { APP_NAME } from '@shared/constants'
if (process.env.ENEST_TEST_USER_DATA) app.setPath('userData', process.env.ENEST_TEST_USER_DATA)
// macOS Dock 的名称来自开发 bundle 的 Info.plist；Electron API/菜单另行统一。
// 保留已有 Chromium 配置目录，避免品牌名称大小写变更造成会话迁移。
const existingUserData = app.getPath('userData')
app.setName(APP_NAME)
app.setPath('userData', existingUserData)

import { registerSchemesAsPrivileged, initPluginProtocol } from '@main/plugin/pluginProtocol'
import { applyHardwareAccelerationBeforeReady } from '@main/hardwareAcceleration'
import { ensureAppDirs } from '@main/paths/pathsService'
import { migrateToDataRoot } from '@main/paths/migrate'
import { initLogService, logError, logInfo, logWarn } from '@main/logs/logService'
import { kvStore } from '@main/db/sqliteService'
import { flushAll } from '@main/db/pluginStorage'
import { themePackRegistry } from '@main/theme/themePacks'
import { createShellWindow, setPanelAppearanceSink, getMainWindow, getShellWebContents } from '@main/window/createShellWindow'
import { flushMainWindowState } from '@main/window/mainWindowState'
import {
  destroyOrbRailViews,
  layoutOrbRailViews
} from '@main/window/orbRailViews'
import { destroyQuickWindow } from '@main/window/createQuickWindow'
import { showMainWindowOnActivate } from '@main/window/mainWindowActivation'
import { pluginHost } from '@main/plugin/PluginHost'
import { startPluginMemoryMonitor, stopPluginMemoryMonitor } from '@main/plugin/pluginMemoryMonitor'
import { broadcastNotice } from '@main/plugin/shellNotices'
import { refreshProfileOnBoot } from '@main/auth/githubAuthService'
import { pluginRegistry } from '@main/plugin/PluginRegistry'
import { appearanceService } from '@main/theme/appearanceService'
import { settingsStore } from '@main/settings/SettingsStore'
import { applyProxyFromSettings } from '@main/proxy/proxyService'
import { restoreDevPlugins } from '@main/dev/DevConsole'
import { stopAllDevServers } from '@main/dev/devServerManager'
import { registerShellHandlers } from '@main/ipc/shellHandlers'
import { registerPluginHandlers } from '@main/ipc/pluginHandlers'
import { registerQuickHandlers } from '@main/ipc/quickHandlers'
import { registerPluginWindowHandlers } from '@main/ipc/pluginWindowHandlers'
import { cancelPluginWindowDrag } from '@main/window/pluginWindowDrag'
import { destroyAllDetachedWindows } from '@main/window/detachedPluginWindows'
import { initQuickHotkeys, disposeQuickHotkeys } from '@main/hotkey/quickHotkey'
import {
  initPluginLaunchHotkeys,
  releaseAllPluginLaunchHotkeys
} from '@main/hotkey/pluginLaunchHotkeys'
import { scanApplications } from '@main/launcher/appScanner'
import { initUpdateService } from '@main/update/updateService'
import { associationService } from '@main/openWith/associationService'
import {
  flushPendingOpenWith, handleOpenFile, handleOpenUrl, handleOpenWithArgv, setOpenWithReadyProbe
} from '@main/openWith/openWithRouter'
import { startPluginBackgrounds, disposePluginBackgrounds } from '@main/plugin/pluginBackgroundRuntime'
import { stopClipboardChanges } from '@main/clipboard/clipboardNativeEvents'
import { disposePluginInstallWorkers } from '@main/plugin/pluginInstallTasks'
import { registerAuxiliaryHandlers, disposeAuxiliaryWindows } from '@main/window/pluginAuxiliaryWindows'
import { disposeFileStreams } from '@main/plugin/pluginFileStreams'
import {
  destroyHomeSurface,
  homeSurfaceManager,
  layoutHomeSurface,
  prewarmHomeSurface
} from '@main/home/HomeSurfaceManager'
import { registerHomeIpc } from '@main/home/homeIpc'
import { initDeadlineTasks, shutdownDeadlineTasks, shutdownDeadlineTasksSync } from '@main/timer/deadlineTaskService'
import { permissionService } from '@main/plugin/PermissionService'
import { registerThemeSettingsHandlers } from '@main/theme/themeSettingsSurface'
import { registerPanelHandlers } from '@main/ipc/panelHandlers'
import { registerMcpHandlers } from '@main/ipc/mcpHandlers'
import { mcpService } from '@main/mcp/mcpService'
import { registerRegionSurfaceHandlers } from '@main/panel/regionSelection'
import {
  applyAppearanceToPanels,
  disposePanels,
  preparePanelShutdown,
  refreshPanelThemes,
  registerPanelWindowHost,
  restorePanels,
  syncFreePanelSetting
} from '@main/panel/PanelManager'
import { isFreePanelEnabled } from '@main/panel/panelStore'
import { applyPanelHotkeys, disposePanelHotkeys } from '@main/hotkey/panelHotkey'

registerSchemesAsPrivileged()

// 硬件加速必须在 app ready 之前根据 settings.json 决策
applyHardwareAccelerationBeforeReady()

// win32：AppUserModelId 决定通知归属（未设置时通知可能显示为 Electron 默认名/被折叠）
if (process.platform === 'win32') {
  app.setAppUserModelId('com.github.eNest.shell')
}

// linux：Wayland 下屏幕捕获需 PipeWire 授权通道（app ready 前追加才生效）
if (process.platform === 'linux') {
  app.commandLine.appendSwitch('enable-features', 'WebRTCPipeWireCapturer')
}

// 自动化：ENEST_REMOTE_DEBUG=9331 时开启 CDP
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
  mcpService.prepareShutdown()
  if (!shuttingDown) {
    shuttingDown = true
    flushMainWindowState(true)
    logInfo('main', `shutdown begin (${reason})`)
  }
  stopPluginMemoryMonitor()
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
    preparePanelShutdown()
    shutdownDeadlineTasksSync()
    pluginHost.prepareSessionShutdown()
    flushAll()
    settingsStore.flushNow()
  } catch {
    /* 尽力落盘 */
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

// 未捕获异常：必须落盘+stderr，否则热键路径硬崩时「整包退出且无日志」
process.on('uncaughtException', (err) => {
  const stack = (err as Error)?.stack || String(err)
  try {
    logError('main', `uncaughtException: ${stack}`)
  } catch {
    console.error('[main] uncaughtException (log failed):', stack)
  }
  console.error('[main] uncaughtException:', stack)
  try {
    settingsStore.flushNow()
  } catch {
    /* ignore */
  }
})
process.on('unhandledRejection', (reason) => {
  const msg = reason instanceof Error ? (reason.stack || reason.message) : String(reason)
  try {
    logError('main', `unhandledRejection: ${msg}`)
  } catch {
    console.error('[main] unhandledRejection (log failed):', msg)
  }
  console.error('[main] unhandledRejection:', msg)
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

// —— 外部打开（双击文件 / 点击链接）——
// macOS 的 open-file/open-url 可能在 ready 前到达，必须提前注册；router 内部入队等窗口就绪。
app.on('open-file', (event, path) => {
  event.preventDefault()
  handleOpenFile(path)
})
app.on('open-url', (event, url) => {
  event.preventDefault()
  handleOpenUrl(url)
})
// Windows/Linux：第二实例把 argv（文件路径/URL）交给已运行实例
app.on('second-instance', (_event, argv) => {
  handleOpenWithArgv(argv)
  const win = getMainWindow()
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  }
})

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
    appearanceService.invalidate()
    logInfo('main', 'theme packs ok')
    await pluginRegistry.scan()
    logInfo('main', 'registry ok')
    // 恢复上次加载过的开发态插件（dev.json → 源码目录仍存在则重新挂进 registry）
    await restoreDevPlugins()
    logInfo('main', 'dev plugins restored')
    try {
      await initDeadlineTasks((event) => {
        if (event.type === 'change') {
          pluginHost.sendEvent(event.pluginId, { type: 'deadline-task-change', taskId: event.taskId })
        } else {
          const manifest = pluginRegistry.getManifest(event.pluginId)
          if (!pluginRegistry.isEnabled(event.pluginId) || !manifest?.permissions?.includes('notify')
            || settingsStore.getPermissionGrant(event.pluginId, 'notify') !== 'allow' && !permissionService.isGranted(event.pluginId, 'notify')) return
          new Notification({ title: event.title, body: event.body })
            .on('failed', (_event, reason) => logWarn('timer', `notification failed: ${reason}`))
            .show()
        }
      }, id => pluginRegistry.isEnabled(id))
    } catch (error) { logWarn('timer', `initialization failed: ${String(error)}`) }
    initPluginProtocol()
    logInfo('main', 'protocol ok')

    const win: BaseWindow = createShellWindow()
    logInfo('main', 'window ok')

    // 外部打开：等壳渲染层首屏完成再放行排队请求（避免 open-with-choice 事件丢在挂载前）
    const armOpenWith = () => {
      setOpenWithReadyProbe(() => {
        const wc = getShellWebContents()
        return !!wc && !wc.isDestroyed() && !wc.isLoading()
      })
      flushPendingOpenWith()
    }
    const shellWc = getShellWebContents()
    if (shellWc) {
      if (shellWc.isLoading()) shellWc.once('did-finish-load', armOpenWith)
      else armOpenWith()
    }
    // 冷启动 argv（Windows/Linux 双击文件）：窗口创建后再解析，命中插件走 shell 模式
    handleOpenWithArgv(process.argv)
    // 用户此前选择过的 scheme 幂等同步系统注册（未选择的 scheme 不碰）
    void associationService.syncRoutedSchemes().catch((err) => {
      logWarn('open-with', `sync schemes failed: ${String(err)}`)
    })

    const syncShellVisibility = () => pluginHost.setShellVisible(win.isVisible() && !win.isMinimized())
    win.on('hide', syncShellVisibility)
    win.on('minimize', syncShellVisibility)
    win.on('show', syncShellVisibility)
    win.on('restore', syncShellVisibility)
    const syncHomeVisibility = () => {
      const visible = win.isVisible() && !win.isMinimized()
      homeSurfaceManager.setWindowVisible(visible)
    }
    win.on('hide', syncHomeVisibility)
    win.on('minimize', syncHomeVisibility)
    win.on('show', syncHomeVisibility)
    win.on('restore', syncHomeVisibility)
    win.on('resize', () => {
      pluginHost.layoutAll()
      layoutHomeSurface()
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
      e.preventDefault()
      app.quit()
    })
    win.on('closed', () => {
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

    registerInstallSurfaceHandlers()
    registerNotificationHandlers()
    registerModalSurfaceHandlers()
    registerShellHandlers()
    registerPluginHandlers()
    registerMcpHandlers()
    registerQuickHandlers()
    registerPluginWindowHandlers()
    registerAuxiliaryHandlers()
    registerThemeSettingsHandlers()
    registerHomeIpc(homeSurfaceManager)
    registerPanelHandlers()
    registerRegionSurfaceHandlers()
    registerPanelWindowHost()
    // 主题/外观变化 → 面板 chrome 重读 token 与材质（独立文档不随主壳 data-* 联动）。
    setPanelAppearanceSink(() => {
      refreshPanelThemes()
      applyAppearanceToPanels()
    })
    logInfo('main', 'ipc ok')
    void mcpService.initialize().catch(error => logWarn('mcp', `initialization failed: ${String(error)}`))
    startPluginMemoryMonitor()
    void prewarmHomeSurface().catch(error => logWarn('home', `startup prepare failed: ${String(error)}`))

    // 快捷启动：注册全局热键 + 后台扫描；小窗懒创建（首次呼出时）
    // 不要在这里 ensureQuickWindow()：透明小窗按需创建，避免启动阶段并发初始化原生窗口。
    initQuickHotkeys()
    // 用户插件绑定（settings.pluginShortcuts；不随插件关闭或休眠释放）
    initPluginLaunchHotkeys()
    void scanApplications(false)
    logInfo('main', 'quick launcher ok')

    startPluginBackgrounds()
    logInfo('main', 'plugin backgrounds ready (lazy)')

    // 自由面板：功能开启时先建窗口（只画占位条），再按并发上限逐个冷启动组件插件。
    if (isFreePanelEnabled()) {
      void restorePanels().catch(error => logWarn('panel', `restore failed: ${String(error)}`))
    }
    // 面板快捷键（功能关闭时内部自行不注册）。
    applyPanelHotkeys()

    initUpdateService()
    logInfo('main', 'update service ok')

    // 有保存的 GitHub token 则静默刷新资料（401 自动登出）；失败不影响启动
    void refreshProfileOnBoot().catch(() => { /* best effort */ })

    app.on('activate', () => {
      if (shuttingDown || quitting) return
      showMainWindowOnActivate(win)
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

// Electron 文档推荐：退出前注销全部全局快捷键；同时回收壳子拉起的插件 dev server
app.on('will-quit', () => {
  releaseAllGlobalShortcutsSync()
  stopAllDevServers()
})

let quitting = false
app.on('before-quit', (event) => {
  beginShutdown('before-quit')
  if (quitting) return
  quitting = true
  event.preventDefault()
  pluginHost.prepareSessionShutdown()
  preparePanelShutdown()
  cancelPluginWindowDrag()
  // Plugins receive the same bounded lifecycle grace; no business-specific shutdown services run in main.
  const forceTimer = setTimeout(() => {
    logWarn('main', 'before-quit cleanup timeout → force exit')
    try { shutdownDeadlineTasksSync() } catch { /* forced exit: best effort */ }
    releaseAllGlobalShortcutsSync()
    app.exit(0)
  }, 12_000)
  forceTimer.unref?.()

  disposeQuickHotkeys()
  disposePanelHotkeys()
  // 每插件启动热键显式簿记释放（releaseAllGlobalShortcutsSync 兜底仍生效）
  releaseAllPluginLaunchHotkeys()
  releaseAllGlobalShortcutsSync()
  disposePluginBackgrounds()
  stopClipboardChanges()
  disposeNativeClipboard()
  // 壳统一通知：应用即将退出（插件随后收到 beforeClose(app-quit)）
  broadcastNotice('app.before-quit', { reason: 'quit' })
  destroyHomeSurface()
  // 先 destroyAll 再销毁 Quick 小窗：Quick 内嵌插件的 webContents 仍存活，
  // 能真正收到 beforeClose 并 flush；若先毁小窗，向已销毁目标只能空等 ack
  void Promise.allSettled([pluginHost.destroyAll(), disposePluginInstallWorkers(), mcpService.shutdown(), shutdownDeadlineTasks().catch(error => logWarn('timer', `shutdown save failed: ${String(error)}`))])
    .catch((error) => logWarn('main', `shutdown cleanup failed: ${String(error)}`))
    .then(() => {
      disposeAuxiliaryWindows()
      return disposeFileStreams()
    })
    .then(() => {
      destroyQuickWindow()
      destroyAllDetachedWindows()
      // 面板内插件已由 pluginHost.destroyAll 释放，这里只销毁面板窗口本身。
      disposePanels()
    })
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
