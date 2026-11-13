import { Worker } from 'node:worker_threads'
import { join } from 'node:path'
import { readFile, writeFile, rename, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { app } from 'electron'

export const BUILD_METADATA_FILE = '.enest-build.json'
type InstallTask = { action: 'extract'; source: string; dest: string } | { action: 'hash'; root: string }
type InstallTaskResult = { ok: true; result: unknown } | { ok: false; error: Error }
interface PendingInstallTask {
  task: InstallTask
  resolve: (result: unknown) => void
  reject: (error: Error) => void
}
interface ActiveInstallTask {
  cancel: () => void
  exited: Promise<void>
}
const MAX_ACTIVE_WORKERS = 2
const MAX_PENDING_TASKS = 128
const TASK_TIMEOUT_MS = 120_000
const pendingTasks: PendingInstallTask[] = []
const activeTasks = new Set<ActiveInstallTask>()
let stopping = false
let disposePromise: Promise<void> | undefined

function cancelledError(): Error {
  return new Error('应用正在退出，安装已取消')
}

/** Reject queued work immediately, then wait until running workers can no longer touch disk. */
export function disposePluginInstallWorkers(): Promise<void> {
  if (disposePromise) return disposePromise
  stopping = true
  for (const pending of pendingTasks.splice(0)) pending.reject(cancelledError())
  const running = [...activeTasks]
  for (const active of running) active.cancel()
  disposePromise = Promise.all(running.map((active) => active.exited)).then(() => {})
  return disposePromise
}

function runTask<T>(task: InstallTask): Promise<T> {
  if (stopping) return Promise.reject(cancelledError())
  if (pendingTasks.length >= MAX_PENDING_TASKS) {
    return Promise.reject(new Error('插件安装任务繁忙，等待队列已满，请稍后重试'))
  }
  return new Promise((resolve, reject) => {
    pendingTasks.push({ task, resolve: (result) => resolve(result as T), reject })
    drainTasks()
  })
}

function drainTasks(): void {
  while (!stopping && activeTasks.size < MAX_ACTIVE_WORKERS && pendingTasks.length > 0) {
    startTask(pendingTasks.shift()!)
  }
}

function startTask(pending: PendingInstallTask): void {
  let worker: Worker
  try {
    worker = new Worker(join(app.getAppPath(), 'out/main/pluginInstallWorker.js'), { workerData: pending.task })
  } catch (error) {
    pending.reject(error instanceof Error ? error : new Error(String(error)))
    return // A constructor failure must not block later queued work.
  }

  let result: InstallTaskResult | undefined
  let exited = false
  let terminating = false
  let resolveExit!: () => void
  const active: ActiveInstallTask = {
    cancel: () => terminate({ ok: false, error: cancelledError() }),
    exited: new Promise<void>((resolve) => { resolveExit = resolve })
  }
  activeTasks.add(active)
  // Queue residence is not execution time; arm the timeout only after construction succeeds.
  const timeout = setTimeout(() => terminate({ ok: false, error: new Error('插件安装处理超时') }), TASK_TIMEOUT_MS)

  function terminationFailed(error: unknown): void {
    if (exited) return
    terminating = false
    if (!result || result.ok) result = { ok: false, error: error instanceof Error ? error : new Error(String(error)) }
    // A rejected termination is not proof of exit. Retain the slot and wait for the exit event.
  }

  function terminate(nextResult: InstallTaskResult): void {
    if (exited) return
    if (!result || result.ok) result = nextResult
    clearTimeout(timeout)
    if (terminating) return
    terminating = true
    try {
      void worker.terminate().catch(terminationFailed)
    } catch (error) {
      terminationFailed(error)
    }
  }

  worker.once('error', (error) => terminate({ ok: false, error }))
  worker.once('message', (message: { ok: boolean; result?: unknown; error?: string }) => {
    terminate(message.ok
      ? { ok: true, result: message.result }
      : { ok: false, error: new Error(message.error || '插件安装处理失败') })
  })
  worker.once('exit', (code) => {
    exited = true
    clearTimeout(timeout)
    activeTasks.delete(active)
    if (stopping) pending.reject(cancelledError())
    else if (!result) pending.reject(new Error(`插件安装工作线程提前退出 (${code})`))
    else if (result.ok) pending.resolve(result.result)
    else pending.reject(result.error)
    resolveExit()
    drainTasks()
  })
}

export function extractPluginArchive(source: string, dest: string): Promise<void> {
  return runTask({ action: 'extract', source, dest })
}

export async function writePluginBuildRevision(root: string): Promise<string> {
  const revision = await runTask<string>({ action: 'hash', root })
  if (stopping) throw cancelledError()
  await saveRevision(root, revision)
  if (stopping) throw cancelledError()
  return revision
}

async function saveRevision(root: string, revision: string): Promise<void> {
  const temporary = join(root, `.enest-build-${randomUUID()}.tmp`)
  try {
    await writeFile(temporary, JSON.stringify({ revision }), { encoding: 'utf8', flag: 'wx' })
    // Replace the directory entry instead of following a concurrently substituted symlink.
    await rename(temporary, join(root, BUILD_METADATA_FILE))
  } finally { await rm(temporary, { force: true }).catch(() => {}) }
}

/** Legacy installed directories get content hashes once; new installs write them before publish. */
export async function readPluginBuildRevision(root: string): Promise<string> {
  if (stopping) throw cancelledError()
  let existingRevision: string | undefined
  try {
    const metadata = JSON.parse(await readFile(join(root, BUILD_METADATA_FILE), 'utf8')) as { revision?: unknown }
    if (typeof metadata.revision === 'string' && /^[a-f0-9]{64}$/.test(metadata.revision)) existingRevision = metadata.revision
  } catch { /* legacy install */ }
  if (stopping) throw cancelledError()
  if (existingRevision) return existingRevision
  const revision = await runTask<string>({ action: 'hash', root })
  if (stopping) throw cancelledError()
  // Read-only legacy installations remain loadable even if the optional index cannot be saved.
  await saveRevision(root, revision).catch(() => {})
  if (stopping) throw cancelledError()
  return revision
}
