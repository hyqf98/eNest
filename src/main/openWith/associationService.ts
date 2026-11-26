/**
 * associationService — 「打开方式」聚合服务（主进程单例）
 *
 * 职责：
 *  - 聚合清单声明和插件运行时登记；协议冲突优先采用清单声明；
 *  - 维护设置段 openWith 的路由表（键 → pluginId，主进程独占写）；
 *  - 调平台注册器完成候选注册 / 设默认 / 状态检测 / 系统设置引导。
 *
 * 插件是壳内视图，OS 关联目标只能是 eNest 本体；本服务是唯一的系统写入方。
 */
import { contributionRegistry, listOpenWithContributions } from '@main/contrib/ContributionRegistry'
import { logWarn } from '@main/logs/logService'
import { pluginRegistry } from '@main/plugin/PluginRegistry'
import { settingsStore } from '@main/settings/SettingsStore'
import { sendShellEvent } from '@main/window/createShellWindow'
import {
  extKey,
  schemeKey,
  readOpenWithContribution,
  type OpenWithActionResult,
  type OpenWithEntryRow,
  type OpenWithKey,
  type OpenWithListResult,
  type OpenWithRow,
  type OpenWithStatus,
  type OpenWithRoutes
} from '@shared/types/openWith'
import { getOpenWithRegistrar, registrationAvailable, type OpenWithKind } from './registrar'

export type OpenWithProvider = Omit<OpenWithRow['providers'][number], 'routed'>

export interface OpenWithTargetResolution {
  pluginId?: string
  /** 当前候选需要用户确认，不能直接交付文件或链接。 */
  ambiguous: boolean
  providers: OpenWithProvider[]
}

type Candidate = OpenWithProvider & { declared: boolean }

function splitKey(key: OpenWithKey): { kind: OpenWithKind; value: string } {
  const kind = key.startsWith('scheme:') ? 'scheme' : 'ext'
  return { kind, value: key.slice(kind === 'scheme' ? 'scheme:'.length : 'ext:'.length) }
}

function providerFor(pluginId: string): OpenWithProvider | null {
  const summary = pluginRegistry.get(pluginId)
  if (!summary?.installed || !pluginRegistry.isEnabled(pluginId)) return null
  return {
    pluginId,
    pluginName: summary.name || pluginId,
    icon: summary.icon,
    glyph: summary.glyph,
    color: summary.color,
    enabled: true
  }
}

/** 该插件被用户关闭的清单声明项 id 集合 */
function disabledEntriesFor(pluginId: string, disabled: OpenWithRoutes['disabled']): Set<string> {
  return new Set(disabled[pluginId] ?? [])
}

/** 聚合贡献：key → providers（按 pluginId 去重；scheme 冲突先到先得） */
function collectProviders(): Map<OpenWithKey, Candidate[]> {
  const map = new Map<OpenWithKey, Candidate[]>()
  const disabled = settingsStore.getOpenWithRoutes().disabled
  const push = (key: OpenWithKey, provider: OpenWithProvider, declared: boolean): void => {
    const list = map.get(key) ?? []
    if (key.startsWith('scheme:') && list.length) return
    if (!list.some((p) => p.pluginId === provider.pluginId)) list.push({ ...provider, declared })
    map.set(key, list)
  }
  const entries = [...listOpenWithContributions(), ...contributionRegistry.listRuntimeOpenWith()]
  for (const entry of entries) {
    const declared = !('build' in entry)
    if (!declared && entry.build !== pluginRegistry.getOpenWithBuild(entry.source)) continue
    // 清单声明项按声明粒度受设置页开关控制；运行时登记没有开关，始终参与
    if (declared && disabledEntriesFor(entry.source, disabled).has(entry.id)) continue
    const provider = providerFor(entry.source)
    if (!provider) continue
    try {
      const data = readOpenWithContribution(entry.data)
      for (const ext of data.extensions ?? []) push(extKey(ext), { ...provider, entryId: declared ? entry.id : undefined }, declared)
      for (const scheme of data.schemes ?? []) push(schemeKey(scheme), { ...provider, entryId: declared ? entry.id : undefined }, declared)
    } catch (error) {
      logWarn('open-with', `${entry.source}/${entry.id} skipped: ${String(error)}`)
    }
  }
  return map
}

