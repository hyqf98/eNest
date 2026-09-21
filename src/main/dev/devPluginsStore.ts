/**
 * devPluginsStore — 开发态插件路径持久化
 * 职责：读写 {dataRoot}/plugins/dev.json，重启后可从源码目录重新加载调试插件。
 * 仅存 id + 绝对路径 + 退出即杀开关；manifest 每次从目录现读。
 */
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { getAppPaths } from '@main/paths/pathsService'
import { logWarn } from '@main/logs/logService'

export interface DevPluginRecord {
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
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((x): x is DevPluginRecord => {
        const r = x as Partial<DevPluginRecord>
        return typeof r?.id === 'string' && r.id.length > 0 && typeof r?.path === 'string' && r.path.length > 0
      })
      .map((r) => ({ id: r.id, path: r.path, ...(r.killOnHide ? { killOnHide: true } : {}) }))
  } catch (err) {
    logWarn('dev', `read dev.json failed: ${(err as Error).message}`)
    return []
  }
}

export async function writeDevPluginRecords(records: DevPluginRecord[]): Promise<void> {
  const file = devPluginsFile()
  const unique = new Map<string, DevPluginRecord>()
  for (const r of records) {
    if (r.id && r.path) unique.set(r.id, { id: r.id, path: r.path, ...(r.killOnHide ? { killOnHide: true } : {}) })
  }
  await writeFile(file, JSON.stringify([...unique.values()], null, 2), 'utf8')
}

/** 加载后记录；同 id 覆盖路径，保留已有 killOnHide */
export async function upsertDevPluginRecord(id: string, path: string): Promise<void> {
  const list = await readDevPluginRecords()
  const prev = list.find((r) => r.id === id)
  const next = list.filter((r) => r.id !== id)
  next.push({ id, path, ...(prev?.killOnHide ? { killOnHide: true } : {}) })
  await writeDevPluginRecords(next)
}

/** 更新单个 dev 插件的「退出即杀」开关 */
export async function setDevPluginKillOnHide(id: string, killOnHide: boolean): Promise<void> {
  const list = await readDevPluginRecords()
  const rec = list.find((r) => r.id === id)
  if (!rec) return
  await writeDevPluginRecords(list.map((r) => (r.id === id ? { ...r, killOnHide: killOnHide || undefined } : r)))
}

/** 移除开发态时删掉记录 */
export async function dropDevPluginRecord(id: string): Promise<void> {
  const list = await readDevPluginRecords()
  const next = list.filter((r) => r.id !== id)
  if (next.length === list.length) return
  await writeDevPluginRecords(next)
}
