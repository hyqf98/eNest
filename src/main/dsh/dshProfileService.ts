/**
 * DSH 的真实配置面：profiles/<name>/package.json 的 dsh.profile.bundles/dependencies，
 * 加 cordis.patch.yml。宿主环境元数据仅向当前 profile 的子进程提供安全白名单覆盖。
 * 所有写操作由 workbench/upgrade 在 withDshMaintenance + 真正退出后调用；本模块不运行 CLI。
 */
import {
  chmodSync, closeSync, cpSync, existsSync, lstatSync, mkdirSync, openSync,
  readFileSync, readSync, readdirSync, renameSync, rmSync, statSync
} from 'node:fs'
import { randomUUID } from 'node:crypto'
import { basename, dirname, join } from 'node:path'
import * as zlib from 'node:zlib'
// @ts-expect-error js-yaml 没有本项目可用的声明；Vite 将现有依赖内联，不依赖 runtime 安装。
import yaml from 'js-yaml'
import { dshDataDirs } from '@main/dsh/dshRuntimeStore'
import {
  assertDshPath, DSH_SETTINGS_FILENAME, getDshSettings,
  validateDshProfileName, writeDshFileAtomic
} from '@main/dsh/dshSettingsStore'
import type {
  DshBackupEntry, DshEnvironmentResetInput, DshEnvironmentResetResult,
  DshProfileConfig, DshProfileInfo, DshProfileTemplate, DshProfileUpdateInput,
  DshSessionEventDump, DshSessionHeader
} from '@shared/types/dsh-workbench'

export const DSH_BUILTIN_PROFILES = ['web', 'headless', 'sdk', 'sdk-minimal', 'acp'] as const
/** 对齐固定 CLI 0.2.0-rc.2 dsh-app-boot 的 PROFILE_TEMPLATES/initProfile。 */
const TEMPLATE_BUNDLES: Record<DshProfileTemplate, readonly string[]> = {
  web: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'],
  headless: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless'],
  sdk: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-sdk-app'],
  'sdk-minimal': ['@deepseek-ai/dsh-sdk-minimal'],
  acp: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-acp-app']
}
const ENVIRONMENT_FILENAME = '.enest-environment.json'
const DEFAULT_PATCH = '# Your patch layer, applied after every bundle layer.\n[]\n'
const PNPM_WORKSPACE = 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n'
const BACKUP_EXCLUDE = new Set(['node_modules', '.pnpm', '.DS_Store'])
const MAX_CONFIG_BYTES = 1024 * 1024
const SESSION_PEEK_BYTES = 512 * 1024
const zstdDecompressSyncFn = (zlib as unknown as { zstdDecompressSync?: (buf: Buffer) => Buffer }).zstdDecompressSync
/** !!js 是原生补丁语法；只解析成字符串进行形状验证，绝不执行表达式。 */
const PATCH_SCHEMA = yaml.JSON_SCHEMA.extend(new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar', construct: (value: string) => value
}))
const ENVIRONMENT_KEYS = new Set([
  'DEEPSEEK_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'DEEPSEEK_BASE_URL',
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
  'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy', 'DSH_TELEMETRY_DISABLED'
])

