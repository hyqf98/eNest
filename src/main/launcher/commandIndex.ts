/**
 * commandIndex — 快捷启动命令索引（provider 管线）
 * 职责：聚合内置 provider（actions / 插件命令 / 本地应用 / 剪贴板历史）与
 *       插件运行时 quick provider，提供统一搜索排序。
 * 被 quickHandlers 调用。
 */
import type { QuickCommand, QuickCommandKind } from '@shared/types/quick'
import type { PluginManifest, QuickRecentEntry } from '@shared/types/plugin'
import { pluginProtocolUrl } from '@shared/constants'
import { normalizeSearchText } from '@shared/search'
import { parsePluginCommandPattern } from '@shared/pluginCommands'
import { pluginRegistry } from '@main/plugin/PluginRegistry'
import { getPluginLaunchAliases, getPluginLaunchAliasRevision } from '@main/hotkey/pluginLaunchHotkeys'
import { getCachedApps, scanApplications } from './appScanner'
import { getAppIconDataUrl } from './appLauncher'
import { searchHistory } from '@main/clipboard/clipboardHistory'
import { queryQuickProviders } from './quickProviders'
import { prepareQuickName, scoreQuickName, type QuickNameIndex } from './quickNameMatching'
import { matchQuickPatterns, type QuickPatternRule } from './quickPatternMatching'

const BUILTIN_ACTIONS: QuickCommand[] = [
  {
    kind: 'action',
    id: 'action:open-market',
    title: '打开市场',
    subtitle: '浏览与安装插件',
    action: 'open-market'
  },
  {
    kind: 'action',
    id: 'action:open-settings',
    title: '打开设置',
    subtitle: '快捷键 · 主题 · 通用',
    action: 'open-settings'
  },
  {
    kind: 'action',
    id: 'action:refresh-apps',
    title: '重新扫描应用',
    subtitle: '刷新本地软件列表',
    action: 'refresh-apps'
  }
]

const RECENT_MAX = 20
/** 空 query 时「最近」权重：半衰约 7 天 */
const RECENT_HALF_LIFE_MS = 7 * 24 * 60 * 60 * 1000

interface IndexedName { raw: string; index: QuickNameIndex }
interface ContentCommand {
  type: 'regex' | 'over'
  label: string
  match?: string
  regex?: string
  exclude?: string
  minLength?: number
  maxLength?: number
}
interface IndexedContent { command: ContentCommand; rule: Omit<QuickPatternRule, 'key'> }
const normalizedCommands = new WeakMap<QuickCommand, IndexedName[]>()
const contentCommands = new WeakMap<QuickCommand, IndexedContent[]>()

function normalizedCommand(item: QuickCommand): IndexedName[] {
  let names = normalizedCommands.get(item)
  if (!names) {
    names = [...new Set([item.title, ...(item.aliases ?? [])])].filter(Boolean)
      .map((raw) => ({ raw, index: prepareQuickName(raw) }))
    normalizedCommands.set(item, names)
  }
  return names
}

/** Check every command/alias before choosing a feature's best display label. */
function scoreCommand(item: QuickCommand, query: string): { score: number; keywordHit?: string } {
  let best = { score: 0, keywordHit: undefined as string | undefined }
  for (const name of normalizedCommand(item)) {
    const score = scoreQuickName(name.index, query)
    if (score > best.score) best = { score, keywordHit: name.raw }
  }
  // A nonexact app hit gets a small boost; it can never overtake an exact command.
  if (item.kind === 'app' && best.score > 0 && best.score < 10000) best.score = Math.min(9999, best.score + 300)
  return best
}

function indexContentCommand(command: ContentCommand): IndexedContent | null {
  if (!command || !['regex', 'over'].includes(command.type) || !command.label?.trim()) return null
  const expression = command.type === 'regex' ? command.match ?? command.regex : command.exclude
  const pattern = expression === undefined ? null : parsePluginCommandPattern(expression)
  if ((command.type === 'regex' && !pattern) || (expression !== undefined && !pattern)) return null
  return { command, rule: {
    type: command.type, source: pattern?.source, flags: pattern?.flags,
    minLength: command.minLength ?? 1,
    maxLength: command.type === 'over' ? command.maxLength ?? 10000 : undefined
  } }
}

/** 空 query 时按最近时间半衰 + 使用次数加权 */
function recentRank(entry: QuickRecentEntry): number {
  const age = Math.max(0, Date.now() - entry.ts)
  const decay = Math.pow(0.5, age / RECENT_HALF_LIFE_MS)
  const recency = decay * 100
  const freq = Math.min(entry.count, 50) * 2
  return recency + freq
}

