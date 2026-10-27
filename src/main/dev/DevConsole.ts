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
import { dropDevPluginRecord, readDevPluginRecords, updateDevPluginMode, upsertDevPluginRecord } from './devPluginsStore'
import { resolveDevPluginEntry } from './devPluginEntry'
import { resolveDevCommandPlan } from './devCommandResolver'
import { runDevBuild } from './devBuildRunner'
import { forgetDevServer } from './devServerManager'
import { startDevRegistrationWatch, stopDevRegistrationWatch, stopDevWatch } from './devPluginWatcher'

/** 自动拉起开发服务是默认开发体验；显式 url / mode 覆盖时不影响其语义。 */
const DEFAULT_DEV_OPTIONS: DevPluginLoadOptions = { autoStartServer: true }
let changeRevision = 0
const devChanges = new Map<string, number>()

function beginDevChange(id: string, revision = ++changeRevision): () => boolean {
  devChanges.set(id, revision)
  stopDevRegistrationWatch(id)
  stopDevWatch(id)
  return () => devChanges.get(id) === revision
}

function watchRegistration(summary: PluginSummary, outputPath: string): void {
  if (summary.devMode !== 'prod' && summary.sourcePath) {
    startDevRegistrationWatch(summary.id, summary.sourcePath, outputPath)
  } else {
    stopDevRegistrationWatch(summary.id)
  }
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

async function prepareDevPlugin(dirPath: string, options: DevPluginLoadOptions = {}) {
  const sourcePath = resolveLocalUserPath(dirPath, { baseDir: process.cwd() })
  const { rootPath, manifest, devUrl, devSource, plan, mode } = await resolveDevPluginEntry(sourcePath, { ...DEFAULT_DEV_OPTIONS, ...options })
  const category = manifest.category ?? '开发'
  const summary: PluginSummary = {
    id: manifest.id, name: manifest.name, version: manifest.version,
    description: manifest.description ?? '', author: manifest.author ?? '', category,
    installs: 'dev', color: pluginCategoryColor(category), glyph: manifest.name.slice(0, 1),
    permissions: manifest.permissions ?? [], installed: true,
    rootPath, sourcePath, devUrl, devSource, dev: true,
    devMode: mode, devCommand: mode === 'prod' ? plan.build?.label : plan.start?.label,
    ui: resolvePluginUi(manifest.ui)
  }
  return { summary, manifest, outputPath: resolve(sourcePath, plan.output) }
}

/** Recheck automatic selection on reload without closing or changing placement. */
export async function prepareDevPluginReload(plugin: PluginSummary, isCurrent: () => boolean = () => true) {
  if (!plugin.dev || !plugin.sourcePath || !isCurrent()) return null
  const record = (await readDevPluginRecords()).find(record => record.id === plugin.id)
  if (!isCurrent()) return null
  const prepared = await prepareDevPlugin(plugin.sourcePath, record ? { url: record.url, mode: record.mode } : { url: plugin.devUrl, mode: plugin.devMode })
  if (!isCurrent()) return null
  if (prepared.summary.id !== plugin.id) throw new Error('插件源码的 id 已变化，请重新加载该目录')
  return prepared
}

export async function loadDevPlugin(dirPath: string, options: DevPluginLoadOptions = {}, persist = true): Promise<PluginSummary> {
  const revision = ++changeRevision
  const { summary, manifest, outputPath } = await prepareDevPlugin(dirPath, options)
  if ((devChanges.get(manifest.id) ?? 0) > revision) throw new Error('开发插件加载已取消')
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
  logInfo('dev', `loaded ${manifest.id}: ${summary.devUrl ?? summary.rootPath}`)
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
      await loadDevPlugin(rec.path, { url: rec.url, mode: rec.mode }, false)
      if (rec.killOnHide) pluginHost.setKillOnHide(rec.id, true)
    } catch (error) { logWarn('dev', `restore ${rec.id}: ${(error as Error).message}`) }
  }
}

export async function forgetDevPlugin(id: string): Promise<void> {
  beginDevChange(id)
  forgetDevServer(id)
  await dropDevPluginRecord(id)
}

/** Mode changes refresh registration and Home even when no ordinary Tab is open. */
export async function setDevPluginMode(id: string, mode: 'dev' | 'prod'): Promise<void> {
  const isCurrent = beginDevChange(id)
  const record = (await readDevPluginRecords()).find(record => record.id === id)
  if (!isCurrent()) return
  if (!record) throw new Error('开发插件记录不存在，请重新加载该目录')
  await updateDevPluginMode(id, mode)
  if (!isCurrent()) return
  await refreshDevRegistration(id, isCurrent)
}

/** Rebuild uses the same registration/theme/Home commit path, independently of Tab lifetime. */
export async function rebuildDevPlugin(id: string): Promise<void> {
  const isCurrent = beginDevChange(id)
  const summary = pluginRegistry.get(id)
  const record = (await readDevPluginRecords()).find(record => record.id === id)
  if (!isCurrent()) return
  const sourcePath = summary?.sourcePath ?? record?.path
  if (!sourcePath || !existsSync(sourcePath)) throw new Error('插件源码目录不可用，请重新加载该目录')
  const plan = resolveDevCommandPlan(sourcePath)
  await runDevBuild(id, sourcePath, plan)
  if (!isCurrent()) return
  await refreshDevRegistration(id, isCurrent)
}
