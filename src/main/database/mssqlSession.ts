import type { ConnectionPool } from 'mssql'

/** mssql's documented Request/Transaction parent contract is acquire/release/config.
 * Retaining one physical connection gives GO batches the same temporary-table/session
 * semantics as a SQL console. It must be released before closing the owning pool. */
export async function pinMssqlSession(pool: ConnectionPool): Promise<{ parent: ConnectionPool; release: () => void }> {
  const owner = pool as ConnectionPool & {
    config: unknown
    acquire(requester: object): Promise<unknown>
    release(connection: unknown): void
  }
  const connection = await owner.acquire({})
  const parent = Object.create(pool) as ConnectionPool
  let released = false
  Object.assign(parent, {
    acquire(_request: unknown, callback: (error: Error | null, connection?: unknown, config?: unknown) => void) {
      queueMicrotask(() => callback(released ? new Error('SQL Server console is closed') : null, connection, owner.config))
    },
    release() { /* Request completion does not release the console's connection. */ }
  })
  return { parent, release() { if (!released) { released = true; owner.release(connection) } } }
}
