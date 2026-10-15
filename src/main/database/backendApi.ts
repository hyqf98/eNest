/** Compatibility RPC contract. Implementations and drivers belong to the plugin backend. */
import type {
  BatchResult, CompletionResponse, DbApplyChangesInput, DbCompletionInput,
  DbConnectionConfig, DbDialectInfo, DbExecuteInput, DbImportPreviewInput,
  DbImportPreviewResult, DbImportRunInput, DbImportRunResult, DbSchemaTreeInput,
  DbSessionInfo, DbTestResult, QueryResult, SchemaObject, TableDetail
} from '@shared/types/ssh-db'

type TableInput = { sessionKey: string; database?: string; schema?: string; table: string }
export interface DatabaseBackendApi {
  dbOpen(pluginId: string, input: { config: DbConnectionConfig; sessionKey?: string } | DbConnectionConfig): Promise<DbSessionInfo>
  dbTest(pluginId: string, config: DbConnectionConfig): Promise<DbTestResult>
  dbClose(pluginId: string, sessionKey: string): Promise<boolean>
  dbExecute(pluginId: string, input: DbExecuteInput): Promise<QueryResult>
  dbExplain(pluginId: string, input: { sessionKey: string; sql: string }): Promise<QueryResult>
  dbCancel(pluginId: string, input: string | { sessionKey?: string; executionId?: string }): Promise<boolean>
  dbApplyChanges(pluginId: string, input: DbApplyChangesInput): Promise<BatchResult>
  dbSchemaTree(pluginId: string, input: DbSchemaTreeInput): Promise<SchemaObject[]>
  dbSchemaDescribe(pluginId: string, input: TableInput): Promise<TableDetail>
  dbSchemaDdl(pluginId: string, input: TableInput): Promise<string>
  dbCompletion(pluginId: string, input: DbCompletionInput): Promise<CompletionResponse>
  dbDialectsList(pluginId: string): Promise<DbDialectInfo[]>
  dbImportPreview(pluginId: string, input: DbImportPreviewInput): Promise<DbImportPreviewResult>
  dbImportRun(pluginId: string, input: DbImportRunInput): Promise<DbImportRunResult>
}
