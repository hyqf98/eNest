import { createRequire } from 'node:module'
import { Worker } from 'node:worker_threads'
import type { McpJsonSchema } from '@shared/types/mcp'
import { McpFailure } from './mcpErrors'

// Untrusted schema compilation and regex validation must not block Electron's main thread.
const source = `
const {parentPort,workerData}=require('node:worker_threads');
const Ajv=require(workerData.ajv).default;
const ajv=new Ajv({strict:false,allErrors:false,addUsedSchema:false,validateFormats:false});
const cache=new Map();
parentPort.on('message',({id,key,schema,value,compile})=>{
 try {
  let validate=cache.get(key);
  if(!validate){validate=ajv.compile(schema);cache.set(key,validate);if(cache.size>256)cache.delete(cache.keys().next().value);}
  parentPort.postMessage({id,ok:compile?true:!!validate(value)});
 }catch{parentPort.postMessage({id,ok:false});}
});`

let worker: Worker | undefined, nextId = 0
const pending = new Map<number, { resolve(value: boolean): void; timer: ReturnType<typeof setTimeout> }>()
function retire(): void {
  const old = worker
  worker = undefined
  for (const item of pending.values()) { clearTimeout(item.timer); item.resolve(false) }
  pending.clear()
  if (old) void old.terminate()
}
function ensure(): Worker {
  if (worker) return worker
  const current = new Worker(source, { eval: true, workerData: { ajv: createRequire(import.meta.url).resolve('ajv/dist/2020.js') }, resourceLimits: { maxOldGenerationSizeMb: 64, stackSizeMb: 2 } })
  worker = current
  current.unref()
  current.on('message', (message: { id: number; ok: boolean }) => {
    if (worker !== current) return
    const item = pending.get(message.id)
    if (item) { pending.delete(message.id); clearTimeout(item.timer); item.resolve(message.ok === true) }
  })
  current.on('error', () => { if (worker === current) retire() })
  current.on('exit', () => { if (worker === current) retire() })
  return current
}
export function validateMcpSchema(key: string, schema: McpJsonSchema, value?: unknown, compile = false): Promise<boolean> {
  if (pending.size >= 8) return Promise.reject(new McpFailure('busy'))
  return new Promise(resolve => {
    const id = ++nextId
    const current = ensure()
    const timer = setTimeout(retire, 1000)
    pending.set(id, { resolve, timer })
    try { current.postMessage({ id, key, schema, value, compile }) }
    catch { pending.delete(id); clearTimeout(timer); resolve(false) }
  })
}
export function disposeMcpSchemaValidator(): void { retire() }