function routesFor(kind: OpenWithKind): Record<string, string> {
  const routes = settingsStore.getOpenWithRoutes()
  return kind === 'ext' ? routes.ext : routes.scheme
}

async function detectStatus(kind: OpenWithKind, value: string): Promise<OpenWithStatus | undefined> {
  if (!registrationAvailable()) return undefined
  try {
    return await getOpenWithRegistrar().detect(kind, value)
  } catch (err) {
    logWarn('open-with', `detect ${kind}:${value} failed: ${(err as Error).message}`)
    return undefined
  }
}

export class AssociationService {
  register(pluginId: string, input: unknown): void {
    const build = pluginRegistry.getOpenWithBuild(pluginId)
    if (!build || !pluginRegistry.isEnabled(pluginId)) throw new Error('插件未安装或未启用')
    const entry = readOpenWithContribution(input)
    if (pluginRegistry.getManifest(pluginId)?.contributes?.openWith?.some(item => item.id === entry.id)) throw new Error('该登记 ID 已在插件清单中声明')
    if (entry.schemes?.length) {
      const candidates = collectProviders()
      if (entry.schemes.some(scheme => candidates.get(schemeKey(scheme))?.some(candidate => candidate.pluginId !== pluginId))) throw new Error('此协议已被其他插件声明')
    }
    contributionRegistry.registerOpenWith(pluginId, build, entry)
  }

  unregister(pluginId: string, id: unknown): boolean {
    const build = pluginRegistry.getOpenWithBuild(pluginId)
    if (!build || !pluginRegistry.isEnabled(pluginId) || typeof id !== 'string' || !id || id.length > 64) throw new Error('无效的打开方式登记')
    return contributionRegistry.unregisterOpenWith(pluginId, build, id)
  }

  /** 设置页列表：贡献 + 路由 + 系统状态合并 */
  async list(selectedKey?: OpenWithKey): Promise<OpenWithListResult> {
    const providersByKey = collectProviders()
    const registrar = getOpenWithRegistrar()
    const rows: OpenWithRow[] = []
    const routes = settingsStore.getOpenWithRoutes()
    for (const [key, providers] of providersByKey) {
      const { kind, value } = splitKey(key)
      const routedPluginId = Object.hasOwn(routes[kind], value) ? routes[kind][value] : undefined
      rows.push({
        key,
        kind,
        value,
        providers: providers.map(({ declared: _declared, ...provider }) => ({ ...provider, routed: provider.pluginId === routedPluginId })),
        routedPluginId,
        caps: { canSetDefault: false, needsSystemSettings: false }
      })
    }
    // 文件类型在前，scheme 在后；各自按值排序
    rows.sort((a, b) => (a.kind === b.kind ? a.value.localeCompare(b.value) : a.kind === 'ext' ? -1 : 1))
    const selected = rows.find(row => row.key === selectedKey) ?? rows[0]
    if (selected && registrationAvailable()) {
      try {
        selected.caps = await registrar.caps(selected.kind, selected.value)
        selected.status = await detectStatus(selected.kind, selected.value)
      } catch (error) { logWarn('open-with', `system options for ${selected.key} unavailable: ${String(error)}`) }
    }
    return { platform: process.platform, packaged: registrationAvailable(), rows, entries: this.listEntries(), inspectedKey: selected?.key }
  }

  /**
   * 设置页「可注册的打开方式」：全部清单声明项，含被用户关闭的。
   * 插件被停用时条目仍列出但置灰，便于用户知道它存在。
   */
  listEntries(): OpenWithEntryRow[] {
    const disabled = settingsStore.getOpenWithRoutes().disabled
    const out: OpenWithEntryRow[] = []
    for (const entry of listOpenWithContributions()) {
      const summary = pluginRegistry.get(entry.source)
      if (!summary?.installed) continue
      let data
      try { data = readOpenWithContribution(entry.data) } catch { continue }
      out.push({
        pluginId: entry.source,
        pluginName: summary.name || entry.source,
        entryId: entry.id,
        label: data.label,
        targets: [...(data.extensions ?? []), ...(data.schemes ?? []).map(scheme => `${scheme}://`)],
        icon: summary.icon,
        glyph: summary.glyph,
        color: summary.color,
        pluginEnabled: pluginRegistry.isEnabled(entry.source),
        enabled: !disabledEntriesFor(entry.source, disabled).has(entry.id)
      })
    }
    return out
  }

