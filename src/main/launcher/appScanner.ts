/**
 * appScanner — 平台分发 + 内存缓存
 */
import type { ApplicationScanResult } from '@shared/types/quick'
import { logInfo, logWarn } from '../logs/logService'

let cache: ApplicationScanResult | null = null
let scanning: Promise<ApplicationScanResult> | null = null

export async function scanApplications(force = false): Promise<ApplicationScanResult> {
  if (!force && cache) return cache
  if (scanning) {
    const inFlight = await scanning
    if (!force) return inFlight
  }

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
    cache = result
    return result
  })().finally(() => {
    scanning = null
  })

  return scanning
}

export function getCachedApps(): ApplicationScanResult | null {
  return cache
}
