import type { DbDriverId } from '@shared/types/ssh-db'

export const DRIVER_FAMILIES: Record<DbDriverId, string> = {
  mysql: 'mysql', mariadb: 'mysql', tidb: 'mysql', oceanbase: 'mysql', doris: 'mysql', starrocks: 'mysql',
  postgres: 'postgres', timescale: 'postgres', cockroachdb: 'postgres', yugabytedb: 'postgres', questdb: 'postgres',
  sqlite: 'sqlite', mongodb: 'mongodb', redis: 'redis', influxdb: 'flux', influxdb1: 'influxql', influxdb3: 'influx3',
  tdengine: 'tdengine', clickhouse: 'clickhouse', mssql: 'mssql', duckdb: 'duckdb', oracle: 'oracle', cassandra: 'cassandra', scylladb: 'cassandra', neo4j: 'neo4j', elasticsearch: 'search', opensearch: 'search'
}
export const COMPATIBILITY_ENGINES: Partial<Record<DbDriverId, { base: 'mysql' | 'postgres'; label: string; port: number; note: string }>> = {
  mariadb: { base: 'mysql', label: 'MariaDB', port: 3306, note: 'MySQL protocol; server features depend on MariaDB version.' },
  tidb: { base: 'mysql', label: 'TiDB', port: 4000, note: 'MySQL protocol compatibility; distributed-specific administration is not advertised.' },
  oceanbase: { base: 'mysql', label: 'OceanBase (MySQL mode)', port: 2881, note: 'MySQL tenant mode only; Oracle tenant mode is not supported by this adapter.' },
  doris: { base: 'mysql', label: 'Apache Doris', port: 9030, note: 'MySQL query protocol; transaction/row-edit capabilities are disabled.' },
  starrocks: { base: 'mysql', label: 'StarRocks', port: 9030, note: 'MySQL query protocol; transaction/row-edit capabilities are disabled.' },
  cockroachdb: { base: 'postgres', label: 'CockroachDB', port: 26257, note: 'PostgreSQL wire protocol; schema/statistics compatibility is server-version dependent.' },
  yugabytedb: { base: 'postgres', label: 'YugabyteDB (YSQL)', port: 5433, note: 'YSQL PostgreSQL protocol; YCQL is not this adapter.' },
  questdb: { base: 'postgres', label: 'QuestDB (PGWire)', port: 8812, note: 'PGWire queries; PostgreSQL system catalogs and transactions are not assumed.' }
}

export function isStructuredRead(driverId: DbDriverId, text: string): boolean | undefined {
  const family = DRIVER_FAMILIES[driverId]
  if (family === 'mongodb') {
    const value = JSON.parse(text)
    return ['find', 'count', 'aggregate'].includes(value.operation) && !JSON.stringify(value.pipeline || []).match(/"\$(out|merge)"\s*:/)
  }
  if (family === 'redis') {
    const value = JSON.parse(text)
    return Array.isArray(value) && (String(value[0]).toUpperCase() === 'CLIENT' && String(value[1]).toUpperCase() === 'LIST' || String(value[0]).toUpperCase() === 'SLOWLOG' && String(value[1]).toUpperCase() === 'GET' || ['GET','MGET','HGET','HMGET','HGETALL','HSCAN','HLEN','SCAN','SSCAN','SCARD','SMEMBERS','SISMEMBER','ZSCAN','ZCARD','ZRANGE','ZSCORE','LRANGE','LLEN','TYPE','TTL','PTTL','EXISTS','STRLEN','PING','INFO','DBSIZE','TIME','XINFO','XRANGE','XREVRANGE','XLEN'].includes(String(value[0]).toUpperCase()))
  }
  if (family === 'search') { JSON.parse(text); return true }
  if (family === 'flux') return !/\b(to|experimental\.to|http\.post|requests\.)\s*\(/i.test(text) && !/import\s+"(http|experimental\/http|contrib\/)/i.test(text)
  if (family === 'neo4j') return /^\s*(MATCH|OPTIONAL\s+MATCH|RETURN|SHOW|EXPLAIN|PROFILE)\b/i.test(text) && !/\b(CREATE|MERGE|DELETE|SET|REMOVE|DROP|CALL|LOAD)\b/i.test(text)
  return undefined
}

/** Modes implemented by a native read-only connection/transaction or a restricted command API. */
export function supportsIsolatedReadOnly(id: DbDriverId): boolean {
  return ['mysql','mariadb','tidb','oceanbase','postgres','timescale','cockroachdb','yugabytedb','sqlite','duckdb','oracle','clickhouse','mongodb','redis','elasticsearch','opensearch'].includes(id)
}
