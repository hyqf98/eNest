/** Requires built plugin dist/backend and a packaged shell. ENEST_ELECTRON_SMOKE=1 node --test src/main/plugin/pluginBackend.artifact.smoke.test.mjs */
import assert from 'node:assert/strict'
import test from 'node:test'
import { cp, mkdtemp, mkdir, readFile, writeFile, rm, realpath } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import { build } from 'esbuild'
const require = createRequire(import.meta.url)
const root = fileURLToPath(new URL('../../../', import.meta.url))
const defaultShell = join(root, 'release/packaging-fixed-2026-10-15/mac-arm64/eNest.app/Contents/Resources')

test('final copied plugin backends load independently and preserve SQLite/DuckDB cancellation and middleware protocol', { skip: process.env.ENEST_ELECTRON_SMOKE !== '1', timeout: 90000 }, async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'enest-isolated-artifact-')), dir = await realpath(temporary)
  const sources = {}, hashes = {}
  try {
    for (const name of ['database', 'middleware', 'ssh']) {
      const source = join(root, `eNest_plugin/plugins/${name}/dist/backend`)
      assert.ok(existsSync(join(source, 'index.cjs')), `Build ${name} before this test`)
      await cp(source, join(dir, name), { recursive: true })
      sources[name] = source
      hashes[name] = createHash('sha256').update(await readFile(join(source, 'index.cjs'))).digest('hex')
    }
    const shell = process.env.ENEST_PACKAGED_RESOURCES || defaultShell
    assert.ok(existsSync(join(shell, 'app.asar')), 'Package shell before this test or set ENEST_PACKAGED_RESOURCES')
    await mkdir(join(dir, 'shell'))
    await cp(join(shell, 'app.asar'), join(dir, 'shell/app.asar'))
    if (existsSync(join(shell, 'app.asar.unpacked'))) await cp(join(shell, 'app.asar.unpacked'), join(dir, 'shell/app.asar.unpacked'), { recursive: true })
    const moduleGroups = {
      database: ['@clickhouse/client', '@duckdb/node-api', '@tdengine/websocket', 'cassandra-driver', 'csv-parse', 'lossless-json', 'mongodb', 'mssql', 'mysql2', 'neo4j-driver', 'oracledb', 'pg', 'pg-query-stream', 'redis', 'undici'],
      middleware: ['amqplib', 'kafkajs', 'mqtt'], ssh: ['ssh2'], shell: ['adm-zip', 'ajv', 'pinyin-pro', 'ws']
    }
    await writeFile(join(dir, 'probe.cjs'), `
      const {createRequire} = require('node:module');
      const path = require('node:path');
      const groups = ${JSON.stringify(moduleGroups)}, imports=[];
      for (const [group,names] of Object.entries(groups)) {
        const entry = path.join(__dirname, group, group === 'shell' ? 'app.asar/package.json' : 'index.cjs');
        const load = createRequire(entry);
        for (const name of names) { try { const resolved=load.resolve(name); load(name); if(!resolved.startsWith(__dirname+path.sep))throw Error('outside isolated artifact: '+resolved); imports.push({name,group,resolved,ok:true}) } catch(error) { imports.push({name,group,ok:false,error:String(error)}) } }
      }
      const externalCache = Object.keys(require.cache).filter(x=>path.isAbsolute(x)&&!x.startsWith(__dirname+path.sep));
      process.parentPort.postMessage({imports,externalCache,node:process.versions.node,electron:process.versions.electron,platform:process.platform,arch:process.arch});
      setTimeout(()=>process.exit(0), 50);
    `)
    const adapters = {
      '@main/window/createShellWindow': 'export const getMainWindow = () => null;',
      '@main/window/createQuickWindow': 'export const acquireQuickInteraction = () => () => {};',
      '@main/plugin/PluginHost': 'export const pluginHost = {getContainerWindow: () => null, sendSurfaceEvent:()=>{}, sendEvent:()=>{}};',
      '@main/vault/secretVault': 'export const resolveSecret = () => undefined;',
      '@main/logs/logService': 'export const logWarn = () => {};',
      '@main/plugin/localFiles': 'export const pickLocalFiles=()=>{}; export const pickLocalSaveFile=()=>{}; export const resolveLocalFileHandle=()=>{throw Error("No external file handles in artifact test")};',
      '@main/plugin/pluginBackend': `export const resolvePluginBackendEntry = id => ${JSON.stringify(dir)} + '/' + (id.startsWith('mw') ? 'middleware' : 'database') + '/index.cjs';`
    }
    await build({ bundle: true, platform: 'node', format: 'esm', packages: 'external', tsconfig: join(root, 'tsconfig.node.json'), stdin: { resolveDir: root, contents: `
      import {app,utilityProcess} from 'electron';
      import {dbOpen,dbExecute,dbCancel,releaseDbSessions,getDbUtilityDiagnostics} from '@main/database/dbSessionManager';
      import {mwWorkbenchRpc,releaseMwSessions,getMwUtilityDiagnostics} from '@main/middleware/mwSessionManager';
      import {createRuntimeScope} from '@main/plugin/PluginRuntimeScope';
      app.setPath('userData', ${JSON.stringify(join(dir, 'profile'))}); app.disableHardwareAcceleration();
      app.whenReady().then(async()=>{ app.dock?.hide();
        try {
          const modules=await new Promise((resolve,reject)=>{ const child=utilityProcess.fork(${JSON.stringify(join(dir, 'probe.cjs'))},[],{stdio:'inherit'}); let seen=false; child.once('message',data=>{seen=true;resolve(data)}); child.once('exit',code=>{if(!seen)reject(Error('module probe exited '+code))}) });
          const database=[];
          for (const driver of ['sqlite','duckdb']) {
            const id='db-'+driver, scope=createRuntimeScope({pluginId:id,generation:1,wcId:driver==='sqlite'?1:2});
            const opened=await dbOpen(id,{driver,database:':memory:'});
            const sql=driver==='sqlite' ? 'WITH RECURSIVE t(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM t WHERE x < 20) SELECT x FROM t' : 'SELECT range AS x FROM range(20)';
            const rows=await dbExecute(id,{sessionKey:opened.sessionKey,sql,maxRows:3});
            let ticks=0; const heartbeat=setInterval(()=>ticks++,10);
            const expensive=driver==='sqlite' ? 'WITH RECURSIVE t(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM t WHERE x < 1000000000) SELECT sum(x) FROM t' : 'SELECT SUM(SQRT(i)) FROM range(100000000000) t(i)';
            const running=dbExecute(id,{sessionKey:opened.sessionKey,sql:expensive}).then(()=>({success:true}),error=>({error:error.message}));
            await new Promise(resolve=>setTimeout(resolve,60));
            const started=Date.now(); let cancellation=''; try {await dbCancel(id,opened.sessionKey)} catch(error) {cancellation=error.message}
            const elapsed=Date.now()-started, query=await running; clearInterval(heartbeat);
            await releaseDbSessions(id); await scope.dispose();
            database.push({driver,rows:rows.rows.length,truncated:rows.truncated,ticks,elapsed,cancellation,query,leases:scope.activityCount});
          }
          const mwScope=createRuntimeScope({pluginId:'mw-isolated',generation:1,wcId:3});
          const kinds=await mwWorkbenchRpc('mw-isolated',{action:'kinds.list'});
          await releaseMwSessions('mw-isolated'); await mwScope.dispose();
          console.log('ENEST_ARTIFACT '+JSON.stringify({modules,database,middleware:{kinds,leases:mwScope.activityCount},databaseUtilities:getDbUtilityDiagnostics(),middlewareUtilities:getMwUtilityDiagnostics()}));
          app.exit(0);
        } catch(error) {console.error(error);app.exit(1)}
      });
    ` }, outfile: join(dir, 'bootstrap.mjs'), plugins: [{ name: 'artifact-adapters', setup(b) {
      b.onResolve({ filter: /^@main\// }, x => x.path in adapters ? { path: x.path, namespace: 'adapter' } : undefined)
      b.onLoad({ filter: /.*/, namespace: 'adapter' }, x => ({ contents: adapters[x.path], loader: 'js' }))
    } }] })
    const stdout = await new Promise((resolve, reject) => {
      const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_PATH; delete env.NODE_OPTIONS
      const child = spawn(require('electron'), [join(dir, 'bootstrap.mjs'), '--no-sandbox'], { env, cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout='', stderr=''
      child.stdout.on('data', value => stdout += value); child.stderr.on('data', value => stderr += value)
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(Error('Artifact smoke timed out\n'+stdout+'\n'+stderr)) }, 60000)
      child.once('error', reject); child.once('exit', code => { clearTimeout(timer); code === 0 ? resolve(stdout) : reject(Error('Artifact Electron exit '+code+'\n'+stdout+'\n'+stderr)) })
    })
    const marker = stdout.split('\n').find(x => x.startsWith('ENEST_ARTIFACT ')); assert.ok(marker, stdout)
    const data = JSON.parse(marker.slice('ENEST_ARTIFACT '.length))
    const evidence = { ...data, sources, hashes, shell, isolationRoot: dir, note: 'Final dist/backend copied outside workspace; NODE_PATH and NODE_OPTIONS removed. No external DB/MW services contacted.' }
    if (process.env.ENEST_ARTIFACT_EVIDENCE) await writeFile(process.env.ENEST_ARTIFACT_EVIDENCE, JSON.stringify(evidence, null, 2))
    assert.equal(data.modules.imports.length, 23)
    assert.deepEqual(data.modules.imports.filter(x=>!x.ok), [])
    assert.deepEqual(data.modules.externalCache, [])
    for (const result of data.database) {
      assert.equal(result.rows, 3); assert.equal(result.truncated, true); assert.ok(result.ticks >= 3, JSON.stringify(result)); assert.ok(result.elapsed < 1500, JSON.stringify(result))
      assert.match(result.query.error || '', /cancelled|interrupt|service reset/i)
      assert.equal(result.leases, 0)
    }
    assert.equal(data.middleware.kinds.length, 4); assert.equal(data.middleware.leases, 0)
    assert.deepEqual(data.databaseUtilities, []); assert.deepEqual(data.middlewareUtilities, [])
    console.log('Artifact evidence:', JSON.stringify({ loaded: data.modules.imports.length, ...data, modules: undefined }))
  } finally { await rm(dir, { recursive: true, force: true }) }
})
