/**
 * commandIndex — 快捷启动命令索引
 * 职责：聚合本地应用 + 已安装插件 features.cmds + 内置 action，提供搜索排序。
 * 被 quickHandlers 调用。
 */
import type { QuickActionId, QuickCommand } from '@shared/types/quick'
import type { PluginManifest } from '@shared/types/plugin'
import { resolvePluginForm } from '@shared/types/plugin'
import { pluginRegistry } from '../plugin/PluginRegistry'
import { getCachedApps, scanApplications } from './appScanner'

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
  return 0
}

/** 已安装 / 开发态插件 manifest（不含未安装的市场 mock） */
function installedManifests(): PluginManifest[] {
  return pluginRegistry
    .list()
    .filter((s) => s.installed && s.rootPath)
    .map((s) => pluginRegistry.getManifest(s.id))
    .filter((m): m is PluginManifest => !!m)
}

export function buildPluginCommands(): QuickCommand[] {
  const items: QuickCommand[] = []
  for (const m of installedManifests()) {
    const pluginId = m.id
    const form = resolvePluginForm(m.form)
    const features = m.features ?? []
    if (features.length === 0) {
      items.push({
        kind: 'plugin',
        id: `plugin:${pluginId}:`,
        title: m.name,
        subtitle: m.description || (form === 'mini' ? '小窗插件' : '主窗插件'),
        pluginId,
        form
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
        aliases: cmds.slice(1)
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
    path: app.path
  }))
}

export async function searchQuickCommands(query: string, limit = 20): Promise<QuickCommand[]> {
  if (!getCachedApps()) {
    void scanApplications(false)
  }

  const q = (query || '').trim()
  if (!q) {
    const plugins = buildPluginCommands().slice(0, 6)
    const apps = buildAppCommands().slice(0, 8)
    return [...BUILTIN_ACTIONS, ...plugins, ...apps].slice(0, limit)
  }

  const pool: QuickCommand[] = [
    ...BUILTIN_ACTIONS,
    ...buildPluginCommands(),
    ...buildAppCommands()
  ]

  const scored = pool
    .map((item) => ({
      item,
      score: scoreItem(item.title, item.subtitle, q, item.aliases)
    }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.item.title.localeCompare(b.item.title, 'zh-CN'))

  return scored.slice(0, limit).map((s) => s.item)
}

export const QUICK_ACTIONS: QuickActionId[] = ['open-market', 'open-settings', 'refresh-apps']
