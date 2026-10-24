/** Ordered, owner-private temporary output. No arbitrary filesystem paths are accepted. */
export interface FileStreamOpen { extension: string }
export interface FileStreamResult { id: string; path: string; size: number }
export interface FileStreamsApi {
  open(options: FileStreamOpen): Promise<{ streamId: string }>
  write(streamId: string, sequence: number, bytes: ArrayBuffer): Promise<void>
  finish(streamId: string): Promise<FileStreamResult>
  abort(streamId: string): Promise<boolean>
}
