/** Source registration is independent of installation. The shell starts dev servers and owns fallback watchers. */
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { dialog } from 'electron'
import { trackNativeInteraction } from '@main/plugin/pluginInteractionPolicy'
import { resolveLocalUserPath } from '@main/paths/userPath'
import { pluginRegistry } from '@main/plugin/PluginRegistry'
import type { DevPluginLoadOptions, PluginSummary } from '@shared/types/plugin'
import { resolvePluginUi } from '@shared/types/plugin'
import { pluginCategoryColor } from '@shared/constants'
import { logInfo, logWarn } from '@main/logs/logService'
import { dropDevPluginRecord, readDevPluginRecords, upsertDevPluginRecord } from './devPluginsStore'
import { devRegistrationEntry, inspectDevPluginEntry, type ResolvedDevEntry } from './devPluginEntry'
import { forgetDevServer } from './devServerManager'
import { cancelDevPluginPreparation, forgetDevPluginSource, getDevPluginSource, isDevPluginSourceCurrent,
  prepareRegisteredDevPlugin, registerDevPluginSource } from './devPluginRuntime'
import { sendShellEvent } from '@main/window/createShellWindow'
import { startDevRegistrationWatch, stopDevRegistrationWatch, stopDevWatch } from './devPluginWatcher'

/** 自动拉起开发服务是默认开发体验；显式 url 覆盖时不影响其语义。 */
const DEFAULT_DEV_OPTIONS: DevPluginLoadOptions = { autoStartServer: true }
let changeRevision = 0
const devChanges = new Map<string, number>()
const devOperations = new Map<string, Promise<unknown>>()

/** Serialize replacement and removal so an old teardown cannot remove a new registration. */
async function withDevOperation<T>(id: string, action: () => Promise<T>): Promise<T> {
  const operation = (devOperations.get(id) ?? Promise.resolve()).then(action, action)
  devOperations.set(id, operation)
  try { return await operation }
  finally { if (devOperations.get(id) === operation) devOperations.delete(id) }
}

/** Retire the previous in-flight sequence and release both watchers for this id. */
function beginDevChange(id: string, revision = ++changeRevision): () => boolean {
  devChanges.set(id, revision)
  cancelDevPluginPreparation(id)
  stopDevRegistrationWatch(id)
  stopDevWatch(id)
  return () => devChanges.get(id) === revision
}

function watchRegistration(summary: PluginSummary, outputPath: string): void {
  if (summary.sourcePath) startDevRegistrationWatch(summary.id, summary.sourcePath, outputPath)
  else stopDevRegistrationWatch(summary.id)
}

async function publishDevSource(id: string, isCurrent: () => boolean): Promise<void> {
  await pluginRegistry.waitForThemeContributions(id)
  if (!isCurrent()) return
  const { appearanceService } = await import('@main/theme/appearanceService')
  if (!isCurrent()) return
  appearanceService.invalidate()
  const { homeSurfaceManager } = await import('@main/home/HomeSurfaceManager')
  if (!isCurrent()) return
  await homeSurfaceManager.reloadDevSource(id)
}

function describeDevPlugin(sourcePath: string, entry: ResolvedDevEntry) {
  const { rootPath, manifest, devUrl, devSource, devKind, plan } = entry
  const category = manifest.category ?? '开发'
  const summary: PluginSummary = {
    id: manifest.id, name: manifest.name, version: manifest.version,
    description: manifest.description ?? '', author: manifest.author ?? '', category,
    installs: 'dev', color: pluginCategoryColor(category), glyph: manifest.name.slice(0, 1),
    permissions: manifest.permissions ?? [], installed: true,
    rootPath, sourcePath, devUrl, devSource, dev: true,
    devKind, devCommand: devUrl ? plan.start?.label : undefined,
    ui: resolvePluginUi(manifest.ui)
  }
  return { summary, manifest, outputPath: resolve(sourcePath, plan.output) }
}

/** Dormant watchers only refresh local metadata; live reloads may prepare the service. */
export async function prepareDevPluginReload(
  plugin: PluginSummary,
  isCurrent: () => boolean = () => true,
  registrationOnly = false,
  retry = true
) {
  if (!plugin.dev || !plugin.sourcePath || !isCurrent()) return null
  const revision = devChanges.get(plugin.id)
  const previous = getDevPluginSource(plugin.id)
  const options = previous?.source.options ?? { ...DEFAULT_DEV_OPTIONS,
    url: (await readDevPluginRecords()).find(record => record.id === plugin.id)?.url }
  const valid = () => isCurrent() && devChanges.get(plugin.id) === revision
    && pluginRegistry.get(plugin.id)?.sourcePath === plugin.sourcePath
  if (!valid()) return null
  const source = await inspectDevPluginEntry(plugin.sourcePath, options)
  if (!valid()) return null
  if (source.manifest.id !== plugin.id) throw new Error('插件源码的 id 已变化，请重新加载该目录')
  const registration = registerDevPluginSource(source)
  const current = () => valid() && isDevPluginSourceCurrent(plugin.id, registration)
  const metadataOnly = registrationOnly || !pluginRegistry.isEnabled(plugin.id)
  const entry = metadataOnly ? devRegistrationEntry(source) : await prepareRegisteredDevPlugin(plugin.id, {
    isCurrent: () => current() && pluginRegistry.isEnabled(plugin.id), reason: retry ? 'reload' : 'source-change', retry
  })
  if (!current()) return null
  return { ...describeDevPlugin(plugin.sourcePath, entry), isCurrent: current }
}

