/** Generic native display capture. Selection, encoding and presentation belong to plugins. */
import { desktopCapturer, screen } from 'electron'
import { getRuntimeScope } from '@main/plugin/PluginRuntimeScope'
import { permissionService } from '@main/plugin/PermissionService'
import { pluginRegistry } from '@main/plugin/PluginRegistry'
import { checkScreenCapture } from '@main/plugin/OsPermissionChecks'
import type { ScreenBounds, ScreenCaptureResult } from '@shared/types/plugin'

function authorized(pluginId: string, permission: 'screen.capture' | 'screen.record'): void {
  const scope = getRuntimeScope(pluginId)
  if (!scope?.isCurrent() || scope.isClosing || scope.signal.aborted) throw new Error('Capture owner is closing')
  if (!pluginRegistry.getManifest(pluginId)?.permissions?.includes(permission) || !permissionService.isGranted(pluginId, permission)) throw new Error(`permission denied: ${permission}`)
  if (!checkScreenCapture().ok) throw new Error('os permission denied: screen')
}
export function resolveCaptureDisplay(displayId?: number): Electron.Display {
  if (displayId !== undefined && (!Number.isSafeInteger(displayId) || !screen.getAllDisplays().some(display => display.id === displayId))) throw new Error('Display unavailable')
  return displayId === undefined ? screen.getPrimaryDisplay() : screen.getAllDisplays().find(display => display.id === displayId)!
}
export function listCaptureDisplays(pluginId: string) {
  const scope = getRuntimeScope(pluginId)
  if (!scope?.isCurrent() || scope.isClosing) throw new Error('Display owner is closing')
  return screen.getAllDisplays().map(display => ({ id: display.id, bounds: display.bounds, workArea: display.workArea, scaleFactor: display.scaleFactor, primary: display.id === screen.getPrimaryDisplay().id }))
}
export async function captureDisplaySource(pluginId: string, displayId?: number): Promise<Electron.DesktopCapturerSource> {
  const scope = getRuntimeScope(pluginId)
  authorized(pluginId, 'screen.record')
  const display = resolveCaptureDisplay(displayId)
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } })
  authorized(pluginId, 'screen.record')
  if (getRuntimeScope(pluginId) !== scope) throw new Error('Capture owner changed')
  const source = sources.find(item => item.display_id === String(display.id))
  if (!source) throw new Error('Requested display source unavailable')
  return source
}
export async function captureScreen(pluginId: string, opts?: { displayId?: number; bounds?: ScreenBounds }): Promise<ScreenCaptureResult & { displayId: number }> {
  authorized(pluginId, 'screen.capture')
  const scope = getRuntimeScope(pluginId)!
  const release = scope.acquireActivity('native screen capture')
  try {
    const display = resolveCaptureDisplay(opts?.displayId)
    const width = Math.max(1, Math.round(display.size.width * display.scaleFactor)), height = Math.max(1, Math.round(display.size.height * display.scaleFactor))
    if (width * height > 40_000_000) throw new Error('Native capture pixel limit exceeded')
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width, height } })
    authorized(pluginId, 'screen.capture')
    if (getRuntimeScope(pluginId) !== scope) throw new Error('Capture owner changed')
    const source = sources.find(item => item.display_id === String(display.id))
    if (!source || source.thumbnail.isEmpty()) throw new Error('Requested display capture unavailable')
    let image = source.thumbnail
    const size = image.getSize(), bounds = opts?.bounds
    if (bounds) {
      if (![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite) || bounds.width < 1 || bounds.height < 1) throw new Error('Capture bounds invalid')
      const x = Math.max(0, Math.min(size.width - 1, Math.floor(bounds.x))), y = Math.max(0, Math.min(size.height - 1, Math.floor(bounds.y)))
      image = image.crop({ x, y, width: Math.max(1, Math.min(size.width - x, Math.floor(bounds.width))), height: Math.max(1, Math.min(size.height - y, Math.floor(bounds.height))) })
    }
    return { dataUrl: image.toDataURL(), ...image.getSize(), displayId: display.id }
  } finally { release() }
}