function profilesDir(): string {
  const { dshHome } = dshDataDirs()
  return assertDshPath(dshHome, join(dshHome, 'profiles'))
}
function profileDir(name: string): string {
  return assertDshPath(profilesDir(), join(profilesDir(), validateDshProfileName(name)))
}
function builtin(name: string): name is DshProfileTemplate {
  return (DSH_BUILTIN_PROFILES as readonly string[]).includes(name)
}
function object(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(message)
  return value as Record<string, unknown>
}
function readText(file: string, fallback?: string): string {
  assertDshPath(dirname(file), file)
  let stat
  try { stat = lstatSync(file) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' && fallback !== undefined) return fallback
    throw error
  }
  if (!stat.isFile() || stat.size > MAX_CONFIG_BYTES) throw new Error('配置必须是 ≤1MiB 的普通文件')
  return readFileSync(file, 'utf8')
}
function validateBundles(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 128 || !value.every(item => typeof item === 'string' &&
    item.length <= 214 && /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(item))) {
    throw new Error('bundles 必须为 npm 包名有序数组（最多128项），不接受路径或启动参数')
  }
  if (new Set(value).size !== value.length) throw new Error('bundles 不允许重复')
  return [...value]
}
function validatePatch(value: unknown): string {
  if (typeof value !== 'string' || Buffer.byteLength(value) > MAX_CONFIG_BYTES || value.includes('\0')) {
    throw new Error('patch 必须是 ≤1MiB 的 YAML 文本')
  }
  let parsed: unknown
  try { parsed = yaml.load(value, { schema: PATCH_SCHEMA }) }
  catch { throw new Error('cordis.patch.yml 语法无效（未执行任何表达式）') }
  if (!Array.isArray(parsed) || parsed.length > 4096 || !parsed.every(entry => entry && typeof entry === 'object' && !Array.isArray(entry))) {
    throw new Error('cordis.patch.yml 必须是 loader patch mapping 组成的顶层 YAML 数组；空补丁写 []')
  }
  return value
}
/** 不接受任意进程键：PATH/NODE_*/
export function validateProfileEnvironment(value: unknown): Record<string, string> {
  const input = object(value, 'environment 必须是字符串对象')
  if (Object.keys(input).length > ENVIRONMENT_KEYS.size) throw new Error('环境变量数量超限')
  const result: Record<string, string> = {}
  for (const [key, val] of Object.entries(input)) {
    if (!ENVIRONMENT_KEYS.has(key)) throw new Error(`不允许的 profile 环境变量: ${key}`)
    if (typeof val !== 'string' || val.length > 16384 || /[\0\r\n]/.test(val)) throw new Error(`环境变量 ${key} 值无效`)
    if (key === 'DSH_TELEMETRY_DISABLED' && val !== '' && val !== '1') {
      throw new Error('DSH_TELEMETRY_DISABLED 仅接受空串或 1（原生任何非空值均表示禁用）')
    }
    if ((key.toUpperCase().endsWith('_PROXY') && key.toUpperCase() !== 'NO_PROXY' || key === 'DEEPSEEK_BASE_URL') && val) {
      let url: URL
      try { url = new URL(val) } catch { throw new Error(`环境变量 ${key} 必须是有效 HTTP(S) URL`) }
      if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.hash ||
        key === 'DEEPSEEK_BASE_URL' && (url.username || url.password || url.search)) {
        throw new Error(`环境变量 ${key} URL 不受支持`)
      }
    }
    result[key] = val
  }
  // 同一 profile 的代理覆盖同时写上下大小写，避免继承的另一种拼写胜出。
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY']) {
    const lower = key.toLowerCase()
    if (Object.hasOwn(result, key) && Object.hasOwn(result, lower) && result[key] !== result[lower]) throw new Error(`代理变量 ${key} 大小写值冲突`)
  }
  return result
}
function environmentAt(root: string): Record<string, string> {
  const text = readText(join(root, ENVIRONMENT_FILENAME), '{}')
  try { return validateProfileEnvironment(JSON.parse(text)) }
  catch { throw new Error('profile 环境元数据无效，请显式编辑修复；未将任何值注入子进程') }
}
export async function readProfileEnvironment(name: string): Promise<Record<string, string>> {
  const environment = environmentAt(profileDir(name))
  const overlay = { ...environment }
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY']) {
    const val = environment[key] ?? environment[key.toLowerCase()]
    if (val !== undefined) { overlay[key] = val; overlay[key.toLowerCase()] = val }
  }
  return overlay
}
function manifestAt(root: string): Record<string, unknown> {
  try { return object(JSON.parse(readText(join(root, 'package.json'))), 'profile manifest 必须为对象') }
  catch { throw new Error('profile package.json 无效，请修复配置或恢复备份') }
}
function manifestBundles(manifest: Record<string, unknown>): string[] {
  const dsh = manifest.dsh === undefined ? {} : object(manifest.dsh, 'manifest dsh 必须为对象')
  const profile = dsh.profile === undefined ? {} : object(dsh.profile, 'manifest dsh.profile 必须为对象')
  return validateBundles(profile.bundles ?? [])
}
function templateManifest(name: string, template: DshProfileTemplate): Record<string, unknown> {
  return { name: `dsh-profile-${name}`, private: true, dependencies: {}, dsh: { profile: { bundles: [...TEMPLATE_BUNDLES[template]] } } }
}
function roles(bundles: string[]): Pick<DshProfileInfo, 'webCompatible' | 'sdkCompatible' | 'template'> {
  const webCompatible = bundles.includes('@deepseek-ai/dsh-web-app')
  const sdkCompatible = bundles.includes('@deepseek-ai/dsh-sdk-app') || bundles.includes('@deepseek-ai/dsh-sdk-minimal')
  const template = DSH_BUILTIN_PROFILES.find(name => TEMPLATE_BUNDLES[name].length === bundles.length &&
    TEMPLATE_BUNDLES[name].every((bundle, index) => bundle === bundles[index]))
  return { webCompatible, sdkCompatible, template }
}
export function readProfile(name: string): DshProfileConfig {
  const root = profileDir(name)
  const exists = existsSync(root)
  if (!exists && !builtin(name)) throw new Error(`profile 不存在: ${name}`)
  const manifest = exists ? manifestAt(root) : templateManifest(name, name as DshProfileTemplate)
  const bundles = manifestBundles(manifest)
  const dependencies = manifest.dependencies === undefined ? {} : object(manifest.dependencies, 'dependencies 必须为对象')
  if (Object.values(dependencies).some(value => typeof value !== 'string')) throw new Error('dependencies 必须为字符串对象')
  const patch = exists ? readText(join(root, 'cordis.patch.yml'), '[]\n') : DEFAULT_PATCH
  return {
    name, builtin: builtin(name), reserved: false, exists, bundles, ...roles(bundles),
    plugins: Object.keys(dependencies).filter(key => key !== 'dsh-bundles' && !key.startsWith('@deepseek-ai/dsh-')),
    patchLines: patch.trim() ? patch.split('\n').length : 0,
    ...(exists ? { createdAt: statSync(root).birthtimeMs || statSync(root).mtimeMs } : {}),
    patch, environment: environmentAt(root), dependencies: { ...dependencies } as Record<string, string>
  }
}
export function listProfiles(): DshProfileInfo[] {
  const dir = profilesDir()
  const names = new Set<string>(DSH_BUILTIN_PROFILES)
  if (existsSync(dir)) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
      try { validateDshProfileName(entry.name, true); names.add(entry.name) } catch { /* 非 profile 子目录 */ }
    }
  }
  return [...names].map(name => {
    try {
      const { patch: _patch, environment: _environment, dependencies: _dependencies, ...info } = readProfile(name)
      return info
    } catch {
      return { name, builtin: builtin(name), reserved: name.toLowerCase() === 'desktop', exists: true,
        bundles: [], patchLines: 0, plugins: [], webCompatible: false, sdkCompatible: false,
        error: '配置不可读或不安全；未读取密钥值' } satisfies DshProfileInfo
    }
  }).sort((a, b) => a.builtin === b.builtin ? a.name.localeCompare(b.name) : a.builtin ? -1 : 1)
}
export async function assertProfileCompatibility(name: string, kind: 'web' | 'sdk'): Promise<void> {
  const info = readProfile(name)
  if (kind === 'web' ? !info.webCompatible : !info.sdkCompatible) throw new Error(`profile ${name} 不包含 ${kind} 应用 bundle，不能用于该启动入口`)
}

