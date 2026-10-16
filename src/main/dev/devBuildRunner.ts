/**
 * devBuildRunner — prod 模式的构建执行器：运行 devCommandResolver 解析出的
 * build 命令并等待退出。输出进开发者日志面板；失败/超时抛错由调用方提示。
 */
import type { ChildProcess } from 'node:child_process'
import { sendShellEvent } from '@main/window/createShellWindow'
import { logInfo } from '@main/logs/logService'
import type { DevCommandPlan } from '@shared/types/plugin'
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
  const child = await spawnCommand(sourcePath, buildSpawnCandidates(build, []), env, warn => emitLog(pluginId, 'warn', warn))
  if (!child) throw new Error(`构建命令 ${build.label} 启动失败（未安装或不在 PATH）`)
  pipeOutput(child, (level, text) => emitLog(pluginId, level, text))
  const code = await waitExit(child)
  logInfo('dev', `${pluginId}: build via ${build.label} exited code=${code}`)
  if (code !== 0) throw new Error(`构建失败（退出码 ${code ?? '信号终止'}），详见开发者日志`)
  emitLog(pluginId, 'info', '构建完成')
}

function waitExit(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      killTree(child)
      reject(new Error(`构建超过 ${BUILD_TIMEOUT_MS / 1000}s，已终止`))
    }, BUILD_TIMEOUT_MS)
    child.once('exit', (exitCode) => { clearTimeout(timer); resolve(exitCode) })
    child.once('error', (error) => { clearTimeout(timer); reject(error) })
  })
}
