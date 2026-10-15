/**
 * Native PluginHost lifecycle benchmark. Run with Node, not electron-vite:
 * node src/main/plugin/PluginHost.native-bench.mjs --output docs/engineering/plugin-native-benchmark-2026-10-13.json
 *
 * Uses real Electron windows, WebContents, renderer processes and protocol requests.
 * Registry/storage/service adapters are isolated fixtures; no user profile is loaded.
 * Measures host detach/destruction and this app's process memory, not end-to-end FPS.
 */
import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import electronPath from 'electron'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const outputFlag = process.argv.indexOf('--output')
const output = outputFlag >= 0 ? path.resolve(process.argv[outputFlag + 1]) : null
const keepBundle = process.argv.includes('--keep-bundle')
const temp = await mkdtemp(path.join(tmpdir(), 'enest-native-bench-'))
const profile = path.join(temp, 'profile')
await mkdir(profile)
const fixtureHtml = `<!doctype html><meta charset="utf-8"><title>Native lifecycle fixture</title>
<style>body{margin:0;background:#13251e;color:#ebf3ed;font:16px system-ui}canvas{width:100%;height:160px}</style>
<body><p>Isolated plugin lifecycle fixture</p><canvas width="1024" height="320"></canvas><script>
  globalThis.fixtureMemory = new Uint8Array(8 * 1024 * 1024);
  globalThis.fixtureMemory.fill(37);
  const canvas = document.querySelector('canvas'), ctx = canvas.getContext('2d');
  let frame = 0;
  function paint() { ctx.fillStyle = '#254e3e'; ctx.fillRect(0, 0, 1024, 320); ctx.fillStyle = '#b4e3cf'; ctx.fillRect((frame++ * 3) % 900, 90, 120, 120); requestAnimationFrame(paint); }
  requestAnimationFrame(paint);
  globalThis.fixtureTimer = setInterval(() => { globalThis.fixtureTick = (globalThis.fixtureTick || 0) + 1 }, 100);
  globalThis.fixtureReady = typeof globalThis.enest?.onBeforeClose === 'function';
  if (location.search.includes('noack')) enest.onBeforeClose(() => new Promise(() => {}));
  if (location.search.includes('veto')) addEventListener('beforeunload', e => { e.returnValue = false });
</script>`
const fixtureScript = fixtureHtml.match(/<script>([\s\S]*?)<\/script>/)[1]
await writeFile(path.join(temp, 'fixture.js'), fixtureScript)
await writeFile(path.join(temp, 'fixture.html'), fixtureHtml.replace(/<script>[\s\S]*?<\/script>/, '<script src="fixture.js"></script>'))


