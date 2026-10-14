/**
 * Isolated Electron custom-protocol code-cache probe (run with Node).
 * node src/main/plugin/pluginCodeCache.native-bench.mjs --output docs/engineering/plugin-code-cache-2026-10-13.json
 *
 * Every load uses a fresh hidden BrowserWindow/WebContents. The enabled profile is
 * then reused by a new Electron process. No user's profile or plugin data is read.
 * Timings include renderer startup/loading; they are NOT isolated V8 compile time.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir, cpus, release } from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import electronPath from 'electron'

const outputFlag = process.argv.indexOf('--output')
const output = outputFlag >= 0 ? path.resolve(process.argv[outputFlag + 1]) : null
const temp = await mkdtemp(path.join(tmpdir(), 'enest-code-cache-'))
const mainPath = path.join(temp, 'main.cjs')
const scriptPath = path.join(temp, 'fixture.js')
const functionCount = 8000
const expected = functionCount * (functionCount + 1) / 2
const source = [
  'globalThis.fixtureScriptStarted = performance.now();',
  ...Array.from({ length: functionCount }, (_, i) => `function fixture${i}(x) { return x + ${i}; }`),
  `const functions = [${Array.from({ length: functionCount }, (_, i) => `fixture${i}`).join(',')}];`,
  'globalThis.fixtureChecksum = 0;',
  'for (const fn of functions) globalThis.fixtureChecksum += fn(1);',
  'globalThis.fixtureScriptReady = performance.now();'
].join('\n')

const mainSource = `
const {app,BrowserWindow,protocol,session}=require('electron');
const {readFile,writeFile}=require('node:fs/promises');
const {performance}=require('node:perf_hooks');
const profile=process.env.ENEST_CACHE_PROFILE;
app.setPath('userData',profile);app.setPath('sessionData',profile);
const enabled=process.env.ENEST_CACHE_ENABLED==='1';
protocol.registerSchemesAsPrivileged([{scheme:'enest-cache-probe',privileges:{standard:true,secure:true,supportFetchAPI:true,codeCache:enabled}}]);
app.on('window-all-closed',()=>{});
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const round=n=>Math.round(n*1000)/1000;
async function run(){
 await app.whenReady();
 const script=await readFile(process.env.ENEST_CACHE_SCRIPT);
 const html=Buffer.from('<!doctype html><meta charset="utf-8"><script src="fixture.js"></script>');
 const ses=session.fromPartition('persist:code-cache-probe');
 const report={enabled,electron:process.versions.electron,chromium:process.versions.chrome,node:process.versions.node,loads:[],requests:[]};
 ses.protocol.handle('enest-cache-probe',request=>{
   const isScript=new URL(request.url).pathname.endsWith('fixture.js');
   report.requests.push({url:request.url,ifNoneMatch:request.headers.get('if-none-match')});
   return new Response(isScript?script:html,{headers:{
     'Content-Type':isScript?'text/javascript; charset=utf-8':'text/html; charset=utf-8',
     'Cache-Control':'no-cache','ETag':'W/"fixture-build-1"','Last-Modified':'Tue, 13 Oct 2026 00:00:00 GMT'
   }});
 });
 for(let index=0;index<Number(process.env.ENEST_CACHE_LOADS);index++){
   const started=performance.now();
   const win=new BrowserWindow({show:false,width:320,height:240,webPreferences:{session:ses,contextIsolation:true,sandbox:true,nodeIntegration:false}});
   const wc=win.webContents;
   await wc.loadURL('enest-cache-probe://plugin/index.html');
   const loaded=performance.now();
   const execution=await wc.executeJavaScript('({checksum:globalThis.fixtureChecksum,scriptExecutionMs:globalThis.fixtureScriptReady-globalThis.fixtureScriptStarted,documentToScriptReadyMs:globalThis.fixtureScriptReady})');
   if(execution.checksum!==Number(process.env.ENEST_CACHE_EXPECTED))throw Error('fixture checksum mismatch');
   report.loads.push({index:index+1,wcId:wc.id,loadIncludingWindowCreationMs:round(loaded-started),scriptExecutionMs:round(execution.scriptExecutionMs),documentToScriptReadyMs:round(execution.documentToScriptReadyMs),checksum:execution.checksum});
   // Give Chromium's asynchronous code-cache writer time to publish before destroying this WC.
   await sleep(800);
   await new Promise((resolve,reject)=>{
     const timer=setTimeout(()=>reject(Error('fixture renderer was not destroyed')),3000);
     wc.once('destroyed',()=>{clearTimeout(timer);resolve()});win.destroy();
   });
 }
 await sleep(500);
 await writeFile(process.env.ENEST_CACHE_RESULT,JSON.stringify(report));
 app.exit(0);
}
run().catch(async error=>{console.error(error.stack||error);try{await writeFile(process.env.ENEST_CACHE_RESULT,JSON.stringify({error:String(error)}))}catch{}app.exit(1)});
`

async function cacheFiles(profile) {
  const files = []
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const child = path.join(dir, entry.name)
      if (entry.isDirectory()) await walk(child)
      else if (child.includes(`${path.sep}Code Cache${path.sep}`)) files.push({ path: path.relative(profile, child).split(path.sep).join('/'), bytes: (await stat(child)).size })
    }
  }
  await walk(profile)
  return files.sort((a, b) => a.path.localeCompare(b.path))
}

async function run(label, enabled, profile, count) {
  await mkdir(profile, { recursive: true })
  const resultPath = path.join(temp, `${label}.json`)
  const env = { ...process.env, ENEST_CACHE_PROFILE: profile, ENEST_CACHE_ENABLED: enabled ? '1' : '0', ENEST_CACHE_LOADS: String(count), ENEST_CACHE_SCRIPT: scriptPath, ENEST_CACHE_EXPECTED: String(expected), ENEST_CACHE_RESULT: resultPath }
  delete env.ELECTRON_RUN_AS_NODE
  const started = performance.now()
  const launch = await new Promise((resolve, reject) => {
    const child = spawn(electronPath, [mainPath], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', data => { stderr = (stderr + data.toString()).slice(-12000) })
    child.stdout.on('data', data => process.stdout.write(data))
    const timer = setTimeout(() => child.kill('SIGTERM'), 45_000)
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stderr }) })
  })
  const measured = JSON.parse(await readFile(resultPath, 'utf8').catch(() => JSON.stringify({ error: 'Electron did not write a result' })))
  const files = await cacheFiles(profile)
  const compiledEntries = files.filter(file => /\/js\/[a-f\d]+_\d+$/.test(file.path))
  console.log(`${label}: exit=${launch.code}, compiled entries=${compiledEntries.length}, loads=${measured.loads?.length ?? 0}`)
  return { label, processElapsedMs: Math.round(performance.now() - started), ...measured, launch, cacheFiles: files, compiledEntries }
}

try {
  await writeFile(mainPath, mainSource)
  await writeFile(scriptPath, source)
  const runs = []
  runs.push(await run('disabled-fresh-process', false, path.join(temp, 'disabled'), 4))
  const enabledProfile = path.join(temp, 'enabled')
  runs.push(await run('enabled-fresh-process', true, enabledProfile, 4))
  runs.push(await run('enabled-new-process-same-profile', true, enabledProfile, 2))
  const passed = runs.every(run => run.launch.code === 0 && run.loads?.every(load => load.checksum === expected)) && runs[0].compiledEntries.length === 0 && runs[1].compiledEntries.length > 0 && runs[2].compiledEntries.length > 0
  const report = {
    schemaVersion: 1, measuredAt: new Date().toISOString(), platform: process.platform, arch: process.arch,
    osRelease: release(), cpu: cpus()[0]?.model, fixture: { functionCount, bytes: Buffer.byteLength(source), sha256: createHash('sha256').update(source).digest('hex'), expectedChecksum: expected },
    isolation: 'Temporary userData/sessionData, hidden BrowserWindows; each load creates and destroys one new WebContents; user data is never accessed',
    methodology: 'Production-style custom standard scheme, secure=true, codeCache flag varied, Response(Buffer), Cache-Control=no-cache, weak ETag and stable Last-Modified. Enabled profile reused after the first Electron process fully exits.',
    conclusions: {
      codeCacheFilesCreatedOnlyWhenEnabled: runs[0].compiledEntries.length === 0 && runs[1].compiledEntries.length > 0,
      filesPersistAcrossElectronRestart: runs[2].compiledEntries.length > 0,
      allRendererExecutionsCorrect: runs.every(run => run.loads?.every(load => load.checksum === expected)),
      limits: 'No V8 compile trace or cache-hit counters collected. File persistence and successful reload do not prove a cache hit. Load times include native window/renderer initialization and OS noise, use a small fixed-order sample, and do not establish speedup or cross-platform performance.'
    },
    runs, passed
  }
  const json = JSON.stringify(report, null, 2) + '\n'
  if (output) { await mkdir(path.dirname(output), { recursive: true }); await writeFile(output, json); console.log('Report: ' + output) }
  else console.log(json)
  assert.equal(passed, true, 'Electron code-cache probe failed; see report')
} finally {
  await rm(temp, { recursive: true, force: true })
}
