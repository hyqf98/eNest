/** Shared SQL providers: deterministic DDL previews and parameterized table browsing. */
import type { TableRef } from '@shared/types/ssh-db'
import type { DbScalar, DbDesignColumn, DbTableDesign, DbTablePage, DbDdlPreview } from '@shared/types/db-table-operations'

type Flavor = 'mysql' | 'postgres' | 'sqlite'
const mysql = new Set(['mysql', 'mariadb', 'tidb', 'oceanbase'])
const postgres = new Set(['postgres', 'timescale', 'cockroachdb', 'yugabytedb'])
export function tableOperationsFlavor(driver: string): Flavor | undefined {
  return mysql.has(driver) ? 'mysql' : postgres.has(driver) ? 'postgres' : driver === 'sqlite' ? 'sqlite' : undefined
}
function flavorOf(driver: string): Flavor {
  const flavor = tableOperationsFlavor(driver)
  if (!flavor) throw new Error('This driver does not provide the relational table designer')
  return flavor
}
function identifier(value: string, flavor: Flavor): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 256 || /[\x00-\x1f]/.test(value)) throw new Error('Invalid table or column identifier')
  const quote = flavor === 'mysql' ? '`' : '"'
  return quote + value.replaceAll(quote, quote + quote) + quote
}
function tableName(table: TableRef, flavor: Flavor): string {
  const scope = flavor === 'mysql' ? table.database || table.schema : table.schema
  return [scope, table.table].filter((value): value is string => value !== undefined && value !== '').map(value => identifier(value, flavor)).join('.')
}
function scalar(value: unknown): DbScalar {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  throw new Error('Filter/default values must be finite numbers, strings, booleans or null')
}
function literal(value: DbScalar, flavor: Flavor): string {
  scalar(value)
  if (value === null) return 'NULL'
  if (typeof value === 'number') return String(value)
  if (typeof value === 'boolean') return flavor === 'sqlite' ? (value ? '1' : '0') : (value ? 'TRUE' : 'FALSE')
  if (value.includes('\0')) throw new Error('A default cannot contain a NUL character')
  // MySQL backslash escaping varies with sql_mode; hex literals are mode-independent.
  if (flavor === 'mysql') return `X'${Buffer.from(value).toString('hex')}'`
  return "'" + value.replaceAll("'", "''") + "'"
}
function integer(value: number | undefined, fallback: number, min: number, max: number, label: string): number {
  const result = value ?? fallback
  if (!Number.isSafeInteger(result) || result < min || result > max) throw new Error(`Invalid ${label}`)
  return result
}

