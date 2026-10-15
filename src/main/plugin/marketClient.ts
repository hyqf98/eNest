/**
 * marketClient — 远程插件市场（eNest_plugin 仓库）
 * 职责：拉取 registry.json 并转换为 PluginSummary 列表，供 PluginRegistry 合并；
 *       提供 .enestplugin 资产下载（https + 可选 sha256 校验），保留 Node fetch 代理链路。
 * 数据源优先级：Release latest → raw main 分支。
 * 关键依赖：Node undici fetch（避开 Chromium c-ares）、marketMetadata、logService。
 */
import { createHash } from 'node:crypto'
import { mkdtemp, open, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseRemoteMarket, type MarketPluginSummary } from '@main/plugin/marketMetadata'
import { logInfo, logWarn } from '@main/logs/logService'

export type { MarketPluginSummary } from '@main/plugin/marketMetadata'

/** 官方插件市场仓库（hyqf98/eNest_plugin） */
export const MARKET_REPO_OWNER = 'hyqf98'
export const MARKET_REPO_NAME = 'eNest_plugin'

/** GitHub Release latest 下载基址（registry.json 与 .enestplugin 资产同源） */
const RELEASE_BASE = `https://github.com/${MARKET_REPO_OWNER}/${MARKET_REPO_NAME}/releases/latest/download/`

const REGISTRY_URLS = [
  `${RELEASE_BASE}registry.json`,
  `https://raw.githubusercontent.com/${MARKET_REPO_OWNER}/${MARKET_REPO_NAME}/main/registry.json`
]

async function fetchJson(url: string): Promise<unknown> {
  try {
    // Node undici fetch（不走 Chromium net/c-ares）：主进程外部请求须避开内置解析器，
    // 见 index.ts host-resolver-rules 注释；代理经 proxyService 设置的 HTTP(S)_PROXY 生效
    const res = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(15_000) })
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}

const readmeCache = new Map<string, string>()
/** Only registry-owned URLs reach this function; bound time, bytes and retained cache. */
export async function fetchMarketReadme(url: string): Promise<string> {
  const parsed = new URL(url)
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('invalid README URL')
  const cached = readmeCache.get(url)
  if (cached !== undefined) { readmeCache.delete(url); readmeCache.set(url, cached); return cached }
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) })
  if (!response.ok || !response.body) throw new Error(`插件说明读取失败：HTTP ${response.status}`)
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > 512 * 1024) throw new Error('插件说明超过 512 KiB')
      chunks.push(value)
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
  const markdown = Buffer.concat(chunks).toString('utf8')
  readmeCache.set(url, markdown)
  while (readmeCache.size > 20) readmeCache.delete(readmeCache.keys().next().value!)
  return markdown
}

/**
 * 拉取远程市场列表；全部失败时返回空数组（保留已验证缓存与已安装插件）。
 * 不在此处抛错，避免断网导致市场页崩溃。
 */
export async function fetchRemoteMarket(): Promise<MarketPluginSummary[]> {
  for (const url of REGISTRY_URLS) {
    const data = await fetchJson(url)
    const plugins = parseRemoteMarket(data, url, RELEASE_BASE)
    if (plugins.length) return plugins
  }
  return []
}

// —— 资产下载 ——

/** 通用单包上限；允许插件自带各平台原生依赖，仍限制下载与解压预算。 */
export const MAX_PLUGIN_PACKAGE_BYTES = 256 * 1024 * 1024
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
 * - 走 Node fetch，沿用 proxyService 设置的环境代理。
 * - 大小上限 / 超时 / 可选 sha256；失败或调用方结束时 cleanup 临时文件。
 */
export async function downloadPluginPackage(
  url: string,
  opts: {
    /** Known registry identity, not inferred from an arbitrary URL or display name. */
    pluginId?: string
    expectedSha256?: string | null
    fileName?: string
    onProgress?: (p: DownloadProgress) => void
  } = {}
): Promise<DownloadedPackage> {
  const maxBytes = MAX_PLUGIN_PACKAGE_BYTES
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
    // 同 fetchJson：Node undici fetch，避开 Chromium c-ares（见 index.ts host-resolver-rules）
    const res = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
      redirect: 'follow'
    })
    if (!res.ok) {
      throw new Error(`download failed: HTTP ${res.status}`)
    }
    const lengthHeader = res.headers.get('content-length')
    const total = lengthHeader ? Number(lengthHeader) : null
    if (total != null && total > maxBytes) {
      throw new Error(`package too large: ${total} bytes (limit ${maxBytes})`)
    }

    const body = res.body
    if (!body) {
      throw new Error('download failed: empty body')
    }

    const reader = body.getReader()
    const file = await open(dest, 'wx')
    const digest = createHash('sha256')
    let received = 0
    try { for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) {
        received += value.byteLength
        if (received > maxBytes) {
          try {
            await reader.cancel()
          } catch {
            /* ignore */
          }
          throw new Error(`package too large: exceeded ${maxBytes} bytes`)
        }
        digest.update(value)
        await file.writeFile(value)
        opts.onProgress?.({
          percent: total ? Math.min(99, Math.round((received / total) * 100)) : 0,
          received,
          total
        })
      }
    }

    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); await file.close() }
    if (received === 0) {
      throw new Error('download failed: empty file')
    }

    const actualSha = digest.digest('hex')
    const expected = (opts.expectedSha256 ?? '').trim().toLowerCase()
    if (expected) {
      if (actualSha !== expected) {
        throw new Error(`sha256 mismatch: expected ${expected.slice(0, 12)}… got ${actualSha.slice(0, 12)}…`)
      }
      logInfo('market', `sha256 ok ${actualSha.slice(0, 12)}…`)
    } else {
      logWarn('market', `sha256 not provided, skip verify (${actualSha.slice(0, 12)}…)`)
    }

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
    controller.abort()
  }
}
