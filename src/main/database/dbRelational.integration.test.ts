/** Run with ENEST_DB_INTEGRATION=mysql|postgres and ENEST_DB_PORT/USER/PASSWORD/DATABASE. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { dbOpen, dbClose, dbExecute, dbCancel, dbTransaction, dbApplyChanges, dbSchemaDescribe, dbSchemaDdl, dbCompletion } from '@main/database/dbService'
import { dbWorkbenchService } from '@main/database/workbenchService'
import type { DbDriverId, QueryResult } from '@shared/types/ssh-db'

for (const driver of ['mysql','postgres'] as const) test(`${driver}: native transaction, precision, editing, metadata, cancellation, Quick and table design`, { skip: process.env.ENEST_DB_INTEGRATION !== driver, timeout: 45000 }, async () => {
  const config = { driver: driver as DbDriverId, host: process.env.ENEST_DB_HOST || '127.0.0.1', port: Number(process.env.ENEST_DB_PORT), username: process.env.ENEST_DB_USER, ephemeralSecret: process.env.ENEST_DB_PASSWORD, database: process.env.ENEST_DB_DATABASE }
  const main = await dbOpen('native-test', config), sessionKey = main.sessionKey
  const quick = await dbOpen('native-test', { ...config, options: { readOnly: true } })
  const table = `enest_test_${Date.now()}`, parent = `${table}_parent`, index = `${table}_idx`
  const ref = { table, ...(driver === 'mysql' ? { database: config.database } : { schema: 'public' }) }
  const exec = async (sql: string) => { if (process.env.ENEST_DB_TRACE) console.log(sql); const r = await dbExecute('native-test', { sessionKey, sql }); if (process.env.ENEST_DB_TRACE) console.log('done'); return r }
  try {
    await exec(`CREATE TABLE ${parent}(id BIGINT PRIMARY KEY); INSERT INTO ${parent} VALUES(1)`)
    await dbWorkbenchService('native-test', { action: 'table.design.apply', input: { sessionKey, confirmed: true, design: { operation: 'create-table', table: ref, columns: [{ name: 'id', type: 'bigint', nullable: false }, { name: 'parent_id', type: 'bigint' }, { name: 'value', type: 'varchar', length: 80, default: { kind: 'literal', value: "a'b\\c" } }], primaryKey: ['id'], foreignKeys: [{ name: `${table}_fk`, columns: ['parent_id'], references: { table: parent }, referencedColumns: ['id'] }] } } })
    await exec(`INSERT INTO ${table}(id,parent_id) VALUES(9223372036854775807,1)`)
    const original = await exec(`SELECT * FROM ${table}`)
    assert.equal(original.rows[0][0], '9223372036854775807')
    assert.equal(original.rows[0][2], "a'b\\c")
    const details = await dbSchemaDescribe('native-test', { sessionKey, ...ref })
    assert.deepEqual(details.primaryKey, ['id'])
    assert.deepEqual(details.foreignKeys?.[0].columns, ['parent_id'])
    assert.equal(details.foreignKeys?.[0].referencedTable, parent)
    const ddl = await dbSchemaDdl('native-test', { sessionKey, ...ref })
    assert.match(ddl, /PRIMARY KEY/); assert.match(ddl, /FOREIGN KEY/)
    const completion = await dbCompletion('native-test', { sessionKey, sql: `SELECT * FROM ${table} WHERE val`, cursor: `SELECT * FROM ${table} WHERE val`.length })
    assert.ok(completion.items.some(item => item.label.includes('value')))
    await dbTransaction('native-test', { sessionKey, operation: 'begin' })
    await exec(`UPDATE ${table} SET value='pending'`)
    const independent = await dbExecute('native-test', { sessionKey: quick.sessionKey, sql: `SELECT value FROM ${table}`, surface: 'quick' })
    assert.equal(independent.rows[0][0], "a'b\\c")
    await assert.rejects(dbWorkbenchService('native-test', { action: 'table.design.apply', input: { sessionKey, confirmed: true, design: { operation: 'drop-column', table: ref, column: 'value' } } }), /Finish the current transaction/)
    await dbTransaction('native-test', { sessionKey, operation: 'rollback' })
    const batch = await dbApplyChanges('native-test', { sessionKey, mode: 'stop-on-error', changes: [{ type: 'insert', table: ref, values: { id: '2', value: 'rollback' } }, { type: 'update', table: ref, key: { id: '404' }, set: { value: 'missing' } }] })
    assert.equal(batch.ok, false)
    assert.equal(Number((await exec(`SELECT count(*) FROM ${table}`)).rows[0][0]), 1)
    await dbWorkbenchService('native-test', { action: 'table.design.apply', input: { sessionKey, confirmed: true, design: { operation: 'create-index', table: ref, name: index, columns: ['value'] } } })
    const page = await dbWorkbenchService('native-test', { action: 'table.page', input: { sessionKey, table: ref, limit: 1, filters: [{ column: 'value', operator: 'contains', value: "'b" }], order: [{ column: 'id', direction: 'desc' }] } }) as QueryResult & { page: { stableOrder: boolean } }
    assert.equal(page.rows.length, 1); assert.equal(page.page.stableOrder, true)
    const inspected = await dbWorkbenchService('native-test', { action: 'inspect', input: { sessionKey, kind: 'resources' } }) as { state: string; columns: Array<{ name: string; unit?: string }>; rows: unknown[][] }
    assert.equal(inspected.state, 'available'); assert.ok(inspected.columns.some(column => column.unit))
    const many = driver === 'mysql' ? 'WITH RECURSIVE s(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM s WHERE n<500) SELECT n FROM s' : 'SELECT * FROM generate_series(1,500)'
    const capped = await dbExecute('native-test', { sessionKey: quick.sessionKey, sql: many, maxRows: 900, surface: 'quick' })
    assert.equal(capped.rows.length, 200); assert.equal(capped.truncated, true)
    await assert.rejects(dbExecute('native-test', { sessionKey: quick.sessionKey, sql: `DELETE FROM ${table}`, surface: 'quick' }), /rejects writes/)
    const running = dbExecute('native-test', { sessionKey, executionId: 'cancel_native', sql: driver === 'mysql' ? 'SELECT SLEEP(10)' : 'SELECT pg_sleep(10)' })
    const rejected = assert.rejects(running, /cancelled/)
    await new Promise(resolve => setTimeout(resolve, 100))
    await dbCancel('native-test', { sessionKey, executionId: 'cancel_native' }); await rejected
    assert.equal(Number((await exec('SELECT 1')).rows[0][0]), 1)
  } catch (error) { console.error(error); throw error } finally {
    await dbTransaction('native-test', { sessionKey, operation: 'rollback' }).catch(() => undefined)
    await dbClose('native-test', quick.sessionKey)
    await exec(`DROP TABLE IF EXISTS ${table}; DROP TABLE IF EXISTS ${parent}`).catch(() => undefined)
    await dbClose('native-test', sessionKey)
  }
})