/** 已安装 / 开发态插件 manifest（不含未安装的市场 mock） */
function installedManifests(): PluginManifest[] {
  return pluginRegistry.getInstalledDescriptors()
    .filter((entry) => entry.enabled)
    .map((entry) => entry.manifest)
}

/** Canonical manifest icon → version-selected plugin resource. */
function pluginIconUrl(pluginId: string, icon: string): string {
  return pluginProtocolUrl(pluginId, icon)
}

let commandCache: { registry: number; aliases: number; items: QuickCommand[] } | null = null
let commandCacheHits = 0
let commandCacheMisses = 0
let commandCacheBuilds = 0

/** Counts only the static plugin-command snapshot; no command text, aliases or queries escape. */
export function getCommandCacheMetrics() {
  return {
    hits: commandCacheHits, misses: commandCacheMisses, builds: commandCacheBuilds,
    entries: commandCache?.items.length ?? 0, snapshots: commandCache ? 1 : 0, snapshotCapacity: 1,
    registryRevision: commandCache?.registry ?? null, aliasRevision: commandCache?.aliases ?? null
  }
}

export function buildPluginCommands(): QuickCommand[] {
  const registry = pluginRegistry.getInstalledRevision()
  const aliases = getPluginLaunchAliasRevision()
  if (commandCache?.registry === registry && commandCache.aliases === aliases) { commandCacheHits++; return commandCache.items }
  commandCacheMisses++
  const items: QuickCommand[] = []
  for (const m of installedManifests()) {
    const pluginId = m.id
    const features = m.features ?? []
    const icon = pluginIconUrl(pluginId, m.icon)
    // 用户自定义触发词（settings.pluginLaunch.aliases）与 manifest cmds 等权参与检索
    const userAliases = getPluginLaunchAliases(pluginId)
    if (features.length === 0) {
      items.push({
        kind: 'plugin',
        id: `plugin:${pluginId}:`,
        title: m.name,
        subtitle: m.description || '插件',
        pluginId,
        icon,
        aliases: [...userAliases, m.name, m.id],
        type: 'text'
      })
      continue
    }
    const primaryFeature = features.find((feature) => feature.cmds?.some((cmd) => typeof cmd === 'string' && cmd.trim()))
    for (const feature of features) {
      const cmds = Array.isArray(feature.cmds)
        ? feature.cmds.filter((c): c is string => typeof c === 'string' && Boolean(c.trim()))
        : []
      const explain = feature.explain || cmds.join(' · ')
      const item: QuickCommand = {
        kind: 'plugin',
        id: `plugin:${pluginId}:${feature.code}`,
        title: cmds[0] || m.name,
        subtitle: explain ? `${m.name} · ${explain}` : m.name,
        pluginId,
        code: feature.code,
        aliases: [...cmds, ...(feature === primaryFeature ? [...userAliases, m.name, m.id] : [])],
        icon,
        type: 'text'
      }
      const content = (feature.cmds ?? []).filter((cmd) => typeof cmd === 'object' && cmd !== null)
        .map((cmd) => indexContentCommand(cmd as ContentCommand)).filter((cmd): cmd is IndexedContent => cmd !== null)
      contentCommands.set(item, content)
      normalizedCommands.set(item, [...new Set(item.aliases)].map((raw) => ({ raw, index: prepareQuickName(raw) })))
      items.push(item)
    }
  }
  for (const item of items) normalizedCommand(item)
  commandCache = { registry, aliases, items }
  commandCacheBuilds++
  return items
}

let appCommandCache: { source: ReturnType<typeof getCachedApps>; items: QuickCommand[] } | null = null
export function buildAppCommands(): QuickCommand[] {
  const cached = getCachedApps()
  if (!cached) return []
  if (appCommandCache?.source === cached) return appCommandCache.items
  const items: QuickCommand[] = cached.apps.map((app) => ({
    kind: 'app' as const,
    id: `app:${app.path}`,
    title: app.name,
    subtitle: app.path,
    path: app.path,
    icon: app.icon,
    aliases: app.alias ? [app.alias] : undefined,
    /** linux：Icon= 原始值，提图时由 appLauncher 解析（mac/win 忽略） */
    iconName: app.iconName,
    type: 'text'
  }))
  for (const item of items) normalizedCommand(item)
  appCommandCache = { source: cached, items }
  return items
}

/** 为 top 结果异步补应用图标（data URL）；已带 icon 的跳过 */
async function attachAppIcons(items: QuickCommand[]): Promise<void> {
  await Promise.all(
    items.map(async (item) => {
      if (item.kind === 'app' && item.path && !item.icon) {
        item.icon = await getAppIconDataUrl(item.path, item.iconName)
      }
    })
  )
}

