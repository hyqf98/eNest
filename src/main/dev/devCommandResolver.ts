/**
 * devCommandResolver — 插件本地开发命令解析。
 * 唯一来源是插件源码根的 package.json：`enest` 段显式声明、scripts 按约定回退、
 * 包管理器由锁文件检测（向上兼容 workspace 根持锁）。壳子不预设工具链：
 * 解析不到启动命令（纯静态 HTML 插件）就不拉服务，由调用方走源码静态预览。
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { normalizePluginDevUrl } from '@shared/pluginContract'
import type {
  DevCommandPlan, DevCommandSpec, DevPackageManager, DevPluginKind,
  EnestCommandConfig, EnestDevCommandConfig, EnestPackageConfig, PluginManifest
} from '@shared/types/plugin'

const MANAGERS: readonly DevPackageManager[] = ['npm', 'yarn', 'pnpm', 'bun']
/** script 型缺省回退顺序：dev 服务与构建各自约定 */
const DEV_SCRIPT_FALLBACKS = ['dev', 'start'] as const
const BUILD_SCRIPT_FALLBACKS = ['build', 'pack'] as const
/** workspace 根持锁时向上查找锁文件的层级 */
const LOCKFILE_UP_LEVELS = 4
const LOCKFILE_MANAGERS: ReadonlyArray<readonly [string, DevPackageManager]> = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['bun.lockb', 'bun'],
  ['bun.lock', 'bun'],
  ['package-lock.json', 'npm'],
  ['npm-shrinkwrap.json', 'npm'],
]

interface PackageJsonLike {
  scripts?: Record<string, unknown>
  dependencies?: Record<string, unknown>
  devDependencies?: Record<string, unknown>
  enest?: unknown
}

/** 无 package.json（纯静态插件）或内容损坏一律视为未声明，不抛错。 */
function readPackageJson(sourcePath: string): PackageJsonLike | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(sourcePath, 'package.json'), 'utf8'))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
    return parsed as PackageJsonLike
  } catch {
    return null
  }
}

function readEnv(value: unknown): Record<string, string> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const env: Record<string, string> = {}
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw === 'string') env[key] = raw
  }
  return Object.keys(env).length ? env : undefined
}

function readPortArgs(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const args = value.filter((arg): arg is string => typeof arg === 'string' && arg.length > 0)
  return args.length ? args : undefined
}

/** 形状不对的字段静默忽略，绝不让畸形 enest 段阻断加载。 */
function readCommandSection(value: unknown): EnestCommandConfig {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  const section = value as Record<string, unknown>
  const result: EnestCommandConfig = {}
  if (typeof section.command === 'string' && section.command.trim()) result.command = section.command.trim()
  const manager = MANAGERS.find(candidate => candidate === section.manager)
  if (manager) result.manager = manager
  if (typeof section.script === 'string' && section.script.trim()) result.script = section.script.trim()
  const portArgs = readPortArgs(section.portArgs)
  if (portArgs) result.portArgs = portArgs
  const env = readEnv(section.env)
  if (env) result.env = env
  return result
}

function readDevSection(value: unknown): EnestDevCommandConfig {
  const base = readCommandSection(value)
  if (typeof value === 'object' && value !== null && !Array.isArray(value) && typeof (value as Record<string, unknown>).url === 'string') {
    return { ...base, url: (value as { url: string }).url }
  }
  return base
}

function readEnestConfig(pkg: PackageJsonLike): EnestPackageConfig {
  if (typeof pkg.enest !== 'object' || pkg.enest === null || Array.isArray(pkg.enest)) return {}
  const raw = pkg.enest as Record<string, unknown>
  const config: EnestPackageConfig = {}
  if (raw.dev !== undefined) config.dev = readDevSection(raw.dev)
  if (raw.build !== undefined) config.build = readCommandSection(raw.build)
  if (typeof raw.output === 'string' && raw.output.trim()) config.output = raw.output.trim()
  return config
}

