import type { DbDriver } from '@main/database/drivers'
import type { RowChange } from '@shared/types/ssh-db'
import { quoteIdentifier } from '@main/database/queryPolicy'

export function rowChangeSql(change: RowChange, flavor: 'mysql' | 'postgres' | 'sqlite'): { sql: string; params: unknown[] } {
  const q = (name: string) => quoteIdentifier(name, flavor)
  const table = [flavor === 'mysql' ? change.table.database : change.table.schema, change.table.table].filter(Boolean).map(name => q(name!)).join('.')
  const params: unknown[] = []
  const bind = (value: unknown) => { params.push(value); return flavor === 'postgres' ? `$${params.length}` : '?' }
  if (change.type === 'insert') {
    const names = Object.keys(change.values)
    if (!names.length) throw new Error('No columns to insert')
    return { sql: `INSERT INTO ${table} (${names.map(q).join(', ')}) VALUES (${names.map(name => bind(change.values[name])).join(', ')})`, params }
  }
  if (!Object.keys(change.key).length) throw new Error('Update/delete requires an unambiguous primary key')
  const set = change.type === 'update' ? Object.entries(change.set).map(([name, value]) => `${q(name)} = ${bind(value)}`).join(', ') : ''
  if (change.type === 'update' && !set) throw new Error('No columns to update')
  const condition = { ...(change.type === 'update' ? change.original : {}), ...change.key }
  const where = Object.entries(condition).map(([name, value]) => value === null ? `${q(name)} IS NULL` : `${q(name)} = ${bind(value)}`).join(' AND ')
  return { sql: `${change.type === 'update' ? `UPDATE ${table} SET ${set}` : `DELETE FROM ${table}`} WHERE ${where}`, params }
}

export function attachRowEditing(driver: DbDriver, flavor: 'mysql' | 'postgres' | 'sqlite'): void {
  driver.applyBatch = async (h, changes, mode) => {
    if (h.readOnly) throw new Error('Read-only connection rejects changes')
    if (!driver.transaction) throw new Error('Safe row editing requires transaction support')
    if (changes.length > 10000) throw new Error('Batch limit is 10000 changes')
    const started = Date.now(), ownTransaction = !h.runtime?.transaction
    if (ownTransaction) await driver.transaction(h, 'begin')
    const results: import('@shared/types/ssh-db').BatchResultItem[] = []
    try {
      await driver.execute(h, 'SAVEPOINT enest_batch')
      for (let index = 0; index < changes.length; index++) {
        await driver.execute(h, 'SAVEPOINT enest_row')
        try {
          const statement = rowChangeSql(changes[index]!, flavor)
          const result = await driver.execute(h, statement.sql, { params: statement.params })
          if (changes[index]!.type !== 'insert' && result.affectedRows !== 1) throw new Error('Row changed or key is not unique; refresh before editing')
          await driver.execute(h, 'RELEASE SAVEPOINT enest_row')
          results.push({ index, ok: true, affected: result.affectedRows, sql: statement.sql })
        } catch (error) {
          await driver.execute(h, 'ROLLBACK TO SAVEPOINT enest_row')
          await driver.execute(h, 'RELEASE SAVEPOINT enest_row')
          results.push({ index, ok: false, error: (error as Error).message })
          if (mode === 'stop-on-error') {
            await driver.execute(h, 'ROLLBACK TO SAVEPOINT enest_batch')
            for (const result of results) if (result.ok) { result.ok = false; result.error = 'Batch rolled back after an error'; result.affected = 0 }
            break
          }
        }
      }
      await driver.execute(h, 'RELEASE SAVEPOINT enest_batch')
      if (ownTransaction) await driver.transaction(h, 'commit')
      return { ok: results.every(result => result.ok), results, durationMs: Date.now() - started }
    } catch (error) {
      if (ownTransaction) await driver.transaction(h, 'rollback').catch(() => undefined)
      else await driver.execute(h, 'ROLLBACK TO SAVEPOINT enest_batch').catch(() => undefined)
      throw error
    }
  }
}
