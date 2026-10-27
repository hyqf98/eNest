import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
const module={exports:{}}
new Function('exports',ts.transpileModule(readFileSync(new URL('../../../src/main/net/fetchStream.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(module.exports)
const {consumeFetchStream}=module.exports
const encoder=new TextEncoder()
function reader(chunks) {let cancelled=false;return {reader:new ReadableStream({start(controller){for(const chunk of chunks)controller.enqueue(typeof chunk==='string'?encoder.encode(chunk):chunk);controller.close()},cancel(){cancelled=true}}).getReader(),wasCancelled:()=>cancelled}}

test('SSE handles split UTF-8, CRLF, and final unterminated data line',async()=>{
 const encoded=encoder.encode('data: 你好\r\ndata: done'),source=reader([encoded.slice(0,8),encoded.slice(8)]),events=[]
 await consumeFetchStream(source.reader,true,value=>events.push(value))
 assert.deepEqual(events,['你好','done'])
})
test('SSE rejects an unterminated line over 2 MiB',async()=>{
 const source=reader(['data: '+'x'.repeat(2*1024*1024)])
 await assert.rejects(consumeFetchStream(source.reader,true,()=>{}),/SSE line too large/)
})
test('stream has a 32 MiB total budget and bounded event count',async()=>{
 const source=reader(Array.from({length:33},()=>new Uint8Array(1024*1024)))
 await assert.rejects(consumeFetchStream(source.reader,false,()=>{}),/body too large/)
 const events=reader(['data:x\n'.repeat(65537)])
 await assert.rejects(consumeFetchStream(events.reader,true,()=>{}),/event budget/)
})
