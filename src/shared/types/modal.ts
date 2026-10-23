import type { ResolvedAppearance } from './appearance'
import type { PluginDirtyState, UpdateStatePayload } from './ipc'

export interface ConfirmationOptions { title: string; message: string; confirmLabel: string; danger?: boolean }
export type NativeModalRequest = { kind: 'confirm'; options: ConfirmationOptions } | { kind: 'update' }
export type NativeModalAction = 'confirm' | 'cancel' | 'download' | 'retry' | 'install' | 'release'
export interface NativeModalState {
  id: number
  kind: NativeModalRequest['kind']
  options?: ConfirmationOptions
  update?: UpdateStatePayload
  dirtyItems: PluginDirtyState['items']
  saving: boolean
  error?: string
  locale: 'zh-CN' | 'en-US'
  appearance: ResolvedAppearance
}
export interface NativeModalApi {
  ready(painted?: { id: number; revision: number }): void
  onState(listener: (state: NativeModalState) => void): () => void
  respond(id: number, action: NativeModalAction): void
}
