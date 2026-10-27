export type QuickInputAction = 'next' | 'previous' | 'submit' | 'clear'
export interface QuickInputConfig { placeholder: string; value: string }
export interface QuickInputState extends QuickInputConfig { pluginId: string; generation: number }
export type QuickInputMessage = { pluginId: string; generation: number } & (
  { type: 'change'; value: string } | { type: 'action'; action: QuickInputAction } | { type: 'escape' }
)
export interface PluginBlob { id: string; bytes: number }
export interface PluginAssetMeta { assetId: string; name: string; mime: string; bytes: number; createdAt: number }
export type PluginAsset = PluginAssetMeta
export interface PluginAssetPutInput { bytes: ArrayBuffer; mime: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'; name?: string; assetId?: string }
export interface PluginAssetPutResult extends PluginAsset { path: string }
export interface PluginAssetGetResult { dataUrl: string; mime: string; bytes: number }
export interface PluginFileSaveResult { ok: boolean; path: string }
export interface ClipboardCapabilities {
  files: boolean; sourceApp: boolean; paste: boolean; permissionRequired: boolean; reason?: string
}
export interface ClipboardFileInspection { path: string; exists: boolean | null; directory?: boolean }
