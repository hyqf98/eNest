export type WorkspacePage = 'catalog' | 'installed' | 'detail'
export type WorkspaceRoute =
  | { page: 'catalog' | 'installed' }
  | { page: 'detail'; pluginId: string }

export interface WorkspaceNavigationAck {
  generation: number
  requestId: string
  ok: boolean
}
