/**
 * dshRuntimeStore — DSH runtime 三级解析与热更新版本管理。
 * 解析顺序：① {dataRoot}/dsh-runtime/<version>/（热更新安装，active.json 标记优先）
 * ② 发布根 runtime/（.enestplugin 捆绑基线；源码开发固定为 dist/runtime/）
 * ③ 系统 PATH dsh（高级用户自装，兜底）。
 * runtime 根统一布局：<root>/node_modules/@deepseek-ai/dsh/{package.json, lib/bin.js}。
 * 关键依赖：pathsService、PluginRegistry、node:fs。
 */
import { accessSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { constants } from 'node:fs'
import { getAppPaths } from '@main/paths/pathsService'
import { pluginRegistry } from '@main/plugin/PluginRegistry'
import type { DshRuntimeInfo, DshRuntimeVersion } from '@shared/types/dsh-workbench'

/** DSH 驾驶舱插件 id（捆绑 runtime 从该插件安装目录发现） */
export const DSH_PLUGIN_ID = 'com.github.eNest.dsh'

export interface DshDataDirs {
  /** 插件专属 Harness home（DSH_HOME），与用户系统 dsh 数据隔离 */
  dshHome: string
  /** 热更新 runtime 安装目录（每版本一个子目录） */
  runtimeDir: string
  /** 备份目录（profile / home 快照） */
  backupDir: string
}

export function dshDataDirs(): DshDataDirs {
  const data = getAppPaths().data
  return {
    dshHome: join(data, 'dsh-home'),
    runtimeDir: join(data, 'dsh-runtime'),
    backupDir: join(data, 'backups', 'dsh')
  }
}

export function ensureDshDirs(): DshDataDirs {
  const dirs = dshDataDirs()
  mkdirSync(dirs.dshHome, { recursive: true })
  mkdirSync(dirs.runtimeDir, { recursive: true })
  mkdirSync(dirs.backupDir, { recursive: true })
  return dirs
}

/** runtime 根内 dsh 版本号；非法布局返回 null */
export function runtimeVersionAt(root: string): string | null {
  try {
    const pkg = JSON.parse(readFileSync(join(root, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), 'utf8')) as {
      version?: unknown
    }
    return typeof pkg.version === 'string' && pkg.version ? pkg.version : null
  } catch {
    return null
  }
}

/** runtime 根内 dsh bin 入口（lib/bin.js）；不存在返回 null */
export function runtimeBinAt(root: string): string | null {
  const bin = join(root, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  return existsSync(bin) ? bin : null
}

/** 有效 runtime 根判定（bin + 版本齐全） */
function isRuntimeRoot(root: string): boolean {
  return runtimeBinAt(root) !== null && runtimeVersionAt(root) !== null
}

/** 固定发布布局；源码预览只读取 dist/runtime，不探测旧源码根 runtime。 */
export function bundledRuntimeRoot(): string | null {
  const pluginRoot = pluginRegistry.getRootPath(DSH_PLUGIN_ID)
  if (!pluginRoot) return null
  const sourcePreview = pluginRegistry.get(DSH_PLUGIN_ID)?.devSource === true
  const root = sourcePreview ? join(pluginRoot, 'dist', 'runtime') : join(pluginRoot, 'runtime')
  return isRuntimeRoot(root) ? root : null
}

/** 系统 PATH 上的 dsh 可执行文件；找不到返回 null */
export function systemDshBin(): string | null {
  const pathEnv = process.env.PATH ?? ''
  for (const dir of pathEnv.split(':')) {
    if (!dir) continue
    const candidate = join(dir, 'dsh')
    try {
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch {
      /* continue */
    }
  }
  return null
}

/** 当前激活标记（热更新目录 active.json） */
function activeMarkerPath(): string {
  return join(dshDataDirs().runtimeDir, 'active.json')
}

export function getActiveMarker(): string | null {
  try {
    const raw = JSON.parse(readFileSync(activeMarkerPath(), 'utf8')) as { version?: unknown }
    return typeof raw.version === 'string' && raw.version ? raw.version : null
  } catch {
    return null
  }
}

export function setActiveMarker(version: string): void {
  const { runtimeDir } = ensureDshDirs()
  writeFileSync(activeMarkerPath(), JSON.stringify({ version, switchedAt: Date.now() }, null, 2))
}

export function clearActiveMarker(): void {
  try {
    writeFileSync(activeMarkerPath(), JSON.stringify({ version: null, switchedAt: Date.now() }))
  } catch {
    /* ignore */
  }
}

/** 枚举本地已安装 runtime（热更新目录 + 插件捆绑；同版本 data 优先） */
export function listInstalledRuntimes(): DshRuntimeVersion[] {
  const result = new Map<string, DshRuntimeVersion>()
  const { runtimeDir } = dshDataDirs()
  try {
    for (const name of readdirSync(runtimeDir)) {
      const root = join(runtimeDir, name)
      if (!isRuntimeRoot(root)) continue
      const version = runtimeVersionAt(root)
      if (!version) continue
      result.set(version, { version, channel: 'data', path: root, installedAt: undefined, active: false })
    }
  } catch {
    /* 目录不存在 */
  }
  const bundled = bundledRuntimeRoot()
  if (bundled) {
    const version = runtimeVersionAt(bundled)
    if (version && !result.has(version)) {
      result.set(version, { version, channel: 'bundled', path: bundled, active: false })
    }
  }
  const active = getActiveMarker()
  const entry = active ? result.get(active) : undefined
  if (entry) entry.active = true
  return [...result.values()].sort((a, b) => b.version.localeCompare(a.version))
}

export interface ResolvedRuntime {
  source: 'data' | 'bundled' | 'system' | 'none'
  /** runtime 根（data/bundled）；system 时为 null */
  root: string | null
  /** dsh bin：data/bundled 为 lib/bin.js（RunAsNode 用）；system 为可执行文件路径 */
  bin: string | null
  version: string | null
  /** system 时直接执行可执行文件；否则经 ELECTRON_RUN_AS_NODE 跑 bin.js */
  engine: 'electron-runas' | 'node'
}

/**
 * 解析当前应使用的 runtime：active 标记且存在 > 捆绑 > 系统 PATH。
 */
export function resolveRuntime(): ResolvedRuntime {
  const active = getActiveMarker()
  if (active) {
    const root = join(dshDataDirs().runtimeDir, active)
    const bin = runtimeBinAt(root)
    if (bin) {
      return { source: 'data', root, bin, version: runtimeVersionAt(root), engine: 'electron-runas' }
    }
  }
  const bundled = bundledRuntimeRoot()
  if (bundled) {
    const bin = runtimeBinAt(bundled)
    if (bin) {
      return { source: 'bundled', root: bundled, bin, version: runtimeVersionAt(bundled), engine: 'electron-runas' }
    }
  }
  const sys = systemDshBin()
  if (sys) {
    return { source: 'system', root: null, bin: sys, version: null, engine: 'node' }
  }
  return { source: 'none', root: null, bin: null, version: null, engine: 'electron-runas' }
}

/** DshRuntimeInfo 视图（detect action 返回） */
export function resolvedRuntimeInfo(error?: string): DshRuntimeInfo {
  const resolved = resolveRuntime()
  return {
    available: resolved.bin !== null,
    source: resolved.source,
    version: resolved.version ?? undefined,
    root: resolved.root ?? resolved.bin ?? undefined,
    engine: resolved.engine,
    dshHome: dshDataDirs().dshHome,
    error
  }
}