const adapters = {
  fixture: `export const f = { window: null, host: null, events: [], created: [], errors: [] };`,
  '@main/window/createShellWindow': `import {f} from 'fixture'; import path from 'node:path';
    export const getMainWindow=()=>f.window;
    export const getPluginContentBounds=()=>({x:0,y:0,width:1024,height:640});
    export const resolvePreload=()=>path.join(process.env.ENEST_NATIVE_BENCH_DIR,'preload.cjs');
    export const sendShellEvent=e=>{f.events.push(e);if(f.events.length>500)f.events.shift()};`,
  '@main/window/createQuickWindow': `export const getQuickPluginParent=()=>null; export const revealQuickPlugin=()=>{}; export const finishQuickPluginReveal=()=>{}; export const getQuickWindow=()=>null; export const ensureQuickWindow=()=>{throw Error('Quick is outside this benchmark')}; export const prepareQuickWindowForPlugin=async()=>false; export const presentQuickWindowForPlugin=()=>false; export const getQuickPluginBounds=()=>({}); export const getQuickWebContents=()=>null; export const setQuickContentSize=()=>{}; export const hideQuickWindow=()=>{}; export const setQuickPluginHiddenHook=()=>{}; export const setQuickPluginRelayout=()=>{}; export const setQuickPluginResetHook=()=>{};`,
  '@main/settings/SettingsStore': `export const settingsStore={getAll:()=>({general:{sessionTabs:[],sessionActivePluginId:''}}),setAll:async()=>{},flushNow(){}};`,
  '@main/window/detachedPluginWindows': `export const bindDetachedWindowHost=()=>{}; export const createDetachedWindow=async()=>{throw Error('Independent windows are outside this lifecycle benchmark')}; export const destroyDetachedWindow=()=>{}; export const getDetachedWindow=()=>null; export const getDetachedParent=()=>null; export const getDetachedChrome=()=>null; export const getDetachedPluginBounds=()=>({}); export const sendDetachedEvent=()=>{}; export const updateDetachedState=()=>{}; export const presentRestoredDetachedWindow=()=>{}; export const getDetachedWindowSession=()=>null;`,
  '@main/window/orbRailViews': `export const raiseOrbRailViews=()=>{};`,
  '@main/logs/logService': `import {f} from 'fixture'; export const logInfo=()=>{}; export const logWarn=(area,message)=>{f.errors.push({area,message})};`,
  '@main/plugin/PluginSessionStore': `export const clearPluginSession=()=>{}; export const deleteSessionSnapshot=()=>{}; export const loadSessionSnapshot=()=>true; export const saveSessionSnapshot=()=>true; export const getSessionRevision=()=>0; export const releaseSessionMemory=()=>{};`,
  '@main/plugin/PluginRegistry': `export const pluginRegistry={ensureInstalled:async id=>({id,name:id,rootPath:process.env.ENEST_NATIVE_BENCH_DIR}),get:id=>({id,name:id,rootPath:process.env.ENEST_NATIVE_BENCH_DIR}),getManifest:id=>({id,name:id,main:'index.html',ui:{themeAware:false,chrome:'none',background:'opaque'}}),getBuildRevision:()=> 'fixture-build-1',invalidateBuildRevision:()=> 'fixture-build-2'};`,
  '@main/plugin/pluginEnabledStore': `export const isEnabledSync=()=>true;`,
  '@main/plugin/PluginInstaller': `export const setPluginInstallLifecycleHooks=()=>{};`,
  '@main/plugin/pluginProtocol': `import fs from 'node:fs';import path from 'node:path';
    const html=fs.readFileSync(path.join(process.env.ENEST_NATIVE_BENCH_DIR,'fixture.html')), js=fs.readFileSync(path.join(process.env.ENEST_NATIVE_BENCH_DIR,'fixture.js'));
    export const registerPluginProtocolForSession=ses=>{try{ses.protocol.unhandle('enest')}catch{};ses.protocol.handle('enest',request=>{const script=new URL(request.url).pathname.endsWith('.js');return new Response(script?js:html,{headers:{'Content-Type':script?'text/javascript':'text/html; charset=utf-8'}})})};
    export const invalidatePluginFileCache=()=>{}; export const invalidatePluginCodeCache=async()=>{};`,
  '@main/plugin/PermissionService': `export const permissionService={cancelFor(){}};`,
  '@main/proxy/proxyService': `export const applyProxyToPluginPartition=async()=>{}; export const getActiveProxy=()=>({type:'none'});`,
  '@main/db/pluginStorage': `export const releasePluginStorage=()=>true;`,
  '@main/pin/pinService': `export const closeAllPins=()=>{};`,
  '@main/contrib/ContributionRegistry': `export const contributionRegistry={releaseQuickProviders(){}};`,
  '@main/hotkey/pluginRuntimeHotkeys': `export const releasePluginHotkeys=()=>{};`,
  '@main/ssh/sshSessionManager': `export const releaseSshSessions=async()=>{};`,
  '@main/database/dbSessionManager': `export const releaseDbSessions=async()=>{};`,
  '@main/dsh/dshRuntimeService': `export const releaseDshRuntime=async()=>{};`,
  '@main/plugin/localFiles': `export const releaseLocalFiles=()=>{};`,
  '@main/theme/resolveThemeCss': `export const resolveThemeTokens=()=>({}); export const themeTokensToInjectScript=()=>'';`,
  '@main/plugin/externalLinks': `export const routeExternal=async()=>{}; export const isInternalNavigation=()=>true;`
}

