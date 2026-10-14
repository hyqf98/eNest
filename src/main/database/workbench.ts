/** Main-process dispatch only. Native drivers and business work stay in dbUtility. */
import type { DbWorkbenchRequest } from '@shared/types/db-workbench'
import type { PluginPermission } from '@shared/types/plugin'
import { dbWorkbenchRpc } from '@main/database/dbSessionManager'

export function dbWorkbenchPermission(action: string): PluginPermission {
  switch (action) {
    case 'drivers.list': case 'test': return 'db.connect'
    case 'redis.scan': case 'inspect': case 'table.design.preview': return 'db.schema'
    case 'table.page': case 'table.design.apply': case 'execute': case 'browse': case 'cancel': case 'transaction': case 'compare': return 'db.query'
    default: throw new Error(`Unknown database workbench action: ${String(action)}`)
  }
}
export function dbWorkbenchCall(pluginId: string, request: DbWorkbenchRequest): Promise<unknown> {
  if (!request || typeof request !== 'object') return Promise.reject(new Error('Invalid workbench request'))
  dbWorkbenchPermission(request.action)
  return dbWorkbenchRpc(pluginId, request)
}