/** 把 settings recent 映射到命令项 */
function applyRecentMeta(
  items: QuickCommand[],
  recent: QuickRecentEntry[]
): QuickCommand[] {
  if (!recent.length) return items
  const map = new Map(recent.map((r) => [r.id, r]))
  return items.map((item) => {
    const r = map.get(item.id)
    if (!r) return item
    return { ...item, lastUsedTs: r.ts, useCount: r.count }
  })
}

/**
 * 剪贴板历史 → QuickCommand 映射：点击项经现有 openPlugin 打开 clipboard
 * 历史插件（若装了的话）；没装时无法执行，但结果仍可作为「找到过」提示——
 * 为避免不可执行项，仅在存在已安装的 clipboard.history 插件时纳入。
 */
function clipboardCommands(
  entries: Array<{ id: string; type: string; preview: string; ts: number; pinned: boolean }>
): QuickCommand[] {
  if (entries.length === 0) return []
  const owner = pluginRegistry.getInstalledDescriptors()
    .find((entry) => entry.enabled && (entry.manifest.permissions ?? []).includes('clipboard.history'))
  const pluginId = owner?.id
  if (!pluginId) return []
  return entries.map((e) => ({
    kind: 'plugin' as const,
    id: `clip:${e.id}`,
    title: e.type === 'image' ? `图片 ${e.preview}` : e.preview,
    subtitle: `剪贴板 · ${e.pinned ? '置顶 · ' : ''}${new Date(e.ts).toLocaleString()}`,
    pluginId,
    aliases: ['clip', 'clipboard', '剪贴板'],
    group: 'match',
    type: 'text'
  }))
}

/** 插件 provider 回传项 → QuickCommand（点击经现有 openPlugin 打开，code/payload 透传） */
function providerCommands(
  results: Array<{ pluginId: string; providerId: string; items: Array<{ id?: string; title?: string; subtitle?: string; explain?: string; code?: string; payload?: unknown }> }>
): QuickCommand[] {
  const out: QuickCommand[] = []
  const enabledIds = new Set(pluginRegistry.getInstalledDescriptors().filter((entry) => entry.enabled).map((entry) => entry.id))
  const seen = new Set<string>()
  for (const result of results) {
    if (!enabledIds.has(result.pluginId)) continue
    const manifest = pluginRegistry.getManifest(result.pluginId)
    const icon = manifest ? pluginIconUrl(result.pluginId, manifest.icon) : undefined
    for (const item of result.items) {
      const title = String(item?.title ?? '').trim()
      if (!title) continue
      const id = `provider:${result.pluginId}:${result.providerId}:${String(item?.id ?? title)}`
      if (seen.has(id)) continue
      seen.add(id)
      out.push({
        kind: 'plugin',
        id,
        title,
        subtitle: String(item?.subtitle ?? item?.explain ?? ''),
        pluginId: result.pluginId,
        code: item?.code ? String(item.code) : undefined,
        payload: item.payload,
        aliases: [result.providerId],
        icon,
        group: 'provider',
        type: 'text'
      })
    }
  }
  return out
}

let providerSearch: AbortController | null = null
let staticSearch: AbortController | null = null

async function searchContentCommands(items: QuickCommand[], rawQuery: string, signal: AbortSignal): Promise<QuickCommand[]> {
  const candidates = items.flatMap((item) => (contentCommands.get(item) ?? []).map((content) => ({ item, ...content })))
  const keys = await matchQuickPatterns(candidates.map((candidate, key) => ({ ...candidate.rule, key })), rawQuery, signal)
  return [...keys].map((key) => {
    const { item, command } = candidates[key]!
    return { ...item, title: command.label, group: command.type === 'regex' ? 'match' as const : 'recommendation' as const,
      type: command.type, payload: rawQuery, keywordHit: undefined }
  })
}

async function searchProviders(rawQuery: string, recent: QuickRecentEntry[], signal: AbortSignal): Promise<QuickCommand[]> {
  try {
    const results = await queryQuickProviders(rawQuery, signal)
    if (signal.aborted) return []
    return applyRecentMeta(providerCommands(results), recent)
  } catch { return [] }
}

/**
 * Static returns indexed names immediately; enrichment and providers arrive independently.
 * Long queries still match typed content commands; name indexing stops at 32 characters.
 * The omitted phase retains the complete-result API for existing consumers.
 */
