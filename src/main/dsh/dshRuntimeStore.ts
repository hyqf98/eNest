/** DSH runtime discovery and explicit, source-aware local selection. */
import {
  accessSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync,
  readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync
} from 'node:fs'
import { constants } from 'node:fs'
import { delimiter, isAbsolute, join, relative, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { getAppPaths } from '@main/paths/pathsService'
import { pluginRegistry } from '@main/plugin/PluginRegistry'
import type { DshRuntimeInfo, DshRuntimeVersion } from '@shared/types/dsh-workbench'

export const DSH_PLUGIN_ID = 'com.github.eNest.dsh'
export interface DshRuntimeSelection {
  version: string
  source: 'data' | 'bundled' | 'system'
}
export interface DshDataDirs {
  dshHome: string
  runtimeDir: string
  backupDir: string
}
export interface ResolvedRuntime {
  source: 'data' | 'bundled' | 'system' | 'none'
  root: string | null
  bin: string | null
  version: string | null
  engine: 'electron-runas' | 'node'
}

export function dshDataDirs(): DshDataDirs {
  const data = getAppPaths().data
  return {
    dshHome: join(data, 'dsh-home'),
    runtimeDir: join(data, 'dsh-runtime'),
    backupDir: join(data, 'backups', 'dsh')
  }
}
function assertDirectory(path: string): void {
  if (!existsSync(path)) {
    // lstat also detects dangling symlinks, which existsSync intentionally does not.
    try { lstatSync(path); throw new Error(`DSH directory is not safe: ${path}`) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    return
  }
  const entry = lstatSync(path)
  if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error(`DSH directory is not safe: ${path}`)
}
export function ensureDshDirs(): DshDataDirs {
  const dirs = dshDataDirs()
  for (const path of [dirs.dshHome, dirs.runtimeDir, dirs.backupDir]) {
    assertDirectory(path)
    mkdirSync(path, { recursive: true })
  }
  return dirs
}

/** All public version inputs pass here before any path lookup or mutation. */
export function safeRuntimeVersion(version: string): string {
  if (typeof version !== 'string' || version.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(version)) {
    throw new Error(`非法版本号: ${String(version)}`)
  }
  return version
}
function contained(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`))
}
/** Reject symlinks, files, traversal and dangling links at managed version roots. */
export function dataRuntimeRoot(version: string): string {
  safeRuntimeVersion(version)
  const root = resolve(dshDataDirs().runtimeDir)
  assertDirectory(root)
  const target = resolve(root, version)
  if (!contained(root, target) || target === root) throw new Error('非法 runtime 路径')
  assertDirectory(target)
  return target
}
function regularRuntimeFile(root: string, parts: string[]): string | null {
  try {
    const canonicalRoot = realpathSync(root)
    const file = join(root, ...parts)
    // A package manager may use internal links; links escaping the runtime are never valid.
    if (!statSync(file).isFile() || !contained(canonicalRoot, realpathSync(file))) return null
    return file
  } catch { return null }
}
export function runtimeVersionAt(root: string): string | null {
  try {
    const file = regularRuntimeFile(root, ['node_modules', '@deepseek-ai', 'dsh', 'package.json'])
    if (!file) return null
    const pkg = JSON.parse(readFileSync(file, 'utf8')) as { name?: unknown; version?: unknown }
    if (pkg.name !== undefined && pkg.name !== '@deepseek-ai/dsh') return null
    return typeof pkg.version === 'string' ? safeRuntimeVersion(pkg.version) : null
  } catch { return null }
}
export function runtimeBinAt(root: string): string | null {
  return regularRuntimeFile(root, ['node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'])
}
function isRuntimeRoot(root: string): boolean {
  try { assertDirectory(root); return runtimeBinAt(root) !== null && runtimeVersionAt(root) !== null }
  catch { return false }
}

/** Validate package identity/version and the published runtime manifest before promotion. */
export function validateRuntimeRoot(root: string, version: string, requireManifest = false): void {
  safeRuntimeVersion(version)
  if (!isRuntimeRoot(root) || runtimeVersionAt(root) !== version) throw new Error(`runtime 布局或版本不匹配: ${version}`)
  const manifestFile = regularRuntimeFile(root, ['package.json'])
  if (!manifestFile) {
    if (requireManifest) throw new Error('runtime 缺少 package.json 清单')
    return
  }
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8')) as {
    name?: unknown; dependencies?: Record<string, unknown>; platform?: unknown; arch?: unknown
    os?: unknown; cpu?: unknown
  }
  if (manifest.name !== 'enest-dsh-runtime' || typeof manifest.dependencies?.['@deepseek-ai/dsh'] !== 'string') {
    throw new Error('runtime 清单身份不符合 enest-dsh-runtime 约定')
  }
  const accepts = (values: unknown, current: string): boolean => {
    if (values === undefined) return true
    if (!Array.isArray(values) || !values.every(value => typeof value === 'string')) return false
    const strings = values as string[]
    return !strings.includes(`!${current}`) && (!strings.some(value => !value.startsWith('!')) || strings.includes(current))
  }
  if (manifest.platform !== undefined && manifest.platform !== process.platform && manifest.platform !== `${process.platform}-${process.arch}`
    || manifest.arch !== undefined && manifest.arch !== process.arch
    || !accepts(manifest.os, process.platform) || !accepts(manifest.cpu, process.arch)) {
    throw new Error('runtime 清单平台与当前主机不匹配')
  }
}

/** Source previews only read dist/runtime; installed releases only read runtime. */
export function bundledRuntimeRoot(): string | null {
  const pluginRoot = pluginRegistry.getRootPath(DSH_PLUGIN_ID)
  if (!pluginRoot) return null
  const root = pluginRegistry.get(DSH_PLUGIN_ID)?.devSource === true
    ? join(pluginRoot, 'dist', 'runtime') : join(pluginRoot, 'runtime')
  try {
    const version = runtimeVersionAt(root)
    if (!version) return null
    validateRuntimeRoot(root, version)
    return root
  } catch { return null }
}
export function systemDshBin(): string | null {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue
    const candidate = join(dir, process.platform === 'win32' ? 'dsh.cmd' : 'dsh')
    try { if (statSync(candidate).isFile()) { accessSync(candidate, constants.X_OK); return candidate } }
    catch { /* continue */ }
  }
  return null
}
function activeMarkerPath(): string { return join(dshDataDirs().runtimeDir, 'active.json') }
export function getActiveMarker(): DshRuntimeSelection | null {
  try {
    assertDirectory(dshDataDirs().runtimeDir)
    const path = activeMarkerPath()
    if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) return null
    const raw = JSON.parse(readFileSync(path, 'utf8')) as { version?: unknown; source?: unknown }
    if (typeof raw.version !== 'string') return null
    safeRuntimeVersion(raw.version)
    const source = raw.source ?? 'data' // migrate legacy version-only markers on the next write
    return source === 'data' || source === 'bundled' || source === 'system' ? { version: raw.version, source } : null
  } catch { return null }
}
function writeMarker(selection: DshRuntimeSelection | null): void {
  const { runtimeDir } = ensureDshDirs()
  const target = activeMarkerPath()
  try {
    const entry = lstatSync(target)
    if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('active.json 不是普通文件')
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  const temporary = join(runtimeDir, `.active-${randomUUID()}.tmp`)
  let fd: number | undefined
  try {
    fd = openSync(temporary, 'wx', 0o600)
    writeFileSync(fd, JSON.stringify({ ...selection, version: selection?.version ?? null, switchedAt: Date.now() }, null, 2))
    fsyncSync(fd)
    closeSync(fd); fd = undefined
    renameSync(temporary, target)
  } finally {
    if (fd !== undefined) closeSync(fd)
    rmSync(temporary, { force: true })
  }
}
/** Low-level commit; lifecycle callers must hold withDshMaintenance and quiesce first. */
export function setActiveMarker(input: string | DshRuntimeSelection): void {
  const selection: DshRuntimeSelection = typeof input === 'string' ? { version: input, source: 'data' } : input
  resolveRuntimeSelection(selection) // never persist an uninstalled/mismatched selection
  writeMarker(selection)
}
export function clearActiveMarker(): void { writeMarker(null) }
export function runtimeIdentity(selection: Pick<DshRuntimeSelection, 'source' | 'version'>): string {
  return `${selection.source}:${selection.version}`
}
export function resolveRuntimeSelection(selection: DshRuntimeSelection): ResolvedRuntime {
  safeRuntimeVersion(selection.version)
  if (selection.source === 'data') {
    const root = dataRuntimeRoot(selection.version)
    validateRuntimeRoot(root, selection.version)
    return { source: 'data', root, bin: runtimeBinAt(root), version: selection.version, engine: 'electron-runas' }
  }
  if (selection.source === 'bundled') {
    const root = bundledRuntimeRoot()
    if (!root || runtimeVersionAt(root) !== selection.version) throw new Error(`捆绑 runtime 版本不存在: ${selection.version}`)
    return { source: 'bundled', root, bin: runtimeBinAt(root), version: selection.version, engine: 'electron-runas' }
  }
  if (selection.source === 'system') {
    const bin = systemDshBin()
    if (!bin) throw new Error('系统 PATH 中未找到 dsh')
    return { source: 'system', root: null, bin, version: selection.version === 'system' ? null : selection.version, engine: 'node' }
  }
  throw new Error('非法 runtime 来源')
}
export function resolveRuntime(): ResolvedRuntime {
  const active = getActiveMarker()
  if (active) {
    try { return resolveRuntimeSelection(active) } catch { /* missing/corrupt selection: safe fallback */ }
  }
  const root = bundledRuntimeRoot()
  if (root) return { source: 'bundled', root, bin: runtimeBinAt(root), version: runtimeVersionAt(root), engine: 'electron-runas' }
  const bin = systemDshBin()
  return bin ? { source: 'system', root: null, bin, version: null, engine: 'node' }
    : { source: 'none', root: null, bin: null, version: null, engine: 'electron-runas' }
}
export function listInstalledRuntimes(): DshRuntimeVersion[] {
  const result: DshRuntimeVersion[] = []
  const { runtimeDir } = dshDataDirs()
  try {
    assertDirectory(runtimeDir)
    for (const entry of readdirSync(runtimeDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name.startsWith('.')) continue
      try {
        const root = dataRuntimeRoot(entry.name)
        if (runtimeVersionAt(root) !== entry.name || !isRuntimeRoot(root)) continue
        result.push({ version: entry.name, channel: 'data', path: root, installedAt: statSync(root).mtimeMs, active: false })
      } catch { /* ignore invalid/incomplete installs */ }
    }
  } catch { /* not installed */ }
  const bundled = bundledRuntimeRoot()
  const bundledVersion = bundled && runtimeVersionAt(bundled)
  if (bundled && bundledVersion) result.push({ version: bundledVersion, channel: 'bundled', path: bundled, active: false })
  const system = systemDshBin()
  if (system) {
    const marker = getActiveMarker()
    result.push({ version: marker?.source === 'system' ? marker.version : 'system', channel: 'system', path: system, active: false })
  }
  const active = resolveRuntime()
  for (const entry of result) entry.active = entry.channel === active.source
    && (entry.channel === 'system' || entry.version === active.version)
  return result.sort((a, b) => b.version.localeCompare(a.version) || a.channel.localeCompare(b.channel))
}
export function resolvedRuntimeInfo(error?: string): DshRuntimeInfo {
  const resolved = resolveRuntime()
  return {
    available: resolved.bin !== null, source: resolved.source, version: resolved.version ?? undefined,
    root: resolved.root ?? resolved.bin ?? undefined, engine: resolved.engine, dshHome: dshDataDirs().dshHome, error
  }
}
