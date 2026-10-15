import type { CSSProperties } from 'react'
import type { BackgroundConfig } from '@shared/types/plugin'
import { backgroundColorStyle } from './backgroundColorStyle'

/** Color backgrounds remain independent from the selected procedural/video effect. */
export function backgroundAtmosphereStyle(background: BackgroundConfig | null | undefined): CSSProperties | null {
  if (background?.type !== 'color' || !background.value) return null
  const color = backgroundColorStyle(background.value)
  if (!Object.keys(color).length) return null
  if (typeof CSS !== 'undefined' && !CSS.supports(color.backgroundImage ? 'background-image' : 'background-color',
    String(color.backgroundImage ?? color.backgroundColor))) return null
  const opacity = Number.isFinite(background.opacity) ? Math.min(1, Math.max(0, background.opacity)) : 0.85
  return { ...color, opacity }
}

/** A small normal wash carries light/dark colors; the color blend above keeps material relief. */
export function backgroundAtmosphereWashStyle(atmosphere: CSSProperties): CSSProperties {
  return { ...atmosphere, opacity: Number(atmosphere.opacity) * 0.32 }
}

/** Paint variables tint existing surfaces without changing theme tokens or reading layout. */
export function syncBackgroundAtmosphereTheme(root: HTMLElement, background: BackgroundConfig | null | undefined): void {
  const atmosphere = backgroundAtmosphereStyle(background)
  root.classList.toggle('has-bg-atmosphere', !!atmosphere && Number(atmosphere.opacity) > 0)
  if (!atmosphere) {
    root.style.removeProperty('--atmosphere-paint')
    root.style.removeProperty('--atmosphere-strength')
    return
  }
  const paint = atmosphere.backgroundImage
    ?? `linear-gradient(${atmosphere.backgroundColor}, ${atmosphere.backgroundColor})`
  // Keep the paint stable during strength dragging; Chromium only updates the scalar.
  if (root.style.getPropertyValue('--atmosphere-paint') !== paint) root.style.setProperty('--atmosphere-paint', String(paint))
  root.style.setProperty('--atmosphere-strength', String(atmosphere.opacity))
}

/** Detached chrome uses the same validated CSS layer as React surfaces. */
export function syncBackgroundAtmosphere(
  container: HTMLElement,
  background: BackgroundConfig | null | undefined,
  blend = true,
): void {
  let layer = container.querySelector<HTMLElement>(':scope > .background-atmosphere')
  let wash = container.querySelector<HTMLElement>(':scope > .background-atmosphere-wash')
  const style = backgroundAtmosphereStyle(background)
  if (!style) { layer?.remove(); wash?.remove(); return }
  if (!layer) {
    layer = container.ownerDocument.createElement('div')
    layer.setAttribute('aria-hidden', 'true')
    container.appendChild(layer)
  }
  layer.className = `background-atmosphere${blend ? ' background-atmosphere--blend' : ''}`
  layer.style.backgroundImage = String(style.backgroundImage ?? '')
  layer.style.backgroundColor = String(style.backgroundColor ?? '')
  layer.style.opacity = String(style.opacity)
  if (!blend) { wash?.remove(); return }
  if (!wash) {
    wash = container.ownerDocument.createElement('div')
    wash.className = 'background-atmosphere-wash'
    wash.setAttribute('aria-hidden', 'true')
    container.appendChild(wash)
  }
  wash.style.backgroundImage = String(style.backgroundImage ?? '')
  wash.style.backgroundColor = String(style.backgroundColor ?? '')
  wash.style.opacity = String(backgroundAtmosphereWashStyle(style).opacity)
}