/** The common open path calls this before configuring a session, backend or native View. */
export async function prepareDevPluginRuntime(pluginId: string, isCurrent: () => boolean, reason = 'open'): Promise<PluginSummary> {
  const registration = getDevPluginSource(pluginId)
  if (!registration) throw new Error('开发插件源码尚未登记，请重新加载该目录')
  const current = () => isCurrent() && isDevPluginSourceCurrent(pluginId, registration)
    && pluginRegistry.isEnabled(pluginId) && pluginRegistry.get(pluginId)?.sourcePath === registration.source.sourcePath
  const entry = await prepareRegisteredDevPlugin(pluginId, {
    isCurrent: current, reason, retry: reason === 'load' || reason === 'open' || reason === 'quick'
  })
  if (!current()) throw new Error('开发插件启动已取消')
  const prepared = describeDevPlugin(registration.source.sourcePath, entry)
  const previous = pluginRegistry.get(pluginId)
  if (previous && previous.rootPath === prepared.summary.rootPath
    && previous.devUrl === prepared.summary.devUrl && previous.devSource === prepared.summary.devSource
    && previous.devKind === prepared.summary.devKind && previous.devCommand === prepared.summary.devCommand) return previous
  // The validated source manifest remains authoritative; only the runtime transport is selected.
  const registered = pluginRegistry.updateDevRuntime(pluginId, prepared.summary)
  if (!current()) throw new Error('开发插件启动已取消')
  sendShellEvent({ type: 'plugins-changed' })
  return registered
}

export async function loadDevPlugin(dirPath: string, options: DevPluginLoadOptions = {}, persist = true,
  restore?: { expectedId: string }): Promise<PluginSummary> {
  const registrationOnly = restore !== undefined
  const revision = ++changeRevision
  const sourcePath = resolveLocalUserPath(dirPath, { baseDir: process.cwd() })
  const source = await inspectDevPluginEntry(sourcePath, { ...DEFAULT_DEV_OPTIONS, ...options })
  const { manifest } = source
  if (restore && manifest.id !== restore.expectedId) throw new Error('插件源码的 id 已变化，请重新加载该目录')
  if ((devChanges.get(manifest.id) ?? 0) > revision) throw new Error('开发插件加载已取消')
  const isCurrent = beginDevChange(manifest.id, revision)
  return withDevOperation(manifest.id, async () => {
    if (!isCurrent()) throw new Error('开发插件加载已取消')
    const { pluginHost } = await import('@main/plugin/PluginHost')
    if (!isCurrent()) throw new Error('开发插件加载已取消')
    const unblock = registrationOnly ? () => {} : pluginHost.blockPlugin(manifest.id, 'development source registration')
    try {
      if (!registrationOnly && (pluginRegistry.get(manifest.id)?.dev || pluginHost.isOpen(manifest.id))) {
        await pluginHost.closePlugin(manifest.id, 'tab-close')
        if (!isCurrent()) throw new Error('开发插件加载已取消')
        forgetDevServer(manifest.id)
      }
      const registration = registerDevPluginSource(source, true)
      const current = () => isCurrent() && isDevPluginSourceCurrent(manifest.id, registration)
      const { summary, outputPath } = describeDevPlugin(sourcePath, devRegistrationEntry(source))
      let registered = pluginRegistry.addDevPlugin(summary, manifest)
      if (persist) await upsertDevPluginRecord(manifest.id, sourcePath, options)
      if (!current()) throw new Error('开发插件加载已取消')
      watchRegistration(summary, outputPath)
      await publishDevSource(manifest.id, current)
      if (!current()) throw new Error('开发插件加载已取消')
      if (!registrationOnly && pluginRegistry.isEnabled(manifest.id)) {
        registered = await prepareDevPluginRuntime(manifest.id, current, 'load')
      }
      logInfo('dev', `${registrationOnly ? 'registered' : 'loaded'} ${manifest.id}: ${registered.devUrl ?? sourcePath} (${registered.devKind ?? 'static'}${registrationOnly && source.declaredUrl ? ', on-demand' : ''})`)
      return registered
    } finally { unblock() }
  })
}

