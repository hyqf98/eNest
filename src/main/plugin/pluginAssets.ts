import { createHash, randomUUID } from 'node:crypto'
import { constants, lstat, mkdir, open, readdir, realpath, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { getAppPaths } from '@main/paths/pathsService'
import { getRuntimeScope, type PluginRuntimeScope } from '@main/plugin/PluginRuntimeScope'

/**
 * storage.assets —— 插件静态资源（生成图片等二进制媒体）的标准持久化通道。
 * 目录 {dataRoot}/data/plugin-assets/{sha256(pluginId)}/，每插件相互隔离、卸载随清。
 * 相比 storage.blobs（dataURL、无 list）：接受 ArrayBuffer 二进制、任意图片 MIME、
 * 稳定自命名 assetId（幂等覆盖）、可 list、可 get（dataUrl 读回；插件页 CSP
 * 不放行 enest://media，读取统一走 get → dataUrl/blob: 渲染）。
 */

const MAX_ASSET_BYTES = 32 * 1024 * 1024
const OWNER_QUOTA_BYTES = 1024 * 1024 * 1024
const MIME_EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' }
const queues = new Map<string, { tail: Promise<unknown>; count: number }>()

const assetDir = (pluginId: string) => join(getAppPaths().data, 'plugin-assets', createHash('sha256').update(pluginId).digest('hex'))

function owner(pluginId: string): PluginRuntimeScope {
  const scope = getRuntimeScope(pluginId)
  if (!scope?.isCurrent() || scope.isClosing) throw new Error('plugin runtime is closing or stale')
  return scope
}
function current(scope: PluginRuntimeScope): void { if (!scope.isCurrent() || scope.signal.aborted) throw new Error('plugin runtime is closing or stale') }

const validAssetId = (id: string) => { if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(id)) throw new Error('无效的资源标识'); return id }

async function ensureDir(pluginId: string, scope: PluginRuntimeScope): Promise<string> {
  const base = assetDir(pluginId), dir = join(base, 'files')
  const dataRoot = await realpath(getAppPaths().data)
  const expect = join(dataRoot, 'plugin-assets', createHash('sha256').update(pluginId).digest('hex'), 'files')
  for (const path of [join(base, '..'), base, dir]) {
    current(scope)
    await mkdir(path, { recursive: true })
    const info = await lstat(path)
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('资源目录不是受信目录')
  }
  const canonical = await realpath(dir)
  current(scope)
  if (canonical !== expect) throw new Error('资源目录不是受信目录')
  return dir
}

async function usedBytes(dir: string, scope: PluginRuntimeScope): Promise<number> {
  let total = 0
  const entries = await readdir(dir).catch(() => [] as string[])
  for (const name of entries) {
    current(scope)
    const info = await stat(join(dir, name)).catch(() => null)
    if (info?.isFile()) total += info.size
  }
  return total
}

function sidecarOf(dir: string, assetId: string): { file: string; meta: string } {
  return { file: join(dir, assetId), meta: `${join(dir, assetId)}.meta.json` }
}

const EXT_MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' }

function mimeFromName(name: string): string {
  const ext = name.split('.').pop() ?? ''
  return EXT_MIME[ext] ?? 'application/octet-stream'
}

function toDataUrl(bytes: Buffer, mime: string): string {
  return `data:${mime};base64,${bytes.toString('base64')}`
}

