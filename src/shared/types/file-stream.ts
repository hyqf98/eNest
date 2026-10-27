/** Ordered, owner-private temporary output. No arbitrary filesystem paths are accepted. */
export interface FileStreamOpen {
  /** 1..12 lowercase letters/digits; "part" is reserved for incomplete streams. */
  extension: string
}
export interface FileStreamResult {
  /** Stable private output ID, accepted by storage.files after finish. */
  id: string
  /** @deprecated Display-only compatibility value; use storage.files to read, remove or export. */
  path: string
  size: number
}
export interface FileStreamsApi {
  open(options: FileStreamOpen): Promise<{ streamId: string }>
  write(streamId: string, sequence: number, bytes: ArrayBuffer): Promise<void>
  finish(streamId: string): Promise<FileStreamResult>
  abort(streamId: string): Promise<boolean>
}

export interface PluginStoredFile { id: string; extension: string; size: number; createdAt: number }
export interface PluginStoredFileListOptions { cursor?: string; limit?: number }
export interface PluginStoredFilePage { items: PluginStoredFile[]; nextCursor: string | null }
export interface PluginStoredFileReadOptions {
  /** Nonnegative safe integer. At or beyond EOF returns an empty buffer. */
  offset?: number
  /** 1..524288 bytes; defaults to 524288. Zero is not a valid read length. */
  length?: number
}
export interface PluginStoredFileChunk {
  file: PluginStoredFile
  offset: number
  bytes: ArrayBuffer
  nextOffset: number | null
}
export interface PluginStoredFileExportOptions { defaultName?: string }
export interface PluginStoredFileExportResult { ok: true; path: string; size: number }
export interface PluginStoredFilesApi {
  /** UUID-ordered pages, default 100 and at most 200 entries. Pass nextCursor back unchanged. */
  list(options?: PluginStoredFileListOptions): Promise<PluginStoredFilePage>
  get(id: string, options?: PluginStoredFileReadOptions): Promise<PluginStoredFileChunk | null>
  /** Removes the completed private file and releases its storage quota. Missing IDs return false. */
  remove(id: string): Promise<boolean>
  /** Native save confirmation is mandatory. Cancel returns null; no arbitrary target path is accepted. */
  export(id: string, options?: PluginStoredFileExportOptions): Promise<PluginStoredFileExportResult | null>
}
