import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'
import { build } from 'esbuild'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { WebSocketServer } from 'ws'
import { createServer as createHttpServer } from 'node:http'
import { connect as connectTcp } from 'node:net'
const require = createRequire(import.meta.url)
const root = fileURLToPath(new URL('../../../', import.meta.url))
const events = []
globalThis.__websocketEvents = events
globalThis.__websocketProxy = { type: 'none' }
const bundle = await build({
  stdin: { contents: `export * from './src/main/net/websocketService.ts'; export * from './src/main/plugin/PluginRuntimeScope.ts'`, resolveDir: root },
  tsconfig: root + 'tsconfig.node.json', bundle: true, write: false, format: 'esm', platform: 'node', plugins: [{ name: 'fixture', setup(b) {
    b.onResolve({ filter: /^ws$/ }, () => ({ path: pathToFileURL(require.resolve('ws')).href, external: true }))
    b.onResolve({ filter: /^@main\/(plugin\/PluginHost|proxy\/proxyService)$/ }, args => ({ path: args.path, namespace: 'fixture' }))
    b.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: `export const pluginHost = {sendEvent:(id,p)=>globalThis.__websocketEvents.push({id,...p})}; export const getActiveProxy=()=>globalThis.__websocketProxy` }))
  }}]
})
const api = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'))
let generation = 0
function scope() { const pluginId = 'ws.fixture.' + ++generation; return { pluginId, scope: api.createRuntimeScope({ pluginId, generation, wcId: generation }) } }
async function until(predicate) { for (let i=0;i<100;i++) { if(predicate()) return; await new Promise(r=>setTimeout(r,10)) } throw new Error('timed out') }
async function server() {
  const value = new WebSocketServer({ host:'127.0.0.1', port:0 })
  await new Promise(resolve=>value.once('listening',resolve))
  value.on('connection',socket=>socket.on('message',(data,binary)=>socket.send(data,{binary})))
  return value
}

test('host WebSocket: text/binary echo, ownership, limits and runtime disposal', async () => {
  const wss=await server(), own=scope(), other=scope()
  try {
    const { socketId }=await api.websocketConnect(own.pluginId,{url:`ws://127.0.0.1:${wss.address().port}`})
    assert.equal(api.websocketSend(own.pluginId,socketId,'hello').sent,5)
    api.websocketSend(own.pluginId,socketId,'AAH/',true)
    await until(()=>events.filter(e=>e.socketId===socketId&&e.type==='net.websocket.message').length===2)
    assert.ok(events.some(e=>e.socketId===socketId&&e.data==='hello'&&!e.binary))
    assert.ok(events.some(e=>e.socketId===socketId&&e.data==='AAH/'&&e.binary))
    assert.throws(()=>api.websocketSend(other.pluginId,socketId,'x'),/belong/)
    assert.throws(()=>api.websocketSend(own.pluginId,socketId,'?',true),/base64/)
    assert.throws(()=>api.websocketSend(own.pluginId,socketId,'x'.repeat(1024*1024+1)),/1 MiB/)
    await own.scope.dispose()
    assert.throws(()=>api.websocketSend(own.pluginId,socketId,'x'),/belong/)
    await until(()=>wss.clients.size===0)
  } finally { await own.scope.dispose(); await other.scope.dispose(); await new Promise(r=>wss.close(r)) }
})

test('host WebSocket rejects raw schemes, credential URLs and unsupported proxies', async () => {
  const own=scope()
  try {
    for(const url of ['file:///tmp/private','https://example.com','ws://user:secret@example.com']) await assert.rejects(api.websocketConnect(own.pluginId,{url}))
    globalThis.__websocketProxy={type:'custom',url:'https://127.0.0.1:4443'}
    await assert.rejects(api.websocketConnect(own.pluginId,{url:'wss://example.com'}),/unsupported/)
    assert.equal(own.scope.activityCount,0)
  } finally { globalThis.__websocketProxy={type:'none'}; await own.scope.dispose() }
})

test('host WebSocket caps 8 connections and rejects oversized inbound payload', async () => {
  const wss=await server(), own=scope()
  try {
    const url=`ws://127.0.0.1:${wss.address().port}`
    const sockets=await Promise.all(Array.from({length:8},()=>api.websocketConnect(own.pluginId,{url})))
    await assert.rejects(api.websocketConnect(own.pluginId,{url}),/limit/)
    const first=[...wss.clients][0]
    first.send(Buffer.alloc(1024*1024+1))
    await until(()=>events.some(e=>e.socketId===sockets[0].socketId&&e.type==='net.websocket.close'))
    await until(()=>wss.clients.size===7)
  } finally { await own.scope.dispose(); await new Promise(r=>wss.close(r)) }
})


test('host WebSocket uses configured HTTP CONNECT proxy without resolving target locally',async()=>{
  const wss=await server(),own=scope(),proxy=createHttpServer(),tunnels=new Set()
  let requested=''
  proxy.on('connect',(req,client)=>{
    requested=req.url
    const upstream=connectTcp(wss.address().port,'127.0.0.1',()=>{client.write('HTTP/1.1 200 Connection Established\r\n\r\n');client.pipe(upstream);upstream.pipe(client)})
    tunnels.add(client);tunnels.add(upstream)
    client.on('error',()=>{});upstream.on('error',()=>{})
    client.on('close',()=>upstream.destroy());upstream.on('close',()=>client.destroy())
  })
  await new Promise(resolve=>proxy.listen(0,'127.0.0.1',resolve))
  globalThis.__websocketProxy={type:'http',host:'127.0.0.1',port:proxy.address().port}
  try {
    const {socketId}=await api.websocketConnect(own.pluginId,{url:'ws://target.invalid:5678/path'})
    assert.equal(requested,'target.invalid:5678')
    api.websocketSend(own.pluginId,socketId,'through-proxy')
    await until(()=>events.some(e=>e.socketId===socketId&&e.data==='through-proxy'))
  } finally {globalThis.__websocketProxy={type:'none'};await own.scope.dispose();for(const socket of tunnels)socket.destroy();await new Promise(r=>proxy.close(r));await new Promise(r=>wss.close(r))}
})
