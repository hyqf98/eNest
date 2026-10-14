/**
 * lanShareService — 局域网传件宿主服务（lan.share.*）
 * 职责：以 node http 起临时下载服务（0.0.0.0 随机端口，局域网可见——
 *       这是功能本身：手机等设备经 ?code= 6 位数字取件码下载白名单文件）；
 *       只读 GET、Range 简单支持、限时自动关停（缺省 10 分钟）、并发连接上限；
 *       每次下载经 pluginHost.sendEvent 推 `lan.request` 事件给插件做传输日志；
 *       插件关闭/休眠时经 PluginRuntimeScope disposer → releaseLanShares 释放。
 * 被 pluginHandlers 分发调用（method 以 lan.share.* 开头）。
 * 安全：
 * - 下载必须携带 ?code= 且 timingSafeEqual 常时校验 6 位数字取件码；
 * - 仅服务 start 时冻结的白名单文件（localFiles 句柄 / 显式绝对路径），目录不可下载；
 * - Content-Disposition 文件名 RFC 5987 编码，URL 路径仅作展示索引；
 * - 并发连接上限 8（超限 503），到期/stop 自动关停并推 `lan.stopped` 事件。
 * 关键依赖：node:http / node:crypto / node:os / node:fs/promises /
 * PluginHost 事件通道 / PluginRuntimeScope。
 */
import * as http from 'node:http'
import { randomInt, randomUUID, timingSafeEqual } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import { networkInterfaces } from 'node:os'
import type { PluginEventPayload } from '@shared/types/ipc'
import { pluginHost } from '@main/plugin/PluginHost'
import { getRuntimeScope } from '@main/plugin/PluginRuntimeScope'

/** 取件码：6 位数字 */
const CODE_LENGTH = 6
/** 缺省分享时长（分钟） */
export const DEFAULT_SHARE_MINUTES = 10
/** 分享时长上限（分钟） */
export const MAX_SHARE_MINUTES = 120
/** 单分享并发下载连接上限 */
export const MAX_CONCURRENT_CONNECTIONS = 8
/** 单文件下载读流上限（4GB，防异常超大文件占死句柄） */
const MAX_FILE_BYTES = 4 * 1024 * 1024 * 1024

/** 可下载文件项：start 时冻结的绝对路径白名单 */
export interface LanShareFile {
  /** 白名单内索引（URL 路径 /d/<id>） */
  id: string
  name: string
  size: number
  /** 宿主侧绝对路径；仅供宿主读取，绝不回传插件 */
  path: string
}

export interface LanShareStatus {
  shareId: string
  port: number
  code: string
  files: Array<Pick<LanShareFile, 'id' | 'name' | 'size'>>
  /** 本机内网 IPv4 列表（过滤回环/内网保留段外地址原样保留，由插件展示/生成二维码） */
  ips: string[]
  startedAt: number
  /** 到期时间戳（ms）；手动/到期关停后由 stopped 标识取代 */
  expiresAt: number
  stopped?: boolean
  stopReason?: string
  activeConnections: number
  downloads: number
}

interface ShareEntry extends LanShareStatus {
  pluginId: string
  server: http.Server
  files: LanShareFile[]
  codeBuf: Buffer
  timer?: NodeJS.Timeout
  detached?: boolean
}

const shares = new Map<string, ShareEntry>()

function emit(pluginId: string, payload: PluginEventPayload): void {
  if (!pluginHost.isOpened(pluginId)) return
  pluginHost.sendEvent(pluginId, payload)
}

/** 本机 IPv4 列表：过滤回环与链路本地；内网段（10/8、172.16/12、192.168/16）优先置前 */
export function lanIpv4Addresses(): string[] {
  const out: string[] = []
  for (const list of Object.values(networkInterfaces())) {
    for (const net of list ?? []) {
      if (net.family !== 'IPv4' || net.internal) continue
      if (net.address === '127.0.0.1' || net.address.startsWith('169.254.')) continue
      out.push(net.address)
    }
  }
  const internal = (ip: string): boolean =>
    ip.startsWith('10.') || ip.startsWith('192.168.') || /^172\.(1[6-9]|2\d|3[01])\./.test(ip)
  return [...new Set(out)].sort((a, b) => Number(internal(b)) - Number(internal(a)))
}

function statusOf(entry: ShareEntry): LanShareStatus {
  const { pluginId: _p, server: _s, files, codeBuf: _c, timer: _t, detached: _d, ...rest } = entry
  return { ...rest, files: files.map(({ id, name, size }) => ({ id, name, size })) }
}

