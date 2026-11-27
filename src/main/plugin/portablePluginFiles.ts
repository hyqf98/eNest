import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, opendir, realpath, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { existingOwnedDirectory } from '@main/paths/ownedDirectory'
import { getAppPaths } from '@main/paths/pathsService'
import { DATA_SUBDIR } from '@shared/constants'
import { SYNC_SNAPSHOT_LIMIT } from '@shared/types/githubSync'
import { syncDirectory } from './pluginStorageIO'

const areas = ['documents', 'blobs', 'assets', 'attachments', 'outputs'] as const
type Area = typeof areas[number]
export interface PortableFile { area: Area; name: string; data: string }
const UUID = '[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}'
const assetId = `(?:${UUID}|[a-z0-9][a-z0-9._-]{0,127}\\.(?:png|jpg|webp|gif))`
const assetData = new RegExp(`^\\.asset-${UUID}\\.blob$`)
const names: Record<Area, RegExp> = {
  documents: /^[a-z\d][a-z\d._-]{0,127}\.json$/i, blobs: /^[a-z\d][a-z\d._-]{0,127}\.(json|blob)$/i,
  assets: new RegExp(`^(?:${assetId}(?:\\.meta\\.json)?|\\.asset-${UUID}\\.blob)$`),
  attachments: new RegExp(`^${UUID}\\.(json|blob)$`), outputs: new RegExp(`^${UUID}\\.(?!part$)[a-z0-9]{1,12}$`),
}
const validName = (area: Area, name: string) => names[area].test(name) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])\./i.test(name)
const fileKey = (item: Pick<PortableFile, 'area' | 'name'>) => `${item.area}/${item.name}`
const sortFiles = (files: PortableFile[]) => files.sort((left, right) => fileKey(left) < fileKey(right) ? -1 : fileKey(left) > fileKey(right) ? 1 : 0)
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT'
const maximumFiles = 2048

async function directory(pluginId: string, area: Area, create = false) {
  const hash = createHash('sha256').update(pluginId).digest('hex')
  const segments = area === 'documents' || area === 'blobs' ? ['plugin-documents', hash, area] : area === 'assets' ? ['plugin-assets', hash, 'files'] : [area === 'attachments' ? 'plugin-attachments' : 'plugin-files', hash]
  let dir = await existingOwnedDirectory(getAppPaths().root, DATA_SUBDIR)
  if (!dir) throw new Error('插件数据根目录不存在')
  for (const part of segments) {
    dir = join(dir, part)
    if (create) await mkdir(dir, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error })
    const info = await lstat(dir).catch(error => { if (missing(error)) return null; throw error })
    if (!info) return null
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(dir) !== dir) throw new Error('不能同步链接目录')
  }
  return dir
}
async function readFile(dir: string, name: string, limit: number): Promise<Buffer | null> {
  const path = join(dir, name)
  const info = await lstat(path).catch(error => { if (missing(error)) return null; throw error })
  if (!info) return null
  if (!info.isFile() || info.nlink !== 1 || info.size > limit) throw new Error('文件不是独立普通文件或超过 16 MiB 快照上限')
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
  try {
    const before = await file.stat()
    if (!before.isFile() || before.nlink !== 1 || before.dev !== info.dev || before.ino !== info.ino || before.size !== info.size) throw new Error('插件文件已变化')
    const bytes = Buffer.allocUnsafe(before.size)
    let offset = 0
    while (offset < bytes.length) {
      const result = await file.read(bytes, offset, bytes.length - offset, offset)
      if (!result.bytesRead) break
      offset += result.bytesRead
    }
    const after = await file.stat()
    if (offset !== before.size || after.size !== before.size || after.ctimeMs !== before.ctimeMs || after.mtimeMs !== before.mtimeMs) throw new Error('插件文件已变化')
    return bytes
  } finally { await file.close() }
}

