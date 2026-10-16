/** 插件市场展示元数据：统一远程索引、本地 manifest 与已安装摘要的图片解析和合并。 */
import { isPluginAssetPath } from '@shared/pluginContract'
import manifestSchema from '@shared/pluginManifest.schema.json'
import { pluginProtocolUrl } from '@shared/constants'
import type { PluginManifest, PluginPermission, PluginSummary, PluginUiConfig } from '@shared/types/plugin'
import { PLUGIN_PERMISSIONS, resolvePluginUi } from '@shared/types/plugin'

export interface RemoteRegistryPlugin {
  id: string
  name: string
  version: string
  description?: string
  author?: string
  category?: string
  icon?: string
  screenshots?: string[]
  readmeUrl?: string
  readmeImages?: Record<string, string>
  permissions?: string[]
  featured?: boolean
  tags?: string[]
  installs?: number
  ui?: Partial<PluginUiConfig>
  asset?: { name?: string; url?: string; sha256?: string; size?: number }
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
  icon?: string
  screenshots?: string[]
  readmeUrl?: string
  readmeImages?: Record<string, string>
  permissions: PluginPermission[]
  ui: PluginUiConfig
  featured: boolean
  tags: string[]
  packageSize?: number
  assetUrl: string | null
  assetSha256: string | null
  source: 'remote'
}

const SCREENSHOT_LIMIT = 8
const IMAGE_EXTENSION = /\.(png|jpe?g|webp|gif)$/i
const PLUGIN_ID_PATTERN = new RegExp(manifestSchema.properties.id.pattern)
const PLUGIN_VERSION_PATTERN = new RegExp(manifestSchema.properties.version.pattern)
/** 本地兜底分类；远程 registry 声明 categories 时以其为准（插件仓库配置即市场分类） */
const CATEGORIES = new Set(['效率', '开发', '设计', '媒体', '其它'])

/** registry.json 顶层 categories（字符串数组）；缺省/非法时回落本地兜底集合 */
function registryCategories(data: unknown): Set<string> {
  if (!data || typeof data !== 'object' || !('categories' in data)) return CATEGORIES
  const arr = (data as { categories?: unknown }).categories
  if (!Array.isArray(arr)) return CATEGORIES
  const set = new Set(
    arr
      .filter((c): c is string => typeof c === 'string' && c.trim().length > 0)
      .map((c) => c.trim())
  )
  return set.size ? set : CATEGORIES
}

/** 仅远程 HTTP(S) 图片；兼容旧 HTTP 元数据，拒绝凭据及其它协议。 */
function httpImageUrl(raw: string): string | undefined {
  try {
    const url = new URL(raw)
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return undefined
    return url.href
  } catch {
    return undefined
  }
}

