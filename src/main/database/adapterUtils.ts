import type { DbDriver, DriverExecuteOptions, DriverHandle } from '@main/database/drivers'
import type { DbDriverId, QueryResult, SchemaObject } from '@shared/types/ssh-db'
import { normalizeLimit, wireValue, ResultBudget } from '@main/database/queryPolicy'

export function tableResult(sql: string, started: number, names: string[], rows: unknown[][], limit?: number): QueryResult {
  const max = normalizeLimit(limit)
  const budget = new ResultBudget(); for (const row of rows.slice(0, max)) budget.add(row)
  return { sql, columns: names.map(name => ({ name })), rows: rows.slice(0, max).map(row => row.map(wireValue)), rowCount: Math.min(max, rows.length), truncated: rows.length > max, durationMs: Date.now() - started }
}
export function objectResult(sql: string, started: number, rows: Record<string, unknown>[], limit?: number): QueryResult {
  const names = [...new Set(rows.flatMap(row => Object.keys(row)))]
  return tableResult(sql, started, names, rows.map(row => names.map(name => row[name] ?? null)), limit)
}
export function abortCheck(opts?: DriverExecuteOptions): void { opts?.signal?.throwIfAborted() }
export function unsupported(feature: string): never { throw new Error(`${feature} is not supported by this driver`) }

/** Every advertised adapter has a real open/test/execute implementation. Optional features default unavailable. */
export function adapterBase(id: DbDriverId, label: string, dialect: string, defaultPort?: number): DbDriver {
  const driver: DbDriver = {
    id, label, dialect, defaultPort,
    capabilities: { multiStatement: false, explain: false, schemas: false, timeSeries: false, fileBased: false, updatableResult: false, ddl: false, import: false },
    async open() { return unsupported('Connection') },
    async close() {},
    async execute() { return unsupported('Query') },
    async test(config, password) {
      const started = Date.now(); let handle: DriverHandle | undefined
      try { handle = await driver.open(config, password); return { ok: true, message: 'Connected', latencyMs: Date.now() - started } }
      catch (error) { return { ok: false, message: (error as Error).message, latencyMs: Date.now() - started } }
      finally { if (handle) await driver.close(handle).catch(() => undefined) }
    },
    async listDatabases(h) { return h.database ? [h.database] : [] },
    async listSchemas() { return [] },
    async listTables() { return unsupported('Object discovery') },
    async describeTable() { return unsupported('Object description') },
    async completionCatalog(h, scope) {
      const tables = await driver.listTables(h, scope)
      return { dialect, databases: await driver.listDatabases(h), schemas: await driver.listSchemas(h, scope.database), tables: tables.map((t: SchemaObject) => ({ name: t.name, schema: t.schema, type: t.type, columns: [] })) }
    }
  }
  return driver
}

export function endpoint(h: { config: { host?: string; port?: number; options?: Record<string, unknown> } }, port: number): string {
  const { config } = h
  const url = new URL(String(config.options?.endpoint || `${config.options?.ssl ? 'https' : 'http'}://${config.host || '127.0.0.1'}:${config.port ?? port}`))
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('HTTP endpoint must use http or https')
  return url.href.replace(/\/$/, '')
}