export async function searchQuickCommands(
  query: string,
  limit = 20,
  recent: QuickRecentEntry[] = [],
  kind?: QuickCommandKind,
  preferredId?: string,
  phase?: 'static' | 'enriched' | 'providers'
): Promise<QuickCommand[]> {
  const rawQuery = String(query ?? '')
  const q = normalizeSearchText(rawQuery)
  const resultLimit = Number.isFinite(limit) ? Math.max(1, Math.min(100, Math.floor(limit))) : 20
  if (phase === 'providers') {
    providerSearch?.abort()
    providerSearch = new AbortController()
    if (!q || kind && kind !== 'plugin') return []
    return (await searchProviders(rawQuery, recent, providerSearch.signal)).slice(0, resultLimit)
  }

  if (phase !== 'enriched') providerSearch?.abort()
  staticSearch?.abort()
  const controller = new AbortController()
  staticSearch = controller
  const signal = controller.signal
  if (!getCachedApps() && (!kind || kind === 'app')) await scanApplications(false)
  if (signal.aborted) return []
  const acceptsKind = (item: QuickCommand): boolean => !kind || item.kind === kind
  const pool = ([
    ...BUILTIN_ACTIONS,
    ...buildPluginCommands(),
    ...buildAppCommands()
  ] as QuickCommand[]).filter(acceptsKind)

  if (!q) {
    const discoverable = pool.filter((item) => (kind === 'action' || item.kind !== 'action') && normalizedCommand(item).length > 0)
    const recentMap = new Map(recent.map((r) => [r.id, r]))
    // 1) 有使用记录的应用/插件（半衰+频次）
    const withRecent = discoverable
      .filter((item) => recentMap.has(item.id))
      .map((item) => {
        const r = recentMap.get(item.id)!
        return { item: { ...item, lastUsedTs: r.ts, useCount: r.count }, score: recentRank(r) }
      })
      .sort((a, b) => b.score - a.score)
      .map((s) => s.item)
    // The default home surfaces apps/plugins; an explicit action filter keeps its own catalog.
    const recentIds = new Set(withRecent.map((i) => i.id))
    const remaining = discoverable.filter((item) => !recentIds.has(item.id)).sort((a, b) => {
      const order = { plugin: 0, app: 1, action: 2 }
      return order[a.kind] - order[b.kind] || a.title.localeCompare(b.title, 'zh-CN')
    })
    const top = [...withRecent, ...remaining].slice(0, resultLimit)
    if (phase !== 'static') await attachAppIcons(top)
    return signal.aborted ? [] : top
  }

  const scored = (q.length <= 32 ? pool : [])
    .map((item) => {
      const hit = scoreCommand(item, q)
      return {
        item: { ...item, title: item.kind === 'plugin' && hit.keywordHit !== item.pluginId ? hit.keywordHit || item.title : item.title,
          keywordHit: hit.keywordHit, group: 'best' as const, type: 'text' as const },
        score: hit.score
      }
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.item.title.localeCompare(b.item.title, 'zh-CN'))

  const best = scored.map((hit) => hit.item)
  const preferred = preferredId ? best.findIndex((item) => item.id === preferredId) : -1
  if (preferred > 0) best.unshift(best.splice(preferred, 1)[0]!)
  if (phase === 'static') return applyRecentMeta(best.slice(0, resultLimit), recent)
  const acceptsContent = !kind || kind === 'plugin'
  const [content, clipboard, providers] = await Promise.all([
    acceptsContent ? searchContentCommands(pool, rawQuery, signal) : [],
    acceptsContent ? searchHistory(q, 6).then(clipboardCommands).catch(() => []) : [],
    acceptsContent && phase === undefined ? searchProviders(rawQuery, recent, signal) : []
  ])
  if (signal.aborted) return []
  const recentMap = new Map(recent.map((entry) => [entry.id, entry.count]))
  const byUse = (a: QuickCommand, b: QuickCommand): number => (recentMap.get(b.id) ?? 0) - (recentMap.get(a.id) ?? 0)
  const contentMatches = content.filter((item) => item.group === 'match').sort(byUse)
  const recommendations = content.filter((item) => item.group === 'recommendation').sort(byUse)
  const seen = new Set<string>()
  const combined = [...best, ...contentMatches, ...clipboard, ...recommendations].filter((item) => {
    if (seen.has(item.id)) return false
    seen.add(item.id)
    return true
  })
  const top = applyRecentMeta([...combined, ...providers].slice(0, resultLimit), recent)
  await attachAppIcons(top)
  return signal.aborted ? [] : top
}

export const QUICK_RECENT_MAX = RECENT_MAX
