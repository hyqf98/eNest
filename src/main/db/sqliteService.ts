/**
 * sqliteService — 壳子共享 KV 存储（真 SQLite）
 * 职责：在 ~/eNest/data/enest.db 上提供同步式 KV API。
 * 实现：Electron 主进程使用 sql.js（SQLite 官方 WASM 编译），
 *      避免 better-sqlite3 原生 ABI 与 Electron 不一致导致的 SIGSEGV。
 * 持久化：每次写入后将内存库 export 为二进制写回 enest.db。
 * 被 index.ts（启动 init）、shellHandlers（shell:query-db）调用。
 * 插件 storage.local 不走本库，文件在 data/plugin-storage/{id}.json。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { getAppPaths } from '@main/paths/pathsService'

type Backend = 'sqlite' | 'none'

/** sql.js Database 最小面 */
interface SqlJsDatabase {
  run(sql: string, params?: unknown[]): void
  exec(sql: string): unknown
  prepare(sql: string): {
    bind(params?: unknown[]): void
    step(): boolean
    getAsObject(): Record<string, unknown>
    free(): void
  }
  export(): Uint8Array
  close(): void
}

type SqlJsStatic = {
  Database: new (data?: ArrayLike<number> | null) => SqlJsDatabase
}

const nodeRequire = createRequire(import.meta.url)

/** 定位打包进 resources 的 wasm（dev 与 asar 内路径不同） */
function resolveWasmPath(): string {
  const candidates: string[] = []
  // electron-vite / 源码运行：项目根 assets/sql
  try {
    const here = dirname(fileURLToPathSafe())
    candidates.push(join(here, '../../assets/sql/sql-wasm.wasm'))
    candidates.push(join(process.cwd(), 'assets/sql/sql-wasm.wasm'))
  } catch {
    /* ignore */
  }
  // 安装包：extraResources → process.resourcesPath/sql
  if (process.resourcesPath) {
    candidates.push(join(process.resourcesPath, 'sql/sql-wasm.wasm'))
  }
  for (const p of candidates) {
    if (p && existsSync(p)) return p
  }
  // 回退到 node_modules（开发期）
  try {
    const pkg = nodeRequire.resolve('sql.js/package.json')
    return join(dirname(pkg), 'dist', 'sql-wasm.wasm')
  } catch {
    return 'sql-wasm.wasm'
  }
}

function fileURLToPathSafe(): string {
  // main bundle 里 __dirname 可能不存在；用 import.meta 若可用
  try {
    return nodeRequire('url').fileURLToPath(import.meta.url)
  } catch {
    return join(process.cwd(), 'out/main')
  }
}

async function loadSqlJs(): Promise<SqlJsStatic> {
  const initSqlJs = nodeRequire('sql.js') as (cfg?: {
    locateFile?: (f: string) => string
  }) => Promise<SqlJsStatic>
  const wasm = resolveWasmPath()
  return initSqlJs({
    locateFile: (file: string) => (file.endsWith('.wasm') ? wasm : file)
  })
}

export class EnestKvStore {
  private backend: Backend = 'none'
  private db: SqlJsDatabase | null = null
  private dbPath = ''
  private ready = false
  private initPromise: Promise<Backend> | null = null

  getBackend(): Backend {
    return this.backend
  }

  /** 异步初始化；重复调用返回同一 Promise */
  initDatabase(path: string = getAppPaths().database): Promise<Backend> {
    if (this.initPromise) return this.initPromise
    this.initPromise = this.doInit(path)
    return this.initPromise
  }

  private async doInit(path: string): Promise<Backend> {
    this.dbPath = path
    mkdirSync(dirname(path), { recursive: true })
    try {
      const SQL = await loadSqlJs()
      const buf = existsSync(path) ? readFileSync(path) : null
      this.db = new SQL.Database(buf && buf.length ? new Uint8Array(buf) : null)
      this.db.run(
        'CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)'
      )
      this.persist()
      this.backend = 'sqlite'
      this.ready = true
      return this.backend
    } catch (err) {
      console.error('[enest] sqlite init failed', err)
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

  private persist(): void {
    if (!this.db) return
    const data = this.db.export()
    mkdirSync(dirname(this.dbPath), { recursive: true })
    writeFileSync(this.dbPath, Buffer.from(data))
  }

  kvGet(key: string): string | null {
    this.ensureReady()
    const stmt = this.db!.prepare('SELECT value FROM kv WHERE key = ?')
    stmt.bind([key])
    try {
      if (!stmt.step()) return null
      const row = stmt.getAsObject()
      return typeof row.value === 'string' ? row.value : null
    } finally {
      stmt.free()
    }
  }

  kvSet(key: string, value: string): void {
    this.ensureReady()
    this.db!.run('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [
      key,
      value
    ])
    this.persist()
  }

  kvDelete(key: string): void {
    this.ensureReady()
    this.db!.run('DELETE FROM kv WHERE key = ?', [key])
    this.persist()
  }

  kvKeys(prefix = ''): string[] {
    this.ensureReady()
    const stmt = this.db!.prepare(
      prefix
        ? 'SELECT key FROM kv WHERE key LIKE ? ORDER BY key'
        : 'SELECT key FROM kv ORDER BY key'
    )
    stmt.bind(prefix ? [`${prefix}%`] : [])
    const out: string[] = []
    try {
      while (stmt.step()) {
        const row = stmt.getAsObject()
        if (typeof row.key === 'string') out.push(row.key)
      }
    } finally {
      stmt.free()
    }
    return out
  }

  close(): void {
    try {
      this.persist()
      this.db?.close()
    } catch {
      /* ignore */
    }
    this.db = null
    this.ready = false
    this.initPromise = null
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
