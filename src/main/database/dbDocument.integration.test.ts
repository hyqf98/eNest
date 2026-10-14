/** ENEST_DB_INTEGRATION=redis|mongodb|influxdb|tdengine plus ENEST_DB_PORT and optional credentials. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { dbOpen, dbClose, dbExecute, dbCancel, dbSchemaDescribe, dbSchemaTree } from '@main/database/dbService'
import { dbWorkbenchService, driverDescriptors } from '@main/database/workbenchService'
import type { DbDriverId, QueryResult } from '@shared/types/ssh-db'

test('registered native drivers expose only implemented table/transaction capabilities', () => {
  const drivers = driverDescriptors()
  assert.ok(drivers.length >= 27)
  for (const name of ['mysql','postgres','mongodb','redis','influxdb','tdengine','scylladb']) assert.ok(drivers.some(driver => driver.id === name))
  for (const name of ['mongodb','redis','tdengine','cassandra','scylladb','influxdb','clickhouse']) assert.equal(drivers.find(driver => driver.id === name)?.capabilities.transaction.state, 'unsupported')
  assert.equal(drivers.find(driver => driver.id === 'mssql')?.capabilities.compare.state, 'unsupported')
  assert.equal(drivers.find(driver => driver.id === 'mysql')?.capabilities.tableDesign.state, 'available')
})

for (const driver of ['redis','mongodb','influxdb','tdengine'] as const) test(`${driver}: actual native query, schema and bounded results`, { skip: process.env.ENEST_DB_INTEGRATION !== driver, timeout: 40000 }, async () => {
  const config = { driver: driver as DbDriverId, host: '127.0.0.1', port: Number(process.env.ENEST_DB_PORT), username: process.env.ENEST_DB_USER, ephemeralSecret: process.env.ENEST_DB_PASSWORD, database: process.env.ENEST_DB_DATABASE || 'enest_test', org: process.env.ENEST_DB_ORG, bucket: process.env.ENEST_DB_BUCKET }
  if (driver === 'redis') config.database = '0'
  if (driver === 'tdengine') { assert.match(config.database, /^[a-zA-Z0-9_]+$/); const setup = await fetch(`http://127.0.0.1:${config.port}/rest/sql`, { method: 'POST', headers: { Authorization: `Basic ${Buffer.from(`${config.username}:${config.ephemeralSecret}`).toString('base64')}` }, body: `CREATE DATABASE IF NOT EXISTS ${config.database}` }); assert.equal(setup.status, 200) }
  const opened = await dbOpen('document-test', config), sessionKey = opened.sessionKey, name = `enest_test_${Date.now()}`
  const exec = (sql: string, maxRows?: number) => dbExecute('document-test', { sessionKey, sql, maxRows })
  try {
    if (driver === 'redis') {
      const command = (args: string[]) => exec(JSON.stringify(args))
      try {
        await command(['SET',name,'9007199254740992','EX','60'])
        assert.equal((await command(['INCR',name])).rows[0][0], '9007199254740993')
        const detail = await dbSchemaDescribe('document-test', { sessionKey, table: name })
        assert.equal(detail.metadata?.type, 'string'); assert.ok(Number(detail.metadata?.ttlSeconds) > 0)
        const scanned = await dbWorkbenchService('document-test', { action: 'redis.scan', input: { sessionKey, match: name, count: 200 } }) as { keys: string[]; cursor: string }
        assert.ok(scanned.keys.includes(name))
        assert.equal((await dbWorkbenchService('document-test', { action: 'browse', input: { sessionKey, table: { table: name } } }) as QueryResult).rows[0][0], '9007199254740993')
        const quick = await dbOpen('document-test', { ...config, options: { readOnly: true } })
        try { await assert.rejects(dbExecute('document-test', { sessionKey: quick.sessionKey, surface: 'quick', sql: JSON.stringify(['SET',name,'write']) }), /rejects writes/) } finally { await dbClose('document-test', quick.sessionKey) }
        await command(['DEL',name]); await command(['LPUSH',name,'a','b'])
        assert.deepEqual((await dbWorkbenchService('document-test', { action: 'browse', input: { sessionKey, table: { table: name } } }) as QueryResult).rows[0][0], ['b','a'])
      } finally { await command(['DEL',name]) }
    } else if (driver === 'mongodb') {
      const query = (operation: string, values: Record<string, unknown> = {}, maxRows?: number) => exec(JSON.stringify({ collection: name, operation, ...values }), maxRows)
      try {
        await query('insertOne', { document: { _id: 'a', n: { $numberLong: '9223372036854775807' }, amount: { $numberDecimal: '1.234567890123456789' } } })
        await query('insertOne', { document: { _id: 'b', n: { $numberLong: '2' } } })
        const result = await query('find', { sort: { _id: 1 } }, 1)
        assert.equal(result.rows.length,1); assert.equal(result.truncated,true)
        assert.deepEqual((result.rows[0][0] as Record<string,unknown>).n, { $numberLong: '9223372036854775807' })
        assert.deepEqual((result.rows[0][0] as Record<string,unknown>).amount, { $numberDecimal: '1.234567890123456789' })
        const detail = await dbSchemaDescribe('document-test', { sessionKey, table: name }); assert.ok(detail.columns.some(column => column.name === 'n')); assert.ok(detail.indexes?.some(index => index.name === '_id_'))
        const schemas = await dbSchemaTree('document-test', { sessionKey, parent: 'database', database: config.database }); assert.ok(schemas.some(node => node.name === name && node.type === 'collection'))
        await assert.rejects(query('aggregate', { pipeline: [{ $out: 'forbidden' }] }), /Writing aggregation/)
        const quick = await dbOpen('document-test', { ...config, options: { readOnly: true } })
        try { const read = await dbExecute('document-test', { sessionKey: quick.sessionKey, surface: 'quick', sql: JSON.stringify({ collection: name, operation: 'find' }) }); assert.equal(read.rows.length,2); await assert.rejects(dbExecute('document-test', { sessionKey: quick.sessionKey, surface: 'quick', sql: JSON.stringify({ collection: name, operation: 'deleteOne', filter: { _id: 'a' } }) }), /rejects writes/) } finally { await dbClose('document-test', quick.sessionKey) }
      } finally { await query('deleteOne', { filter: { _id: 'a' } }); await query('deleteOne', { filter: { _id: 'b' } }) }
    } else if (driver === 'influxdb') {
      const line = `${name} value=9223372036854775807i`
      const response = await fetch(`http://127.0.0.1:${config.port}/api/v2/write?org=${config.org}&bucket=${config.bucket}`, { method: 'POST', headers: { Authorization: `Token ${config.ephemeralSecret}` }, body: line })
      assert.equal(response.status, 204)
      const result = await exec(`from(bucket: ${JSON.stringify(config.bucket)}) |> range(start: -1h) |> filter(fn: (r) => r._measurement == ${JSON.stringify(name)})`)
      assert.equal(result.rows.length,1)
      assert.equal(result.rows[0][result.columns.findIndex(column => column.name === '_value')], '9223372036854775807')
      const schema = await dbSchemaTree('document-test', { sessionKey, parent: 'database', database: config.bucket }); assert.ok(schema.some(node => node.name === name))
    } else {
      try {
        await exec(`CREATE STABLE ${name}(ts TIMESTAMP, reading BIGINT) TAGS (location BINARY(20))`)
        await exec(`CREATE TABLE ${name}_child USING ${name} TAGS ('test')`)
        await exec(`INSERT INTO ${name}_child VALUES(NOW,9223372036854775807) (NOW+1s,2)`)
        const result = await exec(`SELECT * FROM ${name} ORDER BY ts`, 1)
        assert.equal(result.rows.length, 1); assert.equal(result.truncated, true)
        assert.equal(String(result.rows[0][1]), '9223372036854775807')
        const detail = await dbSchemaDescribe('document-test', { sessionKey, table: name }); assert.equal((detail.metadata?.tags as Array<{ name: string }>)[0]?.name,'location')
        const tree = await dbSchemaTree('document-test', { sessionKey, parent: 'database', database: config.database }); assert.ok(tree.some(node => node.name === name && node.type === 'supertable'))
      } finally { await exec(`DROP TABLE IF EXISTS ${name}`) }
      const pending = exec('SELECT * FROM information_schema.ins_tables'); const rejected = assert.rejects(pending, /cancelled/)
      await dbCancel('document-test', sessionKey); await rejected
      await assert.rejects(exec('SELECT 1'), /closed/)
      const reopened = await dbOpen('document-test', config); await dbClose('document-test', reopened.sessionKey)
    }
  } finally { await dbClose('document-test', sessionKey) }
})
