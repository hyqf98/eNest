/** Main-process dispatch only. 子进程与业务逻辑在 dshRuntimeService / dshProfileService / dshUpgradeService。 */
import type { DshSdkStartInput, DshWorkbenchRequest } from '@shared/types/dsh-workbench'
import { DSH_ADMIN_ACTIONS, DSH_CHAT_ACTIONS } from '@shared/types/dsh-workbench'
import type { PluginPermission } from '@shared/types/plugin'
import { detectRuntime, logsTail, runtimeStatus, sdkRpc, startSdk, startWeb, stopSdk, stopWeb } from '@main/dsh/dshRuntimeService'
import {
  createBackup,
  createProfile,
  deleteBackup,
  deleteProfile,
  listBackups,
  listProfiles,
  listSessions,
  readSessionEvents,
  restoreBackup
} from '@main/dsh/dshProfileService'
import {
  activateRuntimeVersion,
  installRuntimeVersion,
  listRemoteVersions,
  oneClickUpgrade,
  removeRuntimeVersion
} from '@main/dsh/dshUpgradeService'
import { installedVersions } from '@main/dsh/dshUpgradeService'

/** dsh.workbench 三档权限映射：连接读取 / 会话写入 / 进程与配置管理 */
export function dshWorkbenchPermission(action: string): PluginPermission {
  switch (action) {
    case 'runtime.detect': case 'runtime.status':
    case 'sessions.list': case 'sessions.read':
    case 'profiles.list': case 'backup.list':
    case 'runtime.versions.list': case 'runtime.versions.available':
    case 'logs.tail':
      return 'dsh.connect'
    default:
      if (DSH_CHAT_ACTIONS.includes(action)) return 'dsh.chat'
      if (DSH_ADMIN_ACTIONS.includes(action)) return 'dsh.admin'
      throw new Error(`Unknown dsh workbench action: ${String(action)}`)
  }
}

function rpcReadMethods(request: Extract<DshWorkbenchRequest, { action: 'rpc.call' }>): boolean {
  return request.input.method === 'session/wait' || request.input.method === 'session/working-directory/get'
}

export async function dshWorkbenchCall(pluginId: string, request: DshWorkbenchRequest): Promise<unknown> {
  if (!request || typeof request !== 'object') throw new Error('Invalid workbench request')
  const action = request.action
  switch (action) {
    // —— dsh.connect ——
    case 'runtime.detect': return detectRuntime()
    case 'runtime.status': return runtimeStatus()
    case 'sessions.list': return listSessions(Number((request as { input?: { limit?: number } }).input?.limit ?? 50))
    case 'sessions.read': {
      const input = (request as { input: { sessionId: string; maxEvents?: number } }).input
      return readSessionEvents(input.sessionId, input.maxEvents ?? 200)
    }
    case 'profiles.list': return listProfiles()
    case 'backup.list': return listBackups()
    case 'runtime.versions.list': return installedVersions()
    case 'runtime.versions.available': return listRemoteVersions(pluginId, Number((request as { input?: { limit?: number } }).input?.limit ?? 20))
    case 'logs.tail': {
      const input = (request as { input: { kind: 'web' | 'sdk'; lines?: number } }).input
      return logsTail(input.kind, input.lines ?? 50)
    }
    // —— dsh.chat ——
    case 'sdk.start': return startSdk(pluginId, (request as { input: DshSdkStartInput }).input)
    case 'sdk.stop': return stopSdk(pluginId)
    case 'rpc.call':
    case 'rpc.write': {
      // rpc.call 只读方法 / rpc.write 写方法；workbench 类型已约束方法集
      const input = (request as { input: { method: string; params: Record<string, unknown> } }).input
      if (action === 'rpc.call' && !rpcReadMethods(request as Extract<DshWorkbenchRequest, { action: 'rpc.call' }>)) {
        throw new Error(`rpc.call 不允许写方法: ${input.method}`)
      }
      return sdkRpc(pluginId, input.method, input.params)
    }
    // —— dsh.admin ——
    case 'web.start': {
      const input = (request as { input?: { profile?: string; port?: number } }).input
      return startWeb(pluginId, input ?? {})
    }
    case 'web.stop': return stopWeb(pluginId)
    case 'web.restart': {
      const input = (request as { input?: { profile?: string; port?: number } }).input
      stopWeb(pluginId)
      return startWeb(pluginId, input ?? {})
    }
    case 'profiles.create': {
      const input = (request as { input: { name: string; template: string } }).input
      await createProfile(input.name, input.template)
      return { ok: true }
    }
    case 'profiles.delete': {
      const input = (request as { input: { name: string; backupFirst?: boolean } }).input
      return { backupId: deleteProfile(input.name, input.backupFirst !== false) }
    }
    case 'profiles.backup': {
      const input = (request as { input: { name: string } }).input
      return { backupId: createBackup('profile', undefined, input.name) }
    }
    case 'backup.create': return { backupId: createBackup('home', (request as { input?: { label?: string } }).input?.label) }
    case 'backup.restore': {
      // 恢复会覆盖 profiles/凭据/会话：先停 dsh 进程，避免运行中被换目录
      stopWeb(pluginId)
      stopSdk(pluginId)
      restoreBackup((request as { input: { backupId: string } }).input.backupId)
      return { ok: true }
    }
    case 'backup.delete': {
      deleteBackup((request as { input: { backupId: string } }).input.backupId)
      return { ok: true }
    }
    case 'runtime.download': return installRuntimeVersion(pluginId, (request as { input: { version: string } }).input.version).then(() => ({ ok: true }))
    case 'runtime.activate': return activateRuntimeVersion(pluginId, (request as { input: { version: string } }).input.version).then(() => ({ ok: true }))
    case 'runtime.remove': {
      removeRuntimeVersion((request as { input: { version: string } }).input.version)
      return { ok: true }
    }
    case 'upgrade.oneClick': return oneClickUpgrade(pluginId, (request as { input: { version: string } }).input.version)
    case 'profiles.restore': {
      // profile 级恢复复用备份恢复通道（备份 scope=profile）
      restoreBackup((request as { input: { backupId: string } }).input.backupId)
      return { ok: true }
    }
    default:
      throw new Error(`Unknown dsh workbench action: ${String(action)}`)
  }
}
