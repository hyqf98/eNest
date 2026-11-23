/**
 * 原生窗口圆角区域。
 *
 * Quick 是透明窗口，Windows 下必须把窗口裁成与 CSS 一致的圆角矩形，
 * 否则 DWM 阴影会透过透明的四角画在背景上。主窗不使用自裁：
 * macOS 交给 `roundedCorners`，Windows 10 没有系统圆角，Win11 由 DWM 处理。
 */
import type { Rectangle } from 'electron'

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