/** RFC 5987：Content-Disposition 文件名（ASCII 回退 + UTF-8 扩展） */
function contentDisposition(name: string): string {
  const fallback = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(name)}`
}

const MIME_BY_EXT: Record<string, string> = {
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.mp3': 'audio/mpeg',
  '.zip': 'application/zip',
  '.csv': 'text/csv; charset=utf-8'
}

/** 取件码常时校验：长度不一致 / 非数字 / 不匹配均拒绝，耗时与内容无关 */
export function verifyShareCode(provided: string, expected: Buffer): boolean {
  if (typeof provided !== 'string' || provided.length !== CODE_LENGTH || !/^\d{6}$/.test(provided)) {
    return false
  }
  return timingSafeEqual(Buffer.from(provided, 'utf-8'), expected)
}

/** 生成 6 位数字取件码（等概率，前导零保留） */
export function generateShareCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(CODE_LENGTH, '0')
}

/**
 * 起一个限时下载服务。files 为「宿主侧绝对路径」白名单
 * （pluginHandlers 侧先经 localFiles 句柄解析得到，本服务不感知句柄）。
 */
export async function lanShareStart(
  pluginId: string,
  input: {
    files: Array<{ path?: string; name?: string }>
    minutes?: number
  }
): Promise<LanShareStatus> {
  const rawFiles = Array.isArray(input?.files) ? input.files : []
  if (rawFiles.length < 1 || rawFiles.length > 64) throw new Error('select between 1 and 64 files to share')
  const minutes = Math.min(MAX_SHARE_MINUTES, Math.max(1, Math.round(Number(input?.minutes) || DEFAULT_SHARE_MINUTES)))
  const scope = getRuntimeScope(pluginId)
  if (!scope || !scope.isCurrent() || scope.signal.aborted) throw new Error('plugin runtime is closing')

  const files: LanShareFile[] = []
  for (const item of rawFiles) {
    const path = String(item?.path ?? '')
    if (!path) throw new Error('file path required')
    const info = await stat(path)
    if (!info.isFile()) throw new Error(`not a regular file: ${basename(path)}`)
    if (info.size > MAX_FILE_BYTES) throw new Error(`file too large to share: ${basename(path)}`)
    files.push({ id: randomUUID().slice(0, 8), name: item.name ? String(item.name) : basename(path), size: info.size, path })
  }

  const shareId = `lan-${randomUUID().slice(0, 8)}`
  const code = generateShareCode()
  const entry: ShareEntry = {
    pluginId,
    shareId,
    port: 0,
    code,
    codeBuf: Buffer.from(code, 'utf-8'),
    files,
    ips: lanIpv4Addresses(),
    startedAt: Date.now(),
    expiresAt: Date.now() + minutes * 60_000,
    activeConnections: 0,
    downloads: 0,
    stopped: false,
    server: null as never as http.Server
  }

  const server = http.createServer((req, res) => handleRequest(entry, req, res))
  entry.server = server
  server.on('connection', (socket) => {
    entry.activeConnections++
    socket.on('close', () => { entry.activeConnections = Math.max(0, entry.activeConnections - 1) })
  })
  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject)
    // 绑 0.0.0.0：局域网可见是功能本身（手机扫码下载）；文件白名单 + 取件码门禁
    server.listen(0, '0.0.0.0', () => {
      server.removeListener('error', reject)
      resolve((server.address() as import('node:net').AddressInfo).port)
    })
  })
  entry.port = port
  entry.timer = setTimeout(() => stopShare(entry, 'expired'), minutes * 60_000)
  entry.timer.unref()
  shares.set(shareId, entry)
  return statusOf(entry)
}

function handleRequest(entry: ShareEntry, req: http.IncomingMessage, res: http.ServerResponse): void {
  const send = (status: number, body: string, headers: Record<string, string> = {}): void => {
    res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'content-length': Buffer.byteLength(body), ...headers })
    res.end(body)
  }
  try {
    if (entry.stopped) { send(403, 'share stopped'); return }
    if (entry.activeConnections > MAX_CONCURRENT_CONNECTIONS) { send(503, 'too many connections'); return }
    if (req.method !== 'GET' && req.method !== 'HEAD') { send(405, 'GET only'); return }
    const url = new URL(req.url ?? '/', 'http://lan.share.local')
    // /d/<fileId>?code=123456：下载；其余路径一律 404（不提供目录/索引页）
    const match = /^\/d\/([A-Za-z0-9-]+)$/.exec(url.pathname)
    const file = match ? entry.files.find((f) => f.id === match[1]) : undefined
    if (!file) { send(404, 'not found'); return }
    if (!verifyShareCode(url.searchParams.get('code') ?? '', entry.codeBuf)) { send(403, 'invalid code'); return }

    // 每个命中白名单且验码通过的请求都推给插件做传输日志
    const ip =
      req.socket.remoteAddress?.replace(/^::ffff:/, '').replace(/^::1$/, '127.0.0.1') ?? 'unknown'
    emit(entry.pluginId, { type: 'lan.request', shareId: entry.shareId, file: file.name, ip, ts: Date.now() })

    const serve = async (): Promise<void> => {
      const info = await stat(file.path)
      if (!info.isFile() || info.size !== file.size) { send(410, 'file changed on disk'); return }
      const headers: Record<string, string> = {
        'content-type': MIME_BY_EXT[extname(file.name).toLowerCase()] ?? 'application/octet-stream',
        'content-disposition': contentDisposition(file.name),
        'accept-ranges': 'bytes',
        'cache-control': 'no-store'
      }
      // 简单 Range：bytes=start-end / bytes=start-（单区间）
      let start = 0
      let end = info.size - 1
      const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ''))
      if (range && (range[1] !== '' || range[2] !== '')) {
        if (range[1] !== '') start = Number(range[1])
        if (range[2] !== '') end = Number(range[2])
        if (range[1] === '') { start = info.size - Number(range[2]); end = info.size - 1 } // 后缀区间
        if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start || start >= info.size) {
          send(416, 'range not satisfiable', { 'content-range': `bytes */${info.size}` })
          return
        }
        end = Math.min(end, info.size - 1)
        headers['content-range'] = `bytes ${start}-${end}/${info.size}`
      } else {
        start = 0
        end = info.size - 1
      }
      const length = end - start + 1
      if (req.method === 'HEAD') {
        res.writeHead(range ? 206 : 200, { ...headers, 'content-length': String(length) })
        res.end()
        if (!range && start === 0 && end === info.size - 1) entry.downloads++
        return
      }
      res.writeHead(range ? 206 : 200, { ...headers, 'content-length': String(length) })
      const stream = createReadStream(file.path, { start, end })
      stream.on('error', () => res.destroy())
      stream.pipe(res)
      // 完整文件投递才计一次下载
      if (!range && start === 0 && end === info.size - 1) entry.downloads++
    }
    void serve().catch(() => { if (!res.headersSent) send(500, 'read failed') })
  } catch {
    send(500, 'internal error')
  }
}

function stopShare(entry: ShareEntry, reason: string): void {
  if (entry.stopped) return
  entry.stopped = true
  entry.stopReason = reason
  if (entry.timer) { clearTimeout(entry.timer); entry.timer = undefined }
  entry.server.close()
  // Node 18.2+：销毁仍在传输的残留连接
  ;(entry.server as http.Server & { closeAllConnections?: () => void }).closeAllConnections?.()
  if (!entry.detached) shares.delete(entry.shareId)
  emit(entry.pluginId, { type: 'lan.stopped', shareId: entry.shareId, reason })
}

/** 当前插件全部分享状态（含已到期条目便于 UI 展示原因；stop 后即移除） */
export function lanShareList(pluginId: string): LanShareStatus[] {
  return [...shares.values()].filter((s) => s.pluginId === pluginId).map(statusOf)
}

/** 查单个分享（同插件归属校验） */
export function lanShareStatus(pluginId: string, shareId: string): LanShareStatus | null {
  const entry = shares.get(String(shareId ?? ''))
  return entry && entry.pluginId === pluginId ? statusOf(entry) : null
}

/** 手动停止 */
export function lanShareStop(pluginId: string, shareId: string): boolean {
  const entry = shares.get(String(shareId ?? ''))
  if (!entry || entry.pluginId !== pluginId) return false
  stopShare(entry, 'stopped by plugin')
  return true
}

/** 测试钩子：直接暴露条目取值（生产代码不使用） */
export function __lookupShareForTest(shareId: string): LanShareStatus | null {
  const entry = shares.get(shareId)
  return entry ? statusOf(entry) : null
}

/** 插件 runtime 关闭 / 休眠时释放全部分享服务（PluginHost disposer 挂载点） */
export function releaseLanShares(pluginId: string, generation?: number): void {
  for (const entry of [...shares.values()]) {
    if (entry.pluginId !== pluginId) continue
    const scope = getRuntimeScope(pluginId)
    if (generation !== undefined && scope && scope.owner.generation !== generation) continue
    stopShare(entry, 'plugin runtime released')
  }
}
