import type { PluginEnterPayload, PluginLaunchTarget } from './plugin'

/** Execution is independent of the layout used when a view is actually presented. */
export type PluginFeatureActivation = { type: 'view'; target?: PluginLaunchTarget } | { type: 'command' }
export interface PluginActivationDeclaration {
  indexSync?: boolean
  /**
   * The host restores this command only while its declared boolean setting is true.
   * The setting may live solely in `activation.resident` (with `default`) instead of
   * a `contributes.settings` section; the plugin then owns its own settings UI.
   */
  resident?: { setting: string; code: string; default?: boolean }
}
export type PluginActivationContext = 'view' | 'command' | 'index-sync' | 'resident'
export type PluginActivationReason = 'quick' | 'workspace' | 'shortcut' | 'settings' | 'open-with' | 'index-sync' | 'resident-restore' | 'resident-setting'

/** Public searchable text and a private, small business reference; never credentials. */
export interface PluginLaunchIndexEntry {
  id: string
  code: string
  title: string
  subtitle?: string
  aliases?: string[]
  payload?: unknown
}
export interface PluginLaunchIndexState { revision: number; dirty: boolean }
/** Function-based cancellation survives Electron's isolated contextBridge. */
export interface PluginActivationSignal {
  isAborted(): boolean
  throwIfAborted(): void
  onAbort(callback: () => void): () => void
}
export interface PluginActivationRequest extends PluginEnterPayload {
  requestId: string
  reason: PluginActivationReason
  entryId?: string
  enabled?: boolean
  deadlineAt: number
  signal: PluginActivationSignal
  onCancel(callback: () => void): () => void
}
export type PluginCommandOutcome = { type: 'done' } | { type: 'view'; target: PluginLaunchTarget }
export interface PluginActivationHandlers {
  command?(request: PluginActivationRequest): PluginCommandOutcome | Promise<PluginCommandOutcome>
  indexSync?(request: PluginActivationRequest): PluginLaunchIndexEntry[] | Promise<PluginLaunchIndexEntry[]>
  /** Install view listeners and finish lazy business initialization before enter is sent. */
  prepareView?(request: PluginActivationRequest): void | Promise<void>
}
export interface PluginLaunchApi {
  getContext(): PluginActivationContext
  /** One registration per document. Resolves only after the host acknowledges this incarnation. */
  registerHandlers(handlers: PluginActivationHandlers): Promise<void>
}
export interface PluginActivationRegistration {
  registrationId: string
  /**
   * 旧文档在重载/关闭前发出的迟到注册：宿主代次已换，注册未生效。
   * 前端按"静默放弃"处理——这不是错误，下一次加载会重新注册。
   */
  retired?: boolean
}
export interface PluginActivationDispatch extends Omit<PluginActivationRequest, 'signal' | 'onCancel'> {
  registrationId: string
  kind: 'command' | 'index-sync' | 'prepare-view'
}
export interface PluginActivationResult {
  requestId: string
  registrationId: string
  ok: boolean
  value?: unknown
  error?: string
}
