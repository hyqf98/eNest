import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
const output = await build({entryPoints:[new URL('./clipboardFormats.ts',import.meta.url).pathname],bundle:true,write:false,platform:'node',format:'esm'})
const api = await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`)
test('URI files roundtrip non-ASCII spaces and literal shell characters without commands',()=>{
 const paths = ['/tmp/笔记 a.txt','/tmp/$(touch nope);x\nline.png']
 assert.deepEqual(api.parseFileUris(api.formatFileUris(paths)),paths)
 assert.deepEqual(api.parseFileUris('#comment\ncopy\nfile:///tmp/a\nfile:///tmp/a\nhttps://example.com\nfile://remote/share/a'),['/tmp/a'])
})
test('malformed URI input is rejected and binary DROPFILES checks offsets',()=>{
 assert.deepEqual(api.parseFileUris('file:///%ZZ\nrelative\nfile:///tmp/%00bad'),[])
 assert.deepEqual(api.decodeDropFiles(Buffer.alloc(19)),[])
 const paths=['/tmp/a','/tmp/中文']; assert.deepEqual(api.decodeDropFiles(api.encodeDropFiles(paths)),paths)
 const bad=api.encodeDropFiles(paths);bad.writeUInt32LE(99999,0);assert.deepEqual(api.decodeDropFiles(bad),[])
})
