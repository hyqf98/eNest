/** Move unpublished ~/eNest data into the standard root; delete only after verification. */
import { createHash } from 'node:crypto'
import { createReadStream, existsSync } from 'node:fs'
import { copyFile, lstat, mkdir, readdir, rename, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { defaultDataRoot } from './pathsService'

async function hash(path: string): Promise<string> {
  const digest = createHash('sha256')
  for await (const chunk of createReadStream(path)) digest.update(chunk as Buffer)
  return digest.digest('hex')
}
async function files(root: string, prefix = ''): Promise<string[]> {
  const result: string[] = []
  for (const name of (await readdir(join(root, prefix))).sort()) {
    const rel = join(prefix, name)
    const info = await lstat(join(root, rel))
    if (info.isSymbolicLink()) throw new Error(`旧数据包含符号链接，未删除来源: ${rel}`)
    if (info.isDirectory()) result.push(...await files(root, rel))
    else if (info.isFile()) result.push(rel)
    else throw new Error(`旧数据包含不支持的文件类型: ${rel}`)
  }
  return result
}

export async function migrateLegacyRoot(source: string, target: string): Promise<void> {
  if (!existsSync(source) || resolve(source) === resolve(target)) return
  if ((await lstat(source)).isSymbolicLink()) throw new Error('旧数据根不能是符号链接')
  const snapshot = await files(source)
  const hashes = new Map<string, string>()
  const conflicts = new Set<string>()
  for (const rel of snapshot) {
    const digest = await hash(join(source, rel))
    hashes.set(rel, digest)
    if (existsSync(join(target, rel)) && await hash(join(target, rel)) !== digest) conflicts.add(rel)
  }
  // Database files and WAL sidecars remain together. Conflicting databases are retained as an import.
  const dbConflict = [...conflicts].some(rel => rel.startsWith(join('data', 'enest.db')))
  const importId = createHash('sha256').update(JSON.stringify([...hashes])).digest('hex').slice(0, 16)
  const imported = new Map<string, string>()
  for (const rel of snapshot) {
    const conflict = conflicts.has(rel) || dbConflict && rel.startsWith(join('data', 'enest.db'))
    const to = conflict ? join(target, 'migration-imports', importId, rel) : join(target, rel)
    await mkdir(dirname(to), { recursive: true })
    if (!existsSync(to)) {
      const temp = `${to}.migrating-${process.pid}`
      try {
        await copyFile(join(source, rel), temp)
        if (await hash(temp) !== hashes.get(rel)) throw new Error(`迁移校验失败: ${rel}`)
        await rename(temp, to)
      } finally { await rm(temp, { force: true }) }
    }
    if (await hash(to) !== hashes.get(rel)) throw new Error(`迁移目标校验失败: ${rel}`)
    imported.set(rel, to)
  }
  const database = imported.get(join('data', 'enest.db'))
  if (database) {
    const db = new DatabaseSync(database, { readOnly: true })
    try {
      if (db.prepare('PRAGMA quick_check').get()?.quick_check !== 'ok') throw new Error('迁移数据库完整性检查失败')
    } finally { db.close() }
  }
  if (JSON.stringify(await files(source)) !== JSON.stringify(snapshot)) throw new Error('迁移期间旧数据变化，未删除来源')
  for (const rel of snapshot) if (await hash(join(source, rel)) !== hashes.get(rel)) throw new Error('迁移期间旧数据变化，未删除来源')
  await rm(source, { recursive: true })
  if (conflicts.size) console.info(`[eNest] 已保留 ${conflicts.size} 个冲突文件于 migration-imports/${importId}，当前数据未覆盖`)
}

export async function migrateToDataRoot(): Promise<void> {
  // Test profiles never inspect or modify the user's data.
  if (process.env.ENEST_TEST_DATA_ROOT) return
  await migrateLegacyRoot(join(homedir(), 'eNest'), defaultDataRoot())
}
