import type { DbDriver, DriverHandle } from '@main/database/drivers'
import { adapterBase, objectResult, tableResult } from '@main/database/adapterUtils'
import { isStructuredRead } from '@main/database/driverCatalog'
import { normalizeLimit, wireValue, ResultBudget } from '@main/database/queryPolicy'

export function mongoAdapter(): DbDriver {
  const driver = adapterBase('mongodb', 'MongoDB', 'mongodb', 27017)
  driver.open = async (config, password) => {
    const { MongoClient } = await import('mongodb')
    const uri = String(config.options?.uri || `mongodb://${config.host || '127.0.0.1'}:${config.port ?? 27017}`)
    const client = new MongoClient(uri, { auth: config.username ? { username: config.username, password: password || '' } : undefined,
      authSource: String(config.options?.authSource || config.database || 'admin'), tls: config.options?.ssl === true,
      serverSelectionTimeoutMS: 10000, maxPoolSize: Math.max(1, Math.min(20, Number(config.options?.poolSize) || 5)), promoteLongs: false, promoteValues: false })
    const runtime = { total: 0, active: 0, waiting: 0 }
    client.on('connectionCreated', () => runtime.total++)
    client.on('connectionClosed', () => runtime.total--)
    client.on('connectionCheckOutStarted', () => runtime.waiting++)
    client.on('connectionCheckedOut', () => { runtime.waiting--; runtime.active++ })
    client.on('connectionCheckOutFailed', () => runtime.waiting--)
    client.on('connectionCheckedIn', () => runtime.active--)
    try { await client.connect(); await client.db(config.database).command({ ping: 1 }) } catch (error) { await client.close(); throw error }
    return { id: 'mongodb', raw: client, config, password, database: config.database, readOnly: !!config.options?.readOnly, runtime }
  }
  driver.close = async h => { await (h.raw as import('mongodb').MongoClient).close(); h.closed = true }
  driver.execute = async (h, text, opts) => {
    const { BSON } = await import('mongodb'), started = Date.now(), max = normalizeLimit(opts?.maxRows)
    const query = BSON.EJSON.parse(text, { relaxed: false }) as Record<string, unknown>
    if (!query.collection || !query.operation) throw new Error('MongoDB query requires {collection, operation, filter?/pipeline?/document?}')
    const collection = (h.raw as import('mongodb').MongoClient).db(h.database).collection(String(query.collection))
    let documents: unknown[]
    if (query.operation === 'find') {
      const cursor = collection.find((query.filter || {}) as import('mongodb').Filter<import('mongodb').Document>, { signal: opts?.signal, maxTimeMS: opts?.timeoutMs || 30000,
        projection: query.projection as import('mongodb').Document | undefined }).limit(max + 1)
      if (query.sort) cursor.sort(query.sort as import('mongodb').Sort)
      documents = []; const budget = new ResultBudget()
      try { for await (const doc of cursor) { const safe = BSON.EJSON.serialize(doc, { relaxed: false }); budget.add(safe); documents.push(safe) } } finally { await cursor.close() }
    } else if (query.operation === 'aggregate') {
      if (!Array.isArray(query.pipeline)) throw new Error('pipeline must be an array')
      const pipeline = query.pipeline as import('mongodb').Document[]
      if (pipeline.some(stage => '$out' in stage || '$merge' in stage)) throw new Error('Writing aggregation stages are not supported; use explicit document operations')
      const cursor = collection.aggregate([...pipeline, { $limit: max + 1 }], { signal: opts?.signal, maxTimeMS: opts?.timeoutMs || 30000 })
      documents = []; const budget = new ResultBudget()
      try { for await (const doc of cursor) { const safe = BSON.EJSON.serialize(doc, { relaxed: false }); budget.add(safe); documents.push(safe) } } finally { await cursor.close() }
    } else if (query.operation === 'count') documents = [{ count: await collection.countDocuments((query.filter || {}) as import('mongodb').Document, { maxTimeMS: opts?.timeoutMs || 30000 }) }]
    else {
      if (h.readOnly) throw new Error('Read-only connection rejects document writes')
      if (query.operation === 'insertOne') documents = [await collection.insertOne(query.document as import('mongodb').Document)]
      else if (query.operation === 'updateOne') documents = [await collection.updateOne(query.filter as import('mongodb').Document, query.update as import('mongodb').Document)]
      else if (query.operation === 'deleteOne') documents = [await collection.deleteOne(query.filter as import('mongodb').Document)]
      else throw new Error('Supported MongoDB operations: find, aggregate, count, insertOne, updateOne, deleteOne')
    }
    const result = tableResult(text, started, ['document'], documents.map(doc => [BSON.EJSON.serialize(doc, { relaxed: false })]), max)
    result.format = 'document'; return result
  }
  driver.listDatabases = async h => (await (h.raw as import('mongodb').MongoClient).db().admin().listDatabases({ nameOnly: true })).databases.map(d => d.name)
  driver.listTables = async (h, scope) => (await (h.raw as import('mongodb').MongoClient).db(scope.database || h.database).listCollections({}, { nameOnly: true }).toArray()).map(c => ({ name: c.name, type: 'collection', database: scope.database || h.database }))
  driver.describeTable = async (h, scope, table) => {
    const collection = (h.raw as import('mongodb').MongoClient).db(scope.database || h.database).collection(table)
    const docs = await collection.find({}).limit(50).toArray()
    const names = [...new Set(docs.flatMap(d => Object.keys(d)))]
    return { table, columns: names.map(name => ({ name, dataType: 'sampled BSON', primaryKey: name === '_id' })), indexes: (await collection.indexes()).map(i => ({ name: i.name || '', columns: Object.keys(i.key), unique: !!i.unique })), comment: 'Fields inferred from at most 50 documents; documents may contain additional fields.' }
  }
  return driver
}

