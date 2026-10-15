/** Real adapters only. ENEST_DB_INTEGRATION=mysql|postgres|sqlite selects one target.
 * Reuse ENEST_DB_HOST/PORT/USER/PASSWORD/DATABASE from dbRelational.integration.test.ts. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { dbOpen, dbClose, dbExecute, dbTransaction, dbListSessions, dbCancel } from '@main/database/dbService'
import type { QueryResult } from '@shared/types/ssh-db'

const owner = 'sql-script-integration'
const records = (result: QueryResult) => result.results || [result]
for (const driver of ['mysql', 'postgres', 'sqlite'] as const) test(`${driver}: compound scripts preserve units, state, results and cancellation`, { skip: process.env.ENEST_DB_INTEGRATION !== driver, timeout: 45000 }, async () => {
  const config = driver === 'sqlite' ? { driver, filePath: ':memory:' } : { driver, host: process.env.ENEST_DB_HOST || '127.0.0.1', port: Number(process.env.ENEST_DB_PORT), username: process.env.ENEST_DB_USER, ephemeralSecret: process.env.ENEST_DB_PASSWORD, database: process.env.ENEST_DB_DATABASE }
  const { sessionKey } = await dbOpen(owner, config)
  const name = `enest_script_${Date.now()}`, routine = `${name}_routine`, failing = `${name}_failure`, trigger = `${name}_trigger`
  const exec = (sql: string, maxRows?: number) => dbExecute(owner, { sessionKey, sql, maxRows })
  let quick: string | undefined
  try {
    await exec(`CREATE TABLE ${name}(id INTEGER PRIMARY KEY, note VARCHAR(80))`)
    if (driver === 'mysql') {
      await exec(`SET @enest_value = 7; CREATE TEMPORARY TABLE ${name}_temp(value INT); INSERT INTO ${name}_temp VALUES(@enest_value);`)
      assert.equal(Number((await exec(`SELECT value FROM ${name}_temp`)).rows[0][0]), 7)
      const result = await exec(`DELIMITER $$\nCREATE PROCEDURE ${routine}() BEGIN SELECT 1 AS left_value UNION ALL SELECT 2 UNION ALL SELECT 3; INSERT INTO ${name} VALUES(1, 'after limited result'); SELECT 9 AS right_value; END$$\nDELIMITER ;\nCALL ${routine}(); SELECT count(*) AS total FROM ${name};`, 1)
      const sets = records(result)
      assert.equal(sets.find(set => set.columns[0]?.name === 'left_value')?.truncated, true)
      assert.equal(Number(sets.find(set => set.columns[0]?.name === 'right_value')?.rows[0][0]), 9)
      assert.equal(Number(sets.find(set => set.columns[0]?.name === 'total')?.rows[0][0]), 1)
      assert.ok(sets.every(set => !/DELIMITER/.test(set.sql || '')))
      await assert.rejects(exec(`INSERT INTO ${name} VALUES(2,'must not run');\nDELIMITER broken\nSELECT 1;`), /Invalid DELIMITER/)
      assert.equal(Number((await exec(`SELECT count(*) FROM ${name}`)).rows[0][0]), 1)
      // An error after START TRANSACTION has no final OK packet. The console must still
      // expose rollback on the exact physical connection that owns the pending insert.
      await exec(`DELIMITER //\nCREATE PROCEDURE ${failing}() BEGIN START TRANSACTION; INSERT INTO ${name} VALUES(2,'pending'); SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='fixture failure'; END//\nDELIMITER ;`)
      await assert.rejects(exec(`CALL ${failing}()`), /fixture failure/)
      assert.equal(dbListSessions(owner).find(session => session.sessionKey === sessionKey)?.transactionActive, true)
      await dbTransaction(owner, { sessionKey, operation: 'rollback' })
      assert.equal(Number((await exec(`SELECT count(*) FROM ${name}`)).rows[0][0]), 1)
      await dbTransaction(owner, { sessionKey, operation: 'begin' })
      await assert.rejects(exec(`UPDATE ${name} SET note='must not run'; CREATE TABLE ${name}_blocked(id INT)`), /implicitly commit/)
      assert.equal((await exec(`SELECT note FROM ${name}`)).rows[0][0], 'after limited result')
      await dbTransaction(owner, { sessionKey, operation: 'rollback' })
    } else if (driver === 'postgres') {
      const result = await exec(`CREATE FUNCTION ${routine}() RETURNS TEXT AS $body$ BEGIN RETURN 'inside;body'; END; $body$ LANGUAGE plpgsql; DO $guard$ BEGIN IF FALSE THEN DELETE FROM ${name}; END IF; INSERT INTO ${name} VALUES(1, 'from block'); END; $guard$; SELECT ${routine}() AS value; SELECT 'C:\\' AS path;`)
      assert.equal(records(result).find(set => set.columns[0]?.name === 'value')?.rows[0][0], 'inside;body')
      assert.equal(records(result).find(set => set.columns[0]?.name === 'path')?.rows[0][0], 'C:\\')
      await assert.rejects(exec(`INSERT INTO ${name} VALUES(2, 'must not run'); DO $bad$ BEGIN NULL; END;`), /Unterminated/)
      assert.equal(Number((await exec(`SELECT count(*) FROM ${name}`)).rows[0][0]), 1)
    } else {
      await exec(`CREATE TABLE ${name}_audit(note TEXT); CREATE TRIGGER ${trigger} AFTER INSERT ON ${name} BEGIN INSERT INTO ${name}_audit VALUES('first;step'); UPDATE ${name} SET note=CASE WHEN NEW.id=1 THEN 'triggered' ELSE note END WHERE id=NEW.id; END; INSERT INTO ${name} VALUES(1, 'initial');`)
      assert.equal((await exec(`SELECT note FROM ${name}`)).rows[0][0], 'triggered')
      assert.equal((await exec(`SELECT note FROM ${name}_audit`)).rows[0][0], 'first;step')
      await assert.rejects(exec(`INSERT INTO ${name} VALUES(2,'must not run'); /* unclosed`), /Unterminated/)
      assert.equal(Number((await exec(`SELECT count(*) FROM ${name}`)).rows[0][0]), 1)
    }
    if (driver !== 'sqlite') {
      quick = (await dbOpen(owner, { ...config, options: { readOnly: true } })).sessionKey
      await assert.rejects(dbExecute(owner, { sessionKey: quick, surface: 'quick', sql: driver === 'mysql' ? `DELIMITER $$\nCALL ${routine}()$$\nDELIMITER ;` : `DO $$ BEGIN DELETE FROM ${name}; END; $$;` }), /rejects writes/)
      const executionId = `${driver}_script_cancel`
      const pending = dbExecute(owner, { sessionKey, executionId, sql: `${driver === 'mysql' ? 'SELECT SLEEP(10)' : 'SELECT pg_sleep(10)'}; INSERT INTO ${name} VALUES(99,'cancelled tail');` })
      const rejected = assert.rejects(pending, /cancelled/)
      await new Promise(resolve => setTimeout(resolve, 100)); await dbCancel(owner, { sessionKey, executionId }); await rejected
      assert.equal(Number((await exec(`SELECT count(*) FROM ${name} WHERE id=99`)).rows[0][0]), 0)
    }
    await assert.rejects(exec(`SELECT 1;\nSELECT * FROM ${name}_missing;`), /SQL unit 2 \(lines 2–2\)/)
  } finally {
    await dbTransaction(owner, { sessionKey, operation: 'rollback' }).catch(() => undefined)
    if (quick) await dbClose(owner, quick)
    if (driver === 'mysql') await exec(`DROP PROCEDURE IF EXISTS ${routine}; DROP PROCEDURE IF EXISTS ${failing}`).catch(() => undefined)
    if (driver === 'postgres') await exec(`DROP FUNCTION IF EXISTS ${routine}()`).catch(() => undefined)
    await exec(`DROP TABLE IF EXISTS ${name}`).catch(() => undefined)
    await dbClose(owner, sessionKey)
  }
})
