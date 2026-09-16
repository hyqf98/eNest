/**
 * PluginInstaller — 插件包安装器
 * 职责：从目录 / .enestplugin(zip) 读取并校验 plugin.json，复制到
 *       {plugins}/{id}/{version}/，通过进度回调上报 0–100。
 * 被 PluginRegistry（scan / installFromSample）、DevConsole、installQueue 调用。
 * 关键依赖：adm-zip（解压）、pathsService 由调用方传入 destRoot、logService。
 */
import { cp, mkdir, mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, extname, join } from 'node:path'
import AdmZip from 'adm-zip'
import type { PluginManifest } from '@shared/types/plugin'
import { logInfo, logWarn } from '@main/logs/logService'

/** 安装进度回调：percent 0–100，step 为当前步骤中文描述 */
export type InstallProgress = (percent: number, step: string) => void

export interface InstallResult {
  manifest: PluginManifest
  dest: string
}

function isManifest(value: unknown): value is PluginManifest {
  if (!value || typeof value !== 'object') return false
  const m = value as Record<string, unknown>
  return (
    typeof m.id === 'string' &&
    typeof m.name === 'string' &&
    typeof m.version === 'string' &&
    typeof m.main === 'string'
  )
}

/** 从目录读取 plugin.json 并校验必填字段，返回类型安全的 manifest */
export async function installFromDirectory(dir: string): Promise<PluginManifest> {
  const manifestPath = join(dir, 'plugin.json')
  let raw: string
  try {
    raw = await readFile(manifestPath, 'utf-8')
  } catch {
    throw new Error(`plugin.json not found in ${dir}`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('invalid plugin.json: not valid JSON')
  }
  if (!isManifest(parsed)) {
    throw new Error('invalid plugin.json: missing required fields (id, name, version, main)')
  }
  return parsed
}

/**
 * 统一入口：按源路径类型分发到文件夹安装或 zip 安装。
 * 支持：本地文件夹（含 plugin.json）、.enestplugin / .zip（根或单层子目录含 plugin.json）。
 */
export async function installPluginFromPath(
  sourcePath: string,
  destRoot: string,
  onProgress?: InstallProgress
): Promise<InstallResult> {
  onProgress?.(2, '检查源路径')
  if (!sourcePath || !existsSync(sourcePath)) {
    throw new Error(`路径不存在: ${sourcePath || '(空)'}`)
  }
  const st = await stat(sourcePath)
  if (st.isDirectory()) {
    logInfo('install', `folder install ← ${sourcePath}`)
    return installFromFolder(sourcePath, destRoot, onProgress)
  }
  const ext = extname(sourcePath).toLowerCase()
  if (ext === '.enestplugin' || ext === '.zip') {
    logInfo('install', `zip install ← ${sourcePath}`)
    return installFromZip(sourcePath, destRoot, onProgress)
  }
  throw new Error(`不支持的安装包类型: ${basename(sourcePath)}（需要文件夹或 .enestplugin/.zip）`)
}

/** 从本地文件夹安装：校验 manifest 后递归复制到 destRoot/{id}/{version} */
export async function installFromFolder(
  srcDir: string,
  destRoot: string,
  onProgress?: InstallProgress
): Promise<InstallResult> {
  onProgress?.(8, '读取 plugin.json')
  const manifest = await installFromDirectory(srcDir)
  const version = manifest.version || '0.0.0'
  const dest = join(destRoot, manifest.id, version)
  onProgress?.(35, '复制插件文件')
  await mkdir(dest, { recursive: true })
  await cp(srcDir, dest, { recursive: true, force: true })
  onProgress?.(90, '复制完成')
  logInfo('install', `folder ok ${manifest.id}@${version} → ${dest}`)
  return { manifest, dest }
}

/**
 * 从 .enestplugin / .zip 安装：
 * 1. 解压到系统临时目录
 * 2. 定位 plugin.json（根目录，或唯一一层子目录内）
 * 3. 复制到 destRoot/{id}/{version}
 */
export async function installFromZip(
  zipPath: string,
  destRoot: string,
  onProgress?: InstallProgress
): Promise<InstallResult> {
  onProgress?.(5, '解压安装包')
  const tmp = await mkdtemp(join(tmpdir(), 'enest-plugin-'))
  try {
    let zip: AdmZip
    try {
      zip = new AdmZip(zipPath)
    } catch (err) {
      throw new Error(`无法读取安装包: ${(err as Error).message}`)
    }
    zip.extractAllTo(tmp, true)
    onProgress?.(40, '定位 plugin.json')
    const pluginRoot = await findPluginRoot(tmp)
    const manifest = await installFromDirectory(pluginRoot)
    const version = manifest.version || '0.0.0'
    const dest = join(destRoot, manifest.id, version)
    onProgress?.(65, '写入插件目录')
    await mkdir(dest, { recursive: true })
    await cp(pluginRoot, dest, { recursive: true, force: true })
    onProgress?.(90, '写入完成')
    logInfo('install', `zip ok ${manifest.id}@${version} → ${dest}`)
    return { manifest, dest }
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {
      logWarn('install', `cleanup temp failed: ${tmp}`)
    })
  }
}

/** 在解压目录中查找 plugin.json：优先根目录，再扫一级子目录 */
async function findPluginRoot(dir: string): Promise<string> {
  if (existsSync(join(dir, 'plugin.json'))) return dir
  let items: string[]
  try {
    items = await readdir(dir)
  } catch {
    throw new Error('安装包为空或无法读取')
  }
  for (const item of items) {
    const p = join(dir, item)
    try {
      if ((await stat(p)).isDirectory() && existsSync(join(p, 'plugin.json'))) {
        return p
      }
    } catch {
      /* skip unreadable entry */
    }
  }
  throw new Error('安装包中未找到 plugin.json（需位于根目录或一级子目录）')
}
