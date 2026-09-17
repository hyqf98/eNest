/**
 * commandIndex — 快捷启动命令索引
 * 职责：聚合本地应用 + 已安装插件 features.cmds + 内置 action，提供搜索排序。
 * 被 quickHandlers 调用。
 */
import type { QuickActionId, QuickCommand } from '@shared/types/quick'
import type { PluginManifest, QuickRecentEntry } from '@shared/types/plugin'
import { resolvePluginForm } from '@shared/types/plugin'
import { pluginProtocolUrl } from '@shared/constants'
import { pluginRegistry } from '../plugin/PluginRegistry'
import { getCachedApps, scanApplications } from './appScanner'
import { getAppIconDataUrl } from './appLauncher'

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

/**
 * 子序列 fuzzy 分：如 `vscode` 匹配 `Visual Studio Code`。
 * 奖励词首/连续命中，惩罚大段间隔；返回 1–48，0 = 不匹配。
 */
function fuzzySubsequenceScore(text: string, query: string): number {
  if (!query || !text) return 0
  if (query.length > text.length) return 0
  let ti = 0
  let score = 0
  let consecutive = 0
  let firstMatch = -1
  let prevFound = -1
  for (let qi = 0; qi < query.length; qi++) {
    const ch = query[qi]!
    const found = text.indexOf(ch, ti)
    if (found < 0) return 0
    if (firstMatch < 0) firstMatch = found
    // 词边界（空格/分隔符后或串首）
    const prev = found > 0 ? text[found - 1]! : ''
    if (found === 0 || /[\s\-_./\\()]/.test(prev)) score += 8
    // 连续命中
    if (prevFound >= 0 && found === prevFound + 1) {
      consecutive++
      score += 4 + consecutive
    } else {
      consecutive = 0
      // 间隔惩罚（上限，避免长标题被罚死）
      if (prevFound >= 0) score -= Math.min(4, found - prevFound - 1)
    }
    score += 2
    prevFound = found
    ti = found + 1
  }
  // 越早命中、标题越短越优
  score += Math.max(0, 8 - firstMatch)
  score += Math.max(0, 10 - Math.floor(text.length / 5))
  return Math.max(1, Math.min(48, score))
}

/**
 * 命令打分：精确/前缀/包含/alias 保持高分优先，子序列 fuzzy 作兜底。
 * description（subtitle）仅轻微加权。
 */
function scoreItem(
  title: string,
  subtitle: string,
  query: string,
  aliases: string[] = []
): number {
  if (!query) return 1
  const q = query.toLowerCase()
  const t = title.toLowerCase()
  const s = (subtitle || '').toLowerCase()
  if (t === q) return 100
  if (t.startsWith(q)) return 80
  if (t.includes(q)) return 60
  for (const alias of aliases) {
    const a = alias.toLowerCase()
    if (a === q) return 95
    if (a.startsWith(q)) return 75
    if (a.includes(q)) return 55
  }
  if (s.includes(q)) return 30
  const titleFuzzy = fuzzySubsequenceScore(t, q)
  if (titleFuzzy > 0) return 20 + Math.floor(titleFuzzy * 0.5) // 20–44
  for (const alias of aliases) {
    const af = fuzzySubsequenceScore(alias.toLowerCase(), q)
    if (af > 0) return 16 + Math.floor(af * 0.4) // 16–35
  }
  const descFuzzy = fuzzySubsequenceScore(s, q)
  if (descFuzzy > 0) return 8 + Math.floor(descFuzzy * 0.2) // 8–17
  return 0
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
  return pluginRegistry
    .list()
    .filter((s) => s.installed && s.rootPath)
    .map((s) => pluginRegistry.getManifest(s.id))
    .filter((m): m is PluginManifest => !!m)
}

