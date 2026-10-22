/** 宿主拥有的 DSH 启动选择；独立持久化在隔离 DSH_HOME，不修改系统 ~/.dsh。 */
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import { dshDataDirs } from '@main/dsh/dshRuntimeStore'
import type { DshWorkbenchSettings } from '@shared/types/dsh-workbench'

export const DSH_SETTINGS_FILENAME = '.enest-workbench.json'
const DEFAULT_SETTINGS: DshWorkbenchSettings = {
  webProfile: 'web', sdkProfile: 'sdk', webPortPolicy: 'auto', webPort: 3000
}

export function validateDshProfileName(value: unknown, allowReserved = false): string {
  if (typeof value !== 'string' || value.length > 64 || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) {
    throw new Error('非法 profile 名（1–64 位字母、数字、点、下划线或短横线）')
  }
  if (value.toLowerCase() === 'node_modules' || !allowReserved && value.toLowerCase() === 'desktop') {
    throw new Error(`profile ${JSON.stringify(value)} 为保留名`)
  }
  return value
}

/** 禁止通过任意一级符号链接访问 profile、备份或隔离 home。缺失的尾部可以安全创建。 */
export function assertDshPath(root: string, target = root): string {
  const base = resolve(root)
  const absolute = resolve(target)
  const within = relative(base, absolute)
  if (within === '..' || within.startsWith(`..${sep}`) || isAbsolute(within)) throw new Error('DSH 路径越界')
  let current = parse(absolute).root
  for (const segment of absolute.slice(current.length).split(sep).filter(Boolean)) {
    current = join(current, segment)
    let stat
    try { stat = lstatSync(current) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') break
      throw error
    }
    if (stat.isSymbolicLink()) throw new Error('DSH 配置和备份路径不允许符号链接')
  }
  return absolute
}

/** 同目录临时文件 + fsync + rename；任何失败不覆盖原文件。 */
export function writeDshFileAtomic(file: string, text: string): void {
  assertDshPath(dirname(file), file)
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const tmp = join(dirname(file), `.enest-write-${randomUUID()}`)
  let fd: number | undefined
  try {
    fd = openSync(tmp, 'wx', 0o600)
    writeFileSync(fd, text, 'utf8')
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    renameSync(tmp, file)
  } finally {
    if (fd !== undefined) closeSync(fd)
    rmSync(tmp, { force: true })
  }
}

function settingsPath(): string {
  const { dshHome } = dshDataDirs()
  return assertDshPath(dshHome, join(dshHome, DSH_SETTINGS_FILENAME))
}

export function validateDshSettingsPatch(value: unknown): Partial<DshWorkbenchSettings> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('无效 DSH 设置')
  const patch = value as Record<string, unknown>
  const result: Partial<DshWorkbenchSettings> = {}
  for (const key of Object.keys(patch)) {
    switch (key) {
      case 'webProfile': result.webProfile = validateDshProfileName(patch[key]); break
      case 'sdkProfile': result.sdkProfile = validateDshProfileName(patch[key]); break
      case 'webPortPolicy':
        if (patch[key] !== 'auto' && patch[key] !== 'fixed') throw new Error('webPortPolicy 只能为 auto 或 fixed')
        result.webPortPolicy = patch[key]
        break
      case 'webPort':
        if (typeof patch[key] !== 'number' || !Number.isInteger(patch[key]) || patch[key] < 1 || patch[key] > 65535) {
          throw new Error('webPort 必须为 1–65535 的整数')
        }
        result.webPort = patch[key]
        break
      default: throw new Error(`未知 DSH 设置字段: ${key}`)
    }
  }
  return result
}

export function getDshSettings(): DshWorkbenchSettings {
  let text: string
  try { text = readFileSync(settingsPath(), 'utf8') }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ...DEFAULT_SETTINGS }
    throw error
  }
  try { return { ...DEFAULT_SETTINGS, ...validateDshSettingsPatch(JSON.parse(text)) } }
  catch { throw new Error('DSH 启动设置损坏，请恢复备份或重置配置') }
}

/** 调用方必须持有 withDshMaintenance；只在 durable rename 成功后返回确认值。 */
export function updateDshSettings(patch: Partial<DshWorkbenchSettings>): DshWorkbenchSettings {
  const next = { ...getDshSettings(), ...validateDshSettingsPatch(patch) }
  writeDshFileAtomic(settingsPath(), `${JSON.stringify(next, null, 2)}\n`)
  return next
}
