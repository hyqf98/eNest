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
import { getBackendDiagnostics } from '@main/plugin/pluginBackendRpc'
import { getBackgroundDiagnostics } from '@main/plugin/pluginBackgroundRuntime'
import { getAuxiliaryDiagnostics, getAuxiliaryMemoryOwners } from '@main/window/pluginAuxiliaryWindows'
import { homeSurfaceManager } from '@main/home/HomeSurfaceManager'
import { getFileStreamDiagnostics } from '@main/plugin/pluginFileStreams'

export function getPluginDiagnostics() {
  const host = pluginHost.getDiagnostics()
  const contents = new Map(webContents.getAllWebContents().map((wc) => [wc.id, wc]))
  const backgrounds = getBackgroundDiagnostics()
  const owners = [...pluginHost.getMemoryOwners(), ...homeSurfaceManager.getMemoryOwners(), ...backgrounds, ...getAuxiliaryMemoryOwners()]
  return {
    sampledAt: Date.now(), platform: process.platform,
    host, resources: getRuntimeDiagnostics(), assets: pluginAssetCache.getMetrics(),
    session: getSessionDiagnostics(), localStorage: getStorageDiagnostics(),
    caches: { descriptors: pluginRegistry.getDescriptorCacheMetrics(), commands: getCommandCacheMetrics(), theme: getThemeCacheMetrics() },
    utilities: getBackendDiagnostics(),
    backgrounds, auxiliary: getAuxiliaryDiagnostics(),
    streams: getFileStreamDiagnostics(),
    renderers: owners.map(owner => {
      const wc = contents.get(owner.wcId)
      const pids = new Set<number>()
      let pid: number | null = null
      try {
        if (wc && !wc.isDestroyed()) {
          pid = wc.getOSProcessId()
          pids.add(pid)
          for (const frame of wc.mainFrame.framesInSubtree) if (!frame.detached) pids.add(frame.osProcessId)
        }
      } catch { /* A retiring frame has no reliable process identity. */ }
      return { pluginId: owner.pluginId, generation: owner.generation, wcId: owner.wcId,
        pid, pids: [...pids].filter(pid => pid > 0) }
    }),
    // Electron metrics cover only processes belonging to this app. Values are KiB.
    processes: app.getAppMetrics().map((metric) => ({ pid: metric.pid, creationTime: metric.creationTime, type: metric.type, cpu: metric.cpu, memory: metric.memory }))
  }
}
