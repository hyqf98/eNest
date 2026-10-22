/** Registration owns source watching; ordinary Tab watches are only a runtime fallback. */
import { watch, type FSWatcher } from 'node:fs'
import { relative, resolve } from 'node:path'
import { logWarn } from '@main/logs/logService'

const RELOAD_DEBOUNCE_MS = 400
const RETRY_DELAY_MS = 2000
const MAX_WATCH_RETRIES = 5
const IGNORED_SEGMENTS = new Set(['node_modules', '.git', 'dist', 'out', 'build', 'coverage', '.vite', '.cache', '.turbo', '.next'])

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
  if (!state.outputPath) return false
  const path = resolve(state.rootPath, filename)
  return path === state.outputPath || path.startsWith(`${state.outputPath}/`)
}

/** Re-register in place: removing first would retire the active theme and select a fallback. */
async function refreshRegistration(state: WatchState, pluginId: string, manifestChanged: boolean): Promise<void> {
  const { pluginRegistry } = await import('@main/plugin/PluginRegistry')
  if (!isCurrent(state, pluginId)) return
  const previous = pluginRegistry.get(pluginId)
  if (!previous?.dev || previous.devMode === 'prod' || previous.sourcePath !== state.rootPath) return
  const { prepareDevPluginReload } = await import('@main/dev/DevConsole')
  if (!isCurrent(state, pluginId)) return
  const prepared = await prepareDevPluginReload(previous, () => isCurrent(state, pluginId))
  if (!isCurrent(state, pluginId) || !prepared || prepared.summary.devMode === 'prod') return
  // A forget/re-registration may happen while resolving the entry or starting its server.
  if (!pluginRegistry.get(pluginId)?.dev) return
  pluginRegistry.addDevPlugin(prepared.summary, prepared.manifest)
  state.outputPath = prepared.outputPath
  await pluginRegistry.waitForThemeContributions(pluginId)
  if (!isCurrent(state, pluginId)) return
  const { appearanceService } = await import('@main/theme/appearanceService')
  if (!isCurrent(state, pluginId)) return
  appearanceService.invalidate()
  const { homeSurfaceManager } = await import('@main/home/HomeSurfaceManager')
  if (!isCurrent(state, pluginId)) return
  await homeSurfaceManager.reloadDevSource(pluginId)
  if (!isCurrent(state, pluginId)) return
  const { pluginHost } = await import('@main/plugin/PluginHost')
  if (!isCurrent(state, pluginId)) return
  // Vite owns ordinary UI edits. Manifest/static-entry changes still require a native reload.
  if (pluginHost.isOpen(pluginId) && (!prepared.summary.devUrl || manifestChanged
    || previous.devUrl !== prepared.summary.devUrl || previous.rootPath !== prepared.summary.rootPath)) {
    pluginHost.reloadPlugin(pluginId)
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

/** Survives Tab close/hibernate. Only forgetting or selecting prod releases this owner. */
export function startDevRegistrationWatch(pluginId: string, sourcePath: string, outputPath?: string): void {
  stopDevWatch(pluginId)
  // Never ignore the watched root itself, even if a malformed output setting resolves to it.
  const output = outputPath && relative(sourcePath, outputPath)
  startWatcher(pluginId, sourcePath, 'registration', output && !output.startsWith('..') ? outputPath : undefined)
}

export function stopDevRegistrationWatch(pluginId: string): void {
  stopWatcher(registrationWatchers, pluginId)
}
