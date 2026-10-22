/** Main-process dispatch：严格 action/方法校验、宿主持久化选择和串行停机后的配置管理。 */
import type {
  DshProfileUpdateResult, DshSdkStartInput, DshSettingsUpdateResult,
  DshWorkbenchRequest, DshWorkbenchSettings
} from '@shared/types/dsh-workbench'
import { DSH_ADMIN_ACTIONS, DSH_CHAT_ACTIONS, DSH_CONNECT_ACTIONS } from '@shared/types/dsh-workbench'
import type { PluginPermission } from '@shared/types/plugin'
import {
  detectRuntime, logsTail, restartSdk, restartWeb, runtimeStatus, sdkRpc,
  startSdk, startWeb, stopAllDshAndWait, stopSdkAndWait, stopWebAndWait, withDshMaintenance
} from '@main/dsh/dshRuntimeService'
import {
  assertProfileCompatibility, createBackup, createProfile, deleteBackup, deleteProfile,
  listBackups, listProfiles, listSessions, readProfile, readSessionEvents, resetEnvironment,
  restoreBackup, syncProfiles, updateProfile, validateEnvironmentReset, validateProfileUpdate
} from '@main/dsh/dshProfileService'
import {
  installedVersions, installRuntimeVersion, listRemoteVersions, oneClickUpgrade,
  removeRuntimeVersion, switchDshRuntime
} from '@main/dsh/dshUpgradeService'
import { getDshSettings, updateDshSettings, validateDshProfileName, validateDshSettingsPatch } from '@main/dsh/dshSettingsStore'

/** 已知读取允许 connect；显式读取含密钥的 profile 编辑详情需要 admin。 */
export function dshWorkbenchPermission(action: string): PluginPermission {
  if (DSH_CONNECT_ACTIONS.includes(action)) return 'dsh.connect'
  if (DSH_CHAT_ACTIONS.includes(action)) return 'dsh.chat'
  if (DSH_ADMIN_ACTIONS.includes(action)) return 'dsh.admin'
  throw new Error(`Unknown dsh workbench action: ${String(action)}`)
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid workbench input')
  return value as Record<string, unknown>
}
function requiredText(value: unknown, label: string, maxLength = 256): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength || /[\0\r\n]/.test(value)) throw new Error(`Invalid ${label}`)
  return value
}
function sdkInput(value: unknown): DshSdkStartInput {
  const input = value === undefined ? {} : record(value)
  for (const key of Object.keys(input)) if (!['profile', 'cwd', 'provider', 'model', 'reasoningEffort', 'maxTokens'].includes(key)) throw new Error(`Unknown SDK start field: ${key}`)
  const next: DshSdkStartInput = {}
  if (input.profile !== undefined) next.profile = validateDshProfileName(input.profile)
  if (input.cwd !== undefined) next.cwd = requiredText(input.cwd, 'cwd', 4096)
  if (input.provider !== undefined) next.provider = requiredText(input.provider, 'provider')
  if (input.model !== undefined) next.model = requiredText(input.model, 'model')
  if (input.reasoningEffort !== undefined) next.reasoningEffort = requiredText(input.reasoningEffort, 'reasoningEffort', 80)
  if (input.maxTokens !== undefined) {
    if (typeof input.maxTokens !== 'number' || !Number.isSafeInteger(input.maxTokens) || input.maxTokens < 1) throw new Error('Invalid maxTokens')
    next.maxTokens = input.maxTokens
  }
  return next
}
function webInput(value: unknown, settings: DshWorkbenchSettings): { profile: string; port?: number } {
  const input = value === undefined ? {} : record(value)
  for (const key of Object.keys(input)) if (key !== 'profile' && key !== 'port') throw new Error(`Unknown Web start field: ${key}`)
  const profile = validateDshProfileName(input.profile ?? settings.webProfile)
  const port = input.port ?? (settings.webPortPolicy === 'fixed' ? settings.webPort : undefined)
  if (port !== undefined && (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535)) throw new Error('Invalid web port')
  return { profile, ...(port !== undefined ? { port: port as number } : {}) }
}
const STOPPED_MESSAGE = '配置已持久化，相关 DSH 进程已停止；下次启动时应用，不表示已热重载。'

async function maintenance<T>(pluginId: string, operation: () => T | Promise<T>): Promise<T> {
  return withDshMaintenance(pluginId, async () => {
    // 失败启动/退役实例也须确认退出，不能只按 running/initialized 决定是否等待。
    await stopAllDshAndWait(pluginId)
    return operation()
  })
}

