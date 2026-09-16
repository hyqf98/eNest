/**
 * marketClient — 远程插件市场（eNest_plugin 仓库）
 * 职责：拉取 registry.json 并转换为 PluginSummary 列表，供 PluginRegistry 合并。
 * 数据源优先级：Release latest → raw main 分支。
 * 关键依赖：net.fetch（Electron）、mockMarket 的类型对齐。
 */
import { net } from 'electron'
import type { PluginPermission, PluginUiConfig } from '@shared/types/plugin'
import { DEFAULT_PLUGIN_UI, resolvePluginUi } from '@shared/types/plugin'

/** 官方插件市场仓库（hyqf98/eNest_plugin） */
export const MARKET_REPO_OWNER = 'hyqf98'
export const MARKET_REPO_NAME = 'eNest_plugin'

const REGISTRY_URLS = [
  `https://github.com/${MARKET_REPO_OWNER}/${MARKET_REPO_NAME}/releases/latest/download/registry.json`,
  `https://raw.githubusercontent.com/${MARKET_REPO_OWNER}/${MARKET_REPO_NAME}/main/registry.json`
]

/** registry.json 中单个插件条目（与 eNest_plugin/scripts/build-registry 对齐） */
interface RemoteRegistryPlugin {
  id: string
  name: string
  version: string
  description?: string
  author?: string
  category?: string
  icon?: string
  tags?: string[]
  permissions?: string[]
  featured?: boolean
  installs?: number
  ui?: Partial<PluginUiConfig>
  asset?: { name?: string; url?: string }
}

interface RemoteRegistry {
  schemaVersion?: number
  plugins?: RemoteRegistryPlugin[]
}

export interface MarketPluginSummary {
  id: string
  name: string
  version: string
  description: string
  author: string
  category: string
  installs: string
  color: string
  glyph: string
  permissions: PluginPermission[]
  ui: PluginUiConfig
  featured: boolean
  assetUrl: string | null
  source: 'remote'
}

/** 由 id 稳定生成展示色，避免市场无图标时一片灰 */
function colorFromId(id: string): string {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0
  const hue = h % 360
  return `hsl(${hue} 55% 48%)`
}

function glyphFromName(name: string): string {
  const t = name.trim()
  if (!t) return '?'
  return t.slice(0, 1).toUpperCase()
}

function formatInstalls(n: number | undefined): string {
  if (!n || n <= 0) return '0'
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}

/** Release 资产 URL：优先用 latest download 相对名 */
function resolveAssetUrl(p: RemoteRegistryPlugin): string | null {
  const name = p.asset?.name || p.asset?.url
  if (!name) return null
  if (/^https?:\/\//.test(name)) return name
  return `https://github.com/${MARKET_REPO_OWNER}/${MARKET_REPO_NAME}/releases/latest/download/${name}`
}

async function fetchJson(url: string): Promise<RemoteRegistry | null> {
  try {
    const res = await net.fetch(url, { method: 'GET' })
    if (!res.ok) return null
    return (await res.json()) as RemoteRegistry
  } catch {
    return null
  }
}

/**
 * 拉取远程市场列表；全部失败时返回空数组（壳子继续用本地 mock）。
 * 不在此处抛错，避免断网导致市场页崩溃。
 */
export async function fetchRemoteMarket(): Promise<MarketPluginSummary[]> {
  for (const url of REGISTRY_URLS) {
    const data = await fetchJson(url)
    if (!data?.plugins?.length) continue
    return data.plugins.map((p) => ({
      id: p.id,
      name: p.name,
      version: p.version,
      description: p.description ?? '',
      author: p.author ?? 'unknown',
      category: p.category ?? '其它',
      installs: formatInstalls(p.installs),
      color: colorFromId(p.id),
      glyph: glyphFromName(p.name),
      permissions: (p.permissions ?? []) as PluginPermission[],
      ui: resolvePluginUi(p.ui ?? DEFAULT_PLUGIN_UI),
      featured: Boolean(p.featured),
      assetUrl: resolveAssetUrl(p),
      source: 'remote' as const
    }))
  }
  return []
}

/** 插件 zip 下载地址（安装器使用） */
export function remoteAssetDownloadUrl(fileName: string): string {
  return `https://github.com/${MARKET_REPO_OWNER}/${MARKET_REPO_NAME}/releases/latest/download/${fileName}`
}
