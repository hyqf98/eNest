/** Page identity and the single permission-checked plugin RPC transport. */
import { ipcRenderer } from 'electron'
import type { McpErrorCode } from '@shared/types/mcp'
import * as IpcChannels from '@shared/types/ipc'
import { type PluginCallRequest, type PluginCallResult } from '@shared/types/ipc'
import type { PluginLaunchMode } from '@shared/types/plugin'

/** 读当前页 URL query 参数（preload 无 DOM 保证，失败返回 null） */
export function getQueryParam(name: string): string | null {
  try {
    const search =
      (globalThis as unknown as { location?: { search?: string } }).location?.search ?? ''
    return new URLSearchParams(search).get(name)
  } catch {
    return null
  }
}

function getPluginIdFromQuery(): string {
  return getQueryParam('pid') ?? ''
}

function getPluginIdFromArgv(): string {
  try {
    const prefix = '--enest-plugin-id='
    const hit = process.argv.find((a) => a.startsWith(prefix))
    return hit ? hit.slice(prefix.length) : ''
  } catch {
    return ''
  }
}

/** 优先从 URL query 的 pid 参数获取插件 ID，失败时从进程 argv 回退 */
function resolvePluginId(): string {
  return getPluginIdFromQuery() || getPluginIdFromArgv()
}

let cachedPluginId: string | null = null

export function pluginId(): string {
  if (cachedPluginId === null) cachedPluginId = resolvePluginId()
  return cachedPluginId
}

/** URL query 中的 code（openPlugin 优先走 query，便于首个脚本同步读取） */
export function enterCodeFromQuery(): string | undefined {
  return getQueryParam('code') ?? undefined
}

/**
 * URL query 中的启动方式（?mode=quick|shell|panel）：插件首个脚本同步读取的初始值。
 * 容器迁移不重载页面、URL 不变，运行时真值以 mode-change 事件更新后的
 * getLaunchMode() 为准。
 */
export function launchModeFromQuery(): PluginLaunchMode | null {
  const mode = getQueryParam('mode')
  return mode === 'quick' || mode === 'shell' || mode === 'panel' ? mode : null
}

/** 统一调用入口：组装 PluginCallRequest，经 IPC 发送到主进程 pluginHandlers 分发 */
export async function call<T = unknown>(method: string, args: unknown[] = []): Promise<T> {
  const request: PluginCallRequest = {
    pluginId: pluginId(),
    method,
    args
  }
  const result = (await ipcRenderer.invoke(IpcChannels.PluginCall, request)) as PluginCallResult
  if (!result?.ok) {
    const error = new Error(result?.error || 'plugin call failed') as Error & { code?: McpErrorCode }
    if (result?.errorCode) error.code = result.errorCode
    throw error
  }
  return result.data as T
}
