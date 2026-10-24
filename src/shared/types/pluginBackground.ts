/** Declarative, event-driven browser background owned by an enabled plugin. */
export interface PluginBackgroundManifest {
  entry: string
  events?: string[]
  /** Event-to-plugin-switch binding; the host treats both names as opaque declarations. */
  eventSettings?: Record<string, string>
  quickSearch?: boolean
}

export interface PluginBackgroundBlob {
  id: string
  bytes: number
}

export interface PluginBackgroundLegacyDocument {
  /** Opaque source identity. Commit must reject a changed source. */
  token: string
  document: string
}

export interface PluginBackgroundSearchItem {
  id: string
  title: string
  subtitle?: string
  code?: string
  payload?: unknown
}

export interface PluginBackgroundHost {
  private: {
    readDocument(key: string): Promise<unknown | null>
    /** Atomic replacement; a successful result means durable storage, not a queued write. */
    writeDocument(key: string, value: unknown): Promise<void>
    getBlob(id: string): Promise<{ dataUrl: string; bytes: number } | null>
    /** Optional stable ID makes interrupted imports retryable without duplicating blobs. */
    putBlob(input: { id?: string; dataUrl: string }): Promise<PluginBackgroundBlob>
    removeBlob(id: string): Promise<boolean>
  }
  settings: {
    get(): Promise<Record<string, unknown>>
  }
  /** Event is delivered only to the same plugin's live UI. It does not wake another background. */
  emit(event: string, data?: unknown): Promise<void>
  legacy: {
    /** Sources are fixed host migration entries, never paths supplied by a plugin. */
    read(source: string): Promise<PluginBackgroundLegacyDocument | null>
    getBlob(source: string, token: string, name: string): Promise<{ dataUrl: string; bytes: number } | null>
    /** Writes a one-way marker after the plugin has durably committed its private document. */
    commit(source: string, token: string): Promise<void>
  }
}

export interface PluginBackgroundHandlers {
  onEvent?(event: string, data: unknown): void | Promise<void>
  call(method: string, args: unknown[]): unknown | Promise<unknown>
  search?(query: string, limit: number): PluginBackgroundSearchItem[] | Promise<PluginBackgroundSearchItem[]>
}

export interface PluginBackgroundBridge {
  host: PluginBackgroundHost
  /** One registration per document; operation ACK is sent only after the handler settles. */
  register(handlers: PluginBackgroundHandlers): void
}

export interface ClipboardNativeSnapshot {
  revision: number
  capturedAt: number
  type: 'text' | 'image' | 'files'
  text?: string
  dataUrl?: string
  width?: number
  height?: number
  files?: Array<{ path: string; name: string }>
  sourceApp?: { name: string; id?: string; evidence: 'owner' }
}
