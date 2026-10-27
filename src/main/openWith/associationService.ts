/**
 * associationService — 「打开方式」聚合服务（主进程单例）
 *
 * 职责：
 *  - 聚合所有插件的 manifest.contributes.openWith 声明（open-with 插槽），
 *    做形状校验与 scheme 冲突裁决（先声明者优先）；
 *  - 维护设置段 openWith 的路由表（键 → pluginId，主进程独占写）；
 *  - 调平台注册器完成候选注册 / 设默认 / 状态检测 / 系统设置引导。
 *
 * 插件是壳内视图，OS 关联目标只能是 eNest 本体；本服务是唯一的系统写入方。
 */
import { listOpenWithContributions } from '@main/contrib/ContributionRegistry'
import { logWarn } from '@main/logs/logService'
import { pluginRegistry } from '@main/plugin/PluginRegistry'
import { settingsStore } from '@main/settings/SettingsStore'
import {
  extKey,
  schemeKey,
  validateOpenWithContribution,
  type OpenWithActionResult,
  type OpenWithKey,
  type OpenWithListResult,
  type OpenWithRow,
  type OpenWithStatus
} from '@shared/types/openWith'
import { getOpenWithRegistrar, registrationAvailable, type OpenWithKind } from './registrar'

export interface OpenWithProvider {
  pluginId: string
  pluginName: string
  icon?: string
  glyph?: string
  color?: string
  enabled: boolean
}

export interface OpenWithTargetResolution {
  pluginId?: string
  /** 多个启用插件都声明该键且无路由 → 需要用户选择 */
  ambiguous: boolean
  providers: OpenWithProvider[]
}

function splitKey(key: OpenWithKey): { kind: OpenWithKind; value: string } {
  const kind = key.startsWith('scheme:') ? 'scheme' : 'ext'
  return { kind, value: key.slice(kind === 'scheme' ? 'scheme:'.length : 'ext:'.length) }
}

function providerFor(pluginId: string): OpenWithProvider | null {
  const summary = pluginRegistry.get(pluginId)
  if (!summary) return null
  return {
    pluginId,
    pluginName: summary.name || pluginId,
    icon: summary.icon,
    glyph: summary.glyph,
    color: summary.color,
    enabled: pluginRegistry.isEnabled(pluginId)
  }
}

/** 聚合贡献：key → providers（按 pluginId 去重；scheme 冲突先到先得） */
function collectProviders(): Map<OpenWithKey, OpenWithProvider[]> {
  const map = new Map<OpenWithKey, OpenWithProvider[]>()
  const claimedSchemes = new Map<string, string>()
  const push = (key: OpenWithKey, provider: OpenWithProvider): void => {
    const list = map.get(key) ?? []
    if (!list.some((p) => p.pluginId === provider.pluginId)) list.push(provider)
    map.set(key, list)
  }
  // 贡献按 source 排序，保证冲突裁决稳定
  const contributions = [...listOpenWithContributions()].sort((a, b) => a.source.localeCompare(b.source))
  for (const { source, id, data } of contributions) {
    const errors = validateOpenWithContribution(data)
    if (errors.length) {
      logWarn('open-with', `${source}/${id} skipped: ${errors.join('; ')}`)
      continue
    }
    const provider = providerFor(source)
    if (!provider) continue
    for (const ext of data.extensions ?? []) push(extKey(ext), provider)
    for (const scheme of data.schemes ?? []) {
      const owner = claimedSchemes.get(scheme)
      if (owner && owner !== source) {
        logWarn('open-with', `scheme ${scheme} already claimed by ${owner}, ignored for ${source}`)
        continue
      }
      claimedSchemes.set(scheme, source)
      push(schemeKey(scheme), provider)
    }
  }
  return map
}

function routesFor(kind: OpenWithKind): Record<string, string> {
  const routes = settingsStore.getOpenWithRoutes()
  return kind === 'ext' ? routes.ext : routes.scheme
}

/** 状态检测有子进程开销：30s 内复用 */
const statusCache = new Map<string, { at: number; status: OpenWithStatus | undefined }>()
const STATUS_TTL = 30_000

async function detectCached(kind: OpenWithKind, value: string): Promise<OpenWithStatus | undefined> {
  const cacheKey = `${kind}:${value}`
  const hit = statusCache.get(cacheKey)
  if (hit && Date.now() - hit.at < STATUS_TTL) return hit.status
  let status: OpenWithStatus | undefined
  try {
    status = await getOpenWithRegistrar().detect(kind, value)
  } catch (err) {
    logWarn('open-with', `detect ${cacheKey} failed: ${(err as Error).message}`)
  }
  statusCache.set(cacheKey, { at: Date.now(), status })
  return status
}

