/**
 * devBuildManager — 开发态首次加载缺构建产物时，按 package.json 解析出的构建命令补齐一次。
 * 只有后端/后台入口必须来自编译产物；纯前端仍由 dev server 或源码静态预览负责。
 * 失败只记录并继续打开，后端调用仍会给出可执行错误。
 */
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { logInfo, logWarn } from '@main/logs/logService'
import { registerPluginProcess } from '@main/plugin/pluginOwnedProcesses'
import { getRuntimeScope } from '@main/plugin/PluginRuntimeScope'
import { sendShellEvent } from '@main/window/createShellWindow'
import type { DevCommandPlan, DevCommandSpec, PluginManifest } from '@shared/types/plugin'
import { buildSpawnCandidates, killTree, pipeOutput, spawnCommand } from './devSpawn'

/** 新机器冷装依赖后再构建可能较慢；超时只放弃本次构建。 */
const BUILD_TIMEOUT_MS = 10 * 60_000
const pending = new Map<string, Promise<boolean>>()

export interface DevBuildTarget {
  id: string
  sourcePath: string
  manifest: PluginManifest
  plan: DevCommandPlan
  outputPath: string
}

export interface DevBuildOptions {
  signal?: AbortSignal
  isCurrent?: () => boolean
  reason?: string
}

function emit(pluginId: string, level: 'info' | 'warn', message: string): void {
  sendShellEvent({ type: 'plugin-log', pluginId, level, message: message.slice(0, 2000) })
}

/** Only these declarations run from built output in development. */
function requiredEntries(manifest: PluginManifest): string[] {
  return [manifest.backend?.entry, manifest.background?.entry]
    .filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
}

function missingDevBuild(target: DevBuildTarget): boolean {
  return requiredEntries(target.manifest).some(entry => !existsSync(join(target.outputPath, entry)))
}

/**
 * 后端 / 后台入口是否比产物新：Electron 的 utilityProcess 没有模块重载能力
 * （实例上只有 postMessage / kill），改后端源码必须重新编译再重启进程才生效。
 *
 * 只看产物在不在是不够的：产物存在但过期时，重载插件会重启进程、却仍旧加载旧代码，
 * 表现为「改了后端、重载了、行为一点没变」——排查起来极难。
 *
 * 扫描插件源码树（跳过 node_modules / 产物目录）。后端会从 `../src/shared` 这类位置
 * 导入跨端契约，所以不能只扫 backend 目录；但也不能只看插件根，否则改前端 UI
 * 也会触发后端重建。
 */
const STALE_SCAN_MAX_FILES = 4000
const STALE_SCAN_MAX_DEPTH = 12
const SOURCE_FILE = /\.(?:ts|tsx|mts|cts|js|mjs|cjs|json)$/

function latestSourceMtime(root: string): number {
  let latest = 0
  let visited = 0
  const walk = (directory: string, depth: number): void => {
    if (depth > STALE_SCAN_MAX_DEPTH || visited > STALE_SCAN_MAX_FILES) return
    let entries: import('node:fs').Dirent[]
    try { entries = readdirSync(directory, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      if (++visited > STALE_SCAN_MAX_FILES) return
      const path = join(directory, entry.name)
      if (entry.isDirectory()) {
        // 依赖、产物与缓存目录不是源码
        if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'out' || entry.name.startsWith('.')) continue
        walk(path, depth + 1)
      } else if (SOURCE_FILE.test(entry.name)) {
        try {
          const at = statSync(path).mtimeMs
          if (at > latest) latest = at
        } catch { /* 扫描期间被删掉，忽略 */ }
      }
    }
  }
  walk(root, 0)
  return latest
}

/**
 * 产物是否比后端源码旧。true 表示需要重新构建。
 * 纯前端插件（没有后端/后台入口）永远返回 false，不受此逻辑影响。
 */
