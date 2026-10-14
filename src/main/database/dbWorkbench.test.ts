import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isReadQuery, normalizeLimit, splitSql, ResultBudget } from '@main/database/queryPolicy'
import { buildCompletion } from '@main/database/completion'
import { nativeCompletion } from '@main/database/nativeCompletion'
import { rowChangeSql } from '@main/database/rowChanges'
import { compareResults } from '@main/database/compare'
import { dbOpen, dbClose, dbExecute, dbCancel, dbTransaction, dbApplyChanges } from '@main/database/dbService'
import { dbWorkbenchService } from '@main/database/workbenchService'
import type { QueryResult } from '@shared/types/ssh-db'

test('statement policy preserves delimiters and rejects write CTEs and quoted side effects', () => {
  assert.deepEqual(splitSql("-- heading\nSELECT ';'; SELECT $$semi;colon$$; /* tail */"), ["-- heading\nSELECT ';'", 'SELECT $$semi;colon$$'])
  assert.equal(isReadQuery('/* outer /* inner */ done */ WITH x AS (SELECT 1) SELECT * FROM x'), true)
  for (const sql of ['WITH x AS (DELETE FROM t RETURNING *) SELECT * FROM x', 'SELECT 1; DROP TABLE t', 'SELECT "pg_terminate_backend"(1)', 'SELECT `sys_exec`(1)', 'PRAGMA writable_schema=1', 'SELECT * INTO target FROM source']) assert.equal(isReadQuery(sql), false, sql)
  assert.throws(() => isReadQuery('SELECT 1 /*!50000 INTO OUTFILE \'x\' */'), /Executable/)
  assert.throws(() => splitSql("SELECT 'unfinished"), /Unterminated/)
  assert.equal(isReadQuery("SELECT 'DELETE pg_terminate_backend'"), true)
  assert.equal(normalizeLimit(10000, true), 200)
  assert.equal(normalizeLimit(-10), 1)
  assert.throws(() => new ResultBudget(2).add(['large']), /exceeds/)
})

test('row SQL quotes every identifier, binds values, and preserves optimistic NULL predicates', () => {
  const result = rowChangeSql({ type: 'update', table: { schema: 'odd.schema', table: 't"x' }, key: { id: '9223372036854775807' }, original: { value: null }, set: { value: "x'; DROP TABLE y" } }, 'postgres')
  assert.equal(result.sql, 'UPDATE "odd.schema"."t""x" SET "value" = $1 WHERE "value" IS NULL AND "id" = $2')
  assert.deepEqual(result.params, ["x'; DROP TABLE y", '9223372036854775807'])
  assert.throws(() => rowChangeSql({ type: 'delete', table: { table: 't' }, key: {} }, 'mysql'), /primary key/)
})

test('comparison is column-order independent and flags duplicate keys and partial results', () => {
  const result = (names: string[], rows: unknown[][]): QueryResult => ({ columns: names.map(name => ({ name })), rows, rowCount: rows.length, durationMs: 0 })
  const left = result(['id', 'n'], [['1', '9007199254740993'], ['2', null], ['2', 'x']])
  const right = result(['n', 'id'], [['9007199254740993', '1'], [null, '2'], ['other', '3']])
  left.truncated = true
  const compared = compareResults(left, right, ['id'])
  assert.deepEqual(compared.rows.map(row => row.status), ['equal', 'ambiguous', 'right-only'])
  assert.equal(compared.partial, true)
  assert.throws(() => compareResults(result(['id', 'id'], [[1,2]]), right, ['id']), /unique column/)
})

