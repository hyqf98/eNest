import { BaseWindow, type BaseWindowConstructorOptions } from 'electron'
import { TITLEBAR_HEIGHT } from '@shared/constants'
import { DESKTOP_CORNER_RADIUS, WINDOW_BUTTON_LAYOUT, type WindowControl } from '@shared/windowFrame'
import { trackWindowShape } from './windowShape'

export function createDesktopWindow(options: BaseWindowConstructorOptions & { backgroundColor: string }, controlsEdge: 'left' | 'right' = 'left'): BaseWindow {
  const linux = process.platform === 'linux'
  const { left, diameter, pitch } = WINDOW_BUTTON_LAYOUT
  const buttonPosition = (width: number) => ({
    x: controlsEdge === 'right' ? Math.max(0, width - left - diameter - 2 * pitch) : left,
    y: (TITLEBAR_HEIGHT - diameter) / 2,
  })
  const win = new BaseWindow({
    ...options, frame: false, roundedCorners: true, hasShadow: true,
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hidden', trafficLightPosition: buttonPosition(options.width ?? 0) } : {}),
    ...(linux ? { transparent: true, backgroundColor: '#00000000' } : {}),
  })
  if (process.platform === 'darwin' && controlsEdge === 'right') {
    let lastWidth = options.width
    const alignButtons = () => {
      const { width } = win.getContentBounds()
      if (width === lastWidth) return
      lastWidth = width
      win.setWindowButtonPosition(buttonPosition(width))
    }
    alignButtons()
    win.on('resize', alignButtons)
  }
  if (linux) win.contentView.setBackgroundColor(options.backgroundColor)
  trackWindowShape(win, DESKTOP_CORNER_RADIUS, linux ? win.contentView : undefined)
  return win
}

export function setDesktopWindowBackground(win: BaseWindow, color: string): void {
  if (process.platform === 'linux') win.contentView.setBackgroundColor(color)
  else win.setBackgroundColor(color)
}

export function applyWindowControl(win: BaseWindow | null, control: WindowControl): boolean {
  if (!win || win.isDestroyed()) return false
  switch (control) {
    case 'close': win.close(); break
    case 'minimize': win.minimize(); break
    case 'zoom': if (win.isMaximized()) win.unmaximize(); else win.maximize(); break
    default: return false
  }
  return true
}
