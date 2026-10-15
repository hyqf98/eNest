import assert from 'node:assert/strict'
import test from 'node:test'
import { assertValidScript, planSqlScript, maskSql } from '@main/database/sqlScript'
import { isReadQuery, splitSql } from '@main/database/queryPolicy'
import { transactionCommand, validateExecutionPlan } from '@main/database/executionPolicy'

const sqlUnits = (source: string, dialect: string) => planSqlScript(source, dialect).filter(unit => unit.kind !== 'directive')

test('MySQL DELIMITER supports compound definitions and keeps source diagnostics', () => {
  const source = "-- start\r\nDELIMITER $$\r\nCREATE PROCEDURE p() BEGIN IF 1 THEN SELECT ';$$'; END IF; SELECT 2; END$$\r\nDELIMITER ;\r\nCALL p();"
  const plan = planSqlScript(source, 'mysql'); assertValidScript(plan)
  assert.equal(plan.length, 4)
  assert.equal(plan[1].line, 3)
  assert.equal(plan[1].sql, "CREATE PROCEDURE p() BEGIN IF 1 THEN SELECT ';$$'; END IF; SELECT 2; END")
  assert.equal(plan[3].sql, 'CALL p()')
  assert.equal(source.slice(plan[1].start, plan[1].contentEnd).trim(), plan[1].sql)
  assert.doesNotThrow(() => assertValidScript(planSqlScript('DELIMITER //\nCREATE FUNCTION f() RETURNS INT RETURN 1//\nDELIMITER ;', 'mariadb')))
})

test('all lexical/directive failures are detected before executing any unit', () => {
  for (const [dialect, source, message] of [
    ['mysql', 'UPDATE x SET a=1;\nDELIMITER word\nSELECT 1;', /Invalid DELIMITER/],
    ['mysql', 'UPDATE x SET a=1;\nDELIMITER $$\nSELECT 1;', /Missing custom delimiter/],
    ['mysql', 'SELECT 1; /* incomplete', /Unterminated SQL comment/],
    ['mysql', 'SELECT 1; /*!50000 DROP TABLE x */', /Executable SQL comments/],
    ['mysql', 'SELECT 1; /*M! DROP TABLE x */', /Executable SQL comments/],
    ['postgres', "UPDATE x SET a=1; SELECT 'unfinished", /Unterminated/],
    ['oracle', "SELECT 1 FROM dual; SELECT q'[broken' FROM dual;", /Unterminated Oracle/],
    ['mssql', 'UPDATE x SET a=1;\nGO 2\nSELECT 1;', /repeat counts/],
    ['mssql', 'SELECT 1;\n:r local.sql\n', /SQLCMD/]
  ] as const) assert.throws(() => assertValidScript(planSqlScript(source, dialect)), message, source)
})

test('SQL Server GO preserves variable and guarded-block scope, comments/quoted GO do not split', () => {
  const source = "DECLARE @v INT = 2; IF @v=0 BEGIN SELECT 1; DELETE FROM audit; END; SELECT @v;\nGO -- batch\nSELECT 'GO;';\nGO 1\nSELECT 3;"
  const plan = sqlUnits(source, 'mssql')
  assert.equal(plan.length, 3)
  assert.match(plan[0].sql, /^DECLARE.*DELETE.*SELECT @v;/)
  assert.match(plan[1].sql, /'GO;'/)
  assertValidScript(plan)
  assert.equal(sqlUnits('CREATE OR ALTER PROC p AS SELECT 1; SELECT 2;\nGO\nSELECT 3;', 'mssql')[0].kind, 'definition')
})

test('Oracle anonymous blocks, nested local declarations, labelled blocks and packages stay intact', () => {
  const blocks = [
    'BEGIN WHILE x < 3 LOOP x := x + 1; END LOOP; END;',
    '<<guarded>> BEGIN IF 1=0 THEN NULL; DELETE FROM audit; END IF; END;',
    'DECLARE PROCEDURE p IS BEGIN NULL; END; n NUMBER; BEGIN p; n := 1; END;',
    'CREATE OR REPLACE PACKAGE p AS PROCEDURE f; FUNCTION g RETURN NUMBER; END p;',
    'CREATE OR REPLACE PACKAGE BODY p AS PROCEDURE f IS BEGIN NULL; END; FUNCTION g RETURN NUMBER IS BEGIN RETURN 1; END; END p;'
  ]
  for (const block of blocks) {
    const plan = sqlUnits(`${block}\n/\nSELECT q'[a';b]' FROM dual;`, 'oracle')
    assert.equal(plan.length, 2, block); assert.equal(plan[0].sql, block); assert.equal(plan[1].sql, "SELECT q'[a';b]' FROM dual")
    assertValidScript(plan)
  }
})