/** 读回单文件字节数据（O_NOFOLLOW + 大小上限），供 dataUrl 形式取回 */
async function readAssetBytes(pluginId: string, assetId: string, max = MAX_ASSET_BYTES): Promise<{ data: Buffer; mime: string } | null> {
  const scope = owner(pluginId)
  const dir = join(assetDir(pluginId), 'files')
  const file = join(dir, assetId)
  let handle: Awaited<ReturnType<typeof open>>
  try {
    const info = await lstat(file)
    if (info.isSymbolicLink() || !info.isFile()) throw new Error('资源文件不是受信文件')
    handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  try {
    const size = (await handle.stat()).size
    if (size > max) throw new Error('资源超过读取上限')
    const data = Buffer.allocUnsafe(size)
    let offset = 0
    while (offset < data.length) {
      current(scope)
      const { bytesRead } = await handle.read(data, offset, data.length - offset, offset)
      if (!bytesRead) break
      offset += bytesRead
    }
    return { data: data.subarray(0, offset), mime: mimeFromName(assetId) }
  } finally { await handle.close() }
}

export interface AssetMeta { assetId: string; name: string; mime: string; bytes: number; createdAt: number }
export interface PluginAssetPutResult extends AssetMeta { path: string }

export function putPluginAsset(pluginId: string, input: { bytes: ArrayBuffer; mime: string; name?: string; assetId?: string }): Promise<PluginAssetPutResult> {
  const scope = owner(pluginId)
  const bytes = input?.bytes, mime = String(input?.mime ?? '')
  if (!(bytes instanceof ArrayBuffer)) throw new Error('无效的资源数据')
  if (bytes.byteLength <= 0 || bytes.byteLength > MAX_ASSET_BYTES) throw new Error('资源超过 32 MB 上限')
  const ext = MIME_EXT[mime]
  if (!ext) throw new Error('资源仅支持 PNG、JPEG、WebP 和 GIF')
  const id = validAssetId(String(input?.assetId ?? randomUUID().replaceAll('-', '')))
  if (id.includes('..') || id.includes('/')) throw new Error('无效的资源标识')
  const finalId = `${id}.${ext}`
  const name = typeof input?.name === 'string' && input.name.trim() ? input.name.trim().slice(0, 128) : finalId
  const queue = queues.get(pluginId) ?? { tail: Promise.resolve(), count: 0 }
  if (queue.count >= 2) throw new Error('资源正在写入，请稍后重试')
  queue.count++
  queues.set(pluginId, queue)
  let held: ArrayBuffer | null = bytes
  const abort = () => { held = null }
  scope.signal.addEventListener('abort', abort, { once: true })
  const release = scope.acquireActivity('saving asset')
  const task = queue.tail.catch(() => {}).then(async () => {
    current(scope)
    const data = Buffer.from(held!); held = null
    const dir = await ensureDir(pluginId, scope)
    const { file, meta } = sidecarOf(dir, finalId)
    const previous = await stat(file).then(s => s.size).catch(() => 0)
    current(scope)
    if ((await usedBytes(dir, scope)) - previous + data.length > OWNER_QUOTA_BYTES) throw new Error('静态资源已达 1 GB 配额，请在画廊或设置中清理')
    const temporary = `${file}.${randomUUID()}.tmp`
    try {
      const handle = await open(temporary, 'wx', 0o600)
      try { await handle.writeFile(data, { signal: scope.signal }); await handle.sync() } finally { await handle.close() }
      current(scope)
      await rename(temporary, file)
      const metaRecord: AssetMeta = { assetId: finalId, name, mime, bytes: data.length, createdAt: Date.now() }
      await rm(meta, { force: true })
      const metaTmp = `${meta}.${randomUUID()}.tmp`
      const metaHandle = await open(metaTmp, 'wx', 0o600)
      try { await metaHandle.writeFile(JSON.stringify(metaRecord), 'utf8') } finally { await metaHandle.close() }
      await rename(metaTmp, meta)
      current(scope)
      return { ...metaRecord, path: file }
    } catch (error) {
      await Promise.all([rm(temporary, { force: true }), rm(`${file}.${randomUUID()}.tmp`, { force: true })])
      throw error
    }
  }).finally(() => {
    held = null
    scope.signal.removeEventListener('abort', abort)
    release()
    queue.count--
    if (!queue.count && queues.get(pluginId) === queue) queues.delete(pluginId)
  })
  queue.tail = task
  return task
}

export async function listPluginAssets(pluginId: string): Promise<AssetMeta[]> {
  const scope = owner(pluginId)
  const base = assetDir(pluginId), dir = join(base, 'files')
  const info = await stat(dir).catch(() => null)
  if (!info?.isDirectory()) return []
  const dataRoot = await realpath(getAppPaths().data)
  const canonical = await realpath(dir).catch(() => null)
  if (!canonical || !canonical.startsWith(dataRoot + '/')) return []
  const out: AssetMeta[] = []
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    current(scope)
    if (name.endsWith('.tmp') || name.startsWith('.') || name.endsWith('.meta.json')) continue
    const metaFile = `${join(dir, name)}.meta.json`
    const raw = await open(metaFile, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
      .then(async h => { try { const s = await h.stat(); const b = Buffer.allocUnsafe(s.size); await h.read(b, 0, s.size, 0); return b.toString('utf8') } finally { await h.close() } })
      .catch(() => null)
    const record = raw ? safeJson<AssetMeta>(raw) : null
    const size = await stat(join(dir, name)).then(s => s.size).catch(() => 0)
    out.push({ assetId: name, name: record?.name ?? name, mime: record?.mime ?? mimeFromName(name), bytes: record?.bytes ?? size, createdAt: record?.createdAt ?? 0 })
  }
  out.sort((a, b) => b.createdAt - a.createdAt)
  return out
}

/** dataUrl 读回（插件页 CSP 不放行 enest://media，预览/导出走此通道） */
export async function getPluginAsset(pluginId: string, assetId: string): Promise<{ dataUrl: string; mime: string; bytes: number } | null> {
  const bare = String(assetId ?? '').replace(/\.(png|jpg|webp|gif)$/, '')
  validAssetId(bare || String(assetId ?? ''))
  const id = String(assetId ?? '')
  if (id.includes('/') || id.includes('..')) return null
  const result = await readAssetBytes(pluginId, id)
  if (!result) return null
  return { dataUrl: toDataUrl(result.data, result.mime), mime: result.mime, bytes: result.data.length }
}

export async function deletePluginAsset(pluginId: string, assetId: string): Promise<boolean> {
  owner(pluginId)
  const bare = assetId.replace(/\.(png|jpg|webp|gif)$/, '')
  validAssetId(bare || assetId)
  if (assetId.includes('/') || assetId.includes('..')) return false
  const dir = join(assetDir(pluginId), 'files')
  const parent = await realpath(join(dir, '..')).catch(() => null)
  const dataRoot = await realpath(getAppPaths().data).catch(() => null)
  if (!parent || !dataRoot || !parent.startsWith(dataRoot + '/')) return false
  const file = join(dir, assetId)
  await Promise.all([rm(file, { force: true }), rm(`${file}.meta.json`, { force: true })])
  return true
}

export async function clearPluginAssets(pluginId: string): Promise<void> {
  await queues.get(pluginId)?.tail.catch(() => {})
  await rm(assetDir(pluginId), { recursive: true, force: true })
  queues.delete(pluginId)
}

function safeJson<T>(raw: string): T | null { try { return JSON.parse(raw) as T } catch { return null } }

