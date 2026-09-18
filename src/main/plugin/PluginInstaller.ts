/**
 * PluginInstaller — 插件包安装器
 * 职责：从目录 / .enestplugin(zip) 读取并校验 plugin.json，复制到
 *       {plugins}/{id}/{version}/，通过进度回调上报 0–100。
 * 被 PluginRegistry（scan / installFromSample）、DevConsole、installQueue 调用。
 * 校验为程序化实现（不引 ajv / 不打包 schema 文件）：
 *   必填 id（反向域名）/ name / version（semver）/ main；permissions 白名单；
 *   engines.enest 版本范围（* / ^x.y.z / >=x.y.z / 精确）；main 入口文件存在。
 * 关键依赖：adm-zip（解压）、pathsService 由调用方传入 destRoot、logService。
 */
import { cp, mkdir, mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, extname, join } from 'node:path'
import AdmZip from 'adm-zip'
import type { PluginManifest } from '@shared/types/plugin'
import { PLUGIN_PERMISSIONS } from '@shared/types/plugin'
import { logInfo, logWarn } from '@main/logs/logService'

/** 安装进度回调：percent 0–100，step 为当前步骤中文描述 */
export type InstallProgress = (percent: number, step: string) => void

export interface InstallResult {
  manifest: PluginManifest
  dest: string
}

