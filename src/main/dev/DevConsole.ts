/** Source registration is independent of installation. The shell starts dev servers and owns fallback watchers. */
import { existsSync } from 'node:fs'
import { dialog } from 'electron'
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
import { stopAllDevServers, stopDevServer } from './devServerManager'
import { stopDevWatch } from './devPluginWatcher'

/** 自动拉起开发服务是默认开发体验；显式 url / mode 覆盖时不影响其语义。 */
const DEFAULT_DEV_OPTIONS: DevPluginLoadOptions = { autoStartServer: true }

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
  return { summary, manifest }
}

/** Recheck automatic selection on reload without closing or changing placement. */
export async function prepareDevPluginReload(plugin: PluginSummary) {
  if (!plugin.dev || !plugin.sourcePath) return null
  const record = (await readDevPluginRecords()).find(record => record.id === plugin.id)
  const prepared = await prepareDevPlugin(plugin.sourcePath, record ? { url: record.url, mode: record.mode } : {})
  if (prepared.summary.id !== plugin.id) throw new Error('插件源码的 id 已变化，请重新加载该目录')
  return prepared
}

export async function loadDevPlugin(dirPath: string, options: DevPluginLoadOptions = {}, persist = true): Promise<PluginSummary> {
  const { summary, manifest } = await prepareDevPlugin(dirPath, options)
  const { pluginHost } = await import('@main/plugin/PluginHost')
  if (pluginHost.isOpen(manifest.id)) await pluginHost.closePlugin(manifest.id, 'tab-close')
  const registered = pluginRegistry.addDevPlugin(summary, manifest)
  if (persist) await upsertDevPluginRecord(manifest.id, summary.sourcePath!, options)
  logInfo('dev', `loaded ${manifest.id}: ${summary.devUrl ?? summary.rootPath}`)
  return registered
}

export async function pickAndLoadDevPlugin(dirPath?: string, options: DevPluginLoadOptions = {}): Promise<PluginSummary | null> {
  let dir = dirPath?.trim()
  if (!dir) {
    const result = await dialog.showOpenDialog({ title: '选择含 plugin.json 的插件源码目录', properties: ['openDirectory'] })
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
  stopDevServer(id)
  stopDevWatch(id)
  await dropDevPluginRecord(id)
}

/** dev/prod 模式切换：更新记录后原地重载（打开态下经 reloadPlugin 重跑入口解析）。 */
export async function setDevPluginMode(id: string, mode: 'dev' | 'prod'): Promise<void> {
  const record = (await readDevPluginRecords()).find(record => record.id === id)
  if (!record) throw new Error('开发插件记录不存在，请重新加载该目录')
  await updateDevPluginMode(id, mode)
  const { pluginHost } = await import('@main/plugin/PluginHost')
  if (pluginHost.isOpen(id)) pluginHost.reloadPlugin(toTabId(id))
}

/** prod 模式手动重建：执行解析出的构建命令，完成后若插件打开则原地重载新产物。 */
export async function rebuildDevPlugin(id: string): Promise<void> {
  const summary = pluginRegistry.get(id)
  const record = (await readDevPluginRecords()).find(record => record.id === id)
  const sourcePath = summary?.sourcePath ?? record?.path
  if (!sourcePath || !existsSync(sourcePath)) throw new Error('插件源码目录不可用，请重新加载该目录')
  const plan = resolveDevCommandPlan(sourcePath)
  await runDevBuild(id, sourcePath, plan)
  const { pluginHost } = await import('@main/plugin/PluginHost')
  if (pluginHost.isOpen(id)) pluginHost.reloadPlugin(toTabId(id))
}