/** manifest 使用磁盘原名，registry 使用 URL 编码路径；最终统一编码且不允许越界。 */
function relativeImagePath(raw: string, screenshot: boolean, urlEncoded = true): string | undefined {
  if (/^[a-z][a-z\d+.-]*:/i.test(raw) || raw.startsWith('/')) return undefined
  let decoded: string
  try {
    decoded = urlEncoded ? decodeURIComponent(raw) : raw
  } catch {
    return undefined
  }
  if (/[\\?#\u0000-\u001f\u007f]/.test(decoded) || decoded.startsWith('/')) return undefined
  const parts = decoded.replace(/^\.\//, '').split('/')
  if (parts.some((part) => !part || part === '.' || part === '..' || part.includes(':'))) return undefined
  if (screenshot && !IMAGE_EXTENSION.test(decoded)) return undefined
  return parts.map(encodeURIComponent).join('/')
}

/** 相对路径相对于 registry.json 所在目录，适用于 raw、Release 与自托管索引。 */
export function resolveRegistryImageUrl(
  value: unknown,
  registryUrl: string,
  screenshot = false
): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined
  const raw = value.trim()
  const absolute = httpImageUrl(raw)
  if (absolute) return absolute
  const relative = relativeImagePath(raw, screenshot)
  const base = httpImageUrl(registryUrl)
  if (!relative || !base) return undefined
  return new URL(relative, base).href
}

/** 无截图/非法元数据均返回空数组；保持发布顺序，剔除重复和无效地址。 */
function readmeImages(raw: unknown, registryUrl: string): Record<string, string> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const result: Record<string, string> = Object.create(null)
  for (const [key, value] of Object.entries(raw).slice(0, 32)) {
    const path = key.replace(/^\.\//, '')
    if (!isPluginAssetPath(path) || !/\.(png|jpe?g|webp|gif|svg)$/i.test(path)) continue
    const url = resolveRegistryImageUrl(value, registryUrl)
    if (url) result[path] = url
  }
  return result
}

function screenshotUrls(raw: unknown, resolve: (value: unknown) => string | undefined): string[] {
  if (!Array.isArray(raw)) return []
  const result: string[] = []
  for (const value of raw) {
    const url = resolve(value)
    if (url && !result.includes(url)) result.push(url)
    if (result.length === SCREENSHOT_LIMIT) break
  }
  return result
}

export function manifestScreenshots(manifest: PluginManifest): string[] {
  return screenshotUrls(manifest.market?.screenshots, (value) => {
    if (typeof value !== 'string' || !value.trim()) return undefined
    const raw = value.trim()
    if (!isPluginAssetPath(raw) || !raw.startsWith('assets/market/screenshots/')) return undefined
    const relative = relativeImagePath(raw, true, false)
    return relative ? pluginProtocolUrl(manifest.id, relative) : undefined
  })
}

export function manifestCategory(manifest: PluginManifest): string | undefined {
  const category = (manifest.category ?? '').trim()
  return category || undefined
}

/** 由 id 稳定生成展示色，避免无图标的市场条目一片灰。 */
function colorFromId(id: string): string {
  let hash = 0
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0
  return `hsl(${hash % 360} 55% 48%)`
}

function stringValue(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

/** 不补造标签；只去除无效项、重复项并限制索引提供的文本长度。 */
export function marketTags(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value.filter((tag): tag is string => typeof tag === 'string')
    .map((tag) => tag.trim()).filter((tag) => tag.length > 0 && tag.length <= 40))].slice(0, 12)
}

/** 对旧索引向后兼容；坏条目不拖垮整份市场列表。 */
export function parseRemoteMarket(
  data: unknown,
  registryUrl: string,
  releaseBaseUrl: string
): MarketPluginSummary[] {
  if (!data || typeof data !== 'object' || !('plugins' in data) || !Array.isArray(data.plugins)) return []
  // 分类集合以 registry 声明为准（GitHub 插件仓库配置），未声明时回落本地枚举
  const categorySet = registryCategories(data)
  return data.plugins.flatMap((raw: unknown) => {
    if (!raw || typeof raw !== 'object') return []
    const p = raw as RemoteRegistryPlugin
    if (typeof p.id !== 'string' || !PLUGIN_ID_PATTERN.test(p.id) || p.id === manifestSchema.properties.id.not.const || typeof p.name !== 'string' || !p.name.trim() ||
        typeof p.version !== 'string' || !PLUGIN_VERSION_PATTERN.test(p.version)) return []
    const category = stringValue(p.category).trim()
    const installs = typeof p.installs === 'number' && Number.isFinite(p.installs) && p.installs > 0 ? p.installs : 0
    const asset = stringValue(p.asset?.url) || stringValue(p.asset?.name)
    const assetUrl = asset ? httpImageUrl(asset) ?? (
      /^[^/\\:]+\.enestplugin$/.test(asset) ? new URL(encodeURIComponent(asset), releaseBaseUrl).href : null
    ) : null
    const sha = stringValue(p.asset?.sha256).trim().toLowerCase()
    return [{
      id: p.id,
      name: p.name,
      version: p.version,
      description: stringValue(p.description),
      author: stringValue(p.author),
      category: categorySet.has(category) ? category : '其它',
      installs: installs > 0 ? installs >= 1000 ? `${(installs / 1000).toFixed(1)}k` : String(installs) : '',
      color: colorFromId(p.id),
      glyph: p.name.trim().slice(0, 1).toUpperCase() || '?',
      icon: resolveRegistryImageUrl(p.icon, registryUrl),
      screenshots: screenshotUrls(p.screenshots, (value) => resolveRegistryImageUrl(value, registryUrl, true)),
      readmeUrl: resolveRegistryImageUrl(p.readmeUrl, registryUrl),
      readmeImages: readmeImages(p.readmeImages, registryUrl),
      permissions: Array.isArray(p.permissions)
        ? p.permissions.filter((permission): permission is PluginPermission => PLUGIN_PERMISSIONS.includes(permission as PluginPermission))
        : [],
      ui: resolvePluginUi(p.ui),
      featured: p.featured === true,
      tags: marketTags(p.tags),
      packageSize: typeof p.asset?.size === 'number' && Number.isSafeInteger(p.asset.size) && p.asset.size > 0 ? p.asset.size : undefined,
      assetUrl,
      assetSha256: /^[0-9a-f]{64}$/.test(sha) ? sha : null,
      source: 'remote' as const
    }]
  })
}

/** 安装后保留本地运行信息与版本，同时保留市场分类、推荐和截图。 */
export function mergeMarketMetadata(summary: PluginSummary, remote?: MarketPluginSummary): PluginSummary {
  if (!remote) return summary
  const localScreenshots = summary.screenshots ?? []
  const screenshots = summary.installed ? localScreenshots : remote.screenshots ?? []
  return {
    ...summary,
    category: remote.category,
    installs: summary.dev ? summary.installs : remote.installs,
    color: remote.color,
    glyph: remote.glyph,
    icon: summary.installed ? summary.icon : remote.icon,
    screenshots,
    readmeUrl: summary.installed ? summary.readmeUrl : remote.readmeUrl,
    readmeImages: summary.installed ? undefined : remote.readmeImages,
    tags: summary.installed ? summary.tags : remote.tags,
    packageSize: summary.version === remote.version ? remote.packageSize : undefined,
    featured: summary.dev && summary.featured !== undefined ? summary.featured : remote.featured
  }
}

export function remoteToSummary(remote: MarketPluginSummary, enabled: boolean): PluginSummary {
  const { assetUrl: _url, assetSha256: _sha, source: _source, ...metadata } = remote
  return { ...metadata, installed: false, enabled }
}
