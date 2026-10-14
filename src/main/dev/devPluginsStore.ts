/**
 * devPluginsStore — 开发态插件路径持久化
 * 职责：读写 {dataRoot}/plugins/dev.json，重启后可从源码目录重新加载调试插件。
 * 仅存 id + 绝对路径 + 退出即杀开关；manifest 每次从目录现读。
 */
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { getAppPaths } from '@main/paths/pathsService'
import type { DevPluginLoadOptions } from '@shared/types/plugin'
import { logWarn } from '@main/logs/logService'

export interface DevPluginRecord extends DevPluginLoadOptions {
  id: string
  path: string
  /** 对齐 uTools「退出到后台立即结束运行」：true 时退后台立即休眠（下次进入冷启动读最新代码） */
  killOnHide?: boolean
}

export function devPluginsFile(): string {
  return join(getAppPaths().plugins, 'dev.json')
}

export async function readDevPluginRecords(): Promise<DevPluginRecord[]> {
  const file = devPluginsFile()
  if (!existsSync(file)) return []
  try {
    const raw = await readFile(file, 'utf8')
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      // 写入中断等损坏：截取首个完整数组前缀尽力恢复，避免 dev 插件全部静默丢失
      const end = raw.indexOf(']')
      if (end <= 0) throw new Error('unrecoverable content')
      parsed = JSON.parse(raw.slice(0, end + 1))
      logWarn('dev', 'dev.json was corrupt, recovered records from valid prefix')
    }
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((x): x is DevPluginRecord => {
        const r = x as Partial<DevPluginRecord>
        return typeof r?.id === 'string' && r.id.length > 0 && typeof r?.path === 'string' && r.path.length > 0
      })
      .map((r) => ({ id: r.id, path: r.path, url: typeof r.url === 'string' ? r.url : undefined, preview: r.preview === 'dist' ? 'dist' : 'source', ...(r.killOnHide ? { killOnHide: true } : {}) }))
  } catch (err) {
    logWarn('dev', `read dev.json failed: ${(err as Error).message}`)
    return []
  }
}

async function writeDevPluginRecords(records: DevPluginRecord[]): Promise<void> {
  const file = devPluginsFile()
  await mkdir(getAppPaths().plugins, { recursive: true })
  const unique = new Map<string, DevPluginRecord>()
  for (const r of records) {
    if (r.id && r.path) unique.set(r.id, { id: r.id, path: r.path, url: r.url, preview: r.preview, ...(r.killOnHide ? { killOnHide: true } : {}) })
  }
  // 临时文件 + 同目录 rename 原子替换，进程中断不再留下半截 JSON
  const tmp = `${file}.${process.pid}.tmp`
  await writeFile(tmp, JSON.stringify([...unique.values()], null, 2), 'utf8')
  await rename(tmp, file)
}

/** Serialize read-modify-write operations so concurrent developer actions cannot lose records. */
let mutationTail: Promise<void> = Promise.resolve()
function updateRecords(change: (records: DevPluginRecord[]) => DevPluginRecord[]): Promise<void> {
  const operation = mutationTail.then(async () => writeDevPluginRecords(change(await readDevPluginRecords())))
  mutationTail = operation.catch(() => {})
  return operation
}

/** 加载后记录；同 id 覆盖路径，保留已有 killOnHide */
export function upsertDevPluginRecord(id: string, path: string, options: DevPluginLoadOptions = {}): Promise<void> {
  return updateRecords(list => {
    const previous = list.find(record => record.id === id)
    return [...list.filter(record => record.id !== id), { id, path, ...options, ...(previous?.killOnHide ? { killOnHide: true } : {}) }]
  })
}

export function setDevPluginKillOnHide(id: string, killOnHide: boolean): Promise<void> {
  return updateRecords(list => list.map(record => record.id === id ? { ...record, killOnHide: killOnHide || undefined } : record))
}

export function dropDevPluginRecord(id: string): Promise<void> {
  return updateRecords(list => list.filter(record => record.id !== id))
}
