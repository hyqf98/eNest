/**
 * pluginDataUsage — 按插件统计数据根下的磁盘占用。
 * 职责：列出已安装插件各自在数据根下占用的 插件数据 / 图片 / 文件 / 其他，
 *       以及对不上任何已安装插件的「未归属」目录（已卸载残留或插件自建目录）。
 * 设计：
 *  - 标准存储目录名是插件 ID 的 sha256（见 pluginPrivatePaths / pluginAssets / pluginFileStreams），
 *    这里对已知 ID 预先算一张 hash → id 表反查，不读取目录内任何业务内容；
 *  - 只量文件大小与数量，跳过符号链接，带全局条目上限，避免失控目录拖住主进程；
 *  - 插件包本体（plugins/<id>/）计入 other 并单列 packageBytes：清理数据时它不被删除；
 *  - 运行态取自内存监控的只读快照，不另起一套「是否存活」的判定。
 * 被 shellHandlers（shell:get-plugin-data-usage）引用。
 */
import { promises as fs } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { DATA_SUBDIR, PLUGINS_DIR } from '@shared/constants'
import { kvStore } from '@main/db/sqliteService'
import { getAppPaths } from '@main/paths/pathsService'
import { pluginRegistry } from '@main/plugin/PluginRegistry'
import { getPluginMemoryDiagnosticSnapshot } from '@main/plugin/pluginMemoryMonitor'
import { pluginPrivateNamespace, PRIVATE_DOCUMENTS_DIR, PRIVATE_EXTENSIONS_DIR } from '@main/plugin/pluginPrivatePaths'
import type { OrphanDataItem, PluginDataCategory, PluginDataUsage, PluginDataUsageItem } from '@shared/types/plugin'

/** 递归统计的条目上限：超过即记为不可读，防止异常目录拖住主进程 */
const MAX_ENTRIES = 200_000

export const ASSETS_DIR = 'plugin-assets'
export const LEGACY_ASSETS_DIR = 'plugin-attachments'
export const FILES_DIR = 'plugin-files'
export const SECRETS_DIR = 'secrets'
/** data/ 下由宿主自己管理、不归任何插件的目录 */
const HOST_OWNED_DATA_DIRS = new Set([
  PRIVATE_DOCUMENTS_DIR, ASSETS_DIR, LEGACY_ASSETS_DIR, FILES_DIR, SECRETS_DIR,
  'plugin-storage', 'clipboard-blobs', 'legacy-migrations',
])

export function pluginStorageHash(pluginId: string): string {
  return pluginPrivateNamespace(pluginId)
}

/** 插件 ID 末段，与磁盘上插件自建目录的常见命名一致（com.github.eNest.markdown → markdown） */
export function pluginShortName(pluginId: string): string {
  return pluginId.slice(pluginId.lastIndexOf('.') + 1) || pluginId
}

interface Budget { left: number }

interface TreeSize { bytes: number; count: number; complete: boolean }

async function treeSize(path: string, budget: Budget): Promise<TreeSize> {
  const result: TreeSize = { bytes: 0, count: 0, complete: true }
  const walk = async (dir: string): Promise<void> => {
    let handle: Awaited<ReturnType<typeof fs.opendir>>
    try { handle = await fs.opendir(dir) } catch { result.complete = false; return }
    for await (const entry of handle) {
      if (budget.left-- <= 0) { result.complete = false; return }
      const full = join(dir, entry.name)
      let info
      try { info = await fs.lstat(full) } catch { result.complete = false; continue }
      if (info.isSymbolicLink()) continue
      if (info.isDirectory()) await walk(full)
      else if (info.isFile()) { result.bytes += info.size; result.count++ }
    }
  }
  await walk(path)
  return result
}

/** 目录不存在返回 0；读失败或条目超限记入 unreadable，其余照常返回 */
async function measure(path: string, label: string, budget: Budget, unreadable: string[]): Promise<PluginDataCategory> {
  try {
    if (!(await fs.lstat(path)).isDirectory()) return { bytes: 0, count: 0 }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { bytes: 0, count: 0 }
    unreadable.push(label)
    return { bytes: 0, count: 0 }
  }
  const size = await treeSize(path, budget)
  if (!size.complete) unreadable.push(label)
  return { bytes: size.bytes, count: size.count }
}

/** 目录里直接放置的文件，不计子目录 */
async function looseFiles(path: string, budget: Budget): Promise<PluginDataCategory> {
  let handle: Awaited<ReturnType<typeof fs.opendir>>
  try { handle = await fs.opendir(path) } catch { return { bytes: 0, count: 0 } }
  const result = { bytes: 0, count: 0 }
  for await (const entry of handle) {
    if (budget.left-- <= 0) break
    const info = await fs.lstat(join(path, entry.name)).catch(() => null)
    if (info?.isFile()) { result.bytes += info.size; result.count++ }
  }
  return result
}

function add(into: PluginDataCategory, extra: PluginDataCategory): void {
  into.bytes += extra.bytes
  into.count += extra.count
}

/** 各插件在 plugin_storage 表里的 KV 字节数，一次聚合查询；表不存在或库不可用返回空表 */
function storageBytesByPlugin(): { bytes: Map<string, number>; keys: Map<string, number> } {
  const bytes = new Map<string, number>(), keys = new Map<string, number>()
  const db = kvStore.getDatabase()
  if (!db) return { bytes, keys }
  try {
    const rows = db
      .prepare('SELECT plugin_id AS id, COUNT(*) AS count, COALESCE(SUM(LENGTH(CAST(value AS BLOB))), 0) AS bytes FROM plugin_storage GROUP BY plugin_id')
      .all() as Array<{ id: string; count: number; bytes: number }>
    for (const row of rows) { bytes.set(row.id, row.bytes); keys.set(row.id, row.count) }
  } catch { /* plugin_storage 尚未建表 */ }
  return { bytes, keys }
}

