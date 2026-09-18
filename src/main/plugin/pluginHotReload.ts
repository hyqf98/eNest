/**
 * pluginHotReload — 插件目录文件变更自动热重载
 * 打开的文件型插件（dev / 已安装 rootPath）监视 rootPath；
 * 变更防抖后失效 enest:// 资产缓存并 reload 插件 View，无需开发者手点「热重载」。
 * 依赖：fs.watch、pluginProtocol.invalidatePluginFileCache；reload 回调由 PluginHost 注入（避免环）。
 */
import { watch, type FSWatcher } from 'node:fs'
import { logInfo, logWarn } from '@main/logs/logService'
import { invalidatePluginFileCache } from './pluginProtocol'

/** 防抖：编辑器连存 / 临时文件合并为一次 reload */
const DEBOUNCE_MS = 200
/** 忽略目录/文件：依赖与 VCS 不触发插件重载 */
const IGNORE_RE =
  /(^|[\\/])(node_modules|\.git|\.svn|\.hg|\.DS_Store|Thumbs\.db)([\\/]|$)|(^|[\\/])\.[^\\/]+$|\.log$/i

type ReloadHandler = (pluginId: string) => void

interface WatchEntry {
  watcher: FSWatcher
  timer: NodeJS.Timeout | null
  rootPath: string
}

const watchers = new Map<string, WatchEntry>()
let reloadHandler: ReloadHandler | null = null

/** PluginHost 注入：如何 reload 某个插件（tabId=pluginId） */
export function setPluginHotReloadHandler(fn: ReloadHandler): void {
  reloadHandler = fn
}

/** 打开插件后开始监视；rootPath 为空（纯 devUrl 且无目录）则跳过 */
export function watchPluginForHotReload(pluginId: string, rootPath: string): void {
  stopWatchingPlugin(pluginId)
  if (!pluginId || !rootPath) return
  try {
    const watcher = watch(rootPath, { recursive: true }, (_event, filename) => {
      const name = typeof filename === 'string' ? filename : String(filename ?? '')
      if (name && IGNORE_RE.test(name)) return
      scheduleReload(pluginId, rootPath)
    })
    watcher.on('error', (err) => {
      logWarn('hot-reload', `watch error ${pluginId}: ${(err as Error).message}`)
      stopWatchingPlugin(pluginId)
    })
    watchers.set(pluginId, { watcher, timer: null, rootPath })
    logInfo('hot-reload', `watching ${pluginId} → ${rootPath}`)
  } catch (err) {
    logWarn('hot-reload', `watch failed ${pluginId}: ${(err as Error).message}`)
  }
}

function scheduleReload(pluginId: string, rootPath: string): void {
  const entry = watchers.get(pluginId)
  if (!entry) return
  if (entry.timer) clearTimeout(entry.timer)
  entry.timer = setTimeout(() => {
    entry.timer = null
    // 资产缓存必须先失效，否则 reload 仍读到旧 Buffer
    try {
      invalidatePluginFileCache(rootPath)
    } catch (err) {
      logWarn('hot-reload', `cache invalidate failed ${pluginId}: ${(err as Error).message}`)
    }
    if (!reloadHandler) return
    try {
      reloadHandler(pluginId)
      logInfo('hot-reload', `auto reload ${pluginId}`)
    } catch (err) {
      logWarn('hot-reload', `auto reload failed ${pluginId}: ${(err as Error).message}`)
    }
  }, DEBOUNCE_MS)
  entry.timer.unref?.()
}

export function stopWatchingPlugin(pluginId: string): void {
  const entry = watchers.get(pluginId)
  if (!entry) return
  if (entry.timer) {
    clearTimeout(entry.timer)
    entry.timer = null
  }
  try {
    entry.watcher.close()
  } catch {
    /* already closed */
  }
  watchers.delete(pluginId)
}

export function stopAllPluginWatchers(): void {
  for (const id of [...watchers.keys()]) stopWatchingPlugin(id)
}