/** id：反向域名（至少两段，小写字母/数字/连字符） */
const ID_PATTERN = /^[a-z0-9]+(\.[a-z0-9-]+)+$/
/** version：宽松 semver（允许 -beta.1 / +build 后缀） */
const SEMVER_PATTERN =
  /^\d+\.\d+\.\d+(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/
/** engines.enest 支持的范围语法：* / ^x.y.z / >=x.y.z / 精确 x.y.z（* 需独立分支） */
const ENGINE_RANGE_PATTERN = /^(\*|(\^|>=)?\d+\.\d+\.\d+)$/

function pushError(errors: string[], rawId: unknown, msg: string): void {
  errors.push(typeof rawId === 'string' && rawId ? `${rawId}: ${msg}` : `(unknown id): ${msg}`)
}

/**
 * 程序化校验 manifest（替代旧 isManifest 的四字段检查）。
 * 与 eNest_plugin/docs/plugin-manifest.schema.json 的差异：
 * - description 此处仅建议不强制（schema required 保留 description，仓库侧 CI 拦截）；
 * - 此处额外校验 schema 做不到的：engines.enest 与壳子版本匹配、main 文件存在。
 * 返回全部错误列表；空数组 = 通过。
 */
export function collectManifestIssues(
  value: unknown,
  pluginDir: string,
  appVersion: string
): string[] {
  const errors: string[] = []
  if (!value || typeof value !== 'object') {
    return ['(unknown id): plugin.json 根节点必须是对象']
  }
  const m = value as Record<string, unknown>

  if (typeof m.id !== 'string' || !m.id) {
    pushError(errors, m.id, '字段 id 缺失或不是字符串（必填，反向域名）')
  } else if (!ID_PATTERN.test(m.id)) {
    pushError(errors, m.id, `字段 id "${m.id}" 不是合法反向域名（形如 com.example.plugin）`)
  }

  if (typeof m.name !== 'string' || !m.name.trim()) {
    pushError(errors, m.id, '字段 name 缺失或为空（必填）')
  }

  if (typeof m.version !== 'string' || !SEMVER_PATTERN.test(m.version)) {
    pushError(errors, m.id, `字段 version "${String(m.version)}" 不是 semver（x.y.z）`)
  }

  if (typeof m.main !== 'string' || !m.main) {
    pushError(errors, m.id, '字段 main 缺失或不是字符串（必填，HTML 入口相对路径）')
  }

  // description：建议但不强制（与 schema required 的差异，见函数注释）
  if (m.description !== undefined && typeof m.description !== 'string') {
    pushError(errors, m.id, '字段 description 若存在必须是字符串')
  }

  if (m.permissions !== undefined) {
    if (!Array.isArray(m.permissions)) {
      pushError(errors, m.id, '字段 permissions 若存在必须是字符串数组')
    } else {
      for (const p of m.permissions) {
        if (typeof p !== 'string' || !PLUGIN_PERMISSIONS.includes(p as never)) {
          pushError(
            errors,
            m.id,
            `字段 permissions 含未知权限 "${String(p)}"（白名单见 PLUGIN_PERMISSIONS / plugin-manifest.schema.json）`
          )
        }
      }
    }
  }

  // engines.enest：支持 * / ^x.y.z / >=x.y.z / 精确；复杂范围直接拒绝安装
  const enestRange = (m.engines as { enest?: unknown } | undefined)?.enest
  if (enestRange !== undefined) {
    if (typeof enestRange !== 'string' || !ENGINE_RANGE_PATTERN.test(enestRange.trim())) {
      pushError(
        errors,
        m.id,
        `字段 engines.enest "${String(enestRange)}" 不支持（仅允许 * / ^x.y.z / >=x.y.z / 精确 x.y.z）`
      )
    } else if (!engineSatisfies(appVersion, enestRange.trim())) {
      pushError(
        errors,
        m.id,
        `字段 engines.enest "${enestRange}" 不满足当前壳子版本 ${appVersion}`
      )
    }
  }

  // main 入口文件必须存在于插件根目录（防 zip 缺文件装一半）
  if (typeof m.main === 'string' && m.main) {
    if (!existsSync(join(pluginDir, m.main))) {
      pushError(errors, m.id, `入口文件 ${m.main} 不存在于插件根目录 ${pluginDir}`)
    }
  }

  // logo 软提示（不拦截安装）：壳子显示规范见 @shared/constants PLUGIN_ICON_*
  // 推荐 256×256 PNG/WebP、最小 128×128、正方形、约 80% 安全区。
  // 本安装器不做像素解码（避免引入 sharp 等依赖），仅检查扩展名与文件是否存在。
  if (typeof m.logo === 'string' && m.logo.trim()) {
    const logoRel = m.logo.replace(/^\.?\//, '')
    const logoPath = join(pluginDir, logoRel)
    const ext = extname(logoRel).toLowerCase()
    if (!existsSync(logoPath)) {
      logWarn(
        '[PluginInstaller]',
        `${m.id}: manifest.logo "${m.logo}" 在插件目录中不存在；壳子将回退 glyph 色块`
      )
    } else if (ext && !['.png', '.webp', '.jpg', '.jpeg', '.svg'].includes(ext)) {
      logWarn(
        '[PluginInstaller]',
        `${m.id}: manifest.logo 扩展名 "${ext}" 非常规；推荐 PNG/WebP，源图约 256×256（最小 128×128）`
      )
    }
  }

  return errors
}

/**
 * 最小 semver 范围匹配（主次版本比较即可，与 compareVersions 同粒度）。
 * 支持：* 任意 / ^x.y.z / >=x.y.z / x.y.z 精确。
 * caret 语义对齐 npm：主版本 >0 时同主版本；主版本 0 时同次版本（^0.2.z 只允许 0.2.*），
 * ^0.0.z 再收紧到补丁位。预发布后缀忽略（市场包以稳定版为主）。
 */
export function engineSatisfies(appVersion: string, range: string): boolean {
  const parse = (v: string): [number, number, number] | null => {
    const m = /^\D*(\d+)\.(\d+)\.(\d+)/.exec(v.trim())
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
  }
  const app = parse(appVersion)
  if (!app) return true // 壳子版本解析失败时不因 engines 拦截安装
  if (range === '*') return true
  const req = parse(range.replace(/^(\^|>=)/, ''))
  if (!req) return false
  const cmp = (a: [number, number, number], b: [number, number, number]): number => {
    for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1
    return 0
  }
  if (range.startsWith('^')) {
    if (cmp(app, req) < 0) return false
    if (req[0] > 0) return app[0] === req[0]
    if (req[1] > 0) return app[0] === 0 && app[1] === req[1]
    return app[0] === 0 && app[1] === 0 && app[2] === req[2]
  }
  if (range.startsWith('>=')) {
    return cmp(app, req) >= 0
  }
  return cmp(app, req) === 0
}

/** 旧名兼容导出：仅做必填字段形状检查（不含文件/版本范围副作用），供轻量场景使用 */
export function isManifest(value: unknown): value is PluginManifest {
  return collectManifestIssuesShape(value)
}

function collectManifestIssuesShape(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const m = value as Record<string, unknown>
  return (
    typeof m.id === 'string' &&
    typeof m.name === 'string' &&
    typeof m.version === 'string' &&
    typeof m.main === 'string'
  )
}

/** 从目录读取 plugin.json 并完整校验（收集全部错误后一次抛出），返回类型安全的 manifest */
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
  const { app } = await import('electron')
  const errors = collectManifestIssues(parsed, dir, app.getVersion())
  if (errors.length > 0) {
    throw new Error(`invalid plugin.json:\n  - ${errors.join('\n  - ')}`)
  }
  return parsed as PluginManifest
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
