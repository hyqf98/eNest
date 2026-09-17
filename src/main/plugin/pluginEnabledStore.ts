/**
 * pluginEnabledStore — 插件启用/禁用持久化
 * 职责：读写 ~/eNest/plugins/disabled.json，维护禁用 id 集合；默认全部启用。
 * 为什么独立：启用状态属于插件元数据而非 SettingsStore，卸载/扫描时由
 *       PluginRegistry / PluginUninstaller 调用，避免与 settings.json 耦合。
 * 被 PluginRegistry（list/get/scan/setPluginEnabled）、PluginHost（open 拒绝）、
 * PluginUninstaller（清理）调用。
 * 关键依赖：pathsService、logService。
 */
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { getAppPaths } from '@main/paths/pathsService'
import { logWarn } from '@main/logs/logService'

interface DisabledFile {
  disabled: string[]
}

/** 内存缓存；null 表示尚未从磁盘加载（此时视为全部启用） */
let cache: Set<string> | null = null

function disabledFilePath(): string {
  return join(getAppPaths().plugins, 'disabled.json')
}

async function load(): Promise<Set<string>> {
  if (cache) return cache
  const file = disabledFilePath()
  try {
    if (existsSync(file)) {
      const raw = await readFile(file, 'utf-8')
      const parsed = JSON.parse(raw) as Partial<DisabledFile>
      const list = Array.isArray(parsed.disabled)
        ? parsed.disabled.filter((x): x is string => typeof x === 'string')
        : []
      cache = new Set(list)
      return cache
    }
  } catch (err) {
    logWarn('plugin-enabled', `load disabled.json failed: ${(err as Error).message}`)
  }
  cache = new Set()
  return cache
}

async function persist(set: Set<string>): Promise<void> {
  const file = disabledFilePath()
  await mkdir(getAppPaths().plugins, { recursive: true })
  await writeFile(file, JSON.stringify({ disabled: [...set] }, null, 2), 'utf-8')
}

/** 预热缓存（scan 启动时调用），返回禁用 id 快照 */
export async function loadDisabledIds(): Promise<Set<string>> {
  return load()
}

/**
 * 同步读缓存判断是否启用。
 * 未加载时视为启用（启动早期 open 很少发生；scan 会先 load）。
 */
export function isEnabledSync(id: string): boolean {
  return cache ? !cache.has(id) : true
}

/** 当前禁用 id 集合快照（只读用途） */
export function getDisabledIdsSync(): ReadonlySet<string> {
  return cache ?? new Set()
}

/** 写入启用状态并落盘 */
export async function persistPluginEnabled(id: string, enabled: boolean): Promise<void> {
  const set = await load()
  if (enabled) set.delete(id)
  else set.add(id)
  await persist(set)
}

/** 卸载时清除该 id 的禁用记录（避免重装后仍被禁用） */
export async function clearPluginDisabled(id: string): Promise<void> {
  const set = await load()
  if (set.delete(id)) {
    await persist(set)
  }
}
