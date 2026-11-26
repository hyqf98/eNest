import { app } from 'electron'

export function isWaylandWindowSystem(): boolean {
  if (process.platform !== 'linux') return false
  const ozone = app.commandLine.getSwitchValue('ozone-platform')
  if (ozone === 'x11' || ozone === 'wayland') return ozone === 'wayland'
  return process.env.XDG_SESSION_TYPE === 'wayland' || !!process.env.WAYLAND_DISPLAY
}