/** node_modules/缓存不备份，锁文件保留；禁止跟随配置树内的 symlink。 */
function copyTree(src: string, dest: string): void {
  assertDshPath(src)
  assertDshPath(dest)
  mkdirSync(dest, { recursive: true, mode: 0o700 })
  cpSync(src, dest, {
    recursive: true, dereference: false,
    filter: source => {
      if (source !== src && (BACKUP_EXCLUDE.has(basename(source)) || basename(source).startsWith('.enest-write-'))) return false
      const stat = lstatSync(source)
      if (stat.isSymbolicLink() || !stat.isDirectory() && !stat.isFile()) throw new Error('DSH 配置备份不支持符号链接或特殊文件')
      return true
    }
  })
  secureTree(dest)
}
function secureTree(root: string): void {
  const stat = lstatSync(root)
  if (stat.isSymbolicLink()) throw new Error('DSH 配置不允许符号链接')
  chmodSync(root, stat.isDirectory() ? 0o700 : 0o600)
  if (stat.isDirectory()) for (const entry of readdirSync(root)) secureTree(join(root, entry))
}
function treeSize(root: string): number {
  const stat = lstatSync(root)
  if (stat.isSymbolicLink()) throw new Error('备份包含符号链接')
  if (stat.isFile()) return stat.size
  return readdirSync(root).reduce((total, name) => total + treeSize(join(root, name)), 0)
}
/** staging 与目标同层，先完整准备再替换；rename 失败恢复原目录。 */
function replaceTree(target: string, fill: (staging: string) => void, preserveModules = false): void {
  assertDshPath(dirname(target), target)
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 })
  const stage = join(dirname(target), `.enest-stage-${randomUUID()}`)
  const previous = join(dirname(target), `.enest-previous-${randomUUID()}`)
  let retired = false
  let committed = false
  let preserveRecovery = false
  const modules: string[] = []
  try {
    mkdirSync(stage, { mode: 0o700 })
    fill(stage)
    if (preserveModules && existsSync(target)) {
      for (const name of ['node_modules', '.pnpm']) assertDshPath(target, join(target, name))
    }
    if (existsSync(target)) { renameSync(target, previous); retired = true }
    try {
      // 配置更新不卸载用户已安装依赖，也不遍历 node_modules 中合法的包管理器链接。
      if (retired && preserveModules) for (const name of ['node_modules', '.pnpm']) {
        if (!existsSync(join(previous, name))) continue
        renameSync(join(previous, name), join(stage, name))
        modules.push(name)
      }
      renameSync(stage, target)
      committed = true
    } catch (error) {
      try {
        for (const name of modules.reverse()) renameSync(join(stage, name), join(previous, name))
        if (retired) { renameSync(previous, target); retired = false }
      } catch {
        preserveRecovery = true
        throw new Error(`配置切换失败且自动恢复未完成；原始数据保留在 ${previous} 和 ${stage}，请手动恢复。`)
      }
      throw error
    }
  } finally {
    if (!preserveRecovery) rmSync(stage, { recursive: true, force: true })
    if (retired && committed) rmSync(previous, { recursive: true, force: true })
  }
}
function initializeProfile(root: string, name: string, template: DshProfileTemplate): void {
  writeDshFileAtomic(join(root, 'package.json'), `${JSON.stringify(templateManifest(name, template), null, 2)}\n`)
  writeDshFileAtomic(join(root, 'cordis.patch.yml'), DEFAULT_PATCH)
  writeDshFileAtomic(join(root, 'pnpm-workspace.yaml'), PNPM_WORKSPACE)
}
export async function createProfile(name: string, template: string): Promise<void> {
  validateDshProfileName(name)
  if (DSH_BUILTIN_PROFILES.some(value => value === name.toLowerCase())) throw new Error('新 profile 不可占用内置模板名')
  if (!builtin(template)) throw new Error('未知 profile 模板')
  const target = profileDir(name)
  if (existsSync(target)) throw new Error(`profile 已存在: ${name}`)
  replaceTree(target, stage => initializeProfile(stage, name, template))
}
function keepSelectionsCompatible(name: string, bundles: string[]): void {
  const settings = getDshSettings()
  const info = roles(bundles)
  if (settings.webProfile === name && !info.webCompatible || settings.sdkProfile === name && !info.sdkCompatible) {
    throw new Error('不能移除当前已选启动入口的应用 bundle；请先选择其他兼容 profile')
  }
}
export function validateProfileUpdate(input: DshProfileUpdateInput): DshProfileUpdateInput {
  return { name: validateDshProfileName(input.name), bundles: validateBundles(input.bundles),
    patch: validatePatch(input.patch), environment: validateProfileEnvironment(input.environment) }
}
export function updateProfile(raw: DshProfileUpdateInput): { profile: DshProfileConfig; backupId: string } {
  const input = validateProfileUpdate(raw)
  const old = readProfile(input.name)
  keepSelectionsCompatible(input.name, input.bundles)
  const backupId = createBackup('profile', `before-update-${input.name}`, input.name)
  const target = profileDir(input.name)
  const manifest = old.exists ? manifestAt(target) : templateManifest(input.name, input.name as DshProfileTemplate)
  const dsh = manifest.dsh === undefined ? {} : object(manifest.dsh, 'manifest dsh 无效')
  const profile = dsh.profile === undefined ? {} : object(dsh.profile, 'manifest dsh.profile 无效')
  const next = { ...manifest, dsh: { ...dsh, profile: { ...profile, bundles: input.bundles } } }
  replaceTree(target, stage => {
    if (old.exists) copyTree(target, stage)
    else initializeProfile(stage, input.name, input.name as DshProfileTemplate)
    writeDshFileAtomic(join(stage, 'package.json'), `${JSON.stringify(next, null, 2)}\n`)
    writeDshFileAtomic(join(stage, 'cordis.patch.yml'), input.patch)
    writeDshFileAtomic(join(stage, ENVIRONMENT_FILENAME), `${JSON.stringify(input.environment, null, 2)}\n`)
  }, true)
  return { profile: readProfile(input.name), backupId }
}
export function syncProfiles(source: string, target: string, scope: 'environment' | 'configuration' = 'environment'): { profile: DshProfileConfig; backupId: string } {
  if (source === target) throw new Error('同步源和目标 profile 不能相同')
  if (scope !== 'environment' && scope !== 'configuration') throw new Error('无效同步范围')
  const from = readProfile(source)
  const to = readProfile(target)
  if (scope === 'environment') return updateProfile({ name: target, bundles: to.bundles, patch: to.patch, environment: from.environment })
  if (from.webCompatible !== to.webCompatible || from.sdkCompatible !== to.sdkCompatible) throw new Error('完整配置同步仅支持相同应用角色；跨 Web/SDK 请使用环境同步')
  keepSelectionsCompatible(target, from.bundles)
  validatePatch(from.patch)
  const backupId = createBackup('profile', `before-sync-${target}`, target)
  const targetDir = profileDir(target)
  const targetManifest = to.exists ? manifestAt(targetDir) : templateManifest(target, target as DshProfileTemplate)
  const manifest = from.exists ? manifestAt(profileDir(source)) : templateManifest(source, source as DshProfileTemplate)
  // 名称/版本/发布身份属于目标；配置与依赖来自源。
  for (const key of ['name', 'version', 'private', 'description', 'author', 'license', 'repository', 'publishConfig']) {
    delete manifest[key]
    if (Object.hasOwn(targetManifest, key)) manifest[key] = targetManifest[key]
  }
  replaceTree(targetDir, stage => {
    if (from.exists) copyTree(profileDir(source), stage)
    else initializeProfile(stage, target, source as DshProfileTemplate)
    writeDshFileAtomic(join(stage, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
    writeDshFileAtomic(join(stage, ENVIRONMENT_FILENAME), `${JSON.stringify(from.environment, null, 2)}\n`)
  })
  return { profile: readProfile(target), backupId }
}
export function deleteProfile(name: string, backupFirst = true): string | null {
  const target = profileDir(name)
  const settings = getDshSettings()
  if (settings.webProfile === name || settings.sdkProfile === name) throw new Error('不能删除已选 profile；请先切换启动选择')
  if (!existsSync(target)) throw new Error(`profile 不存在: ${name}`)
  const backupId = backupFirst ? createBackup('profile', undefined, name) : null
  rmSync(target, { recursive: true, force: true })
  return backupId
}

// —— 快照备份/恢复（0600 文件 + 0700 目录）——
function backupsRoot(): string { return assertDshPath(dshDataDirs().backupDir) }
function backupPath(backupId: string): string {
  if (typeof backupId !== 'string' || backupId.length > 120 || !/^(profile|home)-[a-z0-9-]+$/i.test(backupId)) throw new Error('非法 backupId')
  return assertDshPath(backupsRoot(), join(backupsRoot(), backupId))
}
function readBackupMeta(backupId: string): DshBackupEntry | null {
  const root = backupPath(backupId)
  try {
    const raw = object(JSON.parse(readText(join(root, 'meta.json'))), '无效备份元数据')
    if (raw.backupId !== backupId || raw.scope !== 'profile' && raw.scope !== 'home' ||
      !backupId.startsWith(`${raw.scope}-`) || typeof raw.sizeBytes !== 'number' || !Number.isFinite(raw.sizeBytes) || raw.sizeBytes < 0 ||
      typeof raw.createdAt !== 'number' || !Number.isFinite(raw.createdAt)) return null
    if (raw.scope === 'profile') validateDshProfileName(raw.target)
    return { backupId, scope: raw.scope, sizeBytes: raw.sizeBytes, createdAt: raw.createdAt,
      ...(typeof raw.name === 'string' ? { name: raw.name.slice(0, 120) } : {}),
      ...(raw.scope === 'profile' ? { target: raw.target as string } : {}) }
  } catch { return null }
}
export function listBackups(): DshBackupEntry[] {
  const root = backupsRoot()
  if (!existsSync(root)) return []
  return readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    if (!entry.isDirectory() || !/^(profile|home)-[a-z0-9-]+$/i.test(entry.name)) return []
    const meta = readBackupMeta(entry.name)
    return meta ? [meta] : []
  }).sort((a, b) => b.createdAt - a.createdAt)
}
export function createBackup(scope: 'profile' | 'home', label?: string, targetProfile?: string): string {
  if (scope !== 'profile' && scope !== 'home') throw new Error('无效备份范围')
  if (label !== undefined && (typeof label !== 'string' || label.length > 120 || /[\0\r\n]/.test(label))) throw new Error('无效备份名称')
  const profileName = scope === 'profile' ? validateDshProfileName(targetProfile) : undefined
  if (profileName && !existsSync(profileDir(profileName)) && !builtin(profileName)) throw new Error(`profile 不存在: ${profileName}`)
  const backupId = `${scope}-${Date.now().toString(36)}-${randomUUID()}`
  const dest = backupPath(backupId)
  const stage = assertDshPath(backupsRoot(), join(backupsRoot(), `.enest-backup-${randomUUID()}`))
  mkdirSync(stage, { recursive: true, mode: 0o700 })
  try {
    const { dshHome } = dshDataDirs()
    const payload = join(stage, scope)
    if (profileName) {
      const dst = join(payload, profileName)
      // 备份必须能保护损坏配置，不能先要求旧 package/env 可解析。
      if (existsSync(profileDir(profileName))) copyTree(profileDir(profileName), dst)
      else initializeProfile(dst, profileName, profileName as DshProfileTemplate)
    } else if (existsSync(assertDshPath(dshHome))) copyTree(dshHome, payload)
    else mkdirSync(payload, { mode: 0o700 })
    const entry: DshBackupEntry = { backupId, scope, name: label,
      ...(profileName ? { target: profileName } : {}), sizeBytes: treeSize(payload), createdAt: Date.now() }
    writeDshFileAtomic(join(stage, 'meta.json'), `${JSON.stringify(entry, null, 2)}\n`)
    renameSync(stage, dest)
    return backupId
  } finally { rmSync(stage, { recursive: true, force: true }) }
}
export function restoreBackup(backupId: string, expectedScope?: 'profile' | 'home'): void {
  const meta = readBackupMeta(backupId)
  if (!meta || expectedScope && meta.scope !== expectedScope) throw new Error('备份不存在或范围不匹配')
  const root = backupPath(backupId)
  if (meta.scope === 'profile') {
    const name = validateDshProfileName(meta.target)
    const source = assertDshPath(root, join(root, 'profile', name))
    if (!existsSync(source)) throw new Error('profile 备份内容缺失')
    const manifest = manifestAt(source)
    keepSelectionsCompatible(name, manifestBundles(manifest))
    validatePatch(readText(join(source, 'cordis.patch.yml'), '[]\n'))
    environmentAt(source)
    // 安全快照未成功就不会覆盖；恢复失败由 staging 的原目录回滚。
    if (existsSync(profileDir(name))) createBackup('profile', `before-restore-${name}`, name)
    replaceTree(profileDir(name), stage => copyTree(source, stage))
  } else {
    const source = assertDshPath(root, join(root, 'home'))
    if (!existsSync(source)) throw new Error('home 备份内容缺失')
    const { dshHome } = dshDataDirs()
    createBackup('home', 'before-restore')
    // 整个 home 替换；快照之后新增的 .env/patch/凭据不能残留。runtime/backups 位于 home 外。
    replaceTree(assertDshPath(dshHome), stage => copyTree(source, stage))
  }
}
export function deleteBackup(backupId: string): void {
  const dir = backupPath(backupId)
  if (!readBackupMeta(backupId)) throw new Error('备份不存在或无效')
  rmSync(dir, { recursive: true, force: true })
}
export function validateEnvironmentReset(input: DshEnvironmentResetInput): DshEnvironmentResetInput {
  if (!input || typeof input !== 'object') throw new Error('无效重置请求')
  const scope = input.scope ?? 'config'
  if (scope !== 'config' && scope !== 'home' || input.backup !== true || input.confirmation !== (scope === 'home' ? 'RESET HOME' : 'RESET CONFIG')) {
    throw new Error('重置必须启用自动备份，并输入与范围匹配的 RESET CONFIG 或 RESET HOME')
  }
  return { scope, backup: true, confirmation: input.confirmation }
}
export function resetEnvironment(raw: DshEnvironmentResetInput): DshEnvironmentResetResult {
  const { scope } = validateEnvironmentReset(raw)
  const { dshHome } = dshDataDirs()
  assertDshPath(dshHome)
  const backupId = createBackup('home', `before-reset-${scope}`)
  // config 只摘除已知配置；storages/sessions/身份和日志原地保留，不经删后再复制。
  const names = scope === 'home'
    ? existsSync(dshHome) ? readdirSync(dshHome) : []
    : ['profiles', 'cordis.patch.yml', '.credentials.yaml', '.env', DSH_SETTINGS_FILENAME]
  const trash = assertDshPath(backupsRoot(), join(backupsRoot(), `.enest-reset-${randomUUID()}`))
  mkdirSync(trash, { mode: 0o700 })
  const moved: string[] = []
  let keepRecovery = false
  try {
    for (const name of names) {
      const target = assertDshPath(dshHome, join(dshHome, name))
      if (!existsSync(target)) continue
      renameSync(target, join(trash, name))
      moved.push(name)
    }
  } catch (error) {
    const failed: string[] = []
    for (const name of moved.reverse()) {
      try { renameSync(join(trash, name), join(dshHome, name)) }
      catch { failed.push(name) }
    }
    if (failed.length) {
      keepRecovery = true
      throw new Error(`重置失败且部分配置恢复未完成；数据保留在 ${trash}，完整备份 ${backupId}；请手动恢复。`)
    }
    throw error
  } finally { if (!keepRecovery) rmSync(trash, { recursive: true, force: true }) }
  return { ok: true, backupId, scope, preservedSessions: scope === 'config', application: 'stopped',
    message: scope === 'config' ? '隔离配置已清空并备份，会话和存储保留；下次启动使用默认选择。' : '隔离 DSH_HOME 已清空并备份；运行时版本和备份未删除。' }
}

