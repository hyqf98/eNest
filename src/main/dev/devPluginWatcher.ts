/** Registration owns source watching; ordinary Tab watches are only a runtime fallback. */
import { watch, type FSWatcher } from 'node:fs'
import { relative, resolve } from 'node:path'
import { logWarn } from '@main/logs/logService'

const RELOAD_DEBOUNCE_MS = 400
const RETRY_DELAY_MS = 2000
const MAX_WATCH_RETRIES = 5
const IGNORED_SEGMENTS = new Set(['node_modules', '.git', 'dist', 'out', 'build', 'coverage', '.vite', '.cache', '.turbo', '.next'])
/** 插件子构建产物落在 public 下（如 auxiliary 受限资产），是 dev server 启动的副产物而非源码编辑。 */
const IGNORED_PREFIXES = ['public/assets/vendor/']

type WatchOwner = 'runtime' | 'registration'
interface WatchState {
  rootPath: string
  outputPath?: string
  owner: WatchOwner
  stopped: boolean
  watcher: FSWatcher | null
  timer: NodeJS.Timeout | null
  retryTimer: NodeJS.Timeout | null
  retries: number
  running: boolean
  pending: boolean
  manifestChanged: boolean
}

const watchers = new Map<string, WatchState>()
const registrationWatchers = new Map<string, WatchState>()

function isCurrent(state: WatchState, pluginId: string): boolean {
  const owners = state.owner === 'registration' ? registrationWatchers : watchers
  return !state.stopped && owners.get(pluginId) === state
}

function isIgnored(state: WatchState, filename: string): boolean {
  if (filename.split(/[\\/]/).some(segment => IGNORED_SEGMENTS.has(segment))) return true
  if (IGNORED_PREFIXES.some(prefix => filename.replaceAll('\\', '/').startsWith(prefix))) return true
  if (!state.outputPath) return false
  const path = resolve(state.rootPath, filename)
  return path === state.outputPath || path.startsWith(`${state.outputPath}/`)
}

/** Re-register in place: removing first would retire the active theme and select a fallback. */
async function refreshRegistration(state: WatchState, pluginId: string, manifestChanged: boolean): Promise<void> {
  const { pluginRegistry } = await import('@main/plugin/PluginRegistry')
  if (!isCurrent(state, pluginId)) return
  const previous = pluginRegistry.get(pluginId)
  if (!previous?.dev || previous.sourcePath !== state.rootPath) return
  const { prepareDevPluginReload } = await import('@main/dev/DevConsole')
  const { pluginHost } = await import('@main/plugin/PluginHost')
  if (!isCurrent(state, pluginId)) return
  const transition = pluginHost.getPluginTransitionTask(pluginId)
  if (transition) {
    // An opening may already have selected an origin before its View exists.
    // Settle it before deciding whether this source is dormant or running.
    await transition.catch(() => undefined)
    if (isCurrent(state, pluginId)) {
      state.pending = true
      state.manifestChanged ||= manifestChanged
    }
    return
  }
  // 隐藏激活（resident/command/index-sync）没有 transition task；re-register 会推进
  // buildRevision 使激活 guard 失效（dev server 冷启动写产物即可自触发）。先等激活结算。
  const { awaitPluginActivation } = await import('@main/launcher/pluginActivation')
  await awaitPluginActivation(pluginId)
  if (!isCurrent(state, pluginId)) return
  const runtime = pluginHost.getPluginView(pluginId)
  const sameRuntime = () => isCurrent(state, pluginId) && !pluginHost.getPluginTransitionTask(pluginId)
    && pluginHost.getPluginView(pluginId) === runtime
  let completed = false
  try {
    const prepared = await prepareDevPluginReload(previous, sameRuntime, runtime === null, false)
    if (!sameRuntime() || !prepared?.isCurrent()) return
    const current = () => sameRuntime() && prepared.isCurrent()
    // A forget/re-registration or instance transition may happen during local inspection.
    if (!pluginRegistry.get(pluginId)?.dev) return
    pluginRegistry.addDevPlugin(prepared.summary, prepared.manifest)
    state.outputPath = prepared.outputPath
    await pluginRegistry.waitForThemeContributions(pluginId)
    if (!current()) return
    const { appearanceService } = await import('@main/theme/appearanceService')
    if (!current()) return
    appearanceService.invalidate()
    const { homeSurfaceManager } = await import('@main/home/HomeSurfaceManager')
    if (!current()) return
    await homeSurfaceManager.reloadDevSource(pluginId)
    if (!current()) return
    completed = true
    // Vite owns ordinary UI edits. Manifest/static-entry changes still require a native reload.
    if (runtime && (!prepared.summary.devUrl || manifestChanged
      || previous.devUrl !== prepared.summary.devUrl || previous.rootPath !== prepared.summary.rootPath)) {
      pluginHost.reloadPlugin(pluginId)
    }
  } finally {
    // Reclassify a save that raced an open/close; never start a now-dormant source or
    // publish dormant transport fields onto an instance that just finished opening.
    if (!completed && isCurrent(state, pluginId) && !sameRuntime()) {
      state.pending = true
      state.manifestChanged ||= manifestChanged
    }
  }
}

