/**
 * PluginInstaller — 插件包安装器
 * 职责：从目录 / .enestplugin(zip) 读取并校验 plugin.json，复制到
 *       {plugins}/{id}/{version}/，通过进度回调上报 0–100。
 * 被 PluginRegistry（scan / installFromSample）、DevConsole、installQueue 调用。
 * 校验使用插件仓库同步的 JSON Schema，并补充引擎版本与真实文件布局检查；
 * 校验暂存副本后才原子发布，不接受旧嵌套包格式。
 * 关键依赖：adm-zip（解压）、pathsService 由调用方传入 destRoot、logService。
 */
import { cp, lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, extname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { extractPluginArchive, writePluginBuildRevision } from './pluginInstallTasks'
import type { PluginManifest } from '@shared/types/plugin'
import { PLUGIN_PERMISSIONS } from '@shared/types/plugin'
import { collectPluginFeatureIssues } from '@shared/pluginCommands'
import { isPluginAssetPath, isPluginBackendPath, normalizePluginDevUrl, PLUGIN_ENTRY, PLUGIN_ICON, PLUGIN_README, PLUGIN_SCREENSHOTS } from '@shared/pluginContract'
import { resolvePluginFile } from './pluginPaths'
import { resolveBackendFile } from './pluginBackendPath'
import { logInfo, logWarn } from '@main/logs/logService'
import Ajv2020 from 'ajv/dist/2020.js'
import manifestSchema from '@shared/pluginManifest.schema.json'

const validateManifestSchema = new Ajv2020({ allErrors: true, strict: false }).compile(manifestSchema)

/** 安装进度回调：percent 0–100，step 为当前步骤中文描述 */
export type InstallProgress = (percent: number, step: string) => void

export interface InstallResult {
  manifest: PluginManifest
  dest: string
  buildRevision: string
}
/** Runs while the package lock is still held, so registry publication precedes later mutations. */
export type InstallPublished = (result: InstallResult) => void

export interface PluginInstallLifecycleHooks {
  beforeReplace?: (pluginId: string, dest: string) => Promise<void | (() => void)>
  afterReplace?: (pluginId: string, dest: string) => Promise<void>
}
let lifecycleHooks: PluginInstallLifecycleHooks = {}
const installLocks = new Map<string, Promise<unknown>>()
let installSequence = 0
const cancelledBefore = new Map<string, number>()
export function beginPluginInstall(): number { return ++installSequence }
/** Uninstall supersedes preparations/downloads that started before it. */
export function cancelPluginInstalls(id: string): void { cancelledBefore.set(id, ++installSequence) }
function assertInstallCurrent(id: string, sequence: number): void {
  if ((cancelledBefore.get(id) ?? 0) > sequence) throw new Error('插件安装已被卸载操作取消')
}

/** Host supplies close/block hooks without introducing a Registry → Host import cycle. */
export function setPluginInstallLifecycleHooks(hooks: PluginInstallLifecycleHooks): void {
  lifecycleHooks = hooks
}

export async function withInstallLock<T>(id: string, action: () => Promise<T>): Promise<T> {
  const previous = installLocks.get(id)
  const task = (previous ?? Promise.resolve()).catch(() => {}).then(action)
  installLocks.set(id, task)
  try { return await task } finally { if (installLocks.get(id) === task) installLocks.delete(id) }
}

/** id：反向域名（至少两段；首段小写，后续段允许大写如 com.github.eNest.xxx） */
const ID_PATTERN = /^[a-z0-9]+(\.[a-zA-Z0-9-]+)+$/
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
 * - 此处额外校验 schema 做不到的：engines.enest 与壳子版本匹配、main 文件存在。
 * 返回全部错误列表；空数组 = 通过。
 */
export function collectManifestIssues(
  value: unknown,
  pluginDir: string,
  appVersion: string,
  source = false
): string[] {
  const errors: string[] = []
  if (!value || typeof value !== 'object') {
    return ['(unknown id): plugin.json 根节点必须是对象']
  }
  const m = value as Record<string, unknown>
  if (!validateManifestSchema(value)) {
    for (const issue of (validateManifestSchema.errors ?? []).slice(0, 50)) pushError(errors, m.id, `${issue.instancePath || 'plugin.json'} ${issue.message}`)
  }

  if (typeof m.id !== 'string' || !m.id) {
    pushError(errors, m.id, '字段 id 缺失或不是字符串（必填，反向域名）')
  } else if (!ID_PATTERN.test(m.id)) {
    pushError(errors, m.id, `字段 id "${m.id}" 不是合法反向域名（形如 com.github.eNest.plugin）`)
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

  // Keep source, distribution and installation contracts aligned.
  if (typeof m.description !== 'string' || !m.description.trim()) {
    pushError(errors, m.id, '字段 description 必须为非空字符串')
  }

  for (const issue of collectPluginFeatureIssues(m.features)) pushError(errors, m.id, issue)

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

  // net.allowInsecure：只影响宿主 net.fetch，页面直连仍受 session 策略约束。
  if (m.net !== undefined) {
    const netCfg = m.net as { allowInsecure?: unknown }
    if (typeof netCfg !== 'object' || netCfg === null || Array.isArray(netCfg)) {
      pushError(errors, m.id, '字段 net 若存在必须是对象 { allowInsecure?: boolean }')
    } else if (netCfg.allowInsecure !== undefined && typeof netCfg.allowInsecure !== 'boolean') {
      pushError(errors, m.id, '字段 net.allowInsecure 若存在必须是 boolean')
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

  if (m.main !== PLUGIN_ENTRY) pushError(errors, m.id, `main 必须为 ${PLUGIN_ENTRY}`)
  if ('logo' in m) pushError(errors, m.id, 'logo 已移除，请使用 icon')
  if (m.icon !== PLUGIN_ICON) pushError(errors, m.id, `icon 必须为 ${PLUGIN_ICON}`)
  const market = m.market as { readme?: unknown; screenshots?: unknown } | undefined
  if (market?.readme !== PLUGIN_README) pushError(errors, m.id, `market.readme 必须为 ${PLUGIN_README}`)
  if (!Array.isArray(market?.screenshots) || (!source && !market.screenshots.length) || market.screenshots.length > 8) {
    pushError(errors, m.id, 'market.screenshots 必须为数组，发布时需要 1–8 张截图')
  } else for (const path of market.screenshots) {
    if (!isPluginAssetPath(path) || !path.startsWith(PLUGIN_SCREENSHOTS) || !/\.(png|webp|jpe?g)$/i.test(path)) {
      pushError(errors, m.id, '截图必须位于 assets/market/screenshots，使用 PNG/WebP/JPEG')
    }
  }
  if (m.settings !== undefined) pushError(errors, m.id, 'settings HTML 入口已移除，请使用 contributes.settings 或入口内设置页面')
  if (!source && m.development !== undefined) pushError(errors, m.id, '发布包不得包含 development')
  try { normalizePluginDevUrl((m.development as { main?: unknown } | undefined)?.main) }
  catch { pushError(errors, m.id, 'development.main 必须为无凭据的 HTTP(S) URL') }
  if (!(source && (m.development as { main?: string } | undefined)?.main) && !existsSync(join(pluginDir, PLUGIN_ENTRY))) {
    pushError(errors, m.id, `入口文件 ${PLUGIN_ENTRY} 不存在`)
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
    typeof m.main === 'string' &&
    collectPluginFeatureIssues(m.features).length === 0
  )
}

/** 从目录读取 plugin.json 并完整校验（收集全部错误后一次抛出），返回类型安全的 manifest */
export async function installFromDirectory(dir: string, options: { source?: boolean; metadataOnly?: boolean } = {}): Promise<PluginManifest> {
  const manifestPath = join(dir, 'plugin.json')
  let raw: string
  try {
    const info = await lstat(manifestPath)
    if (!info.isFile() || info.isSymbolicLink() || info.size > 256 * 1024) throw new Error('invalid manifest file')
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
  const errors = collectManifestIssues(parsed, dir, app.getVersion(), options.source === true)
  if (errors.length > 0) {
    throw new Error(`invalid plugin.json:\n  - ${errors.join('\n  - ')}`)
  }
  const manifest = parsed as PluginManifest
  const source = options.source === true
  if (source) {
    if (basename(dir) !== manifest.id.split('.').pop()) throw new Error('源码目录名必须等于 plugin.json.id 的末段')
    const packageFile = join(dir, 'package.json')
    if ((await lstat(packageFile)).isSymbolicLink()) throw new Error('源码 package.json 不允许符号链接')
    const pkg = JSON.parse(await readFile(packageFile, 'utf8')) as Record<string, unknown>
    if (pkg.name !== manifest.id.split('.').pop() || pkg.version !== manifest.version || pkg.type !== 'module') throw new Error('package.json name（id 末段）/version/type 必须与插件工程契约一致')
  }
  const resources = [manifest.icon!, manifest.market!.readme!, ...(manifest.market?.screenshots ?? [])]
  if (!(source && manifest.development?.main)) resources.push(PLUGIN_ENTRY)
  for (const path of resources) {
    if (!await resolvePluginFile(dir, path, source)) throw new Error(`插件资源缺失或越界: ${path}`)
  }
  if (!source && manifest.backend) resolveBackendFile(dir, manifest.backend.entry)
  if (!source && !options.metadataOnly) await validatePublishedFiles(dir, manifest)
  return manifest
}

/**
 * 统一入口：按源路径类型分发到文件夹安装或 zip 安装。
 * 支持：本地发布目录、.enestplugin / .zip（根直接包含 plugin.json）。
 */
export async function installPluginFromPath(
  sourcePath: string,
  destRoot: string,
  onProgress?: InstallProgress,
  operation = beginPluginInstall(),
  onPublished?: InstallPublished
): Promise<InstallResult> {
  onProgress?.(2, '检查源路径')
  if (!sourcePath || !existsSync(sourcePath)) {
    throw new Error(`路径不存在: ${sourcePath || '(空)'}`)
  }
  const st = await stat(sourcePath)
  if (st.isDirectory()) {
    logInfo('install', `folder install ← ${sourcePath}`)
    return installFromFolder(sourcePath, destRoot, onProgress, operation, onPublished)
  }
  const ext = extname(sourcePath).toLowerCase()
  if (ext === '.enestplugin' || ext === '.zip') {
    logInfo('install', `zip install ← ${sourcePath}`)
    return installFromZip(sourcePath, destRoot, onProgress, operation, onPublished)
  }
  throw new Error(`不支持的安装包类型: ${basename(sourcePath)}（需要 .zip、.enestplugin 或发布目录）`)
}

/** 从本地文件夹安装：校验 manifest 后递归复制到 destRoot/{id}/{version} */
export async function installFromFolder(
  srcDir: string,
  destRoot: string,
  onProgress?: InstallProgress,
  operation = beginPluginInstall(),
  onPublished?: InstallPublished
): Promise<InstallResult> {
  onProgress?.(8, '读取 plugin.json')
  const manifest = await installFromDirectory(srcDir)
  return withInstallLock(manifest.id, async () => {
    assertInstallCurrent(manifest.id, operation)
    const version = manifest.version || '0.0.0'
    const dest = join(destRoot, manifest.id, version)
    await mkdir(destRoot, { recursive: true })
    const stage = await mkdtemp(join(destRoot, '.staging-'))
    const backup = join(destRoot, `.backup-${randomUUID()}`)
    let movedOld = false
    let committed = false
    let release: void | (() => void) = undefined
    try {
      onProgress?.(35, '准备插件文件')
      await cp(srcDir, stage, { recursive: true, force: true, dereference: false })
      // The selected directory may still be rebuilt while copying. Validate the private
      // snapshot that will actually be published, and never pair it with stale metadata.
      const stagedManifest = await installFromDirectory(stage)
      if (JSON.stringify(stagedManifest) !== JSON.stringify(manifest)) {
        throw new Error('安装期间 plugin.json 已变化，请在构建完成后重试')
      }
      const buildRevision = await writePluginBuildRevision(stage)
      assertInstallCurrent(manifest.id, operation)
      // The old renderer must release files before Windows can replace an installed build.
      release = await lifecycleHooks.beforeReplace?.(manifest.id, dest)
      assertInstallCurrent(manifest.id, operation)
      await mkdir(join(destRoot, manifest.id), { recursive: true })
      if (existsSync(dest)) {
        await rename(dest, backup)
        movedOld = true
      }
      try {
        await rename(stage, dest)
        committed = true
      } catch (error) {
        if (movedOld) await rename(backup, dest)
        movedOld = false
        throw error
      }
      await lifecycleHooks.afterReplace?.(manifest.id, dest)
      const result = { manifest, dest, buildRevision }
      onPublished?.(result)
      onProgress?.(90, '写入完成')
      logInfo('install', `installed ${manifest.id}@${version} → ${dest}`)
      return result
    } finally {
      if (typeof release === 'function') release()
      await rm(stage, { recursive: true, force: true }).catch(() => {})
      if (committed && movedOld) {
        await rm(backup, { recursive: true, force: true }).catch((error: Error) => {
          logWarn('install', `cleanup previous build failed: ${error.message}`)
        })
      }
    }
  })
}

/**
 * 从 .enestplugin ZIP 内容安装：
 * 1. 解压到系统临时目录
 * 2. 校验根目录 plugin.json 与预期市场身份
 * 3. 复制到 destRoot/{id}/{version}
 */
export async function installFromZip(
  zipPath: string,
  destRoot: string,
  onProgress?: InstallProgress,
  operation = beginPluginInstall(),
  onPublished?: InstallPublished,
  expected?: { id: string; version: string }
): Promise<InstallResult> {
  onProgress?.(5, '解压安装包')
  const tmp = await mkdtemp(join(tmpdir(), 'enest-plugin-'))
  try {
    await extractPluginArchive(zipPath, tmp)
    onProgress?.(40, '定位 plugin.json')
    const pluginRoot = await findPluginRoot(tmp)
    if (expected) {
      const manifest = await installFromDirectory(pluginRoot, { metadataOnly: true })
      if (manifest.id !== expected.id || manifest.version !== expected.version) throw new Error('安装包身份与市场版本不一致')
    }
    return await installFromFolder(pluginRoot, destRoot, (percent, step) => {
      onProgress?.(40 + Math.round(percent * 0.55), step)
    }, operation, onPublished)
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {
      logWarn('install', `cleanup temp failed: ${tmp}`)
    })
  }
}

/** Archives have one unambiguous root; wrapping folders are not a package format. */
async function findPluginRoot(dir: string): Promise<string> {
  if (!existsSync(join(dir, 'plugin.json'))) throw new Error('安装包根目录必须包含 plugin.json，不支持外层目录')
  return dir
}

async function validatePublishedFiles(root: string, manifest: PluginManifest): Promise<void> {
  const id = manifest.id
  async function visit(dir: string, prefix = ''): Promise<void> {
    for (const name of await readdir(dir)) {
      const rel = prefix + name
      const info = await lstat(join(dir, name))
      if (info.isSymbolicLink()) throw new Error(`插件包不允许符号链接: ${rel}`)
      if (!prefix && name === '.enest-build.json' && info.isFile()) continue // host-owned revision metadata
      if (!prefix && !['plugin.json', 'index.html', 'assets', ...(manifest.backend ? ['backend'] : []), ...(id === 'com.github.eNest.dsh' ? ['runtime'] : [])].includes(name)) {
        throw new Error(`非标准发布内容: ${rel}`)
      }
      const runtime = id === 'com.github.eNest.dsh' && (rel === 'runtime' || rel.startsWith('runtime/'))
      const backend = !!manifest.backend && (rel === 'backend' || rel.startsWith('backend/'))
      if (!runtime && (!(backend ? isPluginBackendPath(rel) : isPluginAssetPath(rel)) || (!backend && /(?:^|\/)(?:node_modules|tests?|src)(?:\/|$)/.test(rel)) || /\.(?:map|tsx?|vue)$/i.test(rel))) {
        throw new Error(`发布包包含源码或私有文件: ${rel}`)
      }
      if (info.isDirectory()) await visit(join(dir, name), rel + '/')
      else if (!info.isFile()) throw new Error(`插件包包含非普通文件: ${rel}`)
    }
  }
  await visit(root)
}
