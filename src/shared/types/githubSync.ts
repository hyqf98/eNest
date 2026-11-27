export const DEFAULT_SYNC_REPOSITORY = 'enest-sync'
export const SYNC_SNAPSHOT_LIMIT = 16 * 1024 * 1024

export interface SyncRepository { id: number; name: string }
export interface CloudPlugin { pluginId: string; bytes: number; sha: string }
export type SyncDirection = 'upload' | 'restore'
export interface SyncConflict { local: string; remote: string | null }
export interface SyncOutcome {
  pluginId: string
  status: 'done' | 'unchanged' | 'conflict' | 'skipped' | 'error'
  message?: string
  conflict?: SyncConflict
}
export interface SyncReport { direction: SyncDirection; completedAt: number; items: SyncOutcome[]; cancelled?: boolean }
export interface SyncProgress { done: number; total: number; pluginId: string }
export interface GithubSyncState {
  repository: SyncRepository | null
  autoRestore: boolean
  installationUrl: string
  cloud: CloudPlugin[]
  report: SyncReport | null
  progress: SyncProgress | null
  error?: string
}
export interface SyncTransfer {
  accountId: number
  repositoryId: number
  direction: SyncDirection
  pluginIds: string[]
  resolve?: SyncConflict
}
