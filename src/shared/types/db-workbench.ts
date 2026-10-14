import type { DbTablePage, DbTableDesign } from '@shared/types/db-table-operations'
import type { DbConnectionConfig, DbExecuteInput, QueryResult, TableRef } from '@shared/types/ssh-db'

export type DbFeatureState = 'available' | 'unsupported' | 'permission-denied' | 'not-configured' | 'error'
export interface DbCapability { state: DbFeatureState; reason?: string }
export interface DbDriverDescriptor {
  id: string
  label: string
  family: string
  language: 'sql' | 'mongodb' | 'redis' | 'flux' | 'cypher' | 'cql' | 'json'
  defaultPort?: number
  transport: 'native' | 'http' | 'websocket' | 'file'
  compatibility?: string
  capabilities: Record<string, DbCapability>
}
export interface DbWorkbenchExecuteInput extends DbExecuteInput {
  executionId?: string
  /** Quick rejects writes and limits returned rows to 200. */
  surface?: 'quick' | 'shell'
}
export interface DbExecutionResult {
  executionId: string
  results: QueryResult[]
  durationMs: number
  state: 'completed' | 'cancelled'
}
export type DbInspectionKind = 'client' | 'sessions' | 'resources' | 'locks' | 'queries' | 'jobs'
export interface DbInspection {
  kind: DbInspectionKind
  state: DbFeatureState
  source: 'enest-client' | 'database-server'
  sampledAt: number
  reason?: string
  columns: Array<{ name: string; unit?: string }>
  rows: unknown[][]
  /** No host CPU/memory inference is made from database statistics. */
  note?: string
}
export interface DbCompareInput {
  left: { sessionKey: string; sql: string }
  right: { sessionKey: string; sql: string }
  keyColumns: string[]
  /** Key names refer to left columns. Explicit mappings define the compared projection. */
  columnMappings?: Array<{ left: string; right: string; rule?: DbCompareValueRule }>
  defaultRule?: DbCompareValueRule
  maxRows?: number
}
export type DbCompareValueRule = 'strict' | 'text' | 'numeric' | 'json'
export interface DbCompareResult {
  left: QueryResult
  right: QueryResult
  rows: Array<{ key: string; status: 'equal' | 'left-only' | 'right-only' | 'different' | 'ambiguous'; left?: unknown[]; right?: unknown[] }>
  partial: boolean
  snapshot: 'independent-query-snapshots'
  comparedAt: number
  columnMappings?: Array<{ left: string; right: string; rule: DbCompareValueRule }>
  coverage?: { leftRows: number; rightRows: number; leftTruncated: boolean; rightTruncated: boolean }
}
export type DbWorkbenchRequest =
  | { action: 'drivers.list'; input?: Record<string, never> }
  | { action: 'browse'; input: { sessionKey: string; table: TableRef; maxRows?: number; surface?: 'quick' | 'shell' } }
  | { action: 'redis.scan'; input: { sessionKey: string; cursor?: string; match?: string; count?: number } }
  | { action: 'table.page'; input: DbTablePage & { sessionKey: string; surface?: 'quick' | 'shell' } }
  | { action: 'table.design.preview'; input: { sessionKey: string; design: DbTableDesign } }
  | { action: 'table.design.apply'; input: { sessionKey: string; design: DbTableDesign; confirmed?: boolean } }
  | { action: 'execute'; input: DbWorkbenchExecuteInput }
  | { action: 'cancel'; input: { sessionKey: string; executionId?: string } }
  | { action: 'transaction'; input: { sessionKey: string; operation: 'begin' | 'commit' | 'rollback' } }
  | { action: 'inspect'; input: { sessionKey: string; kind: DbInspectionKind } }
  | { action: 'compare'; input: DbCompareInput }
  | { action: 'test'; input: DbConnectionConfig }