// —— 会话持久化扫描 ——

interface SessionFile {
  sessionId: string
  dir: string
  file: string
  generation: number
  mtimeMs: number
  size: number
}

function findSessionFiles(root: string, depth: number, out: SessionFile[]): void {
  if (depth > 5) return
  let entries
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return
  }
  const byDir = new Map<string, SessionFile>()
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue
    const full = join(root, entry.name)
    if (entry.isDirectory()) {
      // 会话目录：目录名即 sessionId 候选（包含 session*.jsonl）
      findSessionFiles(full, depth + 1, out)
    } else {
      const match = /^session(?:\.v(\d+))?\.jsonl(\.zstd)?$/.exec(entry.name)
      if (!match) continue
      const sessionId = basename(root)
      const generation = match[1] ? Number(match[1]) : 0
      let stat
      try {
        stat = statSync(full)
      } catch {
        continue
      }
      const existing = byDir.get(root)
      const candidate: SessionFile = {
        sessionId,
        dir: root,
        file: full,
        generation,
        mtimeMs: stat.mtimeMs,
        size: stat.size
      }
      if (!existing || generation > existing.generation) byDir.set(root, candidate)
    }
  }
  for (const value of byDir.values()) out.push(value)
}

function readSessionText(file: string, tailBytes: number): string | null {
  try {
    if (file.endsWith('.zstd')) {
      if (!zstdDecompressSyncFn) return null
      const buf = zstdDecompressSyncFn(readFileSync(file))
      const text = buf.toString('utf8')
      return text.length > tailBytes ? text.slice(-tailBytes) : text
    }
    const stat = statSync(file)
    const fd = openSync(file, 'r')
    try {
      const start = Math.max(0, stat.size - tailBytes)
      const length = stat.size - start
      const buf = Buffer.alloc(length)
      readSync(fd, buf, 0, length, start)
      return buf.toString('utf8')
    } finally {
      closeSync(fd)
    }
  } catch {
    return null
  }
}

