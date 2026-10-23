/**
 * Host-owned workspace navigation targets.
 *
 * The catalog is one surface: its internal views (marketplace / installed, category
 * filters, search scope) belong to the Home provider, not to the host route. Only real
 * navigations the host must be able to replay after a crash or provider switch live here.
 */
export type WorkspacePage = 'catalog' | 'detail'
export type WorkspaceRoute =
  | { page: 'catalog' }
  | { page: 'detail'; pluginId: string }

export interface WorkspaceNavigationAck {
  generation: number
  requestId: string
  ok: boolean
}
