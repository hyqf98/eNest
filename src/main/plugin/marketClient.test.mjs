import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { build } from 'esbuild'
const output=await build({entryPoints:['src/main/plugin/marketClient.ts'],tsconfig:'tsconfig.node.json',bundle:true,write:false,format:'esm',platform:'node',plugins:[{name:'logs',setup(b){b.onResolve({filter:/^@main\/logs\/logService$/},()=>({path:'logs',namespace:'mock'}));b.onLoad({filter:/.*/,namespace:'mock'},()=>({contents:'export const logInfo=()=>{};export const logWarn=()=>{};'}))}}]})
const {fetchMarketReadme}=await import('data:text/javascript;base64,'+Buffer.from(output.outputFiles[0].text).toString('base64'))
test('market README fetching is bounded, caches version URLs and reports failed downloads',async()=>{
 let calls=0
 const server=createServer((req,res)=>{calls++;if(req.url==='/big'){res.end(Buffer.alloc(512*1024+1));return}if(req.url==='/missing'){res.writeHead(404);res.end();return}res.end('# '+req.url)})
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
 const base=`http://127.0.0.1:${server.address().port}`
 try{
  assert.equal(await fetchMarketReadme(base+'/1.0.md'),'# /1.0.md');assert.equal(await fetchMarketReadme(base+'/1.0.md'),'# /1.0.md');assert.equal(calls,1)
  assert.equal(await fetchMarketReadme(base+'/2.0.md'),'# /2.0.md');assert.equal(calls,2)
  await assert.rejects(fetchMarketReadme(base+'/big'),/512 KiB/)
  await assert.rejects(fetchMarketReadme(base+'/missing'),/404/)
  await assert.rejects(fetchMarketReadme('file:///private/README.md'),/invalid/)
 }finally{await new Promise(resolve=>server.close(resolve))}
})
