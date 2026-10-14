/** Read-only counters for profilers; payload data and secrets are never included. */
import { app, webContents } from 'electron'
import { pluginHost } from '@main/plugin/PluginHost'
import { getRuntimeDiagnostics } from '@main/plugin/PluginRuntimeScope'
import { getSessionDiagnostics } from '@main/plugin/PluginSessionStore'
import { getStorageDiagnostics } from '@main/db/pluginStorage'
import { pluginAssetCache } from '@main/plugin/pluginFileResponse'
import { pluginRegistry } from '@main/plugin/PluginRegistry'
import { getCommandCacheMetrics } from '@main/launcher/commandIndex'
import { getThemeCacheMetrics } from '@main/theme/resolveThemeCss'
import { getDbUtilityDiagnostics } from '@main/database/dbSessionManager'

export function getPluginDiagnostics() {
  const host = pluginHost.getDiagnostics()
  const contents = new Map(webContents.getAllWebContents().map((wc) => [wc.id, wc]))
  return {
    sampledAt: Date.now(), platform: process.platform,
    host, resources: getRuntimeDiagnostics(), assets: pluginAssetCache.getMetrics(),
    session: getSessionDiagnostics(), localStorage: getStorageDiagnostics(),
    caches: { descriptors: pluginRegistry.getDescriptorCacheMetrics(), commands: getCommandCacheMetrics(), theme: getThemeCacheMetrics() },
    utilities: getDbUtilityDiagnostics(),
    renderers: host.entries.map((entry) => ({ pluginId: entry.pluginId, generation: entry.generation,
      wcId: entry.wcId, pid: contents.get(entry.wcId)?.getOSProcessId() ?? null })),
    // Electron metrics cover only processes belonging to this app. Values are KiB.
    processes: app.getAppMetrics().map((metric) => ({ pid: metric.pid, type: metric.type, cpu: metric.cpu, memory: metric.memory }))
  }
}
