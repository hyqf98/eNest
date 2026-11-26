/**
 * devPluginsStore — 开发态插件路径持久化
 * 职责：读写 {dataRoot}/plugins/dev.json，重启后可从源码目录重新加载调试插件。
 * 仅存 id + 绝对路径 + 开发地址覆盖 + 退出即杀开关 + 最近加载时刻；manifest 每次从目录现读。
 * 旧记录里的 mode / preview 字段被读取时忽略并丢弃（不再有 dev/prod 切换），不影响加载。
 */
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { getAppPaths } from '@main/paths/pathsService'
import type { DevPluginLoadOptions } from '@shared/types/plugin'
import type { MissingDevPlugin } from '@shared/types/ipc'
export type { MissingDevPlugin }
import { logWarn } from '@main/logs/logService'

export interface DevPluginRecord {
  id: string
  path: string
  url?: string
  /** 对齐 uTools「退出到后台立即结束运行」：true 时退后台立即休眠（下次进入冷启动读最新代码） */
  killOnHide?: boolean
  /** 最近一次成功加载的时刻（ms）。开发中列表按它倒序，最新加载的排最上面；旧记录没有此字段，排在后面。 */
  loadedAt?: number
}

export function devPluginsFile(): string {
  return join(getAppPaths().plugins, 'dev.json')
}

/** 没有加载时间的旧记录排到最后，彼此保持文件里的原有顺序。 */
export function byRecentlyLoaded(records: DevPluginRecord[]): DevPluginRecord[] {
  return records.map((record, index) => ({ record, index }))
    .sort((a, b) => (b.record.loadedAt ?? 0) - (a.record.loadedAt ?? 0) || a.index - b.index)
    .map((entry) => entry.record)
}

export async function readDevPluginRecords(requireComplete = false): Promise<DevPluginRecord[]> {
  const file = devPluginsFile()
  try {
    const raw = await readFile(file, 'utf8')
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      if (requireComplete) throw error
      // 写入中断等损坏：截取首个完整数组前缀尽力恢复，避免 dev 插件全部静默丢失
      const end = raw.indexOf(']')
      if (end <= 0) throw new Error('unrecoverable content')
      parsed = JSON.parse(raw.slice(0, end + 1))
      logWarn('dev', 'dev.json was corrupt, recovered records from valid prefix')
    }
    if (!Array.isArray(parsed)) throw new Error('Invalid development source registry')
    const records = parsed.filter((record): record is DevPluginRecord => typeof record?.id === 'string' && record.id.length > 0
      && typeof record.path === 'string' && record.path.length > 0)
    if (requireComplete && records.length !== parsed.length) throw new Error('Invalid development source record')
    return byRecentlyLoaded(records
      // 仅保留仍被使用的字段；旧记录多出来的 mode / preview 在此被丢弃，不报错也不迁移。
      .map((r) => ({
        id: r.id, path: r.path,
        ...(typeof r.url === 'string' ? { url: r.url } : {}),
        ...(r.killOnHide ? { killOnHide: true } : {}),
        ...(typeof r.loadedAt === 'number' && Number.isFinite(r.loadedAt) ? { loadedAt: r.loadedAt } : {})
      })))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    logWarn('dev', `read dev.json failed: ${(err as Error).message}`)
    if (requireComplete) throw err
    return []
  }
}

async function writeDevPluginRecords(records: DevPluginRecord[]): Promise<void> {
  const file = devPluginsFile()
  await mkdir(getAppPaths().plugins, { recursive: true })
  const unique = new Map<string, DevPluginRecord>()
  for (const r of records) {
    if (r.id && r.path) unique.set(r.id, { id: r.id, path: r.path, url: r.url, ...(r.killOnHide ? { killOnHide: true } : {}),
      ...(typeof r.loadedAt === 'number' ? { loadedAt: r.loadedAt } : {}) })
  }
  // 临时文件 + 同目录 rename 原子替换，进程中断不再留下半截 JSON
  const tmp = `${file}.${process.pid}.tmp`
  await writeFile(tmp, JSON.stringify([...unique.values()], null, 2), 'utf8')
  await rename(tmp, file)
}

/** Serialize read-modify-write operations so concurrent developer actions cannot lose records. */
let mutationTail: Promise<void> = Promise.resolve()
function updateRecords(change: (records: DevPluginRecord[]) => DevPluginRecord[]): Promise<void> {
  const operation = mutationTail.then(async () => writeDevPluginRecords(change(await readDevPluginRecords(true))))
  mutationTail = operation.catch(() => {})
  return operation
}

/** 加载后记录；同 id 覆盖路径，保留已有 killOnHide，并刷新加载时刻（列表因此排到最上面）。 */
export function upsertDevPluginRecord(id: string, path: string, options: DevPluginLoadOptions = {}): Promise<void> {
  return updateRecords(list => {
    const previous = list.find(record => record.id === id)
    return [...list.filter(record => record.id !== id), {
      id, path, loadedAt: Date.now(),
      ...(options.url ? { url: options.url } : {}), ...(previous?.killOnHide ? { killOnHide: true } : {})
    }]
  })
}

export function setDevPluginKillOnHide(id: string, killOnHide: boolean): Promise<void> {
  return updateRecords(list => list.map(record => record.id === id ? { ...record, killOnHide: killOnHide || undefined } : record))
}

export function dropDevPluginRecord(id: string): Promise<void> {
  return updateRecords(list => list.filter(record => record.id !== id))
}

/**
 * 选择目录对话框的起始位置：最近一次加载的插件目录的上一级。
 * 同一批插件通常并排放在同一个父目录下，落在这里比落在系统默认位置少翻几层。
 */
export function lastDevPluginParentDir(records: DevPluginRecord[]): string | undefined {
  const latest = byRecentlyLoaded(records)[0]
  if (!latest) return undefined
  const parent = dirname(latest.path)
  // 已经在文件系统根（如 / 或 C:\）时不再往上，避免 defaultPath 落到无意义的位置
  return parent === latest.path ? latest.path : parent
}

/**
 * 找出登记了但已无法加载的开发插件：目录被移走/改名、plugin.json 读不出来，或其中的 id 变了。
 * 这些记录不进 registry（运行时的启动、权限、生命周期都以 registry 为准），只在设置页里置灰展示并允许移除。
 * 调用方传入已成功登记的 id 集合，避免在这里依赖 PluginRegistry。
 */
export async function listMissingDevPlugins(registeredIds: ReadonlySet<string>): Promise<MissingDevPlugin[]> {
  const result: MissingDevPlugin[] = []
  for (const record of await readDevPluginRecords()) {
    if (registeredIds.has(record.id)) continue
    if (!existsSync(record.path)) { result.push({ id: record.id, path: record.path, reason: 'directory-missing' }); continue }
    try {
      const manifest = JSON.parse(await readFile(join(record.path, 'plugin.json'), 'utf8')) as { id?: unknown }
      const actualId = typeof manifest.id === 'string' ? manifest.id : undefined
      if (!actualId) result.push({ id: record.id, path: record.path, reason: 'manifest-unreadable' })
      else if (actualId !== record.id) result.push({ id: record.id, path: record.path, reason: 'id-changed', actualId })
    } catch {
      result.push({ id: record.id, path: record.path, reason: 'manifest-unreadable' })
    }
  }
  return result
}