export async function pickAndLoadDevPlugin(dirPath?: string, options: DevPluginLoadOptions = {}): Promise<PluginSummary | null> {
  let dir = dirPath?.trim()
  if (!dir) {
    const result = await trackNativeInteraction(dialog.showOpenDialog({ title: '选择含 plugin.json 的插件源码目录', properties: ['openDirectory'] }))
    if (result.canceled || !result.filePaths[0]) return null
    dir = result.filePaths[0]
  }
  return loadDevPlugin(dir, options)
}

/** Restore registration only. A missing/offline project remains retryable and is never deleted. */
export async function restoreDevPlugins(): Promise<void> {
  const records = await readDevPluginRecords()
  if (!records.length) return
  const { pluginHost } = await import('@main/plugin/PluginHost')
  for (const rec of records) {
    if (!existsSync(rec.path)) { logWarn('dev', `source unavailable: ${rec.id}`); continue }
    try {
      await loadDevPlugin(rec.path, { url: rec.url }, false, { expectedId: rec.id })
      if (rec.killOnHide) pluginHost.setKillOnHide(rec.id, true)
    } catch (error) { logWarn('dev', `restore ${rec.id}: ${(error as Error).message}`) }
  }
}

/**
 * Release everything a development registration owns. Order matters: stop accepting
 * reloads, close the live view, then the development server tree, background/timers,
 * routes and finally the registry entry and its persisted record. Plugin data is kept —
 * the source folder may be loaded again.
 *
 * When the full uninstaller drives this, it has already removed the registry entry and
 * closed the view with its own lifecycle; here only the persisted record is dropped.
 */
export async function forgetDevPlugin(id: string): Promise<void> {
  beginDevChange(id)
  return withDevOperation(id, async () => {
    const ownsTeardown = pluginRegistry.get(id)?.dev === true
    forgetDevPluginSource(id)
    await forgetDevServer(id)
    if (!ownsTeardown) {
      await dropDevPluginRecord(id)
      return
    }
    const { pluginHost } = await import('@main/plugin/PluginHost')
    // Views, MCP runtime, backend/background processes, panel and session-tab references all
    // retire through the same close chain the uninstaller uses.
    try { await pluginHost.closePlugin(id, 'uninstall') }
    catch (error) { logWarn('dev', `${id}: close view: ${(error as Error).message}`) }
    pluginHost.setKillOnHide(id, false)
    const { stopPluginBackground } = await import('@main/plugin/pluginBackgroundRuntime')
    try { stopPluginBackground(id, 'development registration removed') }
    catch (error) { logWarn('dev', `${id}: background: ${(error as Error).message}`) }
    const { permissionService } = await import('@main/plugin/PermissionService')
    try { permissionService.cancelFor(id) }
    catch (error) { logWarn('dev', `${id}: permissions: ${(error as Error).message}`) }
    const { clearPluginDeadlineTasks } = await import('@main/timer/deadlineTaskService')
    try { clearPluginDeadlineTasks(id) }
    catch (error) { logWarn('dev', `${id}: timers: ${(error as Error).message}`) }
    const { releasePluginLaunchHotkey } = await import('@main/hotkey/pluginLaunchHotkeys')
    try { releasePluginLaunchHotkey(id) }
    catch (error) { logWarn('dev', `${id}: hotkeys: ${(error as Error).message}`) }
    const { associationService } = await import('@main/openWith/associationService')
    try { await associationService.removeRoutesForPlugin(id) }
    catch (error) { logWarn('dev', `${id}: open-with routes: ${(error as Error).message}`) }
    const { invalidatePluginFileCache, invalidatePluginCodeCache } = await import('@main/plugin/pluginProtocol')
    const rootPath = pluginRegistry.getRootPath(id)
    try {
      if (rootPath) invalidatePluginFileCache(rootPath)
      await invalidatePluginCodeCache(id)
    } catch (error) { logWarn('dev', `${id}: protocol cache: ${(error as Error).message}`) }
    // Drop residual lifecycle memory: quick-plugin hints, hibernation records and tab state.
    try { pluginHost.beginUninstall(id); pluginHost.finishUninstall(id) }
    catch (error) { logWarn('dev', `${id}: lifecycle state: ${(error as Error).message}`) }
    pluginRegistry.removeDevPlugin(id)
    await dropDevPluginRecord(id)
    const { appearanceService } = await import('@main/theme/appearanceService')
    appearanceService.invalidate()
    const { sendShellEvent } = await import('@main/window/createShellWindow')
    sendShellEvent({ type: 'plugins-changed' })
    logInfo('dev', `forgotten ${id}: view, dev server, watchers, background, timers and registration released`)
  })
}