/** 从事件文本提取标题（首个 user 消息文本）与最近活动摘要 */
function summarizeSession(text: string | null): { title?: string; lastActivity?: string } {
  if (!text) return {}
  let title: string | undefined
  let lastActivity: string | undefined
  try {
    const lines = text.split('\n').filter(Boolean)
    for (const line of lines) {
      let event: { type?: string; message?: { content?: Array<{ type?: string; text?: string }> } }
      try {
        event = JSON.parse(line)
      } catch {
        continue
      }
      const blocks = event.message?.content
      if (event.type === 'user/message' && Array.isArray(blocks)) {
        const firstText = blocks.find(b => b?.type === 'text' && typeof b.text === 'string')
        if (!title && firstText) title = firstText.text!.slice(0, 80)
      }
      if (typeof event.type === 'string') lastActivity = event.type
    }
  } catch {
    /* 解析尽力而为 */
  }
  return { title, lastActivity }
}

export function listSessions(limit = 50): DshSessionHeader[] {
  const { dshHome } = dshDataDirs()
  assertDshPath(dshHome)
  const files: SessionFile[] = []
  findSessionFiles(dshHome, 0, files)
  files.sort((a, b) => b.mtimeMs - a.mtimeMs)
  const seen = new Set<string>()
  const result: DshSessionHeader[] = []
  for (const file of files) {
    if (seen.has(file.sessionId)) continue
    seen.add(file.sessionId)
    const summary = summarizeSession(readSessionText(file.file, SESSION_PEEK_BYTES))
    result.push({
      sessionId: file.sessionId,
      title: summary.title,
      workspace: undefined,
      updatedAt: file.mtimeMs,
      lastActivity: summary.lastActivity
    })
    if (result.length >= Math.max(1, Math.min(200, limit))) break
  }
  return result
}

