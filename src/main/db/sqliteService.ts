/**
 * sqliteService — 壳子共享 KV 存储（Node 内置 node:sqlite）
 * 职责：在 {dataRoot}/data/enest.db 上提供同步式 KV API。
 * 实现：Electron ≥35（Node ≥22.13）内置 node:sqlite 的 DatabaseSync，
 *      零第三方原生依赖，无 ABI 重建问题。
 * 持久化：WAL + synchronous=NORMAL，写操作直接走增量 SQL，不再整库导出。
 * 兼容：旧 enest.db 是 sql.js 导出的标准 SQLite 文件，可直接打开，KV 数据无需迁移。
 * 被 index.ts（启动 init / before-quit close）、shellHandlers（shell:query-db）调用。
 * 插件 storage.local 走同库 plugin_storage 表，见 @main/db/pluginStorage。
 */
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { getAppPaths } from '@main/paths/pathsService'

type Backend = 'sqlite' | 'none'

export class EnestKvStore {
  private backend: Backend = 'none'
  private db: DatabaseSync | null = null
  private ready = false
  private initPromise: Promise<Backend> | null = null

  /** 底层连接（仅供 @main/db/pluginStorage 等同进程模块复用；外部勿直接持有） */
  getDatabase(): DatabaseSync | null {
    return this.backend === 'sqlite' ? this.db : null
  }

  getBackend(): Backend {
    return this.backend
  }

  /** 初始化；重复调用返回同一 Promise（幂等签名与旧版一致） */
  initDatabase(path: string = getAppPaths().database): Promise<Backend> {
    if (this.initPromise) return this.initPromise
    this.initPromise = this.doInit(path)
    return this.initPromise
  }

  private async doInit(path: string): Promise<Backend> {
    try {
      mkdirSync(dirname(path), { recursive: true })
      // 旧库为 sql.js 导出的标准 SQLite 格式，直接打开即可
      this.db = new DatabaseSync(path)
      this.db.exec('PRAGMA journal_mode = WAL')
      this.db.exec('PRAGMA synchronous = NORMAL')
      this.db.exec('CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
      this.backend = 'sqlite'
      this.ready = true
      return this.backend
    } catch (err) {
      console.error('[enest] sqlite init failed', err)
      // 兜底：初始化失败时 backend='none'，后续读写抛错由调用方兜底
      try {
        this.db?.close()
      } catch {
        /* ignore */
      }
      this.db = null
      this.backend = 'none'
      this.ready = true
      return this.backend
    }
  }

  private ensureReady(): void {
    if (!this.ready || !this.db) {
      throw new Error('kvStore not initialized')
    }
  }

  kvGet(key: string): string | null {
    this.ensureReady()
    const row = this.db!.prepare('SELECT value FROM kv WHERE key = ?').get(key) as
      | { value: string }
      | undefined
    return row ? row.value : null
  }

  kvSet(key: string, value: string): void {
    this.ensureReady()
    this.db!
      .prepare(
        'INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
      )
      .run(key, value)
  }

  kvDelete(key: string): void {
    this.ensureReady()
    this.db!.prepare('DELETE FROM kv WHERE key = ?').run(key)
  }

  kvKeys(prefix = ''): string[] {
    this.ensureReady()
    const rows = (
      prefix
        ? this.db!.prepare('SELECT key FROM kv WHERE key LIKE ? ORDER BY key').all(`${prefix}%`)
        : this.db!.prepare('SELECT key FROM kv ORDER BY key').all()
    ) as Array<{ key: string }>
    return rows.map((r) => r.key)
  }

  close(): void {
    try {
      this.db?.close()
    } catch {
      /* ignore */
    }
    this.db = null
    this.ready = false
    this.initPromise = null
    this.backend = 'none'
  }
}

/**
 * 手动事务包裹（node:sqlite 无 better-sqlite3 的 db.transaction 语法糖）。
 * fn 内抛错自动 ROLLBACK 并向上抛出。
 */
export function runInTransaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN')
  try {
    const result = fn()
    db.exec('COMMIT')
    return result
  } catch (err) {
    try {
      db.exec('ROLLBACK')
    } catch {
      /* 连接可能已坏 */
    }
    throw err
  }
}

export const kvStore = new EnestKvStore()

/** 便捷包装，供 IPC handler 使用（需在 initDatabase 之后） */
export function kvGet(key: string): string | null {
  return kvStore.kvGet(key)
}

export function kvSet(key: string, value: string): void {
  kvStore.kvSet(key, value)
}

export function kvDelete(key: string): void {
  kvStore.kvDelete(key)
}
