import type { DesktopDipBounds } from './plugin'

/** Auxiliary pages are untrusted plugin assets, not additional plugin API surfaces. */
export interface AuxiliaryOpen {
  entry: string
  data?: unknown
  title?: string
  bounds?: { x?: number; y?: number; width?: number; height?: number }
  placement?: 'window' | 'display'
  displayId?: number
  visible?: boolean
  transparent?: boolean
  resizable?: boolean
  movable?: boolean
  alwaysOnTop?: boolean
  /** Default true. Passive restored surfaces must not steal desktop focus. */
  focus?: boolean
  /** Native mouse routing; CSS pointer-events cannot pass clicks to other apps. */
  interaction?: 'capture' | 'passthrough'
  /**
   * Exclude this surface from screen capture. Windows 10 2004+ uses
   * WDA_EXCLUDEFROMCAPTURE; macOS sets NSWindowSharingNone (ScreenCaptureKit
   * tools may still see it). Linux has no equivalent and ignores this flag.
   */
  contentProtection?: boolean
  /** A live auxiliary window of this same runtime, never another plugin's window. */
  parentWindowId?: string
  capture?: { displayId?: number; withAudio?: boolean }
}
export interface AuxiliaryUpdate {
  visible?: boolean
  focus?: boolean
  interaction?: 'capture' | 'passthrough'
  bounds?: { x?: number; y?: number; width?: number; height?: number }
}
export interface AuxiliaryWindowState {
  bounds: DesktopDipBounds
  viewportBounds?: DesktopDipBounds
  display: AuxiliaryContext['display']
  interaction: 'capture' | 'passthrough'
}
export interface AuxiliaryContext {
  windowId: string
  data: unknown
  display: DesktopDipBounds & { id: number; scaleFactor: number }
  viewportBounds?: DesktopDipBounds
  capture?: { withAudio: boolean }
}
export type AuxiliaryEvent =
  | { type: 'auxiliary.message'; windowId: string; data: unknown }
  | { type: 'auxiliary.closed'; windowId: string }
  | { type: 'auxiliary.changed'; windowId: string; state: AuxiliaryWindowState }
export interface AuxiliaryApi {
  open(options: AuxiliaryOpen): Promise<{ windowId: string }>
  send(windowId: string, data: unknown, options?: AuxiliaryUpdate): Promise<void>
  close(windowId: string): Promise<boolean>
  list(): Promise<Array<{ windowId: string; entry: string }>>
}
export interface AuxiliaryPageApi {
  getContext(): Promise<AuxiliaryContext>
  onMessage(callback: (data: unknown) => void): () => void
  post(data: unknown): Promise<void>
  close(): Promise<void>
}
