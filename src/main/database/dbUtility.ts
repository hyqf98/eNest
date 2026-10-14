/** Isolated database entry point. No BrowserWindow, vault or shell imports. */
import * as service from '@main/database/dbService'
import { dbWorkbenchService } from '@main/database/workbenchService'

const port = process.parentPort
if (!port) throw new Error('database service requires an Electron utility parent')
const methods: Record<string, (...args: never[]) => unknown> = {
  dbWorkbenchService, dbDialectsList: service.dbDialectsList,
  dbTest: service.dbTest, dbOpen: service.dbOpen, dbClose: service.dbClose,
  dbListSessions: service.dbListSessions, dbExecute: service.dbExecute,
  dbExplain: service.dbExplain, dbCancel: service.dbCancel,
  dbApplyChanges: service.dbApplyChanges, dbSchemaTree: service.dbSchemaTree,
  dbSchemaDescribe: service.dbSchemaDescribe, dbSchemaDdl: service.dbSchemaDdl,
  dbCompletion: service.dbCompletion, dbImportPreview: service.dbImportPreview,
  dbImportRun: service.dbImportRun, releaseDbSessions: service.releaseDbSessions
}
port.on('message', async ({ data }) => {
  const { id, pluginId, method, args = [], proxy } = data ?? {}
  if (!Number.isInteger(id) || typeof pluginId !== 'string' || !Object.hasOwn(methods, method)) return
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY']) {
    if (typeof proxy?.[key] === 'string') process.env[key] = proxy[key]
    else delete process.env[key]
  }
  try {
    const result = await methods[method]!(pluginId as never, ...args as never[])
    // Ensure a result cannot allocate an unbounded IPC message in the main process.
    const bytes = Buffer.byteLength(JSON.stringify(result, (_, value) => typeof value === 'bigint' ? value.toString() : value) ?? '')
    if (bytes > 8 * 1024 * 1024) throw new Error('database result exceeds 8 MiB; narrow the query')
    port.postMessage({ id, ok: true, data: result })
  } catch (error) {
    port.postMessage({ id, ok: false, error: error instanceof Error ? error.message : String(error) })
  }
})
