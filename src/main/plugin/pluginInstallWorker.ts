/** CPU-heavy archive expansion and content hashing never run on Electron's UI thread. */
import { parentPort, workerData } from 'node:worker_threads'
import { createReadStream } from 'node:fs'
import { readdir, lstat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { isAbsolute, join, relative, resolve } from 'node:path'
import AdmZip from 'adm-zip'

export const BUILD_METADATA_FILE = '.enest-build.json'

export async function hashPluginDirectory(root: string): Promise<string> {
  const digest = createHash('sha256')
  async function visit(dir: string): Promise<void> {
    const names = (await readdir(dir)).sort()
    for (const name of names) {
      if (dir === root && name === BUILD_METADATA_FILE) continue
      const path = join(dir, name)
      const info = await lstat(path)
      if (info.isSymbolicLink()) throw new Error(`插件包不允许符号链接: ${relative(root, path)}`)
      if (info.isDirectory()) await visit(path)
      else if (info.isFile()) {
        digest.update(`${relative(root, path).split('\\').join('/')}\0${info.size}\0`)
        for await (const chunk of createReadStream(path)) digest.update(chunk as Buffer)
        digest.update('\0')
      }
    }
  }
  await visit(root)
  return digest.digest('hex')
}

export function extractPluginArchive(source: string, dest: string): void {
  const zip = new AdmZip(source)
  let total = 0
  const entries = zip.getEntries()
  if (entries.length > 100_000) throw new Error('安装包文件数量超过限制')
  for (const entry of entries) {
    const name = entry.entryName.replace(/\\/g, '/')
    const rel = relative(dest, resolve(dest, name))
    if (name.includes('\0') || isAbsolute(name) || !rel || rel.startsWith('..') || isAbsolute(rel)) {
      throw new Error(`安装包包含越界路径: ${name}`)
    }
    if (((entry.header.attr >>> 16) & 0xf000) === 0xa000) throw new Error('安装包不允许符号链接')
    total += entry.header.size
    if (total > 2 * 1024 * 1024 * 1024) throw new Error('安装包解压大小超过 2 GiB')
  }
  zip.extractAllTo(dest, true)
}

if (parentPort && workerData) {
  void (async () => {
    if (workerData.action === 'extract') {
      extractPluginArchive(workerData.source, workerData.dest)
      return null
    }
    if (workerData.action === 'hash') return hashPluginDirectory(workerData.root)
    throw new Error('Unknown plugin install worker action')
  })().then(
    (result) => parentPort!.postMessage({ ok: true, result }),
    (error: unknown) => parentPort!.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) })
  )
}
