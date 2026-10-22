import type { AnimationLevel } from './plugin'

export type NotificationLevel = 'info' | 'success' | 'warn' | 'error'
export type PluginToastType = NotificationLevel
export type NotificationFormat = 'text' | 'html' | 'markdown'
export type NotificationPosition = 'top' | 'center' | 'bottom-right'

export interface NotificationOptions {
  title?: string
  body?: string
  format?: NotificationFormat
  /** Defaults to bottom-right. top remains available for older host callers. */
  position?: NotificationPosition
  level?: NotificationLevel
  /** 0 keeps the card until dismissed; otherwise 1500–60000 ms. */
  duration?: number
}

/** New and legacy toast calls share one payload and one rendering path. */
export interface PluginToastOptions extends NotificationOptions {
  /** @deprecated Use body. */
  message?: string
  /** @deprecated Use level. */
  type?: PluginToastType
}

export interface NotificationItem {
  id: number
  title: string
  body: string
  format: NotificationFormat
  position: NotificationPosition
  level: NotificationLevel
  duration: number
  /** Host assigned identity; plugins cannot impersonate another source. */
  source?: string
}

export interface NotificationOverlayState {
  items: NotificationItem[]
  position: NotificationPosition
  animationLevel: AnimationLevel
  theme: { mode: 'light' | 'dark'; tokens: Record<string, string> }
  visible: boolean
  appearance?: import('./appearance').ResolvedAppearance
}

export interface NotificationClientApi {
  show(options: NotificationOptions): Promise<number>
  dismiss(id: number): Promise<void>
}

export interface NotificationOverlayApi {
  getState(): Promise<NotificationOverlayState>
  onState(listener: (state: NotificationOverlayState) => void): () => void
  dismiss(id: number): Promise<void>
  measure(height: number): void
  openLink(url: string): Promise<void>
}