const mainSource = `
import { app, BaseWindow, ipcMain, protocol, webContents } from 'electron';
import { writeFile } from 'node:fs/promises';
import os from 'node:os';
import { createServer } from 'node:http';
import { performance } from 'node:perf_hooks';
import { pluginHost } from '@main/plugin/PluginHost';
import { IpcChannels } from '@shared/types/ipc';
import { f } from 'fixture';
app.setPath('userData', process.env.ENEST_NATIVE_BENCH_PROFILE);
app.setPath('sessionData', process.env.ENEST_NATIVE_BENCH_PROFILE);
protocol.registerSchemesAsPrivileged([{scheme:'enest',privileges:{standard:true,secure:true,supportFetchAPI:true}}]);
app.on('window-all-closed',()=>{});
app.on('web-contents-created',(_event,wc)=>{f.created.push(wc.id)});
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const waitFor=async(predicate,ms=10000)=>{const start=performance.now();while(!predicate()){if(performance.now()-start>ms)throw Error('condition timed out');await sleep(20)}};
const rounded=n=>Math.round(n*1000)/1000;
const distribution=values=>{const sorted=[...values].sort((a,b)=>a-b);return sorted.length?{count:sorted.length,min:rounded(sorted[0]),median:rounded(sorted[Math.floor(sorted.length/2)]),p95:rounded(sorted[Math.ceil(sorted.length*.95)-1]),max:rounded(sorted.at(-1))}:null};
function memory(){const metrics=app.getAppMetrics();return {cpuPercent:rounded(metrics.reduce((sum,m)=>sum+(m.cpu?.percentCPUUsage??0),0)),ownProcessCount:metrics.length,rendererProcessCount:metrics.filter(m=>m.type==='Tab').length,workingSetKiB:metrics.reduce((sum,m)=>sum+(m.memory?.workingSetSize??0),0),privateKiB:metrics.every(m=>typeof m.memory?.privateBytes==='number')?metrics.reduce((sum,m)=>sum+m.memory.privateBytes,0):null,mainRssBytes:process.memoryUsage().rss,mainHeapUsedBytes:process.memoryUsage().heapUsed,processes:metrics.map(m=>({type:m.type,pid:m.pid,workingSetKiB:m.memory?.workingSetSize??null,privateKiB:m.memory?.privateBytes??null}))}};
f.host=pluginHost;
ipcMain.on(IpcChannels.PluginLifecycleAck,(event,payload)=>{const id=pluginHost.getPluginIdByWebContentsId(event.sender.id);if(id)pluginHost.ackBeforeClose(id,event.sender.id,payload.operationId,payload.success)});
async function openLoaded(id){const started=performance.now();await pluginHost.openPlugin(id);const wc=pluginHost.getWebContents(id);if(!wc)throw Error('missing webContents '+id);await waitFor(()=>wc.isDestroyed()||pluginHost.getState(id)==='active');if(wc.isDestroyed())throw Error('renderer destroyed during opening '+id);if(!wc.getLastWebPreferences().sandbox)throw Error('plugin renderer sandbox disabled');if(!await wc.executeJavaScript("globalThis.fixtureReady === true && typeof require === 'undefined' && typeof process === 'undefined'"))throw Error('fixture script did not execute');pluginHost.setTitle(id,'Benchmark task');pluginHost.setIcon(id,'✓');pluginHost.setBadge(id,7);return rounded(performance.now()-started)};
async function closeMeasured(id){const wc=pluginHost.getWebContents(id);const wcId=wc?.id??null;const started=performance.now();let destroyedMs=null;const destroyed=wc&&!wc.isDestroyed()?new Promise(resolve=>wc.once('destroyed',()=>{destroyedMs=rounded(performance.now()-started);resolve()})):Promise.resolve();const completion=pluginHost.closePlugin(id);const syncDetachMs=rounded(performance.now()-started);const detached=!f.window.contentView.children.some(view=>view.webContents?.id===wcId);await completion;await destroyed;return {id,hadRenderer:wcId!==null,syncDetachMs,completionMs:rounded(performance.now()-started),destroyedMs,detached,destroyed:!wc||wc.isDestroyed()}};
async function settle(){await waitFor(()=>pluginHost.closing.size===0&&pluginHost.suspending.size===0);await sleep(350)};
async function idleSamples(){const samples=[];memory();for(let i=0;i<3;i++){await sleep(1000);samples.push(memory())}return samples};
async function run(){await app.whenReady();f.window=new BaseWindow({width:1024,height:640,show:false,frame:false});
 let deniedHits=0;const denyServer=createServer((_req,res)=>{deniedHits++;res.end('host boundary bypass')});await new Promise(resolve=>denyServer.listen(0,'127.0.0.1',resolve));const deniedUrl='http://127.0.0.1:'+denyServer.address().port+'/not-granted';
 const report={schemaVersion:2,bundleSha256:process.env.ENEST_NATIVE_BENCH_SHA256,measuredAt:new Date().toISOString(),platform:process.platform,arch:process.arch,osRelease:os.release(),electron:process.versions.electron,chromium:process.versions.chrome,node:process.versions.node,cpu:os.cpus()[0]?.model,totalSystemMemoryBytes:os.totalmem(),isolation:'Fresh temporary userData/sessionData; no user settings, plugins or application data read',scope:'Real Electron PluginHost detach/destroy timing and own app process memory; fixture service adapters; hidden native window; not end-to-end interaction/FPS or cross-platform verification',performanceConditions:'Current version only; run after coordinated build/test stop; external system activity remains uncontrolled; hidden-window timing excludes frame presentation',retainedBundle:process.env.ENEST_NATIVE_BENCH_KEEP==='1'?process.env.ENEST_NATIVE_BENCH_DIR:null,fixture:{preload:'production src/preload/pluginPreload.ts',rendererAllocationMiB:8,canvas:'1024x320 rAF',timerIntervalMs:100,beforeCloseAck:'queueMicrotask',residentLimit:6,sandbox:true,tabMetadata:'Host title/glyph/badge set for every created plugin; map measured after each close batch'},baseline:memory(),tabCounts:[],cycles:null,adversarial:[],warnings:[],passed:true};
 for(const count of [1,6,10,20]){const ids=Array.from({length:count},(_,i)=>'bench'+count+'.p'+i);const opening=[];for(const id of ids)opening.push(await openLoaded(id));await settle();if(count===1){report.coldPluginStartupMs=opening[0];const wc=pluginHost.getWebContents(ids[0]);const blocked=await wc.executeJavaScript('fetch('+JSON.stringify(deniedUrl)+').then(()=>false,()=>true)');report.browserBoundary={blocked,deniedHits,sandbox:wc.getLastWebPreferences().sandbox};report.passed&&=blocked&&deniedHits===0;}const loadedMemory=memory();const residentBeforeClose=webContents.getAllWebContents().length;const closes=[];for(const id of ids)closes.push(await closeMeasured(id));await settle();const orphanIds=webContents.getAllWebContents().map(wc=>wc.id);report.tabCounts.push({logicalTabs:count,residentBeforeClose,openMs:distribution(opening),detachMs:distribution(closes.map(row=>row.syncDetachMs)),destroyedMs:distribution(closes.flatMap(row=>row.destroyedMs===null?[]:[row.destroyedMs])),closes,loadedMemory,afterCloseMemory:memory(),afterCloseHost:pluginHost.getDiagnostics(),orphanIds});report.passed&&=residentBeforeClose<=Math.min(count,6)&&pluginHost.getDiagnostics().tabPresentations===0&&orphanIds.length===0&&closes.every(row=>row.detached&&row.destroyed);console.log('native benchmark tabs='+count+' resident='+residentBeforeClose+' orphans='+orphanIds.length)}
 const warmIds=['bench-warm-a','bench-warm-b','bench-warm-c'];for(const id of warmIds)await openLoaded(id);await settle();const warmSwitches=[];for(let i=0;i<30;i++){const id=warmIds[i%warmIds.length],started=performance.now();await pluginHost.openPlugin(id);const hostActivationMs=rounded(performance.now()-started);await pluginHost.getWebContents(id).executeJavaScript('globalThis.fixtureReady');warmSwitches.push({hostActivationMs,rendererRoundtripMs:rounded(performance.now()-started)})}report.warmSwitch={count:30,hostActivationMs:distribution(warmSwitches.map(x=>x.hostActivationMs)),rendererRoundtripMs:distribution(warmSwitches.map(x=>x.rendererRoundtripMs)),visibleFrameMeasured:false};
 pluginHost.setShellVisible(false);await settle();report.backgroundIdle={state:'three retained background renderers, native parent hidden',samples:await idleSamples()};for(const id of warmIds)pluginHost.hibernatePlugin(id);await settle();report.hibernatedIdle={state:'explicit hibernation invokes production suspend/checkpoint/destroy; three-minute timer policy covered by unit tests',diagnostics:pluginHost.getDiagnostics(),samples:await idleSamples()};report.passed&&=webContents.getAllWebContents().length===0;for(const id of warmIds)await closeMeasured(id);pluginHost.setShellVisible(true);await settle();
 const cycles=[],memorySamples=[];for(let i=0;i<50;i++){const openMs=await openLoaded('bench-cycle');const close=await closeMeasured('bench-cycle');cycles.push({cycle:i+1,openMs,...close});if((i+1)%10===0){await settle();memorySamples.push({cycle:i+1,memory:memory(),host:pluginHost.getDiagnostics(),orphanIds:webContents.getAllWebContents().map(wc=>wc.id)})}}
 report.cycles={count:50,openMs:distribution(cycles.map(row=>row.openMs)),detachMs:distribution(cycles.map(row=>row.syncDetachMs)),destroyedMs:distribution(cycles.map(row=>row.destroyedMs)),samples:cycles,memorySamples};report.passed&&=cycles.every(row=>row.detached&&row.destroyed)&&memorySamples.every(sample=>sample.orphanIds.length===0&&sample.host.tabPresentations===0);
 for(const id of ['bench-noack','bench-veto','bench-blocked']){await openLoaded(id);if(id.endsWith('blocked')){void pluginHost.getWebContents(id).executeJavaScript('globalThis.fixtureBlockStarted=true;const until=Date.now()+4000;while(Date.now()<until){}').catch(()=>{});await sleep(50)}const result=await closeMeasured(id);report.adversarial.push(result);report.passed&&=result.detached&&result.destroyed;console.log('native benchmark '+id+' detached='+result.syncDetachMs+'ms destroyed='+result.destroyedMs+'ms')}
 await pluginHost.destroyAll();await new Promise(resolve=>denyServer.close(resolve));await settle();report.finalMemory=memory();report.finalHost=pluginHost.getDiagnostics();report.finalOrphanIds=webContents.getAllWebContents().map(wc=>wc.id);report.totalCreatedWebContents=f.created.length;report.warnings=f.errors;report.passed&&=report.finalOrphanIds.length===0&&report.finalHost.tabPresentations===0;await writeFile(process.env.ENEST_NATIVE_BENCH_REPORT,JSON.stringify(report,null,2)+'\\n');f.window.destroy();app.exit(report.passed?0:1)}
run().catch(async error=>{console.error(error.stack||error);try{await writeFile(process.env.ENEST_NATIVE_BENCH_REPORT,JSON.stringify({passed:false,error:String(error),stack:error.stack,warnings:f.errors,remainingWebContents:webContents.getAllWebContents().map(wc=>wc.id)},null,2))}catch{}app.exit(1)});
`

