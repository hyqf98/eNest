import type { AnimationLevel, ShellView, TabStyle } from './plugin'
import type { ResolvedAppearance } from './appearance'
import { IpcChannels } from './ipc'

export type ThemeChromePart = 'classic' | 'rail' | 'dock'
/** Entries are assets in the declaring, installed theme package, never remote URLs. */
export interface ThemeChromeReference {
  version: 1
  classic?: { entry: string }
  rail?: { entry: string }
  dock?: { entry: string }
}
export interface ThemeChromeSnapshot {
  version: 1
  surface: ThemeChromePart
  tabStyle: TabStyle
  view: ShellView
  activeTabId: string | null
  animationLevel: AnimationLevel
  theme: {
    mode: 'light' | 'dark'
    tokens: Record<string, string>
    /** Trusted builtin adapter only; custom chrome receives the token allowlist. */
    appearance?: ResolvedAppearance
  }
  /** Trusted builtin adapter only; custom chrome never receives account data. */
  profile?: { name: string | null; avatar: string | null } | null
  tabs: Array<{ id: string; pluginId: string; title: string; color: string; glyph: string; badge?: string; icon?: string | null; lazy?: boolean; crashed?: boolean }>
  contribEntries: Array<{ id: string; pluginId: string; title: string; glyph: string; color: string }>
}
export type ThemeChromeAction =
  | { type: 'home' | 'settings' }
  | { type: 'activate'; tabId: string }
  | { type: 'close'; tabId: string }
  | { type: 'detach'; tabId: string }
  | { type: 'reorder'; tabId: string; index: number }
  | { type: 'contribution'; id: string }
  | { type: 'expand'; expanded: boolean }
export interface ThemeChromeApi {
  getSnapshot(): Promise<ThemeChromeSnapshot>
  onSnapshot(listener: (snapshot: ThemeChromeSnapshot) => void): () => void
  dispatch(action: ThemeChromeAction): Promise<void>
  /** Call only after the first usable frame; the host retains its fallback until this ACK. */
  ready(): Promise<void>
}

/** Kept separate from privileged shell channels: custom renderers never receive shellApi. */
export const ThemeChromeChannels = Object.freeze({
  Snapshot: IpcChannels.ThemeChromeSnapshot,
  Changed: IpcChannels.ThemeChromeChanged,
  Action: IpcChannels.ThemeChromeAction,
  Ready: IpcChannels.ThemeChromeReady
})
