import type { PluginLaunchMode, AnimationLevel, BackgroundConfig } from './plugin'
import type { QuickInputMessage, QuickInputState } from './plugin-tools'
import type { ShellEventPayload } from './ipc'
import type { ResolvedBackgroundEffect } from '@shared/backgroundEffects'

/** Presentation mode stays compatible with the plugin SDK; placement is host-only. */
export type PluginPlacement = { kind: 'shell' } | { kind: 'quick' } | { kind: 'detached'; windowId: number }
export interface WindowPoint { x: number; y: number }
export interface WindowRect extends WindowPoint { width: number; height: number }
export interface DetachedPluginState {
  pluginId: string
  title: string
  mode: PluginLaunchMode
  generation: number
  status: 'lazy' | 'loading' | 'ready' | 'error' | 'hibernated'
  alwaysOnTop?: boolean
  icon?: string | null
  glyph?: string
  badge?: string
  input?: QuickInputState | null
  appearance?: {
    theme: 'light' | 'dark'
    tokens: Record<string, string>
    animationLevel: AnimationLevel
    /** Host-resolved background for chrome and the area below transparent plugin content. */
    backgroundEffect?: ResolvedBackgroundEffect | null
    /** Current color atmosphere; media retains its existing effects-off behavior. */
    background?: BackgroundConfig | null
    fontFamily?: string
    fontFamilyEn?: string
    fontSizeScale?: number
    locale?: string
  }
}
export type PluginWindowCommand =
  | { action: 'detach'; pluginId: string }
  | { action: 'dock'; pluginId: string; target: 'shell' | 'quick'; index?: number }
  | { action: 'minimize' | 'maximize' | 'close' | 'retry' | 'activate' | 'toggle-always-on-top' | 'focus-plugin' | 'focus-search' }
  | { action: 'input'; message?: QuickInputMessage }
  | { action: 'input-tab'; shift?: boolean }
export interface PluginDropTarget {
  kind: 'shell' | 'quick'
  rect: WindowRect
  axis: 'x' | 'y'
  items: Array<{ pluginId: string; rect: WindowRect }>
}
export interface PluginDragFeedback {
  active: boolean
  /** Correlates feedback with the host-owned drag session, including its final event. */
  token?: string
  pluginId?: string
  target?: 'shell' | 'quick' | 'outside' | null
  index?: number
  point?: WindowPoint
  /** Main converts the screen cursor to each receiving native surface's local DIP. */
  localPoint?: WindowPoint
}
export type PluginWindowEvent = { type: 'state'; state: DetachedPluginState } | { type: 'shell'; event: ShellEventPayload }
/** Rectangles are renderer-local DIP; only main resolves their native surface origin. */
export interface PluginWindowsApi {
  /** Protect visible docking surfaces between pointer-down and the drag threshold. */
  armDrag(pluginId: string | null): void
  getState(): Promise<DetachedPluginState | null>
  command(command: PluginWindowCommand): Promise<{ ok: boolean; error?: string }>
  beginDrag(pluginId: string): Promise<{ token: string } | null>
  updateDrag(token: string): void
  endDrag(token: string, cancel?: boolean): Promise<void>
  targets(targets: PluginDropTarget[]): void
  onDrag(callback: (event: PluginDragFeedback) => void): () => void
  onEvent(callback: (event: PluginWindowEvent) => void): () => void
}
