/** Source registration is independent of installation. Framework servers own HMR. */
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { dialog } from 'electron'
import { pluginRegistry } from '@main/plugin/PluginRegistry'
import type { DevPluginLoadOptions, PluginSummary } from '@shared/types/plugin'
import { resolvePluginUi } from '@shared/types/plugin'
import { pluginCategoryColor } from '@shared/constants'
import { logInfo, logWarn } from '@main/logs/logService'
import { dropDevPluginRecord, readDevPluginRecords, upsertDevPluginRecord } from './devPluginsStore'
import { resolveDevPluginEntry } from './devPluginEntry'

async function prepareDevPlugin(dirPath: string, options: DevPluginLoadOptions = {}) {
  const sourcePath = resolve(dirPath)
  const { rootPath, manifest, devUrl, devSource } = await resolveDevPluginEntry(sourcePath, options)
  const category = manifest.category ?? '开发'
  const summary: PluginSummary = {
    id: manifest.id, name: manifest.name, version: manifest.version,
    description: manifest.description ?? '', author: manifest.author ?? '', category,
    installs: 'dev', color: pluginCategoryColor(category), glyph: manifest.name.slice(0, 1),
    permissions: manifest.permissions ?? [], installed: true,
    rootPath, sourcePath, devUrl, devSource, dev: true,
    ui: resolvePluginUi(manifest.ui)
  }
  return { summary, manifest }
}

/** Recheck automatic selection on reload without closing or changing placement. */
export async function prepareDevPluginReload(plugin: PluginSummary) {
  if (!plugin.dev || !plugin.sourcePath) return null
  const record = (await readDevPluginRecords()).find(record => record.id === plugin.id)
  const prepared = await prepareDevPlugin(plugin.sourcePath, record ? { url: record.url, preview: record.preview } : {})
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
      await loadDevPlugin(rec.path, { url: rec.url, preview: rec.preview }, false)
      if (rec.killOnHide) pluginHost.setKillOnHide(rec.id, true)
    } catch (error) { logWarn('dev', `restore ${rec.id}: ${(error as Error).message}`) }
  }
}

export async function forgetDevPlugin(id: string): Promise<void> {
  await dropDevPluginRecord(id)
}
