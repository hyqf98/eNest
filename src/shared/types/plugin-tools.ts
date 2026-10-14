export type QuickInputAction = 'next' | 'previous' | 'submit' | 'clear'
export interface QuickInputConfig { placeholder: string; value: string }
export interface QuickInputState extends QuickInputConfig { pluginId: string; generation: number }
export type QuickInputMessage = { pluginId: string; generation: number } & (
  { type: 'change'; value: string } | { type: 'action'; action: QuickInputAction } | { type: 'escape' }
)
export interface PluginBlob { id: string; bytes: number }
export interface PluginFileSaveResult { ok: boolean; path: string }
export interface ClipboardSourceApp { name: string; id?: string; evidence: 'owner' }
export interface ClipboardFile { name: string; path: string; exists?: boolean; directory?: boolean }
export interface ClipboardCapabilities {
  files: boolean; sourceApp: boolean; paste: boolean; permissionRequired: boolean; reason?: string
}
export interface ClipboardQuery {
  query?: string; type?: 'text' | 'image' | 'files'; pinned?: boolean; cursor?: number; limit?: number
}
