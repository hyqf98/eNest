import type { CompletionCatalog, CompletionResponse, DbCompletionInput } from '@shared/types/ssh-db'

const vocabularies: Record<string, string[]> = {
  mongodb: ['collection','operation','find','aggregate','count','insertOne','updateOne','deleteOne','filter','projection','sort','pipeline','document','update','$match','$group','$project','$sort','$limit','$unwind','$lookup','$set','$unset','$inc','$eq','$ne','$gt','$gte','$lt','$lte','$in','$and','$or'],
  redis: ['GET','SET','MGET','DEL','EXISTS','SCAN','MATCH','COUNT','TYPE','TTL','PTTL','EXPIRE','HGET','HGETALL','HSET','HSCAN','LRANGE','LPUSH','RPUSH','LLEN','SSCAN','SADD','SCARD','ZRANGE','ZADD','ZSCORE','XADD','XRANGE','XLEN','INFO','DBSIZE','PING'],
  flux: ['from','range','filter','map','keep','drop','rename','group','sort','limit','aggregateWindow','window','mean','sum','count','min','max','first','last','pivot','join','union','yield','bucket','start','stop','every','fn','_time','_value','_measurement','_field'],
  neo4j: ['MATCH','OPTIONAL MATCH','WHERE','RETURN','WITH','ORDER BY','LIMIT','SKIP','UNWIND','CREATE','MERGE','SET','DELETE','DETACH DELETE','SHOW INDEXES','SHOW CONSTRAINTS','EXPLAIN','PROFILE','count','collect','sum','avg','labels','type','properties'],
  cassandra: ['SELECT','FROM','WHERE','LIMIT','PER PARTITION LIMIT','ALLOW FILTERING','INSERT INTO','VALUES','UPDATE','SET','DELETE','CREATE TABLE','CREATE KEYSPACE','ALTER TABLE','DROP TABLE','PRIMARY KEY','CLUSTERING ORDER BY','IF NOT EXISTS','IF EXISTS','USING TTL','USING TIMESTAMP','token','writetime','ttl','count'],
  search: ['query','match_all','match','term','terms','range','bool','must','filter','should','must_not','aggs','size','from','sort','_source','track_total_hits']
}
const templates: Record<string, Array<[string,string]>> = {
  mongodb: [['find documents','{"collection":"collection_name","operation":"find","filter":{},"projection":{},"sort":{"_id":1}}'],['aggregate documents','{"collection":"collection_name","operation":"aggregate","pipeline":[{"$match":{}},{"$limit":100}]}']],
  redis: [['scan keys','["SCAN","0","MATCH","*","COUNT","100"]'],['get key','["GET","key"]']],
  flux: [['read bucket','from(bucket: "bucket")\n  |> range(start: -1h)\n  |> filter(fn: (r) => r._measurement == "measurement")\n  |> limit(n: 200)']],
  neo4j: [['match nodes','MATCH (n) RETURN n LIMIT 200']],
  search: [['search documents','{"query":{"match_all":{}},"size":100}']]
}

/** Native language vocabulary never falls back to MySQL SQL for JSON/Flux/Cypher/Redis. */
export function nativeCompletion(family: string, input: DbCompletionInput, catalog: CompletionCatalog | null): CompletionResponse | undefined {
  const words = vocabularies[family]
  if (!words) return undefined
  const cursor = Math.max(0, Math.min(input.cursor ?? input.sql.length, input.sql.length))
  const prefix = /[\w$.-]*$/.exec(input.sql.slice(0,cursor))?.[0] || '', lower = prefix.toLowerCase()
  const names = catalog?.tables.flatMap(table => [table.name, ...table.columns.map(column => column.name)]) || []
  const items = [...new Set([...words,...names])].filter(word => word.toLowerCase().includes(lower)).map((word,index) => ({ label: word, insertText: word, kind: 'keyword' as const, sortText: String(index).padStart(4,'0'), detail: family }))
  if (!input.sql.slice(0,cursor).trim() || /^[\w ]+$/.test(input.sql.slice(0,cursor))) for (const [label,insertText] of templates[family] || []) if (label.includes(lower)) items.push({ label, insertText, kind: 'keyword', sortText: '0000', detail: `${family} query template` })
  return { replace: { from: cursor-prefix.length, to: cursor }, items: items.slice(0,200), isIncomplete: items.length > 200 }
}
