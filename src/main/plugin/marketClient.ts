/**
 * marketClient — 远程插件市场（eNest_plugin 仓库）
 * 职责：拉取 registry.json 并转换为 PluginSummary 列表，供 PluginRegistry 合并；
 *       提供 .enestplugin 资产下载（https + 可选 sha256 校验），走 Electron net
 *       以继承 defaultSession 代理配置。
 * 数据源优先级：Release latest → raw main 分支。
 * 关键依赖：net.fetch（Electron）、mockMarket 的类型对齐、logService。
 */
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { net } from 'electron'
import type { PluginPermission, PluginUiConfig } from '@shared/types/plugin'
import { DEFAULT_PLUGIN_UI, resolvePluginUi } from '@shared/types/plugin'
import { logInfo, logWarn } from '@main/logs/logService'

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
  asset?: { name?: string; url?: string; sha256?: string; size?: number }
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
  /** 图标 URL（registry.icon；release 流程会重写为 Release 绝对地址） */
  icon?: string
  permissions: PluginPermission[]
  ui: PluginUiConfig
  featured: boolean
  assetUrl: string | null
  /** registry.asset.sha256；空串/缺省表示跳过校验 */
  assetSha256: string | null
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

/** 归一 sha256：空串/非 hex 视为无 */
function resolveAssetSha256(p: RemoteRegistryPlugin): string | null {
  const raw = (p.asset?.sha256 ?? '').trim().toLowerCase()
  return /^[0-9a-f]{64}$/.test(raw) ? raw : null
}

/**
 * 归一图标 URL：release 流程通常已重写为绝对地址；
 * 相对路径（icons/xxx.svg）按 registry 来源解析 raw main 分支路径兜底。
 */
function resolveIconUrl(p: RemoteRegistryPlugin, registryUrl: string): string | undefined {
  const raw = (p.icon ?? '').trim()
  if (!raw) return undefined
  if (/^https?:\/\//i.test(raw)) return raw
  if (/^https?:\/\/[^/]+\/[^/]+\/[^/]+\/raw\/[^/]+\//.test(registryUrl)) {
    // raw.githubusercontent.com/{owner}/{repo}/{branch}/{path}
    return `${registryUrl.replace(/\/[^/]*$/, '')}/${raw.replace(/^\.?\//, '')}`
  }
  return undefined
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
      icon: resolveIconUrl(p, url),
      permissions: (p.permissions ?? []) as PluginPermission[],
      ui: resolvePluginUi(p.ui ?? DEFAULT_PLUGIN_UI),
      featured: Boolean(p.featured),
      assetUrl: resolveAssetUrl(p),
      assetSha256: resolveAssetSha256(p),
      source: 'remote' as const
    }))
  }
  return []
}

/** 插件 zip 下载地址（安装器使用） */
export function remoteAssetDownloadUrl(fileName: string): string {
  return `https://github.com/${MARKET_REPO_OWNER}/${MARKET_REPO_NAME}/releases/latest/download/${fileName}`
}

// —— 资产下载 ——

/** 单包大小上限：100MB（插件 zip 正常远小于此） */
export const MAX_PLUGIN_PACKAGE_BYTES = 100 * 1024 * 1024
/** 下载总超时：3 分钟 */
export const DOWNLOAD_TIMEOUT_MS = 3 * 60 * 1000

export interface DownloadProgress {
  /** 0–100，按已下载字节 / Content-Length 估算；无长度时用 0 */
  percent: number
  received: number
  total: number | null
}

export interface DownloadedPackage {
  /** 临时文件绝对路径（调用方安装完后须 cleanup） */
  path: string
  cleanup: () => Promise<void>
}

/**
 * 下载 .enestplugin 到系统临时目录。
 * - 仅允许 http(s)；优先 https（GitHub Release）。
 * - 走 Electron net.fetch，继承 defaultSession 代理（proxyService 已 setProxy）。
 * - 大小上限 / 超时 / 可选 sha256；失败或调用方结束时 cleanup 临时文件。
 */
export async function downloadPluginPackage(
  url: string,
  opts: {
    expectedSha256?: string | null
    fileName?: string
    onProgress?: (p: DownloadProgress) => void
  } = {}
): Promise<DownloadedPackage> {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error(`invalid asset url: ${url}`)
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`unsupported asset protocol: ${parsed.protocol}`)
  }
  if (parsed.protocol === 'http:') {
    logWarn('market', `insecure http download: ${url}`)
  }

  const safeName = (opts.fileName || parsed.pathname.split('/').pop() || 'plugin.enestplugin')
    .replace(/[^\w.@+-]+/g, '_')
    .slice(0, 120)
  const tmpDir = await mkdtemp(join(tmpdir(), 'enest-dl-'))
  const dest = join(tmpDir, safeName.endsWith('.enestplugin') ? safeName : `${safeName}.enestplugin`)

  const cleanup = async (): Promise<void> => {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {
      logWarn('market', `cleanup temp failed: ${tmpDir}`)
    })
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS)

  try {
    logInfo('market', `download ← ${url}`)
    const res = await net.fetch(url, {
      method: 'GET',
      signal: controller.signal,
      redirect: 'follow'
    })
    if (!res.ok) {
      throw new Error(`download failed: HTTP ${res.status}`)
    }
    const lengthHeader = res.headers.get('content-length')
    const total = lengthHeader ? Number(lengthHeader) : null
    if (total != null && total > MAX_PLUGIN_PACKAGE_BYTES) {
      throw new Error(`package too large: ${total} bytes (limit ${MAX_PLUGIN_PACKAGE_BYTES})`)
    }

    const body = res.body
    if (!body) {
      throw new Error('download failed: empty body')
    }

    const reader = body.getReader()
    const chunks: Uint8Array[] = []
    let received = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) {
        received += value.byteLength
        if (received > MAX_PLUGIN_PACKAGE_BYTES) {
          try {
            await reader.cancel()
          } catch {
            /* ignore */
          }
          throw new Error(`package too large: exceeded ${MAX_PLUGIN_PACKAGE_BYTES} bytes`)
        }
        chunks.push(value)
        opts.onProgress?.({
          percent: total ? Math.min(99, Math.round((received / total) * 100)) : 0,
          received,
          total
        })
      }
    }

    const buf = Buffer.concat(chunks.map((c) => Buffer.from(c)))
    if (buf.length === 0) {
      throw new Error('download failed: empty file')
    }

    const actualSha = createHash('sha256').update(buf).digest('hex')
    const expected = (opts.expectedSha256 ?? '').trim().toLowerCase()
    if (expected) {
      if (actualSha !== expected) {
        throw new Error(`sha256 mismatch: expected ${expected.slice(0, 12)}… got ${actualSha.slice(0, 12)}…`)
      }
      logInfo('market', `sha256 ok ${actualSha.slice(0, 12)}…`)
    } else {
      logWarn('market', `sha256 not provided, skip verify (${actualSha.slice(0, 12)}…)`)
    }

    await writeFile(dest, buf)
    opts.onProgress?.({ percent: 100, received, total: total ?? received })
    logInfo('market', `download ok → ${dest} (${received} bytes)`)
    return { path: dest, cleanup }
  } catch (err) {
    await cleanup()
    if ((err as Error).name === 'AbortError') {
      throw new Error(`download timeout after ${DOWNLOAD_TIMEOUT_MS}ms`)
    }
    throw err
  } finally {
    clearTimeout(timer)
  }
}