/** 锁文件检测包管理器；找不到（含向上 4 级）按 npm 兜底。 */
export function detectPackageManager(sourcePath: string): DevPackageManager {
  let current = sourcePath
  for (let level = 0; level <= LOCKFILE_UP_LEVELS; level++) {
    for (const [lockfile, manager] of LOCKFILE_MANAGERS) {
      if (existsSync(join(current, lockfile))) return manager
    }
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return 'npm'
}

function hasScript(pkg: PackageJsonLike | null, name: string): boolean {
  return typeof pkg?.scripts?.[name] === 'string'
}

/** 依赖表里的开发框架指纹：命中即对应工具链；顺序即优先级。 */
const FRAMEWORK_DEPS: ReadonlyArray<readonly [DevPluginKind, readonly string[]]> = [
  ['vite', ['vite', '@vitejs/plugin-vue', '@vitejs/plugin-react', 'vitest']],
  ['next', ['next']],
  ['nuxt', ['nuxt', 'nuxt3']],
  ['webpack', ['webpack', 'webpack-cli', 'vue-cli-service', '@angular/cli', 'react-scripts', 'craco']],
]

/**
 * 自动识别开发框架：先读 dependencies/devDependencies 的框架指纹，再看启动命令字符串
 * 里的可执行名（vite/next/nuxt/webpack 及 vue-cli/umi 等经管理脚本调用的工具链）。
 * 有启动/构建命令但不认识时归 'custom'（自定义命令）。本函数不判断是否静态——调用方
 * 在没有可用服务（无 devUrl / 走源码静态预览）时自行落 'static'。
 */
export function detectDevFramework(pkg: PackageJsonLike | null, start?: DevCommandSpec, build?: DevCommandSpec): DevPluginKind {
  const deps = { ...pkg?.dependencies, ...pkg?.devDependencies }
  for (const [kind, names] of FRAMEWORK_DEPS) {
    if (names.some(name => name in deps)) return kind
  }
  const commands = [start, build].flatMap(spec => spec ? [spec.command, spec.kind === 'raw' ? spec.command : ''] : [])
  const text = commands.join(' ').toLowerCase()
  if (/\b(vite)\b/.test(text)) return 'vite'
  if (/\bnext\b/.test(text)) return 'next'
  if (/\bnuxt\b/.test(text)) return 'nuxt'
  if (/\b(webpack|vue-cli-service|react-scripts|craco|angular|umi)\b/.test(text)) return 'webpack'
  return 'custom'
}

/** raw command 优先（逃生舱）；否则 manager + script，script 未声明时按回退链取 scripts 中真实存在者。 */
function resolveCommand(
  section: EnestCommandConfig | undefined,
  pkg: PackageJsonLike | null,
  detected: DevPackageManager,
  fallbacks: readonly string[]
): DevCommandSpec | undefined {
  if (section?.command) return { kind: 'raw', command: section.command, env: section.env, label: section.command }
  const manager = section?.manager ?? detected
  const script = section?.script ?? fallbacks.find(name => hasScript(pkg, name))
  if (!script) return undefined
  return { kind: 'script', command: script, manager, portArgs: section?.portArgs, env: section?.env, label: `${manager} run ${script}` }
}

/**
 * 解析插件的本地开发计划。devUrl 优先级：package.json enest.dev.url > plugin.json development.main。
 * manifest 仅用于 URL 回落，可省略（如仅执行构建时）。
 */
export function resolveDevCommandPlan(sourcePath: string, manifest?: Pick<PluginManifest, 'development'>): DevCommandPlan {
  const pkg = readPackageJson(sourcePath)
  const enest = readEnestConfig(pkg ?? {})
  const detected = detectPackageManager(sourcePath)
  const devUrl = normalizePluginDevUrl(enest.dev?.url ?? manifest?.development?.main)
  const start = resolveCommand(enest.dev, pkg, detected, DEV_SCRIPT_FALLBACKS)
  const build = resolveCommand(enest.build, pkg, detected, BUILD_SCRIPT_FALLBACKS)
  return {
    ...(devUrl !== undefined ? { devUrl } : {}),
    ...(start ? { start } : {}),
    ...(build ? { build } : {}),
    framework: detectDevFramework(pkg, start, build),
    output: enest.output ?? 'dist',
  }
}