async function drainReloads(state: WatchState, pluginId: string): Promise<void> {
  if (state.running || !isCurrent(state, pluginId)) return
  state.running = true
  try {
    // Events arriving during an await coalesce into one follow-up, never concurrent refreshes.
    while (state.pending && isCurrent(state, pluginId) && !state.timer) {
      state.pending = false
      const manifestChanged = state.manifestChanged
      state.manifestChanged = false
      try {
        if (state.owner === 'registration') {
          await refreshRegistration(state, pluginId, manifestChanged)
        } else {
          const { pluginHost } = await import('@main/plugin/PluginHost')
          if (isCurrent(state, pluginId) && !registrationWatchers.has(pluginId) && pluginHost.isOpen(pluginId)) {
            pluginHost.reloadPlugin(pluginId)
          }
        }
      } catch (error) {
        if (isCurrent(state, pluginId)) logWarn('dev', `reload ${pluginId}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  } finally {
    state.running = false
  }
}

function scheduleReload(state: WatchState, pluginId: string, filename?: string): void {
  if (!isCurrent(state, pluginId) || state.owner === 'runtime' && registrationWatchers.has(pluginId)) return
  state.pending = true
  state.manifestChanged ||= !filename || /(^|[\\/])plugin\.json$/.test(filename)
  if (state.timer) clearTimeout(state.timer)
  state.timer = setTimeout(() => {
    state.timer = null
    void drainReloads(state, pluginId)
  }, RELOAD_DEBOUNCE_MS)
}

function attach(state: WatchState, pluginId: string): void {
  if (!isCurrent(state, pluginId)) return
  let watcher: FSWatcher
  try {
    watcher = watch(state.rootPath, { recursive: true }, (_event, filename) => {
      if (!isCurrent(state, pluginId)) return
      const path = filename ? String(filename) : undefined
      if (path && isIgnored(state, path)) return
      scheduleReload(state, pluginId, path)
    })
    state.watcher = watcher
  } catch (error) {
    scheduleRetry(state, pluginId, error)
    return
  }
  watcher.on('error', error => {
    if (!isCurrent(state, pluginId) || state.watcher !== watcher) return
    state.watcher = null
    try { watcher.close() } catch { /* already closed */ }
    scheduleRetry(state, pluginId, error)
  })
}

function scheduleRetry(state: WatchState, pluginId: string, error: unknown): void {
  if (!isCurrent(state, pluginId) || state.retryTimer) return
  const detail = error instanceof Error ? error.message : String(error)
  if (state.retries >= MAX_WATCH_RETRIES) {
    logWarn('dev', `watch ${pluginId}: ${detail}，重试次数已达上限，请重新加载源码目录`)
    return
  }
  state.retries++
  logWarn('dev', `watch ${pluginId}: ${detail}，${RETRY_DELAY_MS / 1000}s 后重试 (${state.retries}/${MAX_WATCH_RETRIES})`)
  state.retryTimer = setTimeout(() => {
    state.retryTimer = null
    attach(state, pluginId)
  }, RETRY_DELAY_MS)
}

function stopWatcher(owners: Map<string, WatchState>, pluginId: string): void {
  const state = owners.get(pluginId)
  if (!state) return
  state.stopped = true
  if (state.timer) clearTimeout(state.timer)
  if (state.retryTimer) clearTimeout(state.retryTimer)
  try { state.watcher?.close() } catch { /* already closed */ }
  owners.delete(pluginId)
}

function startWatcher(pluginId: string, rootPath: string, owner: WatchOwner, outputPath?: string): void {
  const owners = owner === 'registration' ? registrationWatchers : watchers
  stopWatcher(owners, pluginId)
  const state: WatchState = {
    rootPath, outputPath, owner, stopped: false, watcher: null, timer: null, retryTimer: null,
    retries: 0, running: false, pending: false, manifestChanged: false
  }
  owners.set(pluginId, state)
  attach(state, pluginId)
}

export function startDevWatch(pluginId: string, rootPath: string): void {
  stopDevWatch(pluginId)
  if (!registrationWatchers.has(pluginId)) startWatcher(pluginId, rootPath, 'runtime')
}

export function stopDevWatch(pluginId: string): void {
  stopWatcher(watchers, pluginId)
}

/** Survives Tab close/hibernate. Only forgetting the development registration releases this owner. */
export function startDevRegistrationWatch(pluginId: string, sourcePath: string, outputPath?: string): void {
  stopDevWatch(pluginId)
  // Never ignore the watched root itself, even if a malformed output setting resolves to it.
  const output = outputPath && relative(sourcePath, outputPath)
  startWatcher(pluginId, sourcePath, 'registration', output && !output.startsWith('..') ? outputPath : undefined)
}

export function stopDevRegistrationWatch(pluginId: string): void {
  stopWatcher(registrationWatchers, pluginId)
}
