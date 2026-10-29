/** Source registration is independent of installation. The shell starts dev servers and owns fallback watchers. */
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { dialog } from 'electron'
import { trackNativeInteraction } from '@main/plugin/pluginInteractionPolicy'
import { resolveLocalUserPath } from '@main/paths/userPath'
import { pluginRegistry } from '@main/plugin/PluginRegistry'
import type { DevPluginLoadOptions, PluginSummary } from '@shared/types/plugin'
import { resolvePluginUi } from '@shared/types/plugin'
import { pluginCategoryColor, toTabId } from '@shared/constants'
import { logInfo, logWarn } from '@main/logs/logService'
import { dropDevPluginRecord, readDevPluginRecords, upsertDevPluginRecord } from './devPluginsStore'
import { resolveDevPluginEntry } from './devPluginEntry'
import { forgetDevServer } from './devServerManager'
import { startDevRegistrationWatch, stopDevRegistrationWatch, stopDevWatch } from './devPluginWatcher'

/** 自动拉起开发服务是默认开发体验；显式 url 覆盖时不影响其语义。 */
const DEFAULT_DEV_OPTIONS: DevPluginLoadOptions = { autoStartServer: true }
let changeRevision = 0
const devChanges = new Map<string, number>()

/** Retire the previous in-flight sequence and release both watchers for this id. */
function beginDevChange(id: string, revision = ++changeRevision): () => boolean {
  devChanges.set(id, revision)
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

async function prepareDevPlugin(dirPath: string, options: DevPluginLoadOptions = {}) {
  const sourcePath = resolveLocalUserPath(dirPath, { baseDir: process.cwd() })
  const { rootPath, manifest, devUrl, devSource, devKind, plan } = await resolveDevPluginEntry(sourcePath, { ...DEFAULT_DEV_OPTIONS, ...options })
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

/** Recheck automatic selection on reload without closing or changing placement. */
export async function prepareDevPluginReload(plugin: PluginSummary, isCurrent: () => boolean = () => true) {
  if (!plugin.dev || !plugin.sourcePath || !isCurrent()) return null
  const record = (await readDevPluginRecords()).find(record => record.id === plugin.id)
  if (!isCurrent()) return null
  const prepared = await prepareDevPlugin(plugin.sourcePath, record ? { url: record.url } : { url: plugin.devUrl })
  if (!isCurrent()) return null
  if (prepared.summary.id !== plugin.id) throw new Error('插件源码的 id 已变化，请重新加载该目录')
  return prepared
}

async function refreshDevRegistration(id: string, isCurrent: () => boolean): Promise<void> {
  if (!isCurrent()) return
  const previous = pluginRegistry.get(id)
  if (!previous?.dev) return
  const prepared = await prepareDevPluginReload(previous, isCurrent)
  if (!isCurrent() || !prepared) return
  pluginRegistry.addDevPlugin(prepared.summary, prepared.manifest)
  watchRegistration(prepared.summary, prepared.outputPath)
  await publishDevSource(id, isCurrent)
  if (!isCurrent()) return
  const { pluginHost } = await import('@main/plugin/PluginHost')
  if (isCurrent() && pluginHost.isOpen(id)) pluginHost.reloadPlugin(toTabId(id))
}

export async function loadDevPlugin(dirPath: string, options: DevPluginLoadOptions = {}, persist = true): Promise<PluginSummary> {
  const revision = ++changeRevision
  const { summary, manifest, outputPath } = await prepareDevPlugin(dirPath, options)
  if ((devChanges.get(manifest.id) ?? 0) > revision) throw new Error('开发插件加载已取消')
  // 同名唯一性同样约束开发态：另一 id（安装或开发）已声明同名插件时拒绝加载，
  // 避免 dev 通道绕过安装去重造成 Quick 命令与设置分区冲突。
  const conflict = pluginRegistry.findConflictingInstallation(manifest)
  if (conflict) throw new Error(`「${manifest.name}」已由 ${conflict} 注册（安装或开发态）；同一插件只能存在一份，请先移除旧的再加载`)
  const isCurrent = beginDevChange(manifest.id, revision)
  const { pluginHost } = await import('@main/plugin/PluginHost')
  if (!isCurrent()) throw new Error('开发插件加载已取消')
  if (pluginHost.isOpen(manifest.id)) await pluginHost.closePlugin(manifest.id, 'tab-close')
  if (!isCurrent()) throw new Error('开发插件加载已取消')
  const registered = pluginRegistry.addDevPlugin(summary, manifest)
  if (persist) await upsertDevPluginRecord(manifest.id, summary.sourcePath!, options)
  if (!isCurrent()) throw new Error('开发插件加载已取消')
  watchRegistration(summary, outputPath)
  await publishDevSource(manifest.id, isCurrent)
  if (!isCurrent()) throw new Error('开发插件加载已取消')
  logInfo('dev', `loaded ${manifest.id}: ${summary.devUrl ?? summary.rootPath} (${summary.devKind ?? 'static'})`)
  return registered
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
      await loadDevPlugin(rec.path, { url: rec.url }, false)
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
  const ownsTeardown = pluginRegistry.get(id)?.dev === true
  beginDevChange(id)
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
  devChanges.delete(id)
  await dropDevPluginRecord(id)
  const { appearanceService } = await import('@main/theme/appearanceService')
  appearanceService.invalidate()
  const { sendShellEvent } = await import('@main/window/createShellWindow')
  sendShellEvent({ type: 'plugins-changed' })
  logInfo('dev', `forgotten ${id}: view, dev server, watchers, background, timers and registration released`)
}