export async function dshWorkbenchCall(pluginId: string, request: DshWorkbenchRequest): Promise<unknown> {
  if (!request || typeof request !== 'object' || Array.isArray(request)) throw new Error('Invalid workbench request')
  dshWorkbenchPermission(request.action)
  if ('input' in request && request.input !== undefined) record(request.input)
  switch (request.action) {
    // —— dsh.connect ——
    case 'runtime.detect': return detectRuntime(pluginId)
    case 'runtime.status': return runtimeStatus(pluginId)
    case 'settings.get': return getDshSettings()
    case 'sessions.list': return listSessions(request.input?.limit ?? 50)
    case 'sessions.read': return readSessionEvents(request.input.sessionId, request.input.maxEvents ?? 200)
    case 'profiles.list': return listProfiles()
    case 'backup.list': return listBackups()
    case 'runtime.versions.list': return installedVersions()
    case 'runtime.versions.available': return listRemoteVersions(pluginId, request.input?.limit ?? 20)
    case 'logs.tail': {
      if (request.input.kind !== 'web' && request.input.kind !== 'sdk') throw new Error('Invalid DSH log kind')
      return logsTail(request.input.kind, request.input.lines ?? 50, pluginId)
    }
    case 'rpc.call':
    case 'rpc.write': {
      const allowed = request.action === 'rpc.call'
        ? ['session/wait', 'session/working-directory/get']
        : ['session/prompt', 'session/working-directory/set']
      const input = request.input
      if (!allowed.includes(input.method)) throw new Error(`不允许的 ${request.action} 方法`)
      return sdkRpc(pluginId, input.method, record(input.params))
    }
    // —— dsh.chat ——
    case 'sdk.start': return withDshMaintenance(pluginId, async () => {
      const input = sdkInput(request.input)
      input.profile ??= getDshSettings().sdkProfile
      await assertProfileCompatibility(input.profile, 'sdk')
      return startSdk(pluginId, input)
    })
    case 'sdk.stop': {
      await stopSdkAndWait(pluginId)
      return { ok: true }
    }
    // —— dsh.admin ——
    case 'web.start': return withDshMaintenance(pluginId, async () => {
      const input = webInput(request.input, getDshSettings())
      await assertProfileCompatibility(input.profile, 'web')
      return startWeb(pluginId, input)
    })
    case 'web.stop': {
      await stopWebAndWait(pluginId)
      return { ok: true }
    }
    case 'web.restart': return withDshMaintenance(pluginId, async () => {
      const input = webInput(request.input, getDshSettings())
      await assertProfileCompatibility(input.profile, 'web')
      return restartWeb(pluginId, input)
    })
    case 'sdk.restart': return withDshMaintenance(pluginId, async () => {
      const input = sdkInput(request.input)
      input.profile ??= getDshSettings().sdkProfile
      await assertProfileCompatibility(input.profile, 'sdk')
      return restartSdk(pluginId, input)
    })
    case 'settings.update': return withDshMaintenance(pluginId, async () => {
      const patch = validateDshSettingsPatch(request.input)
      const next = { ...getDshSettings(), ...patch }
      await assertProfileCompatibility(next.webProfile, 'web')
      await assertProfileCompatibility(next.sdkProfile, 'sdk')
      await stopAllDshAndWait(pluginId)
      const settings = updateDshSettings(patch)
      return { ok: true, settings, application: 'stopped', message: STOPPED_MESSAGE } satisfies DshSettingsUpdateResult
    })
    case 'profiles.read': return readProfile(request.input.name)
    case 'profiles.create': return withDshMaintenance(pluginId, async () => {
      const input = request.input
      await createProfile(input.name, input.template)
      return { ok: true, profile: readProfile(input.name) }
    })
    case 'profiles.update': {
      const input = validateProfileUpdate(request.input)
      return maintenance(pluginId, () => ({
        ok: true, ...updateProfile(input), application: 'stopped', message: STOPPED_MESSAGE
      } satisfies DshProfileUpdateResult))
    }
    case 'profiles.sync': return maintenance(pluginId, () => ({
      ok: true, ...syncProfiles(request.input.source, request.input.target, request.input.scope),
      application: 'stopped', message: `${STOPPED_MESSAGE} 默认仅同步环境，目标应用角色保持不变。`
    } satisfies DshProfileUpdateResult))
    case 'profiles.delete': return maintenance(pluginId, () => ({
      ok: true, backupId: deleteProfile(request.input.name, request.input.backupFirst !== false),
      application: 'stopped', message: STOPPED_MESSAGE
    }))
    case 'profiles.backup': return maintenance(pluginId, () => ({ backupId: createBackup('profile', undefined, request.input.name) }))
    case 'backup.create': return maintenance(pluginId, () => ({ backupId: createBackup('home', request.input?.label) }))
    case 'backup.restore': return maintenance(pluginId, () => {
      restoreBackup(request.input.backupId)
      return { ok: true, application: 'stopped', message: STOPPED_MESSAGE }
    })
    case 'profiles.restore': return maintenance(pluginId, () => {
      restoreBackup(request.input.backupId, 'profile')
      return { ok: true, application: 'stopped', message: STOPPED_MESSAGE }
    })
    case 'backup.delete': return withDshMaintenance(pluginId, async () => {
      deleteBackup(request.input.backupId)
      return { ok: true }
    })
    case 'environment.reset': {
      const input = validateEnvironmentReset(request.input)
      return maintenance(pluginId, () => resetEnvironment(input))
    }
    case 'runtime.download': return withDshMaintenance(pluginId, async () => {
      await installRuntimeVersion(pluginId, request.input.version)
      return { ok: true }
    })
    case 'runtime.activate': return switchDshRuntime(pluginId, {
      version: request.input.version, source: request.input.source ?? 'data'
    })
    case 'runtime.remove': return withDshMaintenance(pluginId, async () => {
      await removeRuntimeVersion(request.input.version, pluginId)
      return { ok: true }
    })
    case 'upgrade.oneClick': return oneClickUpgrade(pluginId, request.input.version)
    default: {
      const exhaustive: never = request
      throw new Error(`Unknown dsh workbench action: ${String((exhaustive as { action?: unknown }).action)}`)
    }
  }
}
