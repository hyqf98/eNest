import { assertValidScript, maskSql, sqlDialect } from '@main/database/sqlScript'
import type { SqlScriptUnit } from '@main/database/sqlScript'

export type TransactionCommand = 'begin' | 'commit' | 'rollback'
export function transactionCommand(unit: SqlScriptUnit, dialect: string): TransactionCommand | undefined {
  const text = maskSql(unit.sql, dialect).trim().replace(/;+\s*$/, '').trim().toUpperCase()
  if (/^(BEGIN(?:\s+(?:TRAN|TRANSACTION|WORK))?|START\s+TRANSACTION)$/.test(text)) return 'begin'
  if (/^(COMMIT(?:\s+(?:TRAN|TRANSACTION|WORK))?|END(?:\s+WORK)?)$/.test(text)) return 'commit'
  if (/^(ROLLBACK(?:\s+(?:TRAN|TRANSACTION|WORK))?|ABORT)$/.test(text)) return 'rollback'
  return undefined
}

/** Validate the whole plan before the first server side effect, not just the next unit. */
export function validateExecutionPlan(units: SqlScriptUnit[], dialectValue: string, transactionActive: boolean, supportsTransaction: boolean): void {
  assertValidScript(units)
  const dialect = sqlDialect(dialectValue)
  let active = transactionActive
  const reject = (unit: SqlScriptUnit, reason: string): never => { throw new Error(`SQL lines ${unit.line}–${unit.endLine}: ${reason}`) }
  for (const unit of units) {
    if (unit.kind === 'directive') continue
    const command = maskSql(unit.sql, dialect).trim().toUpperCase()
    if (/\bSET\s+(?:(?:SESSION|LOCAL|GLOBAL)\s+)?(?:@@(?:SESSION\.)?)?(?:AUTOCOMMIT|IMPLICIT_TRANSACTIONS)\b|\bXA\s|\bPREPARE\s+TRANSACTION\b/.test(command)) reject(unit, 'Use the transaction toolbar or plain BEGIN/COMMIT/ROLLBACK so this console can track transaction ownership')
    if (/\bSET\s+(?:(?:SESSION|LOCAL|GLOBAL)\s+)?(?:@@(?:SESSION\.)?)?(?:SQL_MODE|STANDARD_CONFORMING_STRINGS)\b/.test(command)) reject(unit, 'Changing SQL quote/escape modes during a script is not supported')
    const control = transactionCommand(unit, dialect)
    if (control) {
      if (!supportsTransaction) reject(unit, 'Transactions unsupported by this driver')
      if (control === 'begin' && active) reject(unit, 'Transaction already active')
      if (control !== 'begin' && !active) reject(unit, 'No active transaction')
      active = control === 'begin'; continue
    }
    // Definitions store their body; they do not execute its COMMIT or ROLLBACK now.
    if (unit.kind !== 'definition') {
      if (/\b(?:COMMIT|ABORT)\b|\bROLLBACK\b(?!\s+TO\b)|\bSTART\s+TRANSACTION\b|\bBEGIN\s+(?:TRAN|TRANSACTION|WORK|DISTRIBUTED)\b/.test(command)) reject(unit, 'Embedded transaction control cannot be tracked; use the transaction toolbar, or separate transaction commands into their own statements/GO batches')
      if (/^(?:BEGIN|END)\b/.test(command) && unit.kind === 'statement') reject(unit, 'Unsupported transaction variant; use plain BEGIN/COMMIT/ROLLBACK')
    }
    if (active && ['mysql', 'oracle'].includes(dialect) && (/^(?:CREATE|ALTER|DROP|TRUNCATE|GRANT|REVOKE|RENAME|ANALYZE|OPTIMIZE|REPAIR|LOCK|UNLOCK)\b/.test(command) || unit.kind === 'block' || /^CALL\b/.test(command))) reject(unit, 'Finish the active transaction before DDL or procedural execution that may implicitly commit it')
  }
}