test('SQLite trigger and PostgreSQL dollar or SQL atomic bodies keep inner semicolons', () => {
  for (const [dialect, definition] of [
    ['sqlite', 'CREATE TRIGGER t AFTER INSERT ON x BEGIN UPDATE x SET a=CASE WHEN a=1 THEN 2 ELSE 3 END; INSERT INTO y VALUES (1); END;'],
    ['postgres', "CREATE FUNCTION f() RETURNS void AS $body$ BEGIN PERFORM ';'; PERFORM 2; END; $body$ LANGUAGE plpgsql;"],
    ['postgres', 'CREATE FUNCTION f() RETURNS INT LANGUAGE SQL BEGIN ATOMIC SELECT 1; SELECT 2; END;'],
    ['mariadb', 'guarded: BEGIN NOT ATOMIC IF 1=0 THEN SELECT 1; DELETE FROM audit; END IF; END;']
  ]) {
    const plan = sqlUnits(`${definition} SELECT 4;`, dialect)
    assert.equal(plan.length, 2, definition); assert.equal(plan[0].sql, definition); assert.equal(plan[1].sql, 'SELECT 4'); assertValidScript(plan)
  }
})

test('SQL quote policies are dialect aware and preserve UTF-16 offsets', () => {
  assert.equal(splitSql('SELECT 1--1; SELECT 2;', 'mysql').length, 2)
  assert.equal(splitSql('SELECT 1--1; SELECT 2;', 'postgres').length, 1)
  for (const dialect of ['postgres', 'sqlite', 'oracle']) assert.equal(splitSql("SELECT 'C:\\'; SELECT 2;", dialect).length, 2)
  assert.equal(splitSql("SELECT E'a\\';b'; SELECT 2;", 'postgres').length, 2)
  for (const sql of ["SELECT '𠀀;'; SELECT 2;", 'SELECT "𠀀;name" FROM t;']) assert.equal(maskSql(sql, 'postgres').length, sql.length)
  assert.equal(isReadQuery('SELECT "a;b" FROM t;', 'postgres'), true)
  assert.equal(isReadQuery("SELECT q'[DELETE;it''s fine]' FROM dual;", 'oracle'), true)
  assert.equal(isReadQuery('SELECT 1;\nGO\nDELETE FROM x;', 'mssql'), false)
  assert.equal(isReadQuery('SELECT 1; EXEC p;', 'mssql'), false)
  assert.equal(isReadQuery('SELECT 1; SELECT 2;', 'mssql'), true)
})

test('transaction policy preflights the complete script and distinguishes definitions from executions', () => {
  const verify = (sql: string, dialect = 'mysql', active = false) => validateExecutionPlan(planSqlScript(sql, dialect), dialect, active, true)
  assert.doesNotThrow(() => verify('BEGIN; UPDATE x SET a=1; COMMIT;'))
  assert.doesNotThrow(() => verify('BEGIN TRANSACTION\nGO\nUPDATE x SET a=1;\nGO\nCOMMIT\nGO', 'mssql'))
  assert.doesNotThrow(() => verify('CREATE PROCEDURE p() BEGIN UPDATE x SET a=1; COMMIT; END;'))
  assert.throws(() => verify('UPDATE x SET a=1; SET autocommit=0;'), /transaction toolbar/)
  assert.throws(() => verify('BEGIN; UPDATE x SET a=1; CREATE TABLE t(id INT);'), /implicitly commit/)
  assert.throws(() => verify('BEGIN NULL; COMMIT; END;', 'oracle'), /Embedded transaction/)
  assert.throws(() => verify('DECLARE @x INT; BEGIN TRANSACTION; SELECT @x;', 'mssql'), /Embedded transaction/)
  assert.throws(() => verify('SELECT 1; SET sql_mode=\'NO_BACKSLASH_ESCAPES\';'), /quote\/escape/)
  assert.throws(() => verify('SELECT 1; BEGIN;', 'mysql', true), /already active/)
  assert.throws(() => verify('SELECT 1; COMMIT;'), /No active transaction/)
  assert.equal(transactionCommand(sqlUnits('BEGIN NULL; END;', 'oracle')[0], 'oracle'), undefined)
})
