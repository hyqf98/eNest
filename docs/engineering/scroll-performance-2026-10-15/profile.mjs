import assert from 'node:assert/strict'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { chromium } from 'playwright-core'
import { build } from 'esbuild'
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, basename } from 'node:path'

import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
const root=fileURLToPath(new URL('../../../',import.meta.url))
const phase=process.argv[2]||'current'
const output=join(root,'docs/engineering/scroll-performance-2026-10-15')
mkdirSync(output,{recursive:true})
const traceOutput=join(tmpdir(),'enest-scroll-performance-2026-10-15')
mkdirSync(traceOutput,{recursive:true})
const registry=JSON.parse(readFileSync(join(root,'eNest_plugin/dist/registry.json'),'utf8'))
const built=await build({stdin:{resolveDir:root,contents:"export * from '@main/plugin/marketMetadata'"},tsconfig:join(root,'tsconfig.node.json'),platform:'node',format:'esm',bundle:true,write:false})
const {parseRemoteMarket,remoteToSummary}=await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`)
const plugins=parseRemoteMarket(registry,'https://github.com/hyqf98/eNest_plugin/releases/download/plugins-local/registry.json','https://github.com/hyqf98/eNest_plugin/releases/latest/download/').map((entry,index)=>({
  ...remoteToSummary(entry,true),installed:index%4===0,
  icon:entry.icon?.startsWith('data:')?entry.icon:`/__asset/${encodeURIComponent(basename(decodeURIComponent(new URL(registry.plugins[index].icon).pathname)))}`,
  screenshots:entry.screenshots.map(url=>`/__asset/${encodeURIComponent(basename(decodeURIComponent(new URL(url).pathname)))}`),
}))
const server=await createServer({configFile:false,root:join(root,'src/renderer'),plugins:[react(),{name:'real-market-fixture',configureServer(server){server.middlewares.use((req,res,next)=>{
  if(req.url==='/__catalog'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify(plugins));return}
  if(req.url?.startsWith('/__asset/')){const name=decodeURIComponent(req.url.slice(9));if(name!==basename(name)){res.statusCode=403;res.end();return}try{res.setHeader('Content-Type',name.endsWith('.svg')?'image/svg+xml':'image/png');res.end(readFileSync(join(root,'eNest_plugin/dist',name)))}catch{res.statusCode=404;res.end()}return}
  next()
})}}],resolve:{alias:Object.fromEntries(['renderer','shared','main','preload'].map(name=>[`@${name}`,join(root,'src',name)]))},server:{host:'127.0.0.1',port:4197,strictPort:true},logLevel:'warn'})
await server.listen()

const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true})
const page=await browser.newPage({viewport:{width:1440,height:900},deviceScaleFactor:2})
const cdp=await page.context().newCDPSession(page)
await cdp.send('Performance.enable')
await cdp.send('LayerTree.enable')
let layers=[]
cdp.on('LayerTree.layerTreeDidChange',e=>{if(e.layers)layers=e.layers})
const browserCdp=await browser.newBrowserCDPSession()
const gpu=await browserCdp.send('SystemInfo.getInfo')
const report={phase,fixture:'Actual 35-entry local registry; 1440x900 viewport at DPR 2; medium animation; native CDP mouse scroll gestures; no CPU throttling',browser:await browser.version(),gpu:gpu.gpu.devices,rounds:[]}
const errors=[];page.on('pageerror',e=>errors.push(e.message))
const metrics=async()=>Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(({name,value})=>[name,value]))
try {
 await page.addInitScript(()=>{localStorage.setItem('enest.theme.v1',JSON.stringify({mode:'light',overrides:{},backgroundEffect:'tunnel'}));localStorage.setItem('enest.settings.v1',JSON.stringify({general:{locale:'zh-CN',animationLevel:'medium',tabStyle:'classic'},quick:{enabled:false}}))})
 await page.goto('http://127.0.0.1:4197/')
 await page.locator('.app-boot.ready').waitFor()
 await page.evaluate(async()=>{const fixture=await(await fetch('/__catalog')).json();const {shellApi}=await import('/services/shellApi.ts');shellApi.getPlugins=async()=>fixture;shellApi.getMarketStatus=async()=>({state:'ready',catalogCount:fixture.length,fetchedAt:Date.now()});const {useShellStore}=await import('/stores/shellStore.ts');useShellStore.setState({plugins:fixture,query:'',category:'全部',seg:'browse'});const {useThemeStore}=await import('/hooks/useTheme.ts');await useThemeStore.getState().setBackgroundEffect('tunnel')})
 await page.getByRole('button',{name:'刷新市场',exact:true}).click()
 await page.waitForTimeout(1200)
 for (const scenario of ['home','settings']) {
  await page.evaluate(async(scenario)=>{const {useShellStore}=await import('/stores/shellStore.ts');useShellStore.setState({view:scenario==='home'?'home':'settings',settingsTab:'appearance'})},scenario)
  const selector=scenario==='home'?'.page-home':'.page-settings'
  await page.locator(selector).waitFor()
  await page.waitForTimeout(1000)
  const configuration=await page.evaluate(selector=>{const el=document.querySelector(selector);return {scrollHeight:el.scrollHeight,clientHeight:el.clientHeight,blurSurfaces:[...document.querySelectorAll('*')].filter(n=>getComputedStyle(n).backdropFilter!=='none').map(n=>({className:n.className,filter:getComputedStyle(n).backdropFilter})),level:document.documentElement.dataset.anim,background:document.documentElement.className}},selector)
  if (scenario==='home') assert.ok(configuration.scrollHeight>configuration.clientHeight)
  await page.screenshot({path:join(output,`${phase}-${scenario}.png`)})
  for(let round=0;round<3;round++) {
   await page.locator(selector).evaluate(el=>{el.scrollTop=0})
   await page.waitForTimeout(350)
   const trace=[];const collect=e=>trace.push(...e.value)
   cdp.on('Tracing.dataCollected',collect)
   await cdp.send('Tracing.start',{categories:'devtools.timeline,disabled-by-default-devtools.timeline.frame,cc,gpu',options:'record-as-much-as-possible',transferMode:'ReportEvents'})
   const before=await metrics()
   await page.evaluate(()=>{window.scrollSample={frames:[],scrolls:0,start:performance.now(),running:true};let previous=performance.now();const run=now=>{if(!window.scrollSample.running)return;window.scrollSample.frames.push(now-previous);previous=now;requestAnimationFrame(run)};requestAnimationFrame(run);window.scrollObserver=()=>window.scrollSample.scrolls++;document.addEventListener('scroll',window.scrollObserver,{capture:true,passive:true})})
   await cdp.send('Input.synthesizeScrollGesture',{x:1200,y:550,yDistance:-1800,speed:650,gestureSourceType:'mouse',preventFling:true})
   await cdp.send('Input.synthesizeScrollGesture',{x:1200,y:550,yDistance:1800,speed:650,gestureSourceType:'mouse',preventFling:true})
   const sample=await page.evaluate(()=>{window.scrollSample.running=false;document.removeEventListener('scroll',window.scrollObserver,true);return {...window.scrollSample,end:performance.now()}})
   const after=await metrics()
   const complete=new Promise(resolve=>cdp.once('Tracing.tracingComplete',resolve));await cdp.send('Tracing.end');await complete;cdp.off('Tracing.dataCollected',collect)
   const sorted=sample.frames.slice(1).sort((a,b)=>a-b),duration=sample.end-sample.start
   const names=['Paint','RasterTask','Layout','UpdateLayoutTree','PrePaint','Layerize','CompositeLayers']
   const events=Object.fromEntries(names.map(name=>{const items=trace.filter(e=>e.name===name&&e.ph==='X');return [name,{count:items.length,totalMs:items.reduce((s,e)=>s+(e.dur||0)/1000,0)}]}))
   const entry={scenario,round,configuration,layers:layers.length,durationMs:duration,frames:sample.frames.length,rafHz:sample.frames.length*1000/duration,p95FrameMs:sorted[Math.floor(sorted.length*.95)],framesOver25ms:sorted.filter(n=>n>25).length,scrollEvents:sample.scrolls,metrics:Object.fromEntries(['TaskDuration','ScriptDuration','LayoutDuration','RecalcStyleDuration','LayoutCount','RecalcStyleCount'].map(name=>[name,after[name]-before[name]])),events}
   report.rounds.push(entry)
   if(round===0) writeFileSync(join(traceOutput,`${phase}-${scenario}-trace.json`),JSON.stringify({traceEvents:trace}))
   console.log(JSON.stringify(entry))
  }
 }
 report.errors=errors;assert.deepEqual(errors,[])
 writeFileSync(join(output,`${phase}.json`),JSON.stringify(report,null,2))
} finally {await browser.close();await server.close()}
