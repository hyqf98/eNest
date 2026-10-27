import type { McpErrorCode, McpToolDeclaration } from './mcp'

export interface McpConfiguration { enabled: boolean; port: number }
export interface McpCatalogTool extends McpToolDeclaration { pluginId: string; pluginName: string }
export interface McpCatalogQuery { pluginId?: string; query?: string; cursor?: string; limit?: number }
export interface McpCatalogPage { tools: McpCatalogTool[]; nextCursor?: string }
export interface McpCallRecord {
  requestId: string
  startedAt: number
  source: string
  pluginId: string
  toolId: string
  status: 'success' | 'error' | 'cancelled'
  durationMs: number
  errorCode?: McpErrorCode
}
export interface McpStatus {
  configuration: McpConfiguration
  state: 'disabled' | 'starting' | 'running' | 'error'
  endpoint: string
  sessionCount: number
  activeCalls: number
  error?: string
  recentCalls: McpCallRecord[]
}
