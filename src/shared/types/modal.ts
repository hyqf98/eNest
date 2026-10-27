import type { ResolvedAppearance } from './appearance'
import type { PluginDirtyState, UpdateStatePayload } from './ipc'

export interface ConfirmationOptions { title: string; message: string; confirmLabel: string; danger?: boolean }
/** 「用哪个插件打开」选择项（多候选文件/scheme 打开时主进程下发） */
export interface OpenWithChoiceOption { pluginId: string; pluginName: string; icon?: string; glyph?: string; color?: string }
export type NativeModalRequest =
  | { kind: 'confirm'; options: ConfirmationOptions }
  | { kind: 'update' }
  | { kind: 'open-with-choice'; options: { title: string; message: string; value: string; choices: OpenWithChoiceOption[] } }
export type NativeModalAction = 'confirm' | 'cancel' | 'download' | 'retry' | 'install' | 'release' | `open-with:${string}`
export interface NativeModalState {
  id: number
  kind: NativeModalRequest['kind']
  options?: ConfirmationOptions
  openWith?: { value: string; choices: OpenWithChoiceOption[] }
  /** open-with-choice 确认后主进程写入被选 pluginId（渲染层经 finish 结果读取） */
  openWithPicked?: string
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
