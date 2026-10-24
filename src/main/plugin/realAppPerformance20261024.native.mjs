/** Opt-in, serial real-app probe. Never imported by production or the historical test suite. */
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { access, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const require = createRequire(join(root, 'package.json'))
const evidenceRoot = join(root, 'docs/engineering/performance-2026-10-24/round-023')
const samples = ['calculator', 'cron', 'regex', 'password-kit', 'timestamp', 'todos', 'sketchbook', 'sticky-notes']
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const option = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3)
const message = error => error instanceof Error ? error.stack || error.message : String(error)

function safeEnvironment(directory) {
  // Do not forward account/provider credentials, debugger switches, proxy credentials or agent sockets.
  const env = {}
  for (const key of ['PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'SystemRoot', 'WINDIR', 'DISPLAY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR']) {
    if (process.env[key]) env[key] = process.env[key]
  }
  return { ...env, HOME: join(directory, 'home'), USERPROFILE: join(directory, 'home'),
    TMPDIR: join(directory, 'tmp'), TMP: join(directory, 'tmp'), TEMP: join(directory, 'tmp'),
    XDG_CONFIG_HOME: join(directory, 'home/config'), XDG_CACHE_HOME: join(directory, 'home/cache'),
    XDG_DATA_HOME: join(directory, 'home/data'),
    ENEST_TEST_USER_DATA: join(directory, 'user-data'), ENEST_TEST_DATA_ROOT: join(directory, 'data-root') }
}

function redactor(directory) {
  const replacements = [[directory, '<temporary-profile>'], [root.replace(/\/$/, ''), '<repository>'], [process.env.HOME, '<user-home>']]
    .filter(([value]) => value).sort((a, b) => b[0].length - a[0].length)
  return input => {
    let text = String(input)
    for (const [from, to] of replacements) {
      text = text.replaceAll(from, to).replaceAll(encodeURI(from), to)
    }
    return text.replace(/\/Users\/[^/\s"']+/g, '<user-home>')
      .replace(/\b(Bearer\s+)[A-Za-z0-9._~+\/-]+/gi, '$1<redacted>')
      .replace(/([?&](?:access_token|token|api_key|key|secret)=)[^&\s"']+/gi, '$1<redacted>')
  }
}

async function inputs(expectedElectron) {
  const appPackage = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  const electronPackage = JSON.parse(await readFile(require.resolve('electron/package.json'), 'utf8'))
  const expected = expectedElectron || electronPackage.version
  if (!/^\d+\.\d+\.\d+$/.test(expected) || expected !== electronPackage.version) {
    throw new Error(`Expected Electron ${expected}; installed package is ${electronPackage.version}. No install or upgrade is performed.`)
  }
  const required = ['out/main/pluginInstallWorker.js', 'out/renderer/index.html', 'out/renderer/home.html',
    ...['shellPreload', 'pluginPreload', 'backgroundPreload', 'auxiliaryPreload', 'homePreload', 'modalPreload', 'themeChromePreload']
      .map(name => `out/preload/${name}.cjs`)]
  if (process.platform === 'darwin') required.push('native/bin/process-memory-helper')
  const artifacts = []
  for (const path of required) {
    const bytes = await readFile(join(root, path)), info = await stat(join(root, path))
    artifacts.push({ path, bytes: bytes.length, modifiedAt: info.mtime.toISOString(), sha256: sha(bytes) })
  }
  if (process.platform === 'darwin') await access(join(root, 'native/bin/process-memory-helper'), 1)
  const plugins = []
  const sourceRoot = join(root, 'eNest_plugin/plugins')
  for (const entry of (await readdir(sourceRoot, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || !existsSync(join(sourceRoot, entry.name, 'plugin.json'))) continue
    const source = JSON.parse(await readFile(join(sourceRoot, entry.name, 'plugin.json'), 'utf8'))
    const distribution = join(sourceRoot, entry.name, 'dist')
    const bytes = await readFile(join(distribution, 'plugin.json')), manifest = JSON.parse(bytes)
    if (manifest.id !== source.id || manifest.version !== source.version || manifest.development) {
      throw new Error(`Rebuild ${entry.name}: distribution identity/version is stale or contains development configuration`)
    }
    await access(join(distribution, 'index.html'))
    plugins.push({ id: manifest.id, version: manifest.version, manifestSha256: sha(bytes), distribution,
      permissions: manifest.permissions || [] })
  }
  if (plugins.length !== 32) throw new Error(`This round requires all 32 compiled plugins; found ${plugins.length}`)
  for (const name of samples) if (!plugins.some(plugin => plugin.id === `com.github.eNest.${name}`)) throw new Error(`Missing safe sample ${name}`)
  const policy = JSON.parse(await readFile(join(root, 'eNest_plugin/docs/plugin-permission-policy.json'), 'utf8'))
  if (!Array.isArray(policy.builtin)) throw new Error('Generate the canonical permission policy before running this probe')
  return { appPackage, expectedElectron: expected, executable: require('electron'), artifacts, plugins, builtin: policy.builtin }
}

function bootstrap(config) {
  return `
import {app} from 'electron';
import {mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {homedir} from 'node:os';
const config=${JSON.stringify(config)};
app.setAppPath(config.repository);
for (const [name,path] of Object.entries({home:config.home,appData:join(config.home,'app-data'),userData:config.userData,
 sessionData:join(config.temporary,'sessions'),cache:join(config.home,'cache'),temp:join(config.temporary,'tmp'),
 logs:join(config.temporary,'logs'),crashDumps:join(config.temporary,'crashes'),desktop:join(config.home,'Desktop'),
 documents:join(config.home,'Documents'),downloads:join(config.home,'Downloads'),pictures:join(config.home,'Pictures'),
 music:join(config.home,'Music'),videos:join(config.home,'Videos')})) {mkdirSync(path,{recursive:true});app.setPath(name,path)}
if(homedir()!==config.home||app.getPath('home')!==config.home)throw Error('Home isolation failed');
const network={nodeFetchDenied:0,sessionRequestsDenied:0};
const realFetch=globalThis.fetch;
globalThis.fetch=(input,init)=>{let url;try{url=new URL(typeof input==='string'||input instanceof URL?String(input):input.url)}catch{}
 if(url&&['http:','https:'].includes(url.protocol)){network.nodeFetchDenied++;return Promise.reject(Error('Native performance probe is intentionally offline'))}
 return realFetch(input,init)};
app.on('session-created',ses=>{
 const register=ses.webRequest.onBeforeRequest.bind(ses.webRequest);
 // Production installs its own unfiltered policy later. Compose rather than overwrite it.
 ses.webRequest.onBeforeRequest=(...args)=>{
  if(args.length!==1||args[0]!==null&&typeof args[0]!=='function'){
   register((_details,callback)=>callback({cancel:true}));throw Error('Unexpected filtered request registration; probe fails closed');
  }
  const listener=args[0];
  return register((details,callback)=>{
   if(/^(https?|wss?):/i.test(details.url)){network.sessionRequestsDenied++;callback({cancel:true});return}
   if(listener)listener(details,callback);else callback({});
  });
 };
 ses.webRequest.onBeforeRequest(null);
});
const created=new Map(),failures=[];
app.on('web-contents-created',(_event,wc)=>{
 const row={id:wc.id,type:wc.getType(),createdAt:Date.now(),destroyedAt:null};created.set(wc.id,row);
 wc.once('destroyed',()=>{row.destroyedAt=Date.now()});
 wc.on('render-process-gone',(_event,details)=>{if(details.reason!=='clean-exit')failures.push({kind:'renderer-exit',wcId:wc.id,reason:details.reason,exitCode:details.exitCode})});
 wc.on('did-fail-load',(_event,code,_description,_url,isMainFrame)=>{if(isMainFrame&&code!==-3)failures.push({kind:'load-failed',wcId:wc.id,code})});
});
process.on('uncaughtException',error=>failures.push({kind:'uncaught-exception',message:String(error?.message||error)}));
process.on('unhandledRejection',error=>failures.push({kind:'unhandled-rejection',message:String(error?.message||error)}));
(async()=>{
 if(process.versions.electron!==config.expectedElectron)throw Error('Runtime Electron does not match the requested installed version');
 await import('@main/index');
 const {runNativePerformanceProbe}=await import('@main/plugin/realAppPerformance20261024.probe.mjs');
 await runNativePerformanceProbe(config,{network,created,failures});
})().catch(error=>{writeFileSync(config.report,JSON.stringify({schemaVersion:1,status:'failed',passed:false,stage:'bootstrap',
 error:String(error?.stack||error),electron:process.versions.electron,expectedElectron:config.expectedElectron},null,2));app.exit(1)});
`
}

async function childRun(executable, directory, env, append, uiHoldMs) {
  return new Promise(resolveRun => {
    const child = spawn(executable, [directory], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' })
    let timedOut = false, interrupted = false, spawnError = null, forceTimer
    const signal = name => {
      try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, name); else child.kill(name) } catch { /* already exited */ }
    }
    const stop = reason => {
      append(`[runner] ${reason}; terminating only this probe's child process group\n`)
      signal('SIGTERM')
      forceTimer ??= setTimeout(() => signal('SIGKILL'), 8000)
    }
    const interruptedByUser = () => { interrupted = true; stop('interrupted') }
    process.once('SIGINT', interruptedByUser); process.once('SIGTERM', interruptedByUser)
    const watchdogMs = 240_000 + uiHoldMs
    const timer = setTimeout(() => { timedOut = true; stop(`${watchdogMs}-millisecond watchdog expired`) }, watchdogMs)
    for (const [name, stream] of [['stdout', child.stdout], ['stderr', child.stderr]]) stream.on('data', bytes => append(`[${name}] ${bytes}`))
    child.once('error', error => { spawnError = message(error) })
    child.once('close', (code, exitSignal) => {
      clearTimeout(timer); clearTimeout(forceTimer)
      process.removeListener('SIGINT', interruptedByUser); process.removeListener('SIGTERM', interruptedByUser)
      // The group is created by this runner, not a name/port match against another eNest app.
      signal('SIGTERM')
      resolveRun({ exitCode: code, exitSignal, timedOut, interrupted, spawnError })
    })
  })
}

export async function runRealAppPerformance() {
  const label = option('label') || 'migration-baseline'
  if (!/^[\p{L}\p{N}._-]{1,64}$/u.test(label) || label === '.' || label === '..') throw new Error('Use a short label without paths or whitespace')
  const uiHoldMs = Number(option('ui-hold-ms') ?? 0)
  if (!Number.isSafeInteger(uiHoldMs) || uiHoldMs < 0 || uiHoldMs > 300_000) throw new Error('ui-hold-ms must be an integer from 0 to 300000')
  await mkdir(evidenceRoot, { recursive: true })
  const reportPath = join(evidenceRoot, `native-real-app-performance-${label}.json`)
  const logPath = join(evidenceRoot, `native-real-app-performance-${label}.log`)
  if (!process.argv.includes('--overwrite') && (existsSync(reportPath) || existsSync(logPath))) throw new Error('Evidence already exists; select a new --label or explicitly pass --overwrite')
  const directory = await mkdtemp(join(tmpdir(), 'enest-real-app-performance-'))
  const clean = redactor(directory)
  let logs = '', metadata, launch = null, report = null
  const append = value => { logs = (logs + clean(value)).slice(-2 * 1024 * 1024) }
  try {
    metadata = await inputs(option('expected-electron'))
    const env = safeEnvironment(directory)
    for (const path of [env.HOME, env.TMPDIR, env.ENEST_TEST_USER_DATA, env.ENEST_TEST_DATA_ROOT]) await mkdir(path, { recursive: true })
    const plugins = Object.fromEntries(metadata.plugins.map(plugin => [plugin.id, { permissionGrants:
      Object.fromEntries(plugin.permissions.filter(permission => !metadata.builtin.includes(permission)).map(permission => [permission, 'deny'])) }]))
    await writeFile(join(env.ENEST_TEST_DATA_ROOT, 'settings.json'), JSON.stringify({
      general: { dataRoot: env.ENEST_TEST_DATA_ROOT, closeBehavior: 'quit', proxy: { type: 'none' },
        pluginMemoryMonitor: { enabled: true, alertsEnabled: false, warningThresholdMiB: 8192 } }, plugins
    }))
    const config = { repository: root, temporary: directory, home: env.HOME, userData: env.ENEST_TEST_USER_DATA,
      dataRoot: env.ENEST_TEST_DATA_ROOT, report: join(directory, 'report.json'), expectedElectron: metadata.expectedElectron,
      label, plugins: metadata.plugins, sampleIds: samples.map(name => `com.github.eNest.${name}`), artifacts: metadata.artifacts,
      sampleCount: 4, sampleIntervalMs: 2000, uiHoldMs }
    const { build } = await import('esbuild')
    await build({ stdin: { contents: bootstrap(config), resolveDir: root, sourcefile: 'real-app-performance-bootstrap.ts', loader: 'ts' },
      outfile: join(directory, 'main.mjs'), bundle: true, platform: 'node', format: 'esm', target: 'node22',
      tsconfig: join(root, 'tsconfig.node.json'), logLevel: 'warning',
      banner: { js: `import {createRequire as __probeCreateRequire} from 'node:module';
const __enestProbeRequire=__probeCreateRequire(${JSON.stringify(join(root, 'package.json'))});
const require=__enestProbeRequire;
const __filename=${JSON.stringify(join(root, 'out/main/index.js'))};const __dirname=${JSON.stringify(join(root, 'out/main'))};` },
      plugins: [{ name: 'bind-installed-runtime-dependencies-without-service-stubs', setup(builder) {
        // Match Vite's raw asset transform without replacing any application service.
        builder.onResolve({ filter: /\?raw$/ }, async args => {
          const result = await builder.resolve(args.path.slice(0, -4), { kind: args.kind, resolveDir: args.resolveDir })
          return result.errors.length ? { errors: result.errors } : { path: result.path, namespace: 'native-probe-raw-asset' }
        })
        builder.onLoad({ filter: /.*/, namespace: 'native-probe-raw-asset' }, async args => ({
          contents: await readFile(args.path, 'utf8'), loader: 'text'
        }))
        builder.onResolve({ filter: /^[^./]/ }, args => {
          if (/^@(main|shared|preload)\//.test(args.path)) return undefined
          if (args.path === 'electron' || args.path.startsWith('node:')) return { path: args.path, external: true }
          return { path: args.path, namespace: 'installed-native-dependency' }
        })
        builder.onLoad({ filter: /.*/, namespace: 'installed-native-dependency' }, args => ({
          contents: `module.exports=__enestProbeRequire(${JSON.stringify(args.path)});`, loader: 'js'
        }))
      } }] })
    const bundleSha256 = sha(await readFile(join(directory, 'main.mjs')))
    await writeFile(join(directory, 'package.json'), JSON.stringify({ name: metadata.appPackage.name, version: metadata.appPackage.version, type: 'module', main: 'main.mjs', private: true }))
    append(`[runner] label=${label} expectedElectron=${metadata.expectedElectron} plugins=32 samples=4 intervalMs=2000 offline=true\n`)
    launch = await childRun(metadata.executable, directory, env, append, uiHoldMs)
    try { report = JSON.parse(await readFile(config.report, 'utf8')) } catch { report = { schemaVersion: 1, status: 'failed', passed: false, error: 'Child did not produce a valid report' } }
    report.provenance = { ...(report.provenance || {}), bundledRealMainSha256: bundleSha256,
      sourceMainSha256: sha(await readFile(join(root, 'src/main/index.ts'))),
      probeSha256: sha(await readFile(new URL('./realAppPerformance20261024.probe.mjs', import.meta.url))),
      runnerSha256: sha(await readFile(fileURLToPath(import.meta.url))) }
    report.launch = launch
    report.passed = report.passed === true && report.shutdown?.completed === true && launch.exitCode === 0 && !launch.timedOut && !launch.interrupted
    report.temporaryProfileRemoved = false
  } catch (error) {
    append(`[runner] ${message(error)}\n`)
    report = { ...(report || {}), schemaVersion: 1, status: 'failed', passed: false, label,
      expectedElectron: metadata?.expectedElectron || option('expected-electron') || null, launch, error: message(error), temporaryProfileRemoved: false }
  } finally {
    try { await rm(directory, { recursive: true, force: true }); if (report) report.temporaryProfileRemoved = true }
    catch (error) { append(`[runner] Temporary profile removal failed: ${message(error)}\n`); if (report) report.passed = false }
    if (report) await writeFile(reportPath, clean(JSON.stringify(report, null, 2)) + '\n', { mode: 0o600 })
    await writeFile(logPath, logs, { mode: 0o600 })
  }
  console.log(`Native performance report: ${reportPath}\nSanitized log: ${logPath}\nPassed: ${report?.passed === true}`)
  if (report?.passed !== true) process.exitCode = 1
  return report
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv.includes('--run')) console.log('Opt-in only. Run serially after current builds: node src/main/plugin/realAppPerformance20261024.native.mjs --run --expected-electron=44.4.3 --label=migration-baseline\nNo Electron process or bundle is created without --run. A new installed version requires a matching --expected-electron or omission to lock the installed package version.')
  else await runRealAppPerformance().catch(error => { console.error(message(error)); process.exitCode = 1 })
}
