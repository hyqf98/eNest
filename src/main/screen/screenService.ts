/** Generic native display capture. Selection, encoding and presentation belong to plugins. */
import { desktopCapturer, nativeImage, screen } from 'electron'
import { getRuntimeScope } from '@main/plugin/PluginRuntimeScope'
import { permissionService } from '@main/plugin/PermissionService'
import { pluginRegistry } from '@main/plugin/PluginRegistry'
import { assertScreenCaptureAllowed } from '@main/plugin/OsPermissionChecks'
import { interactionError } from '@main/plugin/pluginInteractionPolicy'
import type { ScreenBounds, ScreenCaptureResult } from '@shared/types/plugin'

function authorized(pluginId: string, permission: 'screen.capture' | 'screen.record'): void {
  const scope = getRuntimeScope(pluginId)
  if (!scope?.isCurrent() || scope.isClosing || scope.signal.aborted) throw new Error('Capture owner is closing')
  if (!pluginRegistry.getManifest(pluginId)?.permissions?.includes(permission) || !permissionService.isGranted(pluginId, permission)) throw interactionError('permission-denied', `permission denied: ${permission}`)
  assertScreenCaptureAllowed(pluginId)
}
export function resolveCaptureDisplay(displayId?: number): Electron.Display {
  if (displayId === undefined) return screen.getPrimaryDisplay()
  const display = Number.isSafeInteger(displayId) && screen.getAllDisplays().find(item => item.id === displayId)
  if (!display) throw new Error('Display unavailable')
  return display
}
export function assertCaptureDisplayCurrent(display: Electron.Display): void {
  const next = resolveCaptureDisplay(display.id)
  const before = display.bounds, after = next.bounds
  if (before.x !== after.x || before.y !== after.y || before.width !== after.width || before.height !== after.height
    || display.scaleFactor !== next.scaleFactor || display.rotation !== next.rotation) throw new Error('Display changed during capture')
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
  assertCaptureDisplayCurrent(display)
  const source = sources.find(item => item.display_id === String(display.id))
  if (!source) throw new Error('Requested display source unavailable')
  return source
}

function checkCaptureSize({ width, height }: Electron.Size): void {
  if (width <= 0 || height <= 0 || width * height > 40_000_000) throw new Error('Native capture pixel limit exceeded')
}

function capturePixels(thumbnail: Electron.NativeImage, reference: Electron.Size, bounds?: ScreenBounds): ScreenCaptureResult {
  const [scaleFactor = 1] = thumbnail.getScaleFactors().sort((left, right) => right - left)
  let image = thumbnail
  if (scaleFactor !== 1) {
    const png = thumbnail.toPNG({ scaleFactor })
    if (png.length < 24) throw new Error('Requested display capture unavailable')
    const size = { width: png.readUInt32BE(16), height: png.readUInt32BE(20) }
    checkCaptureSize(size)
    if (!bounds) return { dataUrl: `data:image/png;base64,${png.toString('base64')}`, ...size }
    image = nativeImage.createFromBuffer(png, { scaleFactor: 1 })
  }
  const size = image.getSize(1)
  checkCaptureSize(size)
  if (!bounds) return { dataUrl: image.toDataURL({ scaleFactor: 1 }), ...size }
  const projectAxis = (start: number, length: number, displayPixels: number, imagePixels: number) => {
    const first = Math.max(0, start), last = Math.min(displayPixels, start + length)
    if (last <= first) throw new Error('Capture bounds outside display')
    const from = Math.min(imagePixels - 1, Math.round(first * imagePixels / displayPixels))
    return { from, length: Math.max(1, Math.round(last * imagePixels / displayPixels) - from) }
  }
  const horizontal = projectAxis(bounds.x, bounds.width, reference.width, size.width)
  const vertical = projectAxis(bounds.y, bounds.height, reference.height, size.height)
  const crop = { x: horizontal.from, y: vertical.from, width: horizontal.length, height: vertical.length }
  return { dataUrl: image.crop(crop).toDataURL({ scaleFactor: 1 }), width: crop.width, height: crop.height }
}

export async function captureScreen(pluginId: string, opts?: { displayId?: number; bounds?: ScreenBounds }): Promise<ScreenCaptureResult & { displayId: number }> {
  authorized(pluginId, 'screen.capture')
  const scope = getRuntimeScope(pluginId)!
  const release = scope.acquireActivity('native screen capture')
  try {
    const display = resolveCaptureDisplay(opts?.displayId)
    const reference = { width: Math.round(display.bounds.width * display.scaleFactor), height: Math.round(display.bounds.height * display.scaleFactor) }
    checkCaptureSize(reference)
    const bounds = opts?.bounds
    if (bounds && (![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite) || bounds.width < 1 || bounds.height < 1)) throw new Error('Capture bounds invalid')
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: reference })
    authorized(pluginId, 'screen.capture')
    if (getRuntimeScope(pluginId) !== scope) throw new Error('Capture owner changed')
    assertCaptureDisplayCurrent(display)
    const source = sources.find(item => item.display_id === String(display.id))
    if (!source || source.thumbnail.isEmpty()) throw new Error('Requested display capture unavailable')
    return { ...capturePixels(source.thumbnail, reference, bounds), displayId: display.id }
  } finally { release() }
}
