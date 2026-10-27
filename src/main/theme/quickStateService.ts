import { kvStore, runInTransaction } from '@main/db/sqliteService'
import { QuickProviderStateStore } from './quickProviderState'

/** A native persistence adapter only; provider schemas and retention live in their themes. */
export const quickProviderStates = new QuickProviderStateStore({
  get: key => kvStore.kvGet(key),
  set: (key, value) => kvStore.kvSet(key, value),
  deletePrefix: prefix => {
    const db = kvStore.getDatabase()
    if (!db) throw new Error('Quick state storage unavailable')
    const keys = kvStore.kvKeys(prefix).filter(key => key.startsWith(prefix))
    runInTransaction(db, () => { for (const key of keys) kvStore.kvDelete(key) })
  }
})
