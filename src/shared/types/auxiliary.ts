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
  capture?: { displayId?: number; withAudio?: boolean }
}
export interface AuxiliaryContext {
  windowId: string
  data: unknown
  display: { id: number; x: number; y: number; width: number; height: number; scaleFactor: number }
  capture?: { withAudio: boolean }
}
export type AuxiliaryEvent =
  | { type: 'auxiliary.message'; windowId: string; data: unknown }
  | { type: 'auxiliary.closed'; windowId: string }
export interface AuxiliaryApi {
  open(options: AuxiliaryOpen): Promise<{ windowId: string }>
  send(windowId: string, data: unknown, options?: { visible?: boolean }): Promise<void>
  close(windowId: string): Promise<boolean>
  list(): Promise<Array<{ windowId: string; entry: string }>>
}
export interface AuxiliaryPageApi {
  getContext(): Promise<AuxiliaryContext>
  onMessage(callback: (data: unknown) => void): () => void
  post(data: unknown): Promise<void>
  close(): Promise<void>
}
