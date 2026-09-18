/**
 * commandIndex — 快捷启动命令索引（provider 管线）
 * 职责：聚合内置 provider（actions / 插件命令 / 本地应用 / 剪贴板历史）与
 *       插件运行时 quick provider，提供统一搜索排序。
 * 兼容承诺：无外部 provider 时搜索结果与旧版完全一致（provider 仅追加）。
 * 被 quickHandlers 调用。
 */
import type { QuickActionId, QuickCommand } from '@shared/types/quick'
import type { PluginManifest, QuickRecentEntry } from '@shared/types/plugin'
import { resolvePluginForm } from '@shared/types/plugin'
import { pluginProtocolUrl } from '@shared/constants'
import { pluginRegistry } from '../plugin/PluginRegistry'
import { getCachedApps, scanApplications } from './appScanner'
import { getAppIconDataUrl } from './appLauncher'
import { searchHistory } from '../clipboard/clipboardHistory'
import { queryQuickProviders } from './quickProviders'

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
 * 命令打分：触发词（alias）精确/前缀最高（uTools），标题次之，子序列 fuzzy 兜底。
 * 返回 score 与可选 keywordHit。
 */
function scoreCommand(item: QuickCommand, query: string): { score: number; keywordHit?: string } {
  if (!query) return { score: 1 }
  const q = query.toLowerCase()
  const t = (item.title || '').toLowerCase()
  const s = (item.subtitle || '').toLowerCase()
  const aliases = item.aliases ?? []

  // 触发词优先：键入 cmds/别名直接命中插件
  for (const raw of aliases) {
    const a = raw.toLowerCase()
    if (!a) continue
    if (a === q) return { score: 120, keywordHit: raw }
    if (q.length >= 1 && a.startsWith(q)) return { score: 110, keywordHit: raw }
  }
  if (t === q) return { score: 100 }
  if (t.startsWith(q)) return { score: 80 }
  if (t.includes(q)) return { score: 60 }
  for (const raw of aliases) {
    const a = raw.toLowerCase()
    if (a.includes(q)) return { score: 55, keywordHit: raw }
  }
  if (s.includes(q)) return { score: 30 }
  const titleFuzzy = fuzzySubsequenceScore(t, q)
  if (titleFuzzy > 0) return { score: 20 + Math.floor(titleFuzzy * 0.5) }
  for (const raw of aliases) {
    const af = fuzzySubsequenceScore(raw.toLowerCase(), q)
    if (af > 0) return { score: 16 + Math.floor(af * 0.4), keywordHit: raw }
  }
  const descFuzzy = fuzzySubsequenceScore(s, q)
  if (descFuzzy > 0) return { score: 8 + Math.floor(descFuzzy * 0.2) }
  return { score: 0 }
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
        icon,
        aliases: [m.name]
      })
      continue
    }
    for (const feature of features) {
      const cmds = Array.isArray(feature.cmds)
        ? feature.cmds.filter((c) => typeof c === 'string' && c)
        : []
      // uTools 风格：展示插件名，cmds 全部作为触发关键词
      const explain = feature.explain || cmds.join(' · ')
      items.push({
        kind: 'plugin',
        id: `plugin:${pluginId}:${feature.code}`,
        title: features.length > 1 && cmds[0] ? `${m.name} · ${cmds[0]}` : m.name,
        subtitle: explain || (form === 'mini' ? '小窗插件' : '主窗插件'),
        pluginId,
        code: feature.code,
        form,
        aliases: cmds,
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
 * 剪贴板历史 → QuickCommand 映射：点击项经现有 openPlugin 打开 clipboard
 * 历史插件（若装了的话）；没装时无法执行，但结果仍可作为「找到过」提示——
 * 为避免不可执行项，仅在存在已安装的 clipboard.history 插件时纳入。
 */
function clipboardCommands(
  entries: Array<{ id: string; type: string; preview: string; ts: number; pinned: boolean }>
): QuickCommand[] {
  if (entries.length === 0) return []
  const owner = pluginRegistry
    .list()
    .find(
      (p) =>
        p.installed !== false &&
        (Boolean(p.rootPath) || p.dev === true) &&
        p.enabled !== false &&
        (p.permissions ?? []).includes('clipboard.history')
    )
  const pluginId = owner?.id
  if (!pluginId) return []
  return entries.map((e) => ({
    kind: 'plugin' as const,
    id: `clip:${e.id}`,
    title: e.type === 'image' ? `图片 ${e.preview}` : e.preview,
    subtitle: `剪贴板 · ${e.pinned ? '置顶 · ' : ''}${new Date(e.ts).toLocaleString()}`,
    pluginId,
    form: resolvePluginForm(owner?.form),
    aliases: ['clip', 'clipboard', '剪贴板']
  }))
}

/** 插件 provider 回传项 → QuickCommand（点击经现有 openPlugin 打开，code 透传） */
function providerCommands(
  results: Array<{ pluginId: string; providerId: string; items: Array<{ id?: string; title?: string; subtitle?: string; explain?: string; code?: string }> }>
): QuickCommand[] {
  const out: QuickCommand[] = []
  for (const result of results) {
    const manifest = pluginRegistry.getManifest(result.pluginId)
    const form = resolvePluginForm(manifest?.form)
    const icon = manifest ? pluginIconUrl(result.pluginId, manifest.logo) : undefined
    for (const item of result.items) {
      const title = String(item?.title ?? '').trim()
      if (!title) continue
      out.push({
        kind: 'plugin',
        id: `provider:${result.pluginId}:${result.providerId}:${String(item?.id ?? title)}`,
        title,
        subtitle: String(item?.subtitle ?? item?.explain ?? ''),
        pluginId: result.pluginId,
        code: item?.code ? String(item.code) : undefined,
        form,
        aliases: [result.providerId],
        icon
      })
    }
  }
  return out
}

/**
 * 搜索命令（provider 管线）。
 * - 空 query（首页网格）：最近使用的应用/插件 + 已安装小窗插件；不倾倒全部本地应用
 * - 有 query：内置 pool（actions/插件命令/应用/剪贴板）触发词 > 标题 > fuzzy；
 *   并发追加插件 quick provider 结果（每路 try/catch，超时 500ms 丢弃，不阻塞内置）
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

  // 内置剪贴板 provider：壳子自身能力，有数据即可搜（失败不阻塞）
  if (q) {
    try {
      pool.push(...clipboardCommands(await searchHistory(q, 6)))
    } catch {
      /* 剪贴板历史不可用时静默跳过 */
    }
  }

  if (!q) {
    const recentMap = new Map(recent.map((r) => [r.id, r]))
    // 1) 有使用记录的应用/插件（半衰+频次）
    const withRecent = pool
      .filter((item) => recentMap.has(item.id))
      .map((item) => {
        const r = recentMap.get(item.id)!
        return { item: { ...item, lastUsedTs: r.ts, useCount: r.count }, score: recentRank(r) }
      })
      .sort((a, b) => b.score - a.score)
      .map((s) => s.item)
    // 2) 已安装小窗插件补位（未在最近里）
    const recentIds = new Set(withRecent.map((i) => i.id))
    const miniRest = pool.filter((i) => i.kind === 'plugin' && i.form === 'mini' && !recentIds.has(i.id))
    const top = [...withRecent, ...miniRest].slice(0, limit)
    await attachAppIcons(top)
    return top
  }

  const scored = pool
    .map((item) => {
      const hit = scoreCommand(item, q)
      return {
        item: hit.keywordHit ? { ...item, keywordHit: hit.keywordHit } : item,
        score: hit.score
      }
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.item.title.localeCompare(b.item.title, 'zh-CN'))

  let top = applyRecentMeta(
    scored.slice(0, limit).map((s) => s.item),
    recent
  )

  // 插件 quick provider：并发查询，失败/超时不阻塞内置结果
  try {
    const providerItems = providerCommands(await queryQuickProviders(q))
    if (providerItems.length > 0) {
      // provider 项给中段分数（低于触发词/标题精确命中，高于 fuzzy 弱命中），
      // 与内置结果合并重排后仍受 limit 约束
      const merged = [
        ...scored.map((s) => ({ item: s.item, score: s.score })),
        ...providerItems.map((item) => ({ item, score: 34 }))
      ]
        .sort((a, b) => b.score - a.score || a.item.title.localeCompare(b.item.title, 'zh-CN'))
        .map((s) => s.item)
      top = applyRecentMeta(merged.slice(0, limit), recent)
    }
  } catch {
    /* provider 管线失败不影响内置搜索 */
  }

  await attachAppIcons(top)
  return top
}

export const QUICK_ACTIONS: QuickActionId[] = ['open-market', 'open-settings', 'refresh-apps']
export const QUICK_RECENT_MAX = RECENT_MAX