function staleDevBuild(target: DevBuildTarget): boolean {
  const entries = requiredEntries(target.manifest)
  if (!entries.length) return false
  // 产物缺失由 missingDevBuild 负责；这里只判断「存在但过期」
  let oldestOutput = Number.POSITIVE_INFINITY
  for (const entry of entries) {
    try { oldestOutput = Math.min(oldestOutput, statSync(join(target.outputPath, entry)).mtimeMs) }
    catch { return false }
  }
  if (!Number.isFinite(oldestOutput)) return false
  // 留 1 秒余量：同一次构建里产物与源码的时间戳可能相差不到一个文件系统刻度
  return latestSourceMtime(target.sourcePath) > oldestOutput + 1000
}

/** Single-flight per plugin; resolves false instead of rejecting so opening never fails on a build. */
export function ensureDevBuild(target: DevBuildTarget, options: DevBuildOptions = {}): Promise<boolean> {
  if (!requiredEntries(target.manifest).length) return Promise.resolve(true)
  const running = pending.get(target.id)
  if (running) return running
  const missing = missingDevBuild(target)
  // 产物存在但比源码旧：不重建的话，重载插件会重启进程却仍旧加载旧代码
  const stale = !missing && staleDevBuild(target)
  if (!missing && !stale) return Promise.resolve(true)
  // 产物过期时优先用「只构建后端」的命令：完整构建还要打包前端并过市场素材校验，
  // 一处与后端无关的不合规就会让整条构建失败，把后端改动一起拖下水。
  const build = (stale ? target.plan.backend : undefined) ?? target.plan.build
  if (!build) {
    emit(target.id, 'warn', '缺少构建产物，但 package.json 未声明构建命令；请在插件目录构建后重载')
    return Promise.resolve(false)
  }
  const operation = runBuild(target, build, options).finally(() => {
    if (pending.get(target.id) === operation) pending.delete(target.id)
  })
  pending.set(target.id, operation)
  return operation
}

async function runBuild(target: DevBuildTarget, build: DevCommandSpec, options: DevBuildOptions): Promise<boolean> {
  const scope = getRuntimeScope(target.id)
  const controller = new AbortController()
  const abort = () => controller.abort()
  options.signal?.addEventListener('abort', abort, { once: true })
  const reason = /^[a-z0-9_.-]{1,64}$/i.test(options.reason ?? '') ? options.reason! : 'open'
  const why = missingDevBuild(target) ? '缺少构建产物' : '后端源码已更新，产物需要重建'
  logInfo('dev', `${target.id}: build start reason=${reason} command=${build.label}`)
  emit(target.id, 'info', `${why}，正在运行 ${build.label} …`)
  let timer: NodeJS.Timeout | undefined
  try {
    const child = await spawnCommand(target.sourcePath, buildSpawnCandidates(build, []), { ...process.env },
      warn => emit(target.id, 'warn', warn), {
        signal: controller.signal,
        onChild: child => {
          const unregister = registerPluginProcess({
            pluginId: target.id, generation: scope?.owner.generation, kind: 'development',
            getPid: () => child.pid, stop: () => killTree(child)
          })
          child.once('close', () => unregister())
        }
      })
    if (!child) {
      emit(target.id, 'warn', '构建命令未能启动；请在插件目录手动构建后重载')
      return false
    }
    pipeOutput(child, (level, text) => emit(target.id, level, text))
    timer = setTimeout(() => killTree(child), BUILD_TIMEOUT_MS)
    timer.unref()
    const code = await new Promise<number | null>(resolve => child.once('close', () => resolve(child.exitCode)))
    if (options.isCurrent?.() === false) return false
    if (code !== 0) {
      logWarn('dev', `${target.id}: build failed code=${code}`)
      emit(target.id, 'warn', `构建失败（退出码 ${code ?? 'unknown'}）；插件仍可打开，后端调用会提示缺失产物`)
      return false
    }
    const ready = !missingDevBuild(target)
    emit(target.id, ready ? 'info' : 'warn', ready ? '构建完成' : '构建命令已结束，但声明的产物仍缺失')
    return ready
  } catch (error) {
    logWarn('dev', `${target.id}: build error ${error instanceof Error ? error.message : String(error)}`)
    emit(target.id, 'warn', `构建失败：${error instanceof Error ? error.message : String(error)}`)
    return false
  } finally {
    if (timer) clearTimeout(timer)
    options.signal?.removeEventListener('abort', abort)
  }
}
