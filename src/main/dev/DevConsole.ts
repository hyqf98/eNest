/** Source registration is independent of installation. Framework servers own HMR. */
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { dialog } from 'electron'
import { installFromDirectory } from '@main/plugin/PluginInstaller'
import { pluginRegistry } from '@main/plugin/PluginRegistry'
import type { DevPluginLoadOptions, PluginSummary } from '@shared/types/plugin'
import { resolvePluginUi } from '@shared/types/plugin'
import { normalizePluginDevUrl } from '@shared/pluginContract'
import { pluginCategoryColor } from '@shared/constants'
import { logInfo, logWarn } from '@main/logs/logService'
import { dropDevPluginRecord, readDevPluginRecords, upsertDevPluginRecord } from './devPluginsStore'

export async function loadDevPlugin(dirPath: string, options: DevPluginLoadOptions = {}, persist = true): Promise<PluginSummary> {
  const sourcePath = resolve(dirPath)
  const preview = options.preview === 'dist' ? 'dist' : 'source'
  const rootPath = preview === 'dist' ? join(sourcePath, 'dist') : sourcePath
  const manifest = await installFromDirectory(rootPath, { source: preview === 'source' })
  const devUrl = preview === 'source' ? normalizePluginDevUrl(options.url ?? manifest.development?.main) : undefined
  const category = manifest.category ?? '开发'
  const summary: PluginSummary = {
    id: manifest.id, name: manifest.name, version: manifest.version,
    description: manifest.description ?? '', author: manifest.author ?? '', category,
    installs: 'dev', color: pluginCategoryColor(category), glyph: manifest.name.slice(0, 1),
    permissions: manifest.permissions ?? [], installed: true,
    rootPath, sourcePath, devUrl, devSource: preview === 'source', dev: true,
    ui: resolvePluginUi(manifest.ui)
  }
  const { pluginHost } = await import('@main/plugin/PluginHost')
  if (pluginHost.isOpen(manifest.id)) await pluginHost.closePlugin(manifest.id, 'tab-close')
  const registered = pluginRegistry.addDevPlugin(summary, manifest)
  if (persist) await upsertDevPluginRecord(manifest.id, sourcePath, options)
  logInfo('dev', `loaded ${manifest.id}: ${devUrl ?? rootPath}`)
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