export function buildBrowseQuery(driver: string, input: DbTablePage, knownColumns: string[], primaryKey: string[] = []): { sql: string; params: DbScalar[]; limit: number; offset: number; stableOrder: boolean } {
  const flavor = flavorOf(driver), allowed = new Set(knownColumns)
  const col = (name: string): string => { if (!allowed.has(name)) throw new Error(`Unknown column: ${name}`); return identifier(name, flavor) }
  const limit = integer(input.limit, 200, 1, 10000, 'page size'), offset = integer(input.offset, 0, 0, 10000000, 'page offset')
  if ((input.filters?.length || 0) > 32 || (input.order?.length || 0) > 32) throw new Error('Too many filter or sorting rules')
  const params: DbScalar[] = []
  const bind = (value: unknown): string => { params.push(scalar(value)); return flavor === 'postgres' ? `$${params.length}` : '?' }
  const filters = (input.filters || []).map(filter => {
    const name = col(filter.column)
    if (filter.operator === 'is-null') return `${name} IS NULL`
    if (filter.operator === 'not-null') return `${name} IS NOT NULL`
    if (filter.operator === 'in') {
      if (!Array.isArray(filter.value) || filter.value.length < 1 || filter.value.length > 200) throw new Error('IN requires between 1 and 200 values')
      return `${name} IN (${filter.value.map(bind).join(', ')})`
    }
    if (filter.value === null && ['eq', 'ne'].includes(filter.operator)) return `${name} IS ${filter.operator === 'ne' ? 'NOT ' : ''}NULL`
    if (filter.operator === 'contains') {
      if (typeof filter.value !== 'string') throw new Error('Contains requires a text value')
      return `${name} LIKE ${bind('%' + filter.value.replace(/[!%_]/g, value => '!' + value) + '%')} ESCAPE '!'`
    }
    const operator = ({ eq: '=', ne: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=' } as Record<string, string>)[filter.operator]
    if (!operator) throw new Error('Unsupported filter operator')
    return `${name} ${operator} ${bind(filter.value)}`
  })
  if (params.length > 900) throw new Error('Too many filter parameters; reduce IN lists')
  const order = [...(input.order || [])]
  for (const key of primaryKey) if (!order.some(item => item.column === key)) order.push({ column: key, direction: 'asc' })
  const ordering = order.map(item => { if (!['asc', 'desc'].includes(item.direction)) throw new Error('Invalid sort direction'); return `${col(item.column)} ${item.direction.toUpperCase()}` })
  const projection = input.columns?.length ? input.columns.map(col).join(', ') : '*'
  return {
    sql: `SELECT ${projection} FROM ${tableName(input.table, flavor)}${filters.length ? ' WHERE ' + filters.join(' AND ') : ''}${ordering.length ? ' ORDER BY ' + ordering.join(', ') : ''} LIMIT ${limit + 1} OFFSET ${offset}`,
    params, limit, offset, stableOrder: primaryKey.length > 0
  }
}

function columnDefinition(column: DbDesignColumn, flavor: Flavor, primaryKey: string[] = []): string {
  const types: Record<DbDesignColumn['type'], string> = {
    integer: 'INTEGER', bigint: 'BIGINT', decimal: 'DECIMAL', float: flavor === 'postgres' ? 'DOUBLE PRECISION' : 'DOUBLE',
    varchar: 'VARCHAR', text: 'TEXT', boolean: 'BOOLEAN', date: 'DATE', timestamp: 'TIMESTAMP',
    json: flavor === 'postgres' ? 'JSONB' : flavor === 'mysql' ? 'JSON' : 'TEXT',
    uuid: flavor === 'postgres' ? 'UUID' : 'VARCHAR(36)', binary: flavor === 'postgres' ? 'BYTEA' : 'BLOB'
  }
  let type = types[column.type]
  if (!type) throw new Error('Unsupported column type')
  if (column.type === 'varchar') type += `(${integer(column.length, 255, 1, 65535, 'text length')})`
  if (column.type === 'decimal') {
    const precision = integer(column.precision, 18, 1, 65, 'precision'), scale = integer(column.scale, 2, 0, precision, 'scale')
    type += `(${precision}, ${scale})`
  }
  if (column.autoIncrement) {
    if (!['integer', 'bigint'].includes(column.type)) throw new Error('Auto increment requires an integer type')
    if (column.default) throw new Error('Auto increment cannot also have a default')
    if (flavor === 'sqlite') {
      if (column.type !== 'integer' || primaryKey.length !== 1 || primaryKey[0] !== column.name) throw new Error('SQLite auto increment requires a single INTEGER primary key')
      type = 'INTEGER PRIMARY KEY AUTOINCREMENT'
    } else if (flavor === 'postgres') type += ' GENERATED BY DEFAULT AS IDENTITY'
    else {
      if (!primaryKey.includes(column.name)) throw new Error('MySQL auto increment must be indexed; select it as a primary key')
      type += ' AUTO_INCREMENT'
    }
  }
  let sql = `${identifier(column.name, flavor)} ${type}${column.nullable === false || primaryKey.includes(column.name) ? ' NOT NULL' : ''}`
  if (column.default) {
    if (column.default.kind === 'literal') sql += ` DEFAULT ${literal(column.default.value, flavor)}`
    else if (column.default.kind === 'expression' && ['CURRENT_TIMESTAMP', 'CURRENT_DATE', 'CURRENT_TIME'].includes(column.default.value)) sql += ` DEFAULT ${column.default.value}`
    else throw new Error('Unsupported default expression')
  }
  return sql
}

export function previewTableDesign(driver: string, design: DbTableDesign): DbDdlPreview {
  const flavor = flavorOf(driver), table = tableName(design.table, flavor), warnings: string[] = []
  const quote = (name: string): string => identifier(name, flavor)
  let statement: string
  switch (design.operation) {
    case 'create-table': {
      if (!design.columns.length || design.columns.length > 512) throw new Error('A table requires between 1 and 512 columns')
      const names = new Set(design.columns.map(column => column.name)), pk = design.primaryKey || []
      if (names.size !== design.columns.length) throw new Error('Duplicate column names')
      if (pk.some(name => !names.has(name)) || new Set(pk).size !== pk.length) throw new Error('Invalid primary key columns')
      if (design.columns.filter(column => column.autoIncrement).length > 1) throw new Error('Use only one auto increment column')
      const definitions = design.columns.map(column => columnDefinition(column, flavor, pk))
      if (pk.length && !(flavor === 'sqlite' && design.columns.some(column => column.autoIncrement))) definitions.push(`PRIMARY KEY (${pk.map(quote).join(', ')})`)
      for (const fk of design.foreignKeys || []) {
        if (!fk.columns.length || fk.columns.length !== fk.referencedColumns.length || fk.columns.some(name => !names.has(name))) throw new Error('Invalid foreign key column mapping')
        if (fk.onDelete && !['NO ACTION', 'RESTRICT', 'CASCADE', 'SET NULL'].includes(fk.onDelete)) throw new Error('Invalid foreign key delete behavior')
        if (fk.onDelete === 'SET NULL' && fk.columns.some(name => design.columns.find(column => column.name === name)?.nullable === false || pk.includes(name))) throw new Error('SET NULL requires nullable foreign key columns')
        if (flavor === 'sqlite' && fk.references.schema && fk.references.schema !== (design.table.schema || 'main')) throw new Error('SQLite foreign keys cannot reference another attached database')
        const reference = flavor === 'sqlite' ? quote(fk.references.table) : tableName(fk.references, flavor)
        definitions.push(`${fk.name ? 'CONSTRAINT ' + quote(fk.name) + ' ' : ''}FOREIGN KEY (${fk.columns.map(quote).join(', ')}) REFERENCES ${reference} (${fk.referencedColumns.map(quote).join(', ')})${fk.onDelete ? ' ON DELETE ' + fk.onDelete : ''}`)
      }
      statement = `CREATE TABLE ${table} (\n  ${definitions.join(',\n  ')}\n)`
      break
    }
    case 'add-column': statement = `ALTER TABLE ${table} ADD COLUMN ${columnDefinition(design.column, flavor)}`; break
    case 'rename-column': statement = `ALTER TABLE ${table} RENAME COLUMN ${quote(design.column)} TO ${quote(design.newName)}`; warnings.push('检查依赖该字段的视图、查询与应用；旧版本引擎可能不支持 RENAME COLUMN。'); break
    case 'drop-column': statement = `ALTER TABLE ${table} DROP COLUMN ${quote(design.column)}`; warnings.push('删除字段会丢失该字段数据；存在索引或依赖时数据库可能拒绝。'); break
    case 'create-index':
      if (!design.columns.length || design.columns.length > 32 || new Set(design.columns).size !== design.columns.length) throw new Error('Invalid index columns')
      statement = `CREATE ${design.unique ? 'UNIQUE ' : ''}INDEX ${flavor === 'sqlite' && design.table.schema ? quote(design.table.schema) + '.' : ''}${quote(design.name)} ON ${flavor === 'sqlite' ? quote(design.table.table) : table} (${design.columns.map(quote).join(', ')})`; break
    case 'drop-index': statement = `DROP INDEX ${flavor !== 'mysql' && design.table.schema ? quote(design.table.schema) + '.' : ''}${quote(design.name)}${flavor === 'mysql' ? ' ON ' + table : ''}`; break
    default: throw new Error('Unsupported table design operation')
  }
  if (flavor === 'mysql') warnings.push('MySQL 结构修改可能隐式提交当前事务；使用独立结构控制台执行。')
  if (flavor === 'sqlite' && design.operation !== 'create-table') warnings.push('SQLite 修改列受到引擎版本和现有约束限制；失败时不会自动重建表。')
  return { statements: [statement], sql: statement + ';', destructive: design.operation === 'drop-column' || design.operation === 'drop-index', warnings }
}