export function redisAdapter(): DbDriver {
  const driver = adapterBase('redis', 'Redis', 'redis', 6379)
  driver.open = async (config, password) => {
    const { createClient } = await import('redis')
    const client = createClient({ url: String(config.options?.uri || `${config.options?.ssl ? 'rediss' : 'redis'}://${config.host || '127.0.0.1'}:${config.port ?? 6379}/${Number(config.database) || 0}`), username: config.username, password,
      socket: { connectTimeout: 10000, reconnectStrategy: false } })
    client.on('error', () => undefined)
    await client.connect(); return { id: 'redis', raw: client, config, database: config.database || '0', readOnly: !!config.options?.readOnly }
  }
  driver.close = async h => { if (h.closed) return; h.closed = true; await (h.raw as import('redis').RedisClientType).close() }
  driver.cancel = async h => { (h.raw as import('redis').RedisClientType).destroy(); h.closed = true; return true }
  driver.execute = async (h, text, opts) => {
    const started = Date.now(), command: unknown = JSON.parse(text)
    if (!Array.isArray(command) || !command.length || command.some(v => typeof v !== 'string')) throw new Error('Redis query must be a JSON array, e.g. ["SCAN", "0", "COUNT", "100"]')
    const name = command[0].toUpperCase()
    if (h.readOnly && !isStructuredRead('redis', text)) throw new Error('Read-only connection rejects Redis writes')
    if (['SUBSCRIBE', 'PSUBSCRIBE', 'SSUBSCRIBE', 'MONITOR', 'BLPOP', 'BRPOP', 'BZPOPMIN', 'BZPOPMAX', 'MULTI', 'EXEC', 'DISCARD', 'QUIT', 'SELECT'].includes(name)) throw new Error('Streaming/blocking/session-changing commands are unavailable in the query console')
    if (name === 'KEYS') throw new Error('Use SCAN with COUNT instead of unbounded KEYS')
    const abort = () => { void driver.cancel!(h) }
    opts?.signal?.throwIfAborted(); opts?.signal?.addEventListener('abort', abort, { once: true })
    try {
      const { RESP_TYPES } = await import('redis')
      const result = await (h.raw as import('redis').RedisClientType).sendCommand(command as string[], { abortSignal: opts?.signal, timeout: opts?.timeoutMs || 30000, typeMapping: { [RESP_TYPES.NUMBER]: String, [RESP_TYPES.BIG_NUMBER]: String, [RESP_TYPES.DOUBLE]: String } })
      return { ...tableResult(text, started, ['value'], [[wireValue(result)]], opts?.maxRows), format: 'key-value' }
    } finally { opts?.signal?.removeEventListener('abort', abort) }
  }
  driver.listTables = async h => {
    const result = await (h.raw as import('redis').RedisClientType).scan('0', { COUNT: 200 })
    return result.keys.map(name => ({ name, type: 'key', database: h.database }))
  }
  driver.describeTable = async (h, _scope, key) => {
    const client = h.raw as import('redis').RedisClientType, type = await client.type(key), ttl = await client.ttl(key)
    return { table: key, columns: [{ name: 'value', dataType: type }], metadata: { type, ttlSeconds: ttl, ttlState: ttl === -1 ? 'persistent' : ttl === -2 ? 'expired' : 'countdown' } }
  }
  return driver
}

