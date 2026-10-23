import type { WorkspaceRoute } from '@shared/types/workspace'

/**
 * Host routes contain identities only, never URLs, package paths or executable input.
 * Catalog-internal views (marketplace / installed) are provider state and are rejected here.
 */
export function normalizeWorkspaceRoute(input: unknown): WorkspaceRoute {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid workspace route')
  const route = input as Record<string, unknown>
  if (route.page === 'catalog' && Object.keys(route).length === 1) return { page: 'catalog' }
  if (route.page === 'detail' && Object.keys(route).every(key => key === 'page' || key === 'pluginId') && typeof route.pluginId === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(route.pluginId)) {
    return { page: 'detail', pluginId: route.pluginId }
  }
  throw new Error('Invalid workspace route')
}
