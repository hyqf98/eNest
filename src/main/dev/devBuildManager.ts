/**
 * devBuildManager — 开发态首次加载缺构建产物时，按 package.json 解析出的构建命令补齐一次。
 * 只有后端/后台入口必须来自编译产物；纯前端仍由 dev server 或源码静态预览负责。
 * 失败只记录并继续打开，后端调用仍会给出可执行错误。
 */
import { existsSync } from 'node:fs'
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

/** Single-flight per plugin; resolves false instead of rejecting so opening never fails on a build. */
export function ensureDevBuild(target: DevBuildTarget, options: DevBuildOptions = {}): Promise<boolean> {
  if (!requiredEntries(target.manifest).length) return Promise.resolve(true)
  const running = pending.get(target.id)
  if (running) return running
  if (!missingDevBuild(target)) return Promise.resolve(true)
  if (!target.plan.build) {
    emit(target.id, 'warn', '缺少构建产物，但 package.json 未声明构建命令；请在插件目录构建后重载')
    return Promise.resolve(false)
  }
  const operation = runBuild(target, target.plan.build, options).finally(() => {
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
  logInfo('dev', `${target.id}: build start reason=${reason} command=${build.label}`)
  emit(target.id, 'info', `缺少构建产物，正在运行 ${build.label} …`)
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
