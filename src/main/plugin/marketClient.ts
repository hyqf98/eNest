/**
 * marketClient — 远程插件市场（eNest_plugin 仓库）
 * 职责：拉取 registry.json 并转换为 PluginSummary 列表，供 PluginRegistry 合并；
 *       提供 .enestplugin 资产下载（https + 可选 sha256 校验），保留 Node fetch 代理链路。
 * 数据源优先级：Release latest → raw main 分支。
 * 关键依赖：Node undici fetch（避开 Chromium c-ares）、marketMetadata、logService。
 */
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseRemoteMarket, type MarketPluginSummary } from '@main/plugin/marketMetadata'
import { logInfo, logWarn } from '@main/logs/logService'

export type { MarketPluginSummary } from '@main/plugin/marketMetadata'

/** 官方插件市场仓库（hyqf98/eNest_plugin） */
export const MARKET_REPO_OWNER = 'hyqf98'
export const MARKET_REPO_NAME = 'eNest_plugin'

const REGISTRY_URLS = [
  `https://github.com/${MARKET_REPO_OWNER}/${MARKET_REPO_NAME}/releases/latest/download/registry.json`,
  `https://raw.githubusercontent.com/${MARKET_REPO_OWNER}/${MARKET_REPO_NAME}/main/registry.json`
]

async function fetchJson(url: string): Promise<unknown> {
  try {
    // Node undici fetch（不走 Chromium net/c-ares）：主进程外部请求须避开内置解析器，
    // 见 index.ts host-resolver-rules 注释；代理经 proxyService 设置的 HTTP(S)_PROXY 生效
    const res = await fetch(url, { method: 'GET' })
    if (!res.ok) return null
    return await res.json()
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
    const plugins = parseRemoteMarket(
      data,
      url,
      `https://github.com/${MARKET_REPO_OWNER}/${MARKET_REPO_NAME}/releases/latest/download/`
    )
    if (plugins.length) return plugins
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
 * - 走 Node fetch，沿用 proxyService 设置的环境代理。
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
