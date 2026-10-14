/** Main-process dispatch only. Native drivers and business work stay in mwUtility. */
import type { MwWorkbenchRequest } from '@shared/types/mw-workbench'
import { MW_MUTATING_ACTIONS } from '@shared/types/mw-workbench'
import type { PluginPermission } from '@shared/types/plugin'
import { mwWorkbenchRpc } from '@main/middleware/mwSessionManager'

/** mw.workbench 三档权限映射：连接 / 只读浏览 / 变更管理 */
export function mwWorkbenchPermission(action: string): PluginPermission {
  switch (action) {
    case 'kinds.list': case 'test':
    case 'session.open': case 'session.close': case 'session.list': return 'mw.connect'
    case 'overview': case 'topics.list': case 'topic.describe':
    case 'exchanges.list': case 'bindings.list':
    case 'groups.list': case 'group.describe': case 'clients.list':
    case 'messages.query': case 'messages.get':
    case 'tail.start': case 'tail.stop':
    case 'configs.describe': case 'trace.message': case 'retained.list': return 'mw.query'
    default:
      // 其余全部为变更类（MW_MUTATING_ACTIONS 各项）；未知 action 直接拒绝
      if (MW_MUTATING_ACTIONS.includes(action)) return 'mw.admin'
      throw new Error(`Unknown middleware workbench action: ${String(action)}`)
  }
}
export function mwWorkbenchCall(pluginId: string, request: MwWorkbenchRequest): Promise<unknown> {
  if (!request || typeof request !== 'object') return Promise.reject(new Error('Invalid workbench request'))
  mwWorkbenchPermission(request.action)
  return mwWorkbenchRpc(pluginId, request)
}