export function validatePortableFiles(input: unknown): PortableFile[] {
  if (!Array.isArray(input) || input.length > maximumFiles) throw new Error('插件文件数量超过同步限制')
  const files = new Map<string, PortableFile>(), folded = new Set<string>()
  let length = 0
  for (const item of input) {
    if (!item || !areas.includes(item.area) || typeof item.name !== 'string' || !validName(item.area, item.name) || typeof item.data !== 'string') throw new Error('插件快照包含不支持的文件')
    const file: PortableFile = { area: item.area, name: item.name, data: item.data }, key = fileKey(file)
    length += item.data.length
    if (length > SYNC_SNAPSHOT_LIMIT || folded.has(key.toLowerCase()) || Buffer.from(item.data, 'base64').toString('base64') !== item.data) throw new Error('重复、过大或无效的插件文件')
    folded.add(key.toLowerCase()); files.set(key, file)
  }
  const references = new Set<string>()
  if ([...files.values()].filter(file => file.area === 'documents').length > 128) throw new Error('插件私有文档数量超限')
  for (const file of files.values()) {
    if (!file.name.endsWith('.json') || file.area === 'outputs') continue
    const bytes = Buffer.from(file.data, 'base64')
    if (file.area !== 'documents' && bytes.length > 4096) throw new Error('图片元数据过大')
    const record = JSON.parse(bytes.toString('utf8'))
    if (file.area === 'documents') continue
    if (!record || !/^image\/(?:png|jpeg|webp|gif)$/.test(record.mime)) throw new Error('图片元数据无效')
    if (file.area === 'assets') {
      const id = file.name.slice(0, -'.meta.json'.length)
      if (record.assetId !== id || typeof record.name !== 'string' || record.name.length > 128 || !Number.isFinite(record.createdAt) || record.createdAt < 0 || record.file !== undefined && (typeof record.file !== 'string' || !assetData.test(record.file))) throw new Error('图片引用无效')
      const target = `assets/${record.file ?? id}`, payload = files.get(target)
      if (!payload || Buffer.byteLength(payload.data, 'base64') !== record.bytes) throw new Error('图片内容与元数据不符')
      references.add(target)
    } else if (!files.has(`${file.area}/${file.name.slice(0, -5)}.blob`)) throw new Error('插件图片不完整')
  }
  if ([...files.values()].some(file => (file.area === 'attachments' || file.area === 'blobs') && file.name.endsWith('.blob') && !files.has(`${file.area}/${file.name.slice(0, -5)}.json`))) throw new Error('插件图片缺少元数据')
  return sortFiles([...files.values()].filter(file => file.area !== 'assets' || !assetData.test(file.name) || references.has(fileKey(file))))
}

export async function readPortableFiles(pluginId: string, check: () => void, budget: number): Promise<PortableFile[]> {
  const files: PortableFile[] = []
  let count = 0
  for (const area of areas) {
    check()
    const dir = await directory(pluginId, area)
    if (!dir) continue
    for await (const entry of await opendir(dir)) {
      check()
      if (++count > maximumFiles * 2) throw new Error('插件文件数量超过同步限制')
      if (!validName(area, entry.name)) continue
      const bytes = await readFile(dir, entry.name, Math.floor(budget * 3 / 4))
      if (!bytes) throw new Error('插件文件已变化')
      const data = bytes.toString('base64')
      budget -= data.length
      files.push({ area, name: entry.name, data })
    }
  }
  check()
  return validatePortableFiles(files)
}

export async function applyPortableFiles(pluginId: string, from: PortableFile[], to: PortableFile[], check: () => void) {
  const previous = new Map(from.map(item => [fileKey(item), item])), next = new Map(to.map(item => [fileKey(item), item]))
  const keys = new Set([...previous.keys(), ...next.keys()])
  if (new Set([...keys].map(key => key.toLowerCase())).size !== keys.size) throw new Error('插件文件大小写冲突')
  for (const key of keys) {
    check()
    const old = previous.get(key), item = next.get(key)
    if (old?.data === item?.data) continue
    const { area, name } = (item ?? old)!
    const dir = await directory(pluginId, area, !!item)
    if (!dir) continue
    const existing = (await readFile(dir, name, SYNC_SNAPSHOT_LIMIT))?.toString('base64')
    if (existing === item?.data) continue
    if (existing !== old?.data) throw new Error('本机文件在同步期间已变更，未覆盖新内容')
    check()
    if (!item) await rm(join(dir, name))
    else {
      const temporary = join(dir, `.sync-${randomUUID()}.tmp`)
      const file = await open(temporary, 'wx', 0o600)
      try {
        try { await file.writeFile(Buffer.from(item.data, 'base64')); await file.sync() } finally { await file.close() }
        check()
        await rename(temporary, join(dir, name))
      } finally { await rm(temporary, { force: true }) }
    }
    await syncDirectory(dir)
  }
}
