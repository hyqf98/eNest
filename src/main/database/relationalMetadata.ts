import type { DbDriver } from '@main/database/drivers'
import type { TableDetail } from '@shared/types/ssh-db'
import { quoteIdentifier } from '@main/database/queryPolicy'
import { DIALECT_INFO } from '@main/database/dialects'

/** Metadata uses the same bounded execution path and transaction connection as the console. */
export function attachRelationalMetadata(driver: DbDriver, flavor: 'mysql' | 'postgres'): void {
  const q = (value: string) => quoteIdentifier(value, flavor)
  driver.listDatabases = async h => (await driver.execute(h, flavor === 'mysql' ? 'SHOW DATABASES' : 'SELECT datname FROM pg_database WHERE datistemplate=false', { maxRows: 10000 })).rows.map(row => String(row[0]))
  driver.listSchemas = async h => flavor === 'mysql' ? [] : (await driver.execute(h, "SELECT schema_name FROM information_schema.schemata WHERE schema_name NOT IN ('pg_catalog','information_schema','pg_toast') ORDER BY schema_name", { maxRows: 10000 })).rows.map(row => String(row[0]))
  driver.listTables = async (h, scope) => {
    const schema = (flavor === 'mysql' ? scope.database || h.database : scope.schema || 'public')!
    const result = await driver.execute(h, flavor === 'mysql' ? 'SELECT TABLE_NAME,TABLE_TYPE,TABLE_COMMENT FROM information_schema.TABLES WHERE TABLE_SCHEMA=? ORDER BY TABLE_NAME' : 'SELECT table_name,table_type,NULL FROM information_schema.tables WHERE table_schema=$1 ORDER BY table_name', { params: [schema], maxRows: 10000 })
    return result.rows.map(row => ({ name: String(row[0]), type: String(row[1]).includes('VIEW') ? 'view' : 'table', schema: flavor === 'postgres' ? schema : undefined, database: flavor === 'mysql' ? schema : h.database, comment: row[2] == null ? undefined : String(row[2]) }))
  }
  driver.describeTable = async (h, scope, table) => {
    const schema = (flavor === 'mysql' ? scope.database || h.database : scope.schema || 'public')!
    const params = [schema, table]
    const columns = await driver.execute(h, flavor === 'mysql'
      ? 'SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, COLUMN_KEY, COLUMN_COMMENT FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? AND TABLE_NAME=? ORDER BY ORDINAL_POSITION'
      : `SELECT a.attname, format_type(a.atttypid,a.atttypmod), NOT a.attnotnull, pg_get_expr(d.adbin,d.adrelid), EXISTS(SELECT 1 FROM pg_index i WHERE i.indrelid=c.oid AND i.indisprimary AND a.attnum=ANY(i.indkey)), col_description(c.oid,a.attnum)
         FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum
         WHERE n.nspname=$1 AND c.relname=$2 AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum`, { params, maxRows: 10000 })
    const indexes = await driver.execute(h, flavor === 'mysql'
      ? 'SELECT INDEX_NAME,COLUMN_NAME,NON_UNIQUE=0 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=? AND TABLE_NAME=? ORDER BY INDEX_NAME,SEQ_IN_INDEX'
      : `SELECT ci.relname, pg_get_indexdef(i.indexrelid,k.ord::int,true), i.indisunique FROM pg_index i JOIN pg_class c ON c.oid=i.indrelid JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_class ci ON ci.oid=i.indexrelid CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY k(attnum,ord) WHERE n.nspname=$1 AND c.relname=$2 ORDER BY ci.relname,k.ord`, { params, maxRows: 10000 })
    const references = await driver.execute(h, flavor === 'mysql'
      ? 'SELECT CONSTRAINT_NAME,COLUMN_NAME,REFERENCED_TABLE_SCHEMA,REFERENCED_TABLE_NAME,REFERENCED_COLUMN_NAME FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA=? AND TABLE_NAME=? AND REFERENCED_TABLE_NAME IS NOT NULL ORDER BY CONSTRAINT_NAME,ORDINAL_POSITION'
      : `SELECT fk.conname,a.attname,rn.nspname,rc.relname,ra.attname FROM pg_constraint fk JOIN pg_class c ON c.oid=fk.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_class rc ON rc.oid=fk.confrelid JOIN pg_namespace rn ON rn.oid=rc.relnamespace CROSS JOIN LATERAL unnest(fk.conkey,fk.confkey) WITH ORDINALITY k(attnum,refnum,ord) JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum=k.attnum JOIN pg_attribute ra ON ra.attrelid=rc.oid AND ra.attnum=k.refnum WHERE fk.contype='f' AND n.nspname=$1 AND c.relname=$2 ORDER BY fk.conname,k.ord`, { params, maxRows: 10000 })
    const indexMap = new Map<string, NonNullable<TableDetail['indexes']>[number]>()
    for (const row of indexes.rows) { const name = String(row[0]), value = indexMap.get(name) || { name, columns: [], unique: row[2] === true || Number(row[2]) === 1 }; value.columns.push(String(row[1])); indexMap.set(name, value) }
    const fkMap = new Map<string, NonNullable<TableDetail['foreignKeys']>[number]>()
    for (const row of references.rows) { const name = String(row[0]), value = fkMap.get(name) || { name, columns: [], referencedSchema: String(row[2]), referencedTable: String(row[3]), referencedColumns: [] }; value.columns.push(String(row[1])); value.referencedColumns.push(String(row[4])); fkMap.set(name, value) }
    const detail: TableDetail = { table, schema, database: h.database, columns: columns.rows.map(row => ({ name: String(row[0]), dataType: String(row[1]), nullable: flavor === 'mysql' ? row[2] === 'YES' : row[2] === true, default: row[3], defaultValue: row[3], primaryKey: flavor === 'mysql' ? row[4] === 'PRI' : row[4] === true, comment: row[5] == null ? undefined : String(row[5]) })), indexes: [...indexMap.values()], foreignKeys: [...fkMap.values()] }
    detail.primaryKey = detail.columns.filter(column => column.primaryKey).map(column => column.name)
    return detail
  }
  driver.getDdl = async (h, scope, table) => {
    const schema = (flavor === 'mysql' ? scope.database || h.database : scope.schema || 'public')!, qualified = `${q(schema)}.${q(table)}`
    if (flavor === 'mysql') return String((await driver.execute(h, `SHOW CREATE TABLE ${qualified}`)).rows[0]?.[1] || '')
    const relation = await driver.execute(h, 'SELECT c.relkind,c.relispartition,EXISTS(SELECT 1 FROM pg_inherits i WHERE i.inhrelid=c.oid) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname=$2', { params: [schema, table] })
    if (relation.rows[0]?.[0] === 'v') return `CREATE VIEW ${qualified} AS\n${String((await driver.execute(h, 'SELECT pg_get_viewdef($1::regclass,true)', { params: [qualified] })).rows[0]?.[0] || '')};`
    if (relation.rows[0]?.[0] !== 'r' || relation.rows[0]?.[1] || relation.rows[0]?.[2]) throw new Error('DDL export for partitioned/inherited/materialized relations needs the server schema export tool')
    const cols = await driver.execute(h, `SELECT a.attname,format_type(a.atttypid,a.atttypmod),a.attnotnull,pg_get_expr(d.adbin,d.adrelid),a.attidentity,a.attgenerated FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid=$1::regclass AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum`, { params: [qualified], maxRows: 10000 })
    const constraints = await driver.execute(h, 'SELECT conname,pg_get_constraintdef(oid,true) FROM pg_constraint WHERE conrelid=$1::regclass ORDER BY conname', { params: [qualified], maxRows: 10000 })
    const indexes = await driver.execute(h, 'SELECT pg_get_indexdef(i.indexrelid) FROM pg_index i WHERE i.indrelid=$1::regclass AND NOT EXISTS(SELECT 1 FROM pg_constraint c WHERE c.conindid=i.indexrelid)', { params: [qualified], maxRows: 10000 })
    const definitions = cols.rows.map(row => `${q(String(row[0]))} ${row[1]}${row[4] ? ` GENERATED ${row[4] === 'a' ? 'ALWAYS' : 'BY DEFAULT'} AS IDENTITY` : row[5] ? ` GENERATED ALWAYS AS (${row[3]}) ${row[5] === 's' ? 'STORED' : 'VIRTUAL'}` : row[3] != null ? ` DEFAULT ${row[3]}` : ''}${row[2] ? ' NOT NULL' : ''}`)
    definitions.push(...constraints.rows.map(row => `CONSTRAINT ${q(String(row[0]))} ${row[1]}`))
    return `-- Logical table DDL; ownership, grants, triggers, policies and sequence creation are not included.\nCREATE TABLE ${qualified} (\n  ${definitions.join(',\n  ')}\n);\n${indexes.rows.map(row => row[0] + ';').join('\n')}`
  }
  driver.completionCatalog = async (h, scope) => {
    const schema = (flavor === 'mysql' ? scope.database || h.database : scope.schema || 'public')!
    const tables = await driver.listTables(h, scope)
    const columns = await driver.execute(h, flavor === 'mysql'
      ? 'SELECT TABLE_NAME,COLUMN_NAME,COLUMN_TYPE,COLUMN_KEY FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? ORDER BY TABLE_NAME,ORDINAL_POSITION'
      : 'SELECT table_name,column_name,data_type,NULL FROM information_schema.columns WHERE table_schema=$1 ORDER BY table_name,ordinal_position', { params: [schema], maxRows: 10000 })
    const references = await driver.execute(h, flavor === 'mysql'
      ? 'SELECT TABLE_NAME,COLUMN_NAME,REFERENCED_TABLE_NAME,REFERENCED_COLUMN_NAME FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA=? AND REFERENCED_TABLE_NAME IS NOT NULL'
      : `SELECT c.relname,a.attname,rc.relname,ra.attname FROM pg_constraint fk JOIN pg_class c ON c.oid=fk.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_class rc ON rc.oid=fk.confrelid CROSS JOIN LATERAL unnest(fk.conkey,fk.confkey) k(attnum,refnum) JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum=k.attnum JOIN pg_attribute ra ON ra.attrelid=rc.oid AND ra.attnum=k.refnum WHERE fk.contype='f' AND n.nspname=$1`, { params: [schema], maxRows: 10000 })
    const info = DIALECT_INFO[driver.id] || DIALECT_INFO[flavor === 'mysql' ? 'mysql' : 'timescale']
    return { dialect: driver.dialect, databases: await driver.listDatabases(h), schemas: await driver.listSchemas(h, scope.database), tables: tables.map(table => ({ name: table.name, schema, type: table.type, columns: columns.rows.filter(row => row[0] === table.name).map(row => ({ name: String(row[1]), type: String(row[2]), pk: row[3] === 'PRI' })), fks: references.rows.filter(row => row[0] === table.name).map(row => ({ column: String(row[1]), refTable: String(row[2]), refColumn: String(row[3]) })) })), keywords: info.keywords, functions: info.functions }
  }
}
