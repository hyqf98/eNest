import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { app, BaseWindow, nativeTheme } from 'electron'
import { logWarn } from '@main/logs/logService'

type IconMode = 'light' | 'dark'
const resolved = new Map<IconMode, string | undefined>()

export function resolveWindowIcon(): string | undefined {
  if (process.platform === 'darwin') return undefined
  const windows = process.platform === 'win32'
  const dark = windows ? nativeTheme.shouldUseDarkColorsForSystemIntegratedUI : nativeTheme.shouldUseDarkColors
  const mode = dark ? 'dark' : 'light'
  if (resolved.has(mode)) return resolved.get(mode)
  const root = app.isPackaged ? process.resourcesPath : app.getAppPath()
  const icons = app.isPackaged ? join(root, 'icons') : join(root, 'assets', 'icons')
  const fallback = join(icons, 'enest-icon-256.png')
  const darkIcon = windows ? (app.isPackaged ? join(root, 'window-icons', 'icon.ico') : join(root, 'build', 'icon.ico')) : fallback
  const lightIcon = app.isPackaged ? join(root, 'window-icons', windows ? 'icon-light.ico' : 'icon-light.png')
    : join(icons, 'light', windows ? 'icon.ico' : 'enest-icon-256.png')
  const path = (dark ? [darkIcon, fallback] : [lightIcon, darkIcon, fallback]).find(candidate => existsSync(candidate))
  resolved.set(mode, path)
  return path
}

export function watchSystemIcons(updateTray: (icon: string) => void): void {
  if (process.platform === 'darwin') return
  let current = resolveWindowIcon()
  const update = (): void => {
    const icon = resolveWindowIcon()
    if (!icon || icon === current) return
    current = icon
    for (const win of BaseWindow.getAllWindows()) {
      if (win.isDestroyed()) continue
      try { win.setIcon(icon) } catch (error) { logWarn('main', `cannot update window icon: ${String(error)}`) }
    }
    updateTray(icon)
  }
  nativeTheme.on('updated', update)
  app.once('will-quit', () => nativeTheme.off('updated', update))
}