export function cassandraAdapter(id: 'cassandra' | 'scylladb' = 'cassandra'): DbDriver {
  const driver = adapterBase(id, id === 'scylladb' ? 'ScyllaDB (CQL)' : 'Cassandra', 'cql', 9042)
  driver.open = async (config, password) => {
    const cassandra = await import('cassandra-driver')
    const client = new cassandra.Client({ contactPoints: [config.host || '127.0.0.1'], protocolOptions: { port: config.port ?? 9042 }, localDataCenter: String(config.options?.localDataCenter || 'datacenter1'), keyspace: config.database,
      credentials: config.username ? { username: config.username, password: password || '' } : undefined, socketOptions: { connectTimeout: 10000, readTimeout: 30000 }, sslOptions: config.options?.ssl ? { rejectUnauthorized: true } : undefined })
    await client.connect(); return { id, raw: client, config, password, database: config.database, readOnly: !!config.options?.readOnly }
  }
  driver.close = async h => { await (h.raw as import('cassandra-driver').Client).shutdown(); h.closed = true }
  driver.execute = async (h, text, opts) => {
    opts?.signal?.throwIfAborted(); const started = Date.now(), max = normalizeLimit(opts?.maxRows)
    const result = await (h.raw as import('cassandra-driver').Client).execute(text, Array.isArray(opts?.params) ? opts.params : [], { fetchSize: max + 1, autoPage: false, readTimeout: opts?.timeoutMs || 30000 })
    const rows = result.rows.map(row => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, value && typeof value === 'object' && ['Long','BigDecimal','Integer','Uuid','TimeUuid','LocalDate','LocalTime'].includes(value.constructor?.name) ? String(value) : value])))
    const output = objectResult(text, started, rows, max); output.truncated = output.truncated || !!result.pageState; return output
  }
  driver.listDatabases = async h => (await driver.execute(h, 'SELECT keyspace_name FROM system_schema.keyspaces')).rows.map(r => String(r[0]))
  driver.listTables = async (h, scope) => {
    const result = await driver.execute(h, 'SELECT table_name FROM system_schema.tables WHERE keyspace_name = ?', { params: [scope.database || h.database] })
    return result.rows.map(r => ({ name: String(r[0]), type: 'table', database: scope.database || h.database }))
  }
  driver.describeTable = async (h, scope, table) => {
    const result = await driver.execute(h, 'SELECT column_name, type, kind FROM system_schema.columns WHERE keyspace_name = ? AND table_name = ?', { params: [scope.database || h.database, table] })
    return { table, columns: result.rows.map(r => ({ name: String(r[0]), dataType: String(r[1]), primaryKey: r[2] === 'partition_key' || r[2] === 'clustering' })) }
  }
  return driver
}

export function neo4jAdapter(): DbDriver {
  const driver = adapterBase('neo4j', 'Neo4j', 'cypher', 7687)
  driver.open = async (config, password) => {
    const neo = await import('neo4j-driver')
    const client = neo.driver(String(config.options?.uri || `bolt://${config.host || '127.0.0.1'}:${config.port ?? 7687}`), config.username ? neo.auth.basic(config.username, password || '') : undefined, { connectionTimeout: 10000, maxConnectionPoolSize: 5, useBigInt: true })
    await client.verifyConnectivity(); return { id: 'neo4j', raw: client, config, password, database: config.database, readOnly: !!config.options?.readOnly, runtime: {} }
  }
  driver.close = async h => { await (h.raw as import('neo4j-driver').Driver).close(); h.closed = true }
  driver.execute = async (h, text, opts) => {
    const session = (h.raw as import('neo4j-driver').Driver).session({ database: h.database, defaultAccessMode: h.readOnly ? 'READ' : 'WRITE' }), started = Date.now(), max = normalizeLimit(opts?.maxRows)
    const rows: unknown[][] = []; const budget = new ResultBudget(); let names: string[] = [], truncated = false
    const abort = () => { void session.close() }
    opts?.signal?.throwIfAborted(); opts?.signal?.addEventListener('abort', abort, { once: true })
    try {
      for await (const record of session.run(text, (opts?.params && !Array.isArray(opts.params) ? opts.params : {}), { timeout: opts?.timeoutMs || 30000 })) {
        names = record.keys.map(String)
        if (rows.length >= max) { truncated = true; break }; const safe = [...record.values()].map(wireValue); budget.add(safe); rows.push(safe)
      }
      return { ...tableResult(text, started, names, rows, max), truncated }
    } finally { opts?.signal?.removeEventListener('abort', abort); await session.close() }
  }
  driver.listTables = async h => (await driver.execute(h, 'SHOW INDEXES YIELD labelsOrTypes RETURN DISTINCT labelsOrTypes')).rows.flatMap(r => (Array.isArray(r[0]) ? r[0] : []).map(name => ({ name: String(name), type: 'other' as const })))
  return driver
}