  /** 只处理明确的系统设置请求；不覆盖用户已保存的内部选择。 */
  async setDefault(key: OpenWithKey, pluginId: string): Promise<OpenWithActionResult> {
    const { kind, value } = splitKey(key)
    const provider = collectProviders().get(key)?.find((p) => p.pluginId === pluginId)
    if (!provider || routesFor(kind)[value] !== pluginId) return { ok: false, error: '请先选择用来打开此类型的插件' }
    if (!registrationAvailable()) return { ok: false, error: '只有安装版可以更改系统打开方式' }
    try {
      const result = await getOpenWithRegistrar().setDefault(kind, value)
      return {
        ok: result.ok,
        error: result.error,
        hint: result.hint,
        status: result.status ?? (await detectStatus(kind, value))
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
    await settingsStore.setOpenWithRoute(kind, value, pluginId)
    return { ok: true }
  }

  /** 移除路由（不重置系统默认——系统默认由用户在 OS 侧决定） */
  async clearDefault(key: OpenWithKey): Promise<OpenWithActionResult> {
    const { kind, value } = splitKey(key)
    await settingsStore.clearOpenWithRoute(kind, value)
    return { ok: true }
  }

  /**
   * 设置页开关：启用/停用某插件的清单声明项。只接受清单里真实存在的声明项，
   * 避免写入指向不存在声明的开关。停用后指向它的路由不删除，只是不再命中
   * （resolveTarget 找不到候选即视为未指定），重新启用后恢复。
   */
  async setEnabled(pluginId: string, entryId: unknown, enabled: unknown): Promise<OpenWithActionResult> {
    if (typeof entryId !== 'string' || !entryId || entryId.length > 64 || typeof enabled !== 'boolean') return { ok: false, error: '无效的打开方式声明' }
    const declared = pluginRegistry.getManifest(pluginId)?.contributes?.openWith?.some(item => item.id === entryId)
    if (!declared) return { ok: false, error: '该插件没有这条打开方式声明' }
    await settingsStore.setOpenWithEntryEnabled(pluginId, entryId, enabled)
    sendShellEvent({ type: 'contributions-changed', slot: 'open-with', source: pluginId })
    return { ok: true }
  }

  async openSystemSettings(): Promise<void> {
    await getOpenWithRegistrar().openSystemSettings()
  }

  /**
   * 路由解析（双击打开用）：
   *  - 已有路由且插件仍启用 → 命中；
   *  - 单一清单声明可直接打开，不替用户写入偏好；
   *  - 多个候选或仅有运行时登记时由用户选择；
   *  - 无插件声明 → 空。
   */
  resolveTarget(key: OpenWithKey): OpenWithTargetResolution {
    const providers = collectProviders().get(key) ?? []
    if (!providers.length) return { ambiguous: false, providers: [] }
    const { kind, value } = splitKey(key)
    const routes = routesFor(kind)
    const routed = Object.hasOwn(routes, value) ? routes[value] : undefined
    if (routed && providers.some((p) => p.pluginId === routed)) {
      return { pluginId: routed, ambiguous: false, providers }
    }
    if (!routed && providers.length === 1 && providers[0].declared) {
      return { pluginId: providers[0].pluginId, ambiguous: false, providers }
    }
    return { ambiguous: true, providers }
  }

  /** 卸载/禁用插件：清掉指向它的路由 */
  async removeRoutesForPlugin(pluginId: string): Promise<void> {
    await settingsStore.removeOpenWithRoutesForPlugin(pluginId)
  }
}

export const associationService = new AssociationService()