/** 插件 logo → enest:// 资源 URL；无 logo 返回 undefined */
function pluginIconUrl(pluginId: string, logo?: string): string | undefined {
  if (!logo) return undefined
  // 已是完整 URL（http/data/enest）直接用
  if (/^(https?:|data:|enest:)/i.test(logo)) return logo
  return pluginProtocolUrl(pluginId, logo.replace(/^\.?\//, ''))
}

export function buildPluginCommands(): QuickCommand[] {
  const items: QuickCommand[] = []
  for (const m of installedManifests()) {
    const pluginId = m.id
    const form = resolvePluginForm(m.form)
    const features = m.features ?? []
    const icon = pluginIconUrl(pluginId, m.logo)
    if (features.length === 0) {
      items.push({
        kind: 'plugin',
        id: `plugin:${pluginId}:`,
        title: m.name,
        subtitle: m.description || (form === 'mini' ? '小窗插件' : '主窗插件'),
        pluginId,
        form,
        icon
      })
      continue
    }
    for (const feature of features) {
      const cmds = Array.isArray(feature.cmds)
        ? feature.cmds.filter((c) => typeof c === 'string' && c)
        : []
      const primary = cmds[0]
      const label = primary || m.name
      items.push({
        kind: 'plugin',
        id: `plugin:${pluginId}:${feature.code}`,
        title: label,
        subtitle: feature.explain || m.name,
        pluginId,
        code: feature.code,
        form,
        aliases: cmds.slice(1),
        icon
      })
    }
  }
  return items
}

export function buildAppCommands(): QuickCommand[] {
  const cached = getCachedApps()
  if (!cached) return []
  return cached.apps.map((app) => ({
    kind: 'app' as const,
    id: `app:${app.path}`,
    title: app.name,
    subtitle: app.path,
    path: app.path,
    icon: app.icon
  }))
}

/** 为 top 结果异步补应用图标（data URL）；已带 icon 的跳过 */
async function attachAppIcons(items: QuickCommand[]): Promise<void> {
  await Promise.all(
    items.map(async (item) => {
      if (item.kind === 'app' && item.path && !item.icon) {
        item.icon = await getAppIconDataUrl(item.path)
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
 * 搜索命令。
 * - 空 query：recent（半衰+频次）优先，不足再补 action/插件/应用
 * - 有 query：精确/前缀/包含/alias 高分，子序列 fuzzy 兜底
 */
export async function searchQuickCommands(
  query: string,
  limit = 20,
  recent: QuickRecentEntry[] = []
): Promise<QuickCommand[]> {
  if (!getCachedApps()) {
    void scanApplications(false)
  }

  const q = (query || '').trim()
  const pool: QuickCommand[] = [
    ...BUILTIN_ACTIONS,
    ...buildPluginCommands(),
    ...buildAppCommands()
  ]

  if (!q) {
    const recentMap = new Map(recent.map((r) => [r.id, r]))
    const kindRank = (kind: QuickCommand['kind']): number =>
      kind === 'action' ? 0 : kind === 'plugin' ? 1 : 2
    const ranked = pool
      .map((item) => {
        const r = recentMap.get(item.id)
        return {
          item: r ? { ...item, lastUsedTs: r.ts, useCount: r.count } : item,
          hasRecent: !!r,
          score: r ? recentRank(r) : 0
        }
      })
      .sort((a, b) => {
        if (a.hasRecent !== b.hasRecent) return a.hasRecent ? -1 : 1
        if (a.hasRecent && b.hasRecent && a.score !== b.score) return b.score - a.score
        const kr = kindRank(a.item.kind) - kindRank(b.item.kind)
        if (kr !== 0) return kr
        return a.item.title.localeCompare(b.item.title, 'zh-CN')
      })
    const top = ranked.slice(0, limit).map((s) => s.item)
    await attachAppIcons(top)
    return top
  }

  const scored = pool
    .map((item) => ({
      item,
      score: scoreItem(item.title, item.subtitle, q, item.aliases)
    }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.item.title.localeCompare(b.item.title, 'zh-CN'))

  const top = applyRecentMeta(
    scored.slice(0, limit).map((s) => s.item),
    recent
  )
  await attachAppIcons(top)
  return top
}

export const QUICK_ACTIONS: QuickActionId[] = ['open-market', 'open-settings', 'refresh-apps']
export const QUICK_RECENT_MAX = RECENT_MAX