export class AssociationService {
  /** 设置页列表：贡献 + 路由 + 系统状态合并 */
  async list(): Promise<OpenWithListResult> {
    const providersByKey = collectProviders()
    const registrar = getOpenWithRegistrar()
    const rows: OpenWithRow[] = []
    for (const [key, providers] of [...providersByKey.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const { kind, value } = splitKey(key)
      const routedPluginId = routesFor(kind)[value]
      rows.push({
        key,
        kind,
        value,
        providers: providers.map((p) => ({ ...p, routed: p.pluginId === routedPluginId })),
        routedPluginId,
        status: await detectCached(kind, value),
        caps: registrar.caps(kind)
      })
    }
    // 文件类型在前，scheme 在后；各自按值排序
    rows.sort((a, b) => (a.kind === b.kind ? a.value.localeCompare(b.value) : a.kind === 'ext' ? -1 : 1))
    return { platform: process.platform, packaged: registrationAvailable(), rows }
  }

  /** 设为默认：写路由 + 平台注册（能力受限平台返回候选状态与引导） */
  async setDefault(key: OpenWithKey, pluginId: string): Promise<OpenWithActionResult> {
    const { kind, value } = splitKey(key)
    const provider = collectProviders().get(key)?.find((p) => p.pluginId === pluginId)
    if (!provider) return { ok: false, error: '该插件未声明此类型' }
    if (!provider.enabled) return { ok: false, error: '插件已停用，无法设为打开方式' }
    await settingsStore.setOpenWithRoute(kind, value, pluginId)
    try {
      await getOpenWithRegistrar().registerCandidate(kind, value)
      const result = await getOpenWithRegistrar().setDefault(kind, value)
      statusCache.delete(`${kind}:${value}`)
      return {
        ok: result.ok,
        error: result.error,
        hint: result.hint,
        status: result.status ?? (await detectCached(kind, value))
      }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  /** 只写内部路由（用于「用哪个插件打开」选择；不改系统默认） */
  async route(key: OpenWithKey, pluginId: string): Promise<OpenWithActionResult> {
    const { kind, value } = splitKey(key)
    const provider = collectProviders().get(key)?.find((p) => p.pluginId === pluginId)
    if (!provider) return { ok: false, error: '该插件未声明此类型' }
    if (!provider.enabled) return { ok: false, error: '插件已停用，无法路由' }
    await settingsStore.setOpenWithRoute(kind, value, pluginId)
    return { ok: true, status: await detectCached(kind, value) }
  }

  /** 移除路由（不重置系统默认——系统默认由用户在 OS 侧决定） */
  async clearDefault(key: OpenWithKey): Promise<OpenWithActionResult> {
    const { kind, value } = splitKey(key)
    await settingsStore.clearOpenWithRoute(kind, value)
    statusCache.delete(`${kind}:${value}`)
    return { ok: true, status: await detectCached(kind, value) }
  }

  async openSystemSettings(): Promise<void> {
    await getOpenWithRegistrar().openSystemSettings()
  }

  /**
   * 路由解析（双击打开用）：
   *  - 已有路由且插件仍启用 → 命中；
   *  - 无路由但只有一个启用插件 → 自动写入路由并命中（安装即用）；
   *  - 多个插件 → ambiguous，由 UI 让用户选择；
   *  - 无插件声明 → 空。
   */
  resolveTarget(key: OpenWithKey): OpenWithTargetResolution {
    const providers = (collectProviders().get(key) ?? []).filter((p) => p.enabled)
    if (!providers.length) return { ambiguous: false, providers: [] }
    const { kind, value } = splitKey(key)
    const routed = routesFor(kind)[value]
    if (routed && providers.some((p) => p.pluginId === routed)) {
      return { pluginId: routed, ambiguous: false, providers }
    }
    if (providers.length === 1) {
      const only = providers[0].pluginId
      void settingsStore.setOpenWithRoute(kind, value, only).catch((err) => {
        logWarn('open-with', `auto route ${key} failed: ${(err as Error).message}`)
      })
      return { pluginId: only, ambiguous: false, providers }
    }
    return { ambiguous: true, providers }
  }

  /** 启动时幂等同步用户已选 scheme 的系统注册（不改用户未选的 scheme） */
  async syncRoutedSchemes(): Promise<void> {
    if (!registrationAvailable()) return
    const routes = settingsStore.getOpenWithRoutes()
    for (const scheme of Object.keys(routes.scheme)) {
      try {
        await getOpenWithRegistrar().registerCandidate('scheme', scheme)
        await getOpenWithRegistrar().setDefault('scheme', scheme)
      } catch (err) {
        logWarn('open-with', `sync scheme ${scheme} failed: ${(err as Error).message}`)
      }
    }
  }

  /** 卸载/禁用插件：清掉指向它的路由 */
  async removeRoutesForPlugin(pluginId: string): Promise<void> {
    await settingsStore.removeOpenWithRoutesForPlugin(pluginId)
  }
}

export const associationService = new AssociationService()