try {
  await build({ entryPoints: [path.join(root, 'src/preload/pluginPreload.ts')], tsconfig: path.join(root, 'tsconfig.node.json'),
    outfile: path.join(temp, 'preload.cjs'), bundle: true, format: 'cjs', platform: 'node', external: ['electron'] })
  await build({ stdin: { contents: mainSource, resolveDir: root }, tsconfig: path.join(root, 'tsconfig.node.json'), bundle: true,
    outfile: path.join(temp, 'main.cjs'), format: 'cjs', platform: 'node', external: ['electron'],
    plugins: [{ name: 'native-benchmark-fixtures', setup(b) {
      b.onResolve({ filter: /.*/ }, ({ path: name }) => name in adapters ? { path: name, namespace: 'benchmark' } : undefined)
      b.onLoad({ filter: /.*/, namespace: 'benchmark' }, ({ path: name }) => ({ contents: adapters[name], loader: 'js' }))
    } }] })
  const reportPath = path.join(temp, 'report.json')
  const bundleSha256 = createHash('sha256').update(await readFile(path.join(temp, 'main.cjs'))).update(await readFile(path.join(temp, 'preload.cjs'))).digest('hex')
  const env = { ...process.env, ENEST_NATIVE_BENCH_DIR: temp, ENEST_NATIVE_BENCH_PROFILE: profile, ENEST_NATIVE_BENCH_REPORT: reportPath, ENEST_NATIVE_BENCH_SHA256: bundleSha256, ENEST_NATIVE_BENCH_KEEP: keepBundle ? '1' : '0' }
  delete env.ELECTRON_RUN_AS_NODE
  const result = await new Promise(resolve => {
    const child = spawn(electronPath, [path.join(temp, 'main.cjs')], { env, stdio: 'inherit' })
    const timeout = setTimeout(() => { child.kill('SIGTERM') }, 180_000)
    child.once('error', error => { clearTimeout(timeout); resolve({ code: 1, error: String(error) }) })
    child.once('exit', (code, signal) => { clearTimeout(timeout); resolve({ code: code ?? 1, signal }) })
  })
  const json = await readFile(reportPath, 'utf8').catch(() => JSON.stringify({ passed: false, launchResult: result }, null, 2))
  if (output) { await mkdir(path.dirname(output), { recursive: true }); await writeFile(output, json); console.log('Report: ' + output) }
  else console.log(json)
  process.exitCode = result.code
} finally {
  if (keepBundle) { await rm(profile, { recursive: true, force: true }); console.log('Retained fixture bundle (profile removed): ' + temp) }
  else await rm(temp, { recursive: true, force: true })
}
