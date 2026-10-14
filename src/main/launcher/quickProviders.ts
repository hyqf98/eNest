/**
 * quickProviders — 插件 Quick 搜索 provider 查询桥
 * 职责：把主进程的 Quick 搜索查询派发到注册了 quick provider 的插件 webContents，
 *       收集插件回传的结果项（quick-query-result），超时丢弃。
 * 协议：主进程 → 插件 plugin:event {type:'quick-query', reqId, query}；
 *       插件经 enest.contribute.onQuickQuery 监听，enest.contribute.respondQuickQuery(reqId, items)
 *       回传（plugin:call method 'contribute.respondQuickQuery'）。
 * 被 commandIndex（搜索管线）调用；provider 注册表在 ContributionRegistry。
 * 关键依赖：ContributionRegistry、PluginHost（webContents 路由）。
 */
import { randomUUID } from 'node:crypto'
import type { PluginEventPayload } from '@shared/types/ipc'
import { contributionRegistry } from '@main/contrib/ContributionRegistry'
import { pluginHost } from '@main/plugin/PluginHost'
import { logWarn } from '@main/logs/logService'
import { getRuntimeScope, type PluginRuntimeScope } from '@main/plugin/PluginRuntimeScope'
import { settingsStore } from '@main/settings/SettingsStore'

/** 插件 provider 回传项（插件侧形状；映射见 commandIndex） */
export interface QuickProviderItem {
  id?: string
  title?: string
  subtitle?: string
  explain?: string
  code?: string
  payload?: unknown
}

/** 单路查询超时：超时丢弃该 provider 的结果，不阻塞整体搜索 */
const QUERY_TIMEOUT_MS = 500

/** 向指定插件的存活 webContents 推送 plugin:event 负载（Host 公开访问器，无反射）；返回是否送达 */
function sendPluginEvent(pluginId: string, payload: PluginEventPayload): boolean {
  if (!pluginHost.isOpened(pluginId)) return false
  return pluginHost.getWebContents(pluginId) !== null && (pluginHost.sendEvent(pluginId, payload), true)
}

/** 待回传请求表：reqId → resolve（resolveQuickQuery 命中后消除） */
const pending = new Map<string, { pluginId: string; providerId: string; scope: PluginRuntimeScope; finish: (items: QuickProviderItem[]) => void }>()

/**
 * 插件回传入口（pluginHandlers contribute.respondQuickQuery 调用）：
 * 命中 pending 则 resolve；未知/超时的 reqId 静默丢弃。
 */
export function resolveQuickQuery(pluginId: string, reqId: string, items: unknown): void {
  const hit = pending.get(String(reqId ?? ''))
  if (!hit || hit.pluginId !== pluginId || !hit.scope.isCurrent() || hit.scope.signal.aborted) return
  if (settingsStore.getPermissionGrant(pluginId, 'contribute') === 'deny' ||
    !contributionRegistry.getQuickProviders().some((provider) => provider.pluginId === pluginId && provider.id === hit.providerId)) {
    hit.finish([])
    return
  }
  const list = Array.isArray(items)
    ? (items.filter(
        (x) => x !== null && typeof x === 'object'
      ) as QuickProviderItem[])
    : []
  hit.finish(list.slice(0, 100))
}

/**
 * 并发查询全部运行时 provider；每路独立 try/catch + 超时兜底，
 * 失败/超时不阻塞其它 provider 与内置搜索。
 */
export async function queryQuickProviders(
  query: string,
  signal?: AbortSignal
): Promise<Array<{ pluginId: string; providerId: string; items: QuickProviderItem[] }>> {
  const providers = contributionRegistry.getQuickProviders()
  if (providers.length === 0 || !query.trim() || signal?.aborted) return []

  const tasks = providers.map(async (provider) => {
    const reqId = `${provider.pluginId}:${provider.id}:${randomUUID()}`
    const scope = getRuntimeScope(provider.pluginId)
    if (!scope || scope.signal.aborted || settingsStore.getPermissionGrant(provider.pluginId, 'contribute') === 'deny') {
      return { pluginId: provider.pluginId, providerId: provider.id, items: [] }
    }
    const items = await new Promise<QuickProviderItem[]>((resolve) => {
      let finished = false
      const finish = (items: QuickProviderItem[]) => {
        if (finished) return
        finished = true
        pending.delete(reqId)
        clearTimeout(timer)
        scope.signal.removeEventListener('abort', abort)
        signal?.removeEventListener('abort', abort)
        resolve(items)
      }
      const abort = () => finish([])
      const timer = setTimeout(() => {
        logWarn('quick', `provider timeout: ${provider.pluginId}:${provider.id}`)
        finish([])
      }, QUERY_TIMEOUT_MS)
      timer.unref?.()
      scope.signal.addEventListener('abort', abort, { once: true })
      signal?.addEventListener('abort', abort, { once: true })
      pending.set(reqId, { pluginId: provider.pluginId, providerId: provider.id, scope, finish })
      try { if (!sendPluginEvent(provider.pluginId, { type: 'quick-query', reqId, query })) finish([]) }
      catch { finish([]) }
    })
    return { pluginId: provider.pluginId, providerId: provider.id, items }
  })

  const settled = await Promise.all(
    tasks.map((p) => p.catch(() => ({ pluginId: '', providerId: '', items: [] })))
  )
  return settled.filter((r) => r.pluginId !== '')
}
