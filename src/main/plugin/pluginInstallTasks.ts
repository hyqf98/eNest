import { Worker } from 'node:worker_threads'
import { join } from 'node:path'
import { readFile, writeFile, rename, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { app } from 'electron'

export const BUILD_METADATA_FILE = '.enest-build.json'
type InstallTask = { action: 'extract'; source: string; dest: string } | { action: 'hash'; root: string }
const activeWorkers = new Set<Worker>()
let stopping = false

/** App shutdown cancels installer CPU work; pending callers reject through the exit handler. */
export async function disposePluginInstallWorkers(): Promise<void> {
  stopping = true
  await Promise.all([...activeWorkers].map((worker) => worker.terminate().catch(() => -1)))
}

function runTask<T>(task: InstallTask): Promise<T> {
  if (stopping) return Promise.reject(new Error('应用正在退出，安装已取消'))
  return new Promise((resolve, reject) => {
    const worker = new Worker(join(app.getAppPath(), 'out/main/pluginInstallWorker.js'), { workerData: task })
    activeWorkers.add(worker)
    let settled = false
    const finish = (error?: Error, result?: T): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      // Never leave a worker behind on a failed task or shutdown race.
      void worker.terminate().catch(() => {}).finally(() => activeWorkers.delete(worker))
      if (error) reject(error)
      else resolve(result as T)
    }
    const timeout = setTimeout(() => finish(new Error('插件安装处理超时')), 120_000)
    worker.once('error', (error) => finish(error))
    worker.once('exit', (code) => {
      if (!settled) finish(new Error(`插件安装工作线程提前退出 (${code})`))
    })
    worker.once('message', (message: { ok: boolean; result?: T; error?: string }) => {
      finish(message.ok ? undefined : new Error(message.error || '插件安装处理失败'), message.result)
    })
  })
}

export function extractPluginArchive(source: string, dest: string): Promise<void> {
  return runTask({ action: 'extract', source, dest })
}

export async function writePluginBuildRevision(root: string): Promise<string> {
  const revision = await runTask<string>({ action: 'hash', root })
  await saveRevision(root, revision)
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
  try {
    const metadata = JSON.parse(await readFile(join(root, BUILD_METADATA_FILE), 'utf8')) as { revision?: unknown }
    if (typeof metadata.revision === 'string' && /^[a-f0-9]{64}$/.test(metadata.revision)) return metadata.revision
  } catch { /* legacy install */ }
  const revision = await runTask<string>({ action: 'hash', root })
  // Read-only legacy installations remain loadable even if the optional index cannot be saved.
  await saveRevision(root, revision).catch(() => {})
  return revision
}
