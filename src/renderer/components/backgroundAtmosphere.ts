import type { CSSProperties } from 'react'
import type { BackgroundConfig } from '@shared/types/plugin'
import { backgroundColorStyle } from './backgroundColorStyle'

/** Color backgrounds remain independent from the selected procedural/video effect. */
export function backgroundAtmosphereStyle(background: BackgroundConfig | null | undefined): CSSProperties | null {
  if (background?.type !== 'color' || !background.value) return null
  const color = backgroundColorStyle(background.value)
  if (!Object.keys(color).length) return null
  const opacity = Number.isFinite(background.opacity) ? Math.min(1, Math.max(0, background.opacity)) : 0.85
  return { ...color, opacity }
}

/** Detached chrome uses the same validated CSS layer as React surfaces. */
export function syncBackgroundAtmosphere(
  container: HTMLElement,
  background: BackgroundConfig | null | undefined,
  blend = true,
): void {
  let layer = container.querySelector<HTMLElement>(':scope > .background-atmosphere')
  const style = backgroundAtmosphereStyle(background)
  if (!style) { layer?.remove(); return }
  if (!layer) {
    layer = container.ownerDocument.createElement('div')
    layer.setAttribute('aria-hidden', 'true')
    container.appendChild(layer)
  }
  layer.className = `background-atmosphere${blend ? ' background-atmosphere--blend' : ''}`
  layer.style.backgroundImage = String(style.backgroundImage ?? '')
  layer.style.backgroundColor = String(style.backgroundColor ?? '')
  layer.style.opacity = String(style.opacity)
}