async function recordOrphan(path: string, root: string, budget: Budget, unreadable: string[], into: OrphanDataItem[]): Promise<void> {
  const rel = toRelative(root, path)
  const size = await measure(path, rel, budget, unreadable)
  if (size.bytes > 0 || size.count > 0) into.push({ relativePath: rel, bytes: size.bytes })
}

/**
 * 统计全部已安装插件的占用。目录条目数超限或读失败的条目记入 unreadable，
 * 其余照常返回，不因单个异常目录让整页失败。
 */
export async function collectPluginDataUsage(): Promise<PluginDataUsage> {
  const paths = getAppPaths()
  const dataDir = paths.data
  const budget: Budget = { left: MAX_ENTRIES }
  const unreadable: string[] = []
  const orphans: OrphanDataItem[] = []
  const descriptors = pluginRegistry.getInstalledDescriptors()
  const byHash = new Map(descriptors.map(item => [pluginStorageHash(item.id), item.id]))
  const shortNames = new Set(descriptors.map(item => pluginShortName(item.id)))
  const { bytes: kvBytes, keys: kvKeys } = storageBytesByPlugin()

  const items = new Map<string, PluginDataUsageItem>(descriptors.map(item => [item.id, {
    pluginId: item.id,
    data: { bytes: 0, count: 0 },
    images: { bytes: 0, count: 0 },
    files: { bytes: 0, count: 0 },
    other: { bytes: 0, count: 0 },
    total: 0,
    packageBytes: 0,
    running: false,
  }]))

  // 标准 hash 目录：首层目录名反查归属，认不出的进未归属
  for (const [dirName, kind] of [
    [PRIVATE_DOCUMENTS_DIR, 'documents'],
    [ASSETS_DIR, 'assets'],
    [LEGACY_ASSETS_DIR, 'assets'],
    [FILES_DIR, 'files'],
  ] as const) {
    const base = join(dataDir, dirName)
    const names = await fs.readdir(base).catch(() => [] as string[])
    for (const name of names) {
      const path = join(base, name)
      const owner = byHash.get(name)
      if (!owner) { await recordOrphan(path, dataDir, budget, unreadable, orphans); continue }
      if (!(await fs.lstat(path).catch(() => null))?.isDirectory()) continue
      const item = items.get(owner)!
      if (kind === 'documents') {
        add(item.data, await measure(join(path, 'documents'), `${dirName}/${name}/documents`, budget, unreadable))
        add(item.images, await measure(join(path, 'blobs'), `${dirName}/${name}/blobs`, budget, unreadable))
        add(item.data, await measure(join(path, PRIVATE_EXTENSIONS_DIR), `${dirName}/${name}/${PRIVATE_EXTENSIONS_DIR}`, budget, unreadable))
        add(item.data, await looseFiles(path, budget))
      } else if (kind === 'assets') add(item.images, await measure(path, `${dirName}/${name}`, budget, unreadable))
      else add(item.files, await measure(path, `${dirName}/${name}`, budget, unreadable))
    }
  }

  // 插件包本体
  for (const item of items.values()) {
    const packageDir = join(paths.plugins, item.pluginId)
    const size = await measure(packageDir, `${PLUGINS_DIR}/${item.pluginId}`, budget, unreadable)
    item.packageBytes = size.bytes
    add(item.other, size)
  }

  // 密钥 + 以插件短名自建的目录
  for (const item of items.values()) {
    add(item.other, await measure(join(dataDir, SECRETS_DIR, item.pluginId), `${SECRETS_DIR}/${item.pluginId}`, budget, unreadable))
    const custom = join(dataDir, pluginShortName(item.pluginId))
    add(item.other, await measure(custom, `${DATA_SUBDIR}/${pluginShortName(item.pluginId)}`, budget, unreadable))
  }

  // data/ 下既不归宿主、也认不出插件的一级目录 → 未归属
  const entries = await fs.readdir(dataDir, { withFileTypes: true }).catch(() => [] as import('node:fs').Dirent[])
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.') || HOST_OWNED_DATA_DIRS.has(entry.name) || shortNames.has(entry.name)) continue
    await recordOrphan(join(dataDir, entry.name), paths.root, budget, unreadable, orphans)
  }

  const memory = await getPluginMemoryDiagnosticSnapshot()
  const live = new Map(memory.plugins.map(entry => [entry.pluginId, entry]))
  for (const item of items.values()) {
    const bytes = kvBytes.get(item.pluginId) ?? 0
    item.data.bytes += bytes
    item.data.count += kvKeys.get(item.pluginId) ?? 0
    item.running = (live.get(item.pluginId)?.status ?? 'idle') !== 'idle'
    item.total = item.data.bytes + item.images.bytes + item.files.bytes + item.other.bytes
  }

  return {
    dataRoot: paths.root,
    plugins: [...items.values()],
    orphans: orphans.sort((a, b) => b.bytes - a.bytes),
    unreadable,
    scannedAt: Date.now(),
  }
}

function toRelative(root: string, path: string): string {
  return relative(root, path).split(sep).join('/')
}