test('SQLite actual worker preserves integers, rolls back failed edits, and isolates Quick', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'enest-db-test-')), file = join(dir, 'data.sqlite')
  const opened = await dbOpen('test', { driver: 'sqlite', filePath: file, createIfMissing: true })
  const sessionKey = opened.sessionKey
  let quick: string | undefined
  try {
    await dbExecute('test', { sessionKey, sql: 'CREATE TABLE t(id INTEGER PRIMARY KEY, value TEXT); INSERT INTO t VALUES(9223372036854775807, NULL)' })
    const original = await dbExecute('test', { sessionKey, sql: 'SELECT * FROM t' })
    assert.equal(original.rows[0][0], '9223372036854775807')
    await dbTransaction('test', { sessionKey, operation: 'begin' })
    await dbExecute('test', { sessionKey, sql: "UPDATE t SET value='pending'" })
    quick = (await dbOpen('test', { driver: 'sqlite', filePath: file, options: { readOnly: true } })).sessionKey
    assert.equal((await dbExecute('test', { sessionKey: quick, sql: 'SELECT value FROM t', surface: 'quick' })).rows[0][0], null)
    await assert.rejects(dbExecute('test', { sessionKey: quick, sql: 'SELECT 1; SELECT 2', surface: 'quick' }), /one read-only/)
    await assert.rejects(dbExecute('test', { sessionKey: quick, sql: 'DELETE FROM t', surface: 'quick' }), /rejects writes/)
    await assert.rejects(dbExecute('test', { sessionKey, sql: 'SELECT 1', surface: 'quick' }), /separate console/)
    await dbTransaction('test', { sessionKey, operation: 'rollback' })
    const batch = await dbApplyChanges('test', { sessionKey, mode: 'stop-on-error', changes: [
      { type: 'insert', table: { table: 't' }, values: { id: 2, value: 'must roll back' } },
      { type: 'update', table: { table: 't' }, key: { id: 404 }, set: { value: 'missing' } }
    ] })
    assert.equal(batch.ok, false)
    assert.equal((await dbExecute('test', { sessionKey, sql: 'SELECT count(*) FROM t' })).rows[0][0], '1')
    const capped = await dbExecute('test', { sessionKey: quick, sql: 'WITH RECURSIVE s(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM s WHERE n<500) SELECT n FROM s', maxRows: 900, surface: 'quick' })
    assert.equal(capped.rows.length, 200); assert.equal(capped.truncated, true)
    const compared = await dbWorkbenchService('test', { action: 'compare', input: { left: { sessionKey, sql: 'SELECT * FROM t' }, right: { sessionKey: quick, sql: 'SELECT * FROM t' }, keyColumns: ['id'] } }) as { rows: Array<{ status: string }> }
    assert.equal(compared.rows[0].status, 'equal')
  } finally { await dbClose('test', sessionKey); if (quick) await dbClose('test', quick); await rm(dir, { recursive: true, force: true }) }
})

test('SQLite cancellation ends the worker and prevents late successful results', async () => {
  const { sessionKey } = await dbOpen('test', { driver: 'sqlite', filePath: ':memory:' })
  try {
    const running = dbExecute('test', { sessionKey, executionId: 'cancel_test', sql: 'WITH RECURSIVE s(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM s WHERE n<1000000) SELECT sum(n) FROM s' })
    const rejected = assert.rejects(running, /cancelled/)
    await new Promise(resolve => setTimeout(resolve, 30))
    await dbCancel('test', { sessionKey, executionId: 'cancel_test' })
    await rejected
    await assert.rejects(dbExecute('test', { sessionKey, sql: 'SELECT 1' }), /closed/)
  } finally { await dbClose('test', sessionKey) }
})

test('DuckDB native execution supports capped scans, exact integers, and rollback', async () => {
  const { sessionKey } = await dbOpen('test', { driver: 'duckdb' })
  try {
    await dbExecute('test', { sessionKey, sql: 'CREATE TABLE t(id BIGINT); INSERT INTO t VALUES(9223372036854775807)' })
    assert.equal((await dbExecute('test', { sessionKey, sql: 'SELECT id FROM t' })).rows[0][0], '9223372036854775807')
    await dbTransaction('test', { sessionKey, operation: 'begin' })
    await dbExecute('test', { sessionKey, sql: 'DELETE FROM t' })
    await dbTransaction('test', { sessionKey, operation: 'rollback' })
    assert.equal((await dbExecute('test', { sessionKey, sql: 'SELECT * FROM t' })).rows.length, 1)
    const result = await dbExecute('test', { sessionKey, sql: 'SELECT * FROM range(10000)', maxRows: 3 })
    assert.equal(result.rows.length, 3); assert.equal(result.truncated, true)
  } finally { await dbClose('test', sessionKey) }
})


test('SQL completion prioritizes WHERE columns and preserves quoted table aliases and dialect quoting', () => {
  const catalog = { dialect: 'postgres', databases: [], schemas: ['public'], tables: [{ name: 'table name', schema: 'public', columns: [{ name: 'value' }, { name: 'odd name' }] }] }
  const sql = 'SELECT * FROM "table name" AS t WHERE val'
  const result = buildCompletion({ driverId: 'postgres', input: { sessionKey: 'test', sql }, catalog })
  assert.ok(result.items.some(item => item.label === 'value'))
  const quoted = buildCompletion({ driverId: 'postgres', input: { sessionKey: 'test', sql: 'SELECT * FROM "table name" AS t WHERE t.odd' }, catalog })
  assert.ok(quoted.items.some(item => item.insertText === '"odd name"'))
  const redis = nativeCompletion('redis', { sessionKey: 'test', sql: '' }, null)!
  assert.ok(redis.items.some(item => item.label === 'SCAN'))
  assert.equal(redis.items.some(item => item.label === 'SELECT'), false)
})
