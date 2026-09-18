/**
 * devPluginsStore — 开发态插件路径持久化
 * 职责：读写 {dataRoot}/plugins/dev.json，重启后可从源码目录重新加载调试插件。
 * 仅存 id + 绝对路径；manifest 每次从目录现读。
 */
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { getAppPaths } from '@main/paths/pathsService'
import { logWarn } from '@main/logs/logService'

export interface DevPluginRecord {
  id: string
  path: string
}

export function devPluginsFile(): string {
  return join(getAppPaths().plugins, 'dev.json')
}

export async function readDevPluginRecords(): Promise<DevPluginRecord[]> {
  const file = devPluginsFile()
  if (!existsSync(file)) return []
  try {
    const raw = await readFile(file, 'utf8')
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((x): x is DevPluginRecord => {
        const r = x as Partial<DevPluginRecord>
        return typeof r?.id === 'string' && r.id.length > 0 && typeof r?.path === 'string' && r.path.length > 0
      })
      .map((r) => ({ id: r.id, path: r.path }))
  } catch (err) {
    logWarn('dev', `read dev.json failed: ${(err as Error).message}`)
    return []
  }
}

export async function writeDevPluginRecords(records: DevPluginRecord[]): Promise<void> {
  const file = devPluginsFile()
  const unique = new Map<string, DevPluginRecord>()
  for (const r of records) {
    if (r.id && r.path) unique.set(r.id, { id: r.id, path: r.path })
  }
  await writeFile(file, JSON.stringify([...unique.values()], null, 2), 'utf8')
}

/** 加载后记录；同 id 覆盖路径 */
export async function upsertDevPluginRecord(id: string, path: string): Promise<void> {
  const list = await readDevPluginRecords()
  const next = list.filter((r) => r.id !== id)
  next.push({ id, path })
  await writeDevPluginRecords(next)
}

/** 移除开发态时删掉记录 */
export async function dropDevPluginRecord(id: string): Promise<void> {
  const list = await readDevPluginRecords()
  const next = list.filter((r) => r.id !== id)
  if (next.length === list.length) return
  await writeDevPluginRecords(next)
}