export function readSessionEvents(sessionId: string, maxEvents = 200): DshSessionEventDump {
  // sessionId 即目录名；拒绝穿越
  if (typeof sessionId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(sessionId)) throw new Error('非法 sessionId')
  const { dshHome } = dshDataDirs()
  assertDshPath(dshHome)
  const files: SessionFile[] = []
  findSessionFiles(dshHome, 0, files)
  const target = files.find(f => f.sessionId === sessionId)
  if (!target) throw new Error(`会话不存在: ${sessionId}`)
  const text = readSessionText(target.file, 4 * 1024 * 1024)
  const events: Array<Record<string, unknown>> = []
  if (text) {
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      try {
        events.push(JSON.parse(line) as Record<string, unknown>)
      } catch {
        /* 跳过残行 */
      }
    }
  }
  return { sessionId, events: events.slice(-Math.max(10, Math.min(1000, maxEvents))) }
}

/** 当前 relative 布局探测（诊断用）：DSH_HOME 相对路径树（≤2 层） */
export function diagnoseHome(): string[] {
  const { dshHome } = dshDataDirs()
  assertDshPath(dshHome)
  const lines: string[] = [dshHome]
  const walk = (dir: string, depth: number): void => {
    if (depth > 2) return
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries.slice(0, 40)) {
      lines.push(`${'  '.repeat(depth + 1)}${entry.name}${entry.isDirectory() ? '/' : ''}`)
      if (entry.isDirectory() && depth < 1) walk(join(dir, entry.name), depth + 1)
    }
  }
  walk(dshHome, 0)
  return lines
}
