/**
 * installQueue — 插件安装队列（并发上限 3）
 * 职责：接收来自拖拽 / IPC 的安装请求，按 FIFO 调度；
 *       同时最多 3 个任务并行，其余进入等待列表；
 *       通过 shell:event 推送 install-progress / install-queue / install-result。
 * 为什么需要队列：同时拖入多个包时，无限并行会争抢磁盘 IO、
 *       让进度 UI 与日志顺序不可预期；上限 3 覆盖「多文件拖入」的常见峰值，
 *       又保证用户能同时关注到每条进度。
 * 被 shellHandlers（ShellInstallPlugin）调用；安装完成后重扫 PluginRegistry。
 * 关键依赖：PluginInstaller、PluginRegistry、logService、sendShellEvent。
 */
import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import type { InstallJobInfo } from '@shared/types/ipc'
import { logError, logInfo } from '../logs/logService'
import { getAppPaths } from '../paths/pathsService'
import { installPluginFromPath } from './PluginInstaller'
import { pluginRegistry } from './PluginRegistry'
import { sendShellEvent } from '../window/createShellWindow'

/** 并行安装上限：见文件头「为什么需要队列」 */
export const MAX_PARALLEL_INSTALLS = 3

interface InstallJob extends InstallJobInfo {
  sourcePath: string
}

/** FIFO 等待 + 运行中任务；done/failed 会立刻出队（结果走 toast） */
const queue: InstallJob[] = []
let activeCount = 0

function publicView(job: InstallJob): InstallJobInfo {
  return { id: job.id, name: job.name, progress: job.progress, status: job.status }
}

function emitQueue(): void {
  const active: InstallJobInfo[] = []
  const waiting: InstallJobInfo[] = []
  for (const job of queue) {
    if (job.status === 'active') active.push(publicView(job))
    else if (job.status === 'queued') waiting.push(publicView(job))
  }
  sendShellEvent({ type: 'install-queue', active, waiting })
}

function reportProgress(job: InstallJob, progress: number, step?: string): void {
  job.progress = Math.max(0, Math.min(100, Math.round(progress)))
  sendShellEvent({
    type: 'install-progress',
    jobId: job.id,
    name: job.name,
    progress: job.progress,
    step
  })
  emitQueue()
}

/** 有空位则启动下一个 queued 任务；由 finally 与 enqueue 共同驱动 */
function pump(): void {
  while (activeCount < MAX_PARALLEL_INSTALLS) {
    const next = queue.find((j) => j.status === 'queued')
    if (!next) break
    void runJob(next)
  }
}

async function runJob(job: InstallJob): Promise<void> {
  activeCount++
  job.status = 'active'
  reportProgress(job, 0, '开始安装')
  emitQueue()
  try {
    const destRoot = getAppPaths().plugins
    logInfo('install-queue', `start ${job.name} ← ${job.sourcePath}`)
    const result = await installPluginFromPath(job.sourcePath, destRoot, (p, step) => {
      reportProgress(job, p, step)
    })
    // 重扫注册表，让市场列表立即出现新装插件
    await pluginRegistry.scan()
    job.status = 'done'
    job.progress = 100
    logInfo(
      'install-queue',
      `done ${result.manifest.id}@${result.manifest.version}`
    )
    sendShellEvent({
      type: 'install-result',
      jobId: job.id,
      name: result.manifest.name,
      ok: true
    })
    sendShellEvent({ type: 'plugins-changed' })
  } catch (err) {
    job.status = 'failed'
    const message = (err as Error).message || String(err)
    logError('install-queue', `fail ${job.name}: ${message}`)
    sendShellEvent({
      type: 'install-result',
      jobId: job.id,
      name: job.name,
      ok: false,
      error: message
    })
  } finally {
    activeCount = Math.max(0, activeCount - 1)
    const idx = queue.indexOf(job)
    if (idx >= 0) queue.splice(idx, 1)
    emitQueue()
    pump()
  }
}

/**
 * 入队安装。sourcePath 为本地文件夹或 .enestplugin/.zip 绝对路径。
 * 立即返回任务摘要；实际安装异步进行，进度经 shell:event 推送。
 */
export function enqueueInstall(sourcePath: string): InstallJobInfo {
  const display =
    basename(sourcePath).replace(/\.enestplugin$/i, '').replace(/\.zip$/i, '') || sourcePath
  const job: InstallJob = {
    id: randomUUID(),
    name: display,
    progress: 0,
    status: 'queued',
    sourcePath
  }
  queue.push(job)
  logInfo('install-queue', `enqueue ${job.name} ← ${sourcePath}`)
  pump()
  emitQueue()
  return publicView(job)
}

/** 当前队列快照（active / waiting），供 IPC 查询 */
export function getInstallQueueState(): {
  active: InstallJobInfo[]
  waiting: InstallJobInfo[]
} {
  return {
    active: queue.filter((j) => j.status === 'active').map(publicView),
    waiting: queue.filter((j) => j.status === 'queued').map(publicView)
  }
}
