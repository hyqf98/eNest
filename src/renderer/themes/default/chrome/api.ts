import type { OrbRailState } from '@shared/types/ipc'
import type { ThemeChromeApi, ThemeChromePart, ThemeChromeSnapshot } from '@shared/types/themeChrome'

interface LocalChromeActions {
  home?: () => void | Promise<void>
  settings?: () => void | Promise<void>
  activate?: (tabId: string) => void | Promise<void>
  close?: (tabId: string) => void | Promise<void>
}

/** Keep store/toast behavior in the inline shell, without importing its graph into native chrome. */
export function createDefaultChromeApi(surface: ThemeChromePart, local: LocalChromeActions = {}): ThemeChromeApi {
  if (window.enestChrome) return window.enestChrome
  const shell = window.enestShell
  let state: OrbRailState = {
    view: 'home', tabStyle: surface === 'rail' ? 'orb' : 'classic', activeTabId: null,
    animationLevel: 'medium', theme: { mode: 'light', tokens: {} }, profile: null, tabs: []
  }
  let eventRevision = 0
  let readRevision = 0
  const snapshot = (): ThemeChromeSnapshot => ({
    version: 1, surface, view: state.view, tabStyle: state.tabStyle, activeTabId: state.activeTabId,
    animationLevel: state.animationLevel, theme: state.theme, profile: state.profile, tabs: state.tabs,
    contribEntries: (state.contribEntries ?? []).map(({ id, pluginId, title, glyph, color }) => ({ id, pluginId, title, glyph, color }))
  })
  const getSnapshot = async (): Promise<ThemeChromeSnapshot> => {
    const events = eventRevision, read = ++readRevision
    const next = await shell?.getOrbState?.()
    // A late initial read must not replace a newer push (including its contribution targets).
    if (next && events === eventRevision && read === readRevision) state = next
    return snapshot()
  }
  return {
    getSnapshot,
    onSnapshot(listener) {
      return shell?.onOrbEvent?.(payload => {
        if (payload.type !== 'orb-state') return
        eventRevision++
        state = payload.state
        listener(snapshot())
      }) ?? (() => {})
    },
    async dispatch(action) {
      switch (action.type) {
        case 'home':
          if (local.home) await local.home()
          else await shell?.goHome?.()
          return
        case 'settings':
          if (local.settings) await local.settings()
          else await shell?.setShellView?.('settings')
          return
        case 'activate':
          if (local.activate) await local.activate(action.tabId)
          else await shell?.activatePlugin(action.tabId)
          return
        case 'close':
          if (local.close) await local.close(action.tabId)
          else await shell?.closePlugin(action.tabId)
          return
        case 'expand':
          await shell?.setOrbRailExpanded?.(action.expanded)
          return
        case 'contribution': {
          await getSnapshot()
          const entry = state.contribEntries?.find(row => row.id === action.id)
          if (!entry) throw new Error('Unknown chrome contribution')
          await shell?.openPlugin(entry.pluginId, entry.openCode ? { code: entry.openCode } : undefined)
          return
        }
        case 'reorder':
        case 'detach': {
          await getSnapshot()
          const tab = state.tabs.find(row => row.id === action.tabId)
          if (!tab) throw new Error('Unknown chrome tab')
          if (action.type === 'reorder' && (!Number.isSafeInteger(action.index) || action.index < 0 || action.index >= state.tabs.length)) {
            throw new Error('Invalid chrome tab index')
          }
          const windows = window.enestWindows
          if (!windows) throw new Error('Native window bridge unavailable')
          const result = await windows.command(action.type === 'detach'
            ? { action: 'detach', pluginId: tab.pluginId }
            : { action: 'dock', pluginId: tab.pluginId, target: 'shell', index: action.index })
          if (!result.ok) throw new Error(result.error ?? 'Native window command failed')
        }
      }
    },
    async ready() { /* Trusted builtin surfaces retain their existing host readiness gate. */ }
  }
}
