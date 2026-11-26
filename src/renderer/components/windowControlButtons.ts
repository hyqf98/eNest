import { IS_MAC } from '@shared/platform'
import { WINDOW_BUTTON_LAYOUT, type WindowControl } from '@shared/windowFrame'
import { windowControlLabels } from '@renderer/i18n/windowControls'

const buttons = [
  { control: 'close', label: 'close', path: 'M3 3l6 6M9 3L3 9' },
  { control: 'minimize', label: 'minimize', path: 'M2.5 6h7' },
  { control: 'zoom', label: 'maximize', path: 'M4 8V4h4m-4 0 4.5 4.5' },
] as const

export function renderWindowControls(slot: HTMLElement, locale: string, onControl: (control: WindowControl) => void): void {
  slot.lang = locale
  if (IS_MAC) {
    slot.setAttribute('aria-hidden', 'true')
    return
  }
  const labels = windowControlLabels[locale === 'en-US' ? 'en-US' : 'zh-CN']
  slot.setAttribute('role', 'group')
  slot.setAttribute('aria-label', labels.group)
  slot.style.setProperty('--window-dot', `${WINDOW_BUTTON_LAYOUT.diameter}px`)
  slot.style.setProperty('--window-button-pitch', `${WINDOW_BUTTON_LAYOUT.pitch}px`)
  slot.style.setProperty('--window-button-left', `${WINDOW_BUTTON_LAYOUT.left}px`)
  slot.replaceChildren(...buttons.map(({ control, label, path }) => {
    const button = document.createElement('button')
    button.type = 'button'
    button.dataset.control = control
    button.title = labels[label]
    button.setAttribute('aria-label', labels[label])
    button.onclick = () => onControl(control)
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    svg.setAttribute('viewBox', '0 0 12 12')
    svg.setAttribute('aria-hidden', 'true')
    const glyph = document.createElementNS('http://www.w3.org/2000/svg', 'path')
    glyph.setAttribute('d', path)
    svg.append(glyph)
    button.append(svg)
    return button
  }))
}
