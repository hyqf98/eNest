/**
 * devBuildRunner — prod 模式的构建执行器：运行 devCommandResolver 解析出的
 * build 命令并等待退出。输出进开发者日志面板；失败/超时抛错由调用方提示。
 */
import type { ChildProcess } from 'node:child_process'
import { sendShellEvent } from '@main/window/createShellWindow'
import { logInfo } from '@main/logs/logService'
import type { DevCommandPlan } from '@shared/types/plugin'
import { getRuntimeScope } from '@main/plugin/PluginRuntimeScope'
import { registerPluginProcess } from '@main/plugin/pluginOwnedProcesses'
import { buildSpawnCandidates, killTree, pipeOutput, spawnCommand } from './devSpawn'

const BUILD_TIMEOUT_MS = 180_000

function emitLog(pluginId: string, level: 'info' | 'warn', message: string): void {
  sendShellEvent({ type: 'plugin-log', pluginId, level, message: message.slice(0, 2000) })
}

/** 执行解析出的构建命令；成功 resolve，失败/超时抛带有人类可读信息的 Error。 */
export async function runDevBuild(pluginId: string, sourcePath: string, plan: DevCommandPlan): Promise<void> {
  const build = plan.build
  if (!build) throw new Error('未找到可用的构建命令：package.json 无 enest.build 声明，也无 build/pack 脚本')
  emitLog(pluginId, 'info', `正在构建 ${build.label} …`)
  const env = { ...process.env, ...build.env }
  const scope = getRuntimeScope(pluginId)
  const controller = new AbortController()
  const children = new Set<ChildProcess>()
  const exits: Promise<void>[] = []
  const stop = () => { controller.abort(); for (const child of children) killTree(child) }
  const shutdown = async () => {
    stop()
    let timer: ReturnType<typeof setTimeout> | undefined
    try { await Promise.race([Promise.all(exits), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('plugin build exit not confirmed')), 1500) })]) }
    finally { if (timer) clearTimeout(timer) }
  }
  const unregister = registerPluginProcess({ pluginId, generation: scope?.owner.generation, kind: 'development',
    getPid: () => [...children].find(child => child.exitCode === null && child.signalCode === null)?.pid, stop: shutdown })
  scope?.signal.addEventListener('abort', stop, { once: true })
  const detach = scope?.addDisposer(shutdown)
  try {
    const child = await spawnCommand(sourcePath, buildSpawnCandidates(build, []), env, warn => emitLog(pluginId, 'warn', warn), {
      signal: controller.signal,
      onChild: child => {
        children.add(child)
        exits.push(new Promise(resolve => {
          let done = false
          const finish = () => { if (!done) { done = true; children.delete(child); resolve() } }
          child.once('close', finish)
          child.once('error', () => { if (child.pid === undefined) finish() })
        }))
      }
    })
    if (!child) throw new Error(`构建命令 ${build.label} 启动失败（未安装或不在 PATH）`)
    pipeOutput(child, (level, text) => emitLog(pluginId, level, text))
    const code = await waitExit(child)
    logInfo('dev', `${pluginId}: build via ${build.label} exited code=${code}`)
    if (code !== 0) throw new Error(`构建失败（退出码 ${code ?? '信号终止'}），详见开发者日志`)
    emitLog(pluginId, 'info', '构建完成')
  } finally {
    stop()
    // An unconfirmed child remains attributed until its real close event.
    void Promise.all(exits).then(() => { unregister(); detach?.(); scope?.signal.removeEventListener('abort', stop) })
  }
}

function waitExit(child: ChildProcess): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(child.exitCode)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      killTree(child)
      reject(new Error(`构建超过 ${BUILD_TIMEOUT_MS / 1000}s，已终止`))
    }, BUILD_TIMEOUT_MS)
    child.once('exit', (exitCode) => { clearTimeout(timer); resolve(exitCode) })
    child.once('error', (error) => { clearTimeout(timer); reject(error) })
  })
}
