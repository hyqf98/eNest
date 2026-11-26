export interface FileSearchPreferences {
  enabled: boolean
  roots: string[]
  paused: boolean
  everythingPort?: number
}

export type FileSearchPreferenceRequest =
  | { operation: 'read' | 'add-root' | 'clear' }
  | { operation: 'enable' | 'pause'; value: boolean }
  | { operation: 'remove-root'; index: number }
  | { operation: 'everything'; port: number | null }

export interface FileSearchItem {
  id: string
  name: string
  parent: string
  kind: 'file' | 'directory'
}

export type FileSearchRequest =
  | { operation: 'status' | 'cancel' }
  | { operation: 'query'; query: string; scope: 'mixed' | 'files' }
  | { operation: 'open' | 'reveal'; id: string }

export interface FileSearchResult {
  status: 'off' | 'ready' | 'unavailable' | 'stale' | 'failed'
  items?: FileSearchItem[]
  more?: boolean
  limited?: boolean
  provider?: string
}

export type SearchFiles = (request: FileSearchRequest) => Promise<FileSearchResult>
