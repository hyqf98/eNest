import { screen, type BaseWindow, type Rectangle, type View } from 'electron'
import { isWaylandWindowSystem } from './linuxWindowSystem'

/** 圆角矩形 → 原生窗口区域（每像素一条横向矩形带，四角平滑内收）。 */
export function roundedShapeRects(width: number, height: number, radius: number): Rectangle[] {
  const r = Math.max(0, Math.min(Math.round(radius), Math.floor(Math.min(width, height) / 2)))
  if (r <= 0) return [{ x: 0, y: 0, width, height }]
  const rects: Rectangle[] = []
  if (height - 2 * r > 0) rects.push({ x: 0, y: r, width, height: height - 2 * r })
  for (let y = 0; y < r; y++) {
    const dy = r - y - 0.5
    const inset = Math.round(r - Math.sqrt(Math.max(0, r * r - dy * dy)))
    const stripWidth = width - inset * 2
    if (stripWidth <= 0) continue
    rects.push({ x: inset, y, width: stripWidth, height: 1 })
    rects.push({ x: inset, y: height - 1 - y, width: stripWidth, height: 1 })
  }
  return rects
}

const regionUpdates = new Set<() => void>()
const updateDisplayRegions = (): void => { for (const sync of regionUpdates) sync() }

export function trackWindowShape(win: BaseWindow, radius: number, clip?: View): void {
  const windows = process.platform === 'win32'
  const useRegion = windows || process.platform === 'linux' && !isWaylandWindowSystem()
  if (!useRegion && !clip) return
  clip?.setBackgroundBlur(0)
  let clippedRadius: number | undefined
  let applied: string | undefined
  const sync = (): void => {
    if (win.isDestroyed() || win.isMinimized()) return
    const square = win.isMaximized() || win.isFullScreen() || (windows && win.isSnapped())
    const nextRadius = square ? 0 : radius
    if (clip && clippedRadius !== nextRadius) {
      clip.setBorderRadius(nextRadius)
      clippedRadius = nextRadius
    }
    if (!useRegion) return
    const bounds = win.getBounds()
    const resetRegion = square && windows
    const key = resetRegion ? 'square' : `${bounds.width}x${bounds.height}@${screen.getDisplayMatching(bounds).scaleFactor}:${nextRadius}`
    if (key === applied || bounds.width <= 0 || bounds.height <= 0) return
    const previous = applied
    applied = key
    try {
      win.setShape(resetRegion ? [] : roundedShapeRects(bounds.width, bounds.height, nextRadius))
    } catch { applied = previous }
  }
  win.on('resize', sync)
  win.on('show', sync)
  win.on('restore', sync)
  win.on('maximize', sync)
  win.on('unmaximize', sync)
  win.on('enter-full-screen', sync)
  win.on('leave-full-screen', sync)
  if (useRegion) {
    if (windows) win.on('moved', sync)
    else win.on('move', sync)
    if (!regionUpdates.size) screen.on('display-metrics-changed', updateDisplayRegions)
    regionUpdates.add(sync)
    win.once('closed', () => {
      regionUpdates.delete(sync)
      if (!regionUpdates.size) screen.removeListener('display-metrics-changed', updateDisplayRegions)
    })
  }
  sync()
}
