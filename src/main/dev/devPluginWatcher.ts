/**
 * 非 devUrl 的 dev 插件文件监听：rootPath（源码目录或 dist）变更防抖后自动 reloadPlugin。
 * reloadPlugin 自带缓存失效与 dev 入口重探测，若开发服务此时已上线会自动升级为 devUrl 模式并解除监听。
 * 构建（vite build）会清空重建 dist 目录，watcher 失效时延迟重试重新挂上。
 */
import { watch, type FSWatcher } from 'node:fs'
import { logWarn } from '@main/logs/logService'

const RELOAD_DEBOUNCE_MS = 400
const RETRY_DELAY_MS = 2000
/** 事件过滤：源码目录模式下 node_modules 装依赖不应触发重载 */
const IGNORED_SEGMENTS = new Set(['node_modules', '.git'])

interface WatchState {
  rootPath: string
  stopped: boolean
  watcher: FSWatcher | null
  timer: NodeJS.Timeout | null
  retryTimer: NodeJS.Timeout | null
}

const watchers = new Map<string, WatchState>()

function isIgnored(filename: string): boolean {
  return filename.split(/[\\/]/).some(segment => IGNORED_SEGMENTS.has(segment))
}

function scheduleReload(state: WatchState, pluginId: string): void {
  if (state.timer) clearTimeout(state.timer)
  state.timer = setTimeout(() => {
    state.timer = null
    if (state.stopped) return
    void import('@main/plugin/PluginHost').then(({ pluginHost }) => {
      if (!state.stopped && pluginHost.isOpen(pluginId)) pluginHost.reloadPlugin(pluginId)
    })
  }, RELOAD_DEBOUNCE_MS)
}

function attach(state: WatchState, pluginId: string): void {
  if (state.stopped) return
  try {
    state.watcher = watch(state.rootPath, { recursive: true }, (_event, filename) => {
      if (state.stopped) return
      if (filename && isIgnored(String(filename))) return
      scheduleReload(state, pluginId)
    })
  } catch (error) {
    scheduleRetry(state, pluginId, error)
    return
  }
  state.watcher.on('error', error => {
    try { state.watcher?.close() } catch { /* already closed */ }
    state.watcher = null
    scheduleRetry(state, pluginId, error)
  })
}

function scheduleRetry(state: WatchState, pluginId: string, error: unknown): void {
  if (state.stopped) return
  logWarn('dev', `watch ${pluginId}: ${error instanceof Error ? error.message : String(error)}，${RETRY_DELAY_MS / 1000}s 后重试`)
  if (state.retryTimer) clearTimeout(state.retryTimer)
  state.retryTimer = setTimeout(() => {
    state.retryTimer = null
    attach(state, pluginId)
  }, RETRY_DELAY_MS)
}

export function startDevWatch(pluginId: string, rootPath: string): void {
  stopDevWatch(pluginId)
  const state: WatchState = { rootPath, stopped: false, watcher: null, timer: null, retryTimer: null }
  watchers.set(pluginId, state)
  attach(state, pluginId)
}

export function stopDevWatch(pluginId: string): void {
  const state = watchers.get(pluginId)
  if (!state) return
  state.stopped = true
  if (state.timer) clearTimeout(state.timer)
  if (state.retryTimer) clearTimeout(state.retryTimer)
  try { state.watcher?.close() } catch { /* already closed */ }
  watchers.delete(pluginId)
}
