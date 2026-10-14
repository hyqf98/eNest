import type { TableRef } from '@shared/types/ssh-db'

export type DbScalar = string | number | boolean | null
export interface DbTableFilter {
  column: string
  operator: 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'contains' | 'in' | 'is-null' | 'not-null'
  value?: DbScalar | DbScalar[]
}
export interface DbTablePage {
  table: TableRef
  offset?: number
  limit?: number
  columns?: string[]
  filters?: DbTableFilter[]
  order?: Array<{ column: string; direction: 'asc' | 'desc' }>
}
export interface DbDesignColumn {
  name: string
  type: 'integer' | 'bigint' | 'decimal' | 'float' | 'varchar' | 'text' | 'boolean' | 'date' | 'timestamp' | 'json' | 'uuid' | 'binary'
  length?: number
  precision?: number
  scale?: number
  nullable?: boolean
  autoIncrement?: boolean
  default?: { kind: 'literal'; value: DbScalar } | { kind: 'expression'; value: 'CURRENT_TIMESTAMP' | 'CURRENT_DATE' | 'CURRENT_TIME' }
}
export interface DbDesignForeignKey {
  name?: string
  columns: string[]
  references: TableRef
  referencedColumns: string[]
  onDelete?: 'NO ACTION' | 'RESTRICT' | 'CASCADE' | 'SET NULL'
}
export type DbTableDesign =
  | { operation: 'create-table'; table: TableRef; columns: DbDesignColumn[]; primaryKey?: string[]; foreignKeys?: DbDesignForeignKey[] }
  | { operation: 'add-column'; table: TableRef; column: DbDesignColumn }
  | { operation: 'rename-column'; table: TableRef; column: string; newName: string }
  | { operation: 'drop-column'; table: TableRef; column: string }
  | { operation: 'create-index'; table: TableRef; name: string; columns: string[]; unique?: boolean }
  | { operation: 'drop-index'; table: TableRef; name: string }
export interface DbDdlPreview {
  statements: string[]
  sql: string
  destructive: boolean
  warnings: string[]
}
