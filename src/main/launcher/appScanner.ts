/**
 * appScanner — 平台分发 + 内存缓存
 */
import type { ApplicationScanResult, LocalApp } from '@shared/types/quick'
import { logInfo, logWarn } from '@main/logs/logService'

let cache: ApplicationScanResult | null = null
let scanning: Promise<ApplicationScanResult> | null = null
const listeners = new Set<() => void>()

function sameApps(previous: LocalApp[], next: LocalApp[]): boolean {
  return previous.length === next.length && previous.every((app, index) => {
    const other = next[index]
    return app.path === other.path && app.name === other.name && app.alias === other.alias &&
      app.icon === other.icon && app.iconName === other.iconName
  })
}

export async function scanApplications(force = false): Promise<ApplicationScanResult> {
  if (!force && cache) return cache
  // A forced refresh bypasses the saved snapshot, not a scan already in progress.
  if (scanning) return scanning

  scanning = (async () => {
    const platform = process.platform
    let result: ApplicationScanResult
    if (platform === 'darwin') {
      const { scanApplications: macScan } = await import('./macScanner')
      result = await macScan()
    } else if (platform === 'win32') {
      const { scanApplications: winScan } = await import('./windowsScanner')
      result = await winScan()
    } else {
      const { scanApplications: linuxScan } = await import('./linuxScanner')
      result = await linuxScan()
    }
    logInfo('quick', `apps scanned: ${result.apps.length} complete=${result.complete}`)
    if (result.errors.length > 0) logWarn('quick', `scan errors: ${result.errors.join('; ')}`)
    const changed = !cache || !sameApps(cache.apps, result.apps)
    // Keep the directory identity stable when only scan diagnostics changed.
    if (!changed && cache) result = { ...result, apps: cache.apps }
    cache = result
    if (changed) for (const listener of listeners) {
      try { listener() } catch (error) { logWarn('quick', `scan listener failed: ${String(error)}`) }
    }
    return result
  })().finally(() => {
    scanning = null
  })

  return scanning
}

export function getCachedApps(): ApplicationScanResult | null {
  return cache
}

export function onApplicationsChanged(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
