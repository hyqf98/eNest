import type { PluginStoredFilesApi } from '@shared/types/file-stream'

/** Plugin-private storage contracts; filesystem paths never grant file access. */
export interface PluginBlob { id: string; bytes: number }

export type PluginAssetMime = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'

export interface PluginAssetMeta {
  /** Opaque identifier. Pass it back unchanged, including any existing suffix. */
  assetId: string
  name: string
  mime: string
  bytes: number
  createdAt: number
}

export type PluginAsset = PluginAssetMeta

/** Supply exactly one representation; data URLs carry their own MIME type. */
export type PluginAssetPutInput = { name?: string; assetId?: string } & (
  | { bytes: ArrayBuffer; mime: PluginAssetMime; dataUrl?: never }
  | { dataUrl: string; bytes?: never; mime?: never }
)

export interface PluginAssetPutResult extends PluginAsset {
  /** @deprecated Compatibility only. Render with assets.get(); this path grants no filesystem access. */
  path: string
}

export interface PluginAssetGetResult { dataUrl: string; mime: string; bytes: number }

export interface PluginAssetsApi {
  put(input: PluginAssetPutInput): Promise<PluginAssetPutResult>
  /** Includes this plugin's legacy attachments; no startup migration is required. */
  list(): Promise<PluginAsset[]>
  get(assetId: string): Promise<PluginAssetGetResult | null>
  remove(assetId: string): Promise<boolean>
  /** @deprecated Use remove(). This is an alias with identical behavior. */
  delete(assetId: string): Promise<boolean>
}

export interface PluginBlobsApi {
  put(input: { dataUrl: string; name?: string }): Promise<PluginBlob>
  get(id: string): Promise<{ dataUrl: string; bytes: number } | null>
  remove(id: string): Promise<boolean>
}

export interface PluginKeyValueStorageApi {
  get(key: string): Promise<unknown>
  set(key: string, value: unknown): Promise<boolean>
  remove(key: string): Promise<boolean>
  clear(): Promise<boolean>
}

export type PluginStorageOperation =
  | { op: 'set'; key: string; value: unknown }
  | { op: 'remove'; key: string; value?: never }

export interface PluginStorageCommitReceipt {
  /** Unique receipt, not a CAS token or a cross-domain transaction identifier. */
  commitId: string
  committedAt: number
  /** Distinct keys committed, including the plugin's previously queued changes. */
  committedKeys: number
}

export interface PluginStorageApi extends PluginKeyValueStorageApi {
  /** @deprecated Use assets. Compatibility adapter over the same private image service. */
  blobs: PluginBlobsApi
  assets: PluginAssetsApi
  /** Completed private outputs created by files.stream; no raw paths are accepted. */
  files: PluginStoredFilesApi
  /** Commit this plugin's prior queued KV writes with a SQLite FULL WAL sync. */
  flush(): Promise<PluginStorageCommitReceipt>
  /** Atomically commit 1-100 unique-key changes together with prior queued writes. */
  commit(operations: PluginStorageOperation[]): Promise<PluginStorageCommitReceipt>
  /** Clears persistent KV only; images, settings, session data and secrets are not removed. */
  clear(): Promise<boolean>
  /** In-memory KV, cleared on explicit plugin close; hibernation may restore its snapshot. */
  session: PluginKeyValueStorageApi
}
