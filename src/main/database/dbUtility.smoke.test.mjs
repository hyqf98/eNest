/** ENEST_ELECTRON_SMOKE=1 node --test src/main/database/dbUtility.smoke.test.mjs */
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, writeFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import { build } from 'esbuild'
const require = createRequire(import.meta.url)
const root = fileURLToPath(new URL('../../../', import.meta.url))

test('real Electron utility isolates SQLite, bounds results and cancels a blocked worker', { skip: process.env.ENEST_ELECTRON_SMOKE !== '1', timeout: 25000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'enest-db-smoke-'))
  try {
    await writeFile(join(dir, 'package.json'), '{"type":"module"}')
    await symlink(join(root, 'node_modules'), join(dir, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
    const common = { bundle: true, platform: 'node', format: 'esm', packages: 'external', tsconfig: join(root, 'tsconfig.node.json') }
    await build({ ...common, entryPoints: [join(root, 'src/main/database/dbUtility.ts')], outfile: join(dir, 'dbUtility.js') })
    const adapters = {
      '@main/window/createShellWindow': 'export const getMainWindow = () => null;',
      '@main/window/createQuickWindow': 'export const acquireQuickInteraction = () => () => {};',
      '@main/plugin/PluginHost': 'export const pluginHost = {getContainerWindow: () => null};',
      '@main/vault/secretVault': 'export const resolveSecret = () => undefined;',
      '@main/logs/logService': 'export const logWarn = () => {};'
    }
    await build({ ...common, stdin: { resolveDir: root, contents: `
      import { app } from 'electron';
      import { dbOpen, dbExecute, dbCancel, releaseDbSessions, getDbUtilityDiagnostics } from '@main/database/dbSessionManager';
      import { createRuntimeScope } from '@main/plugin/PluginRuntimeScope';
      app.setPath('userData', ${JSON.stringify(join(dir, 'profile'))});
      app.disableHardwareAcceleration();
      console.log('ENEST_PHASE bootstrap');
      app.whenReady().then(async () => { app.dock?.hide(); console.log('ENEST_PHASE ready');
      try {
        const scope = createRuntimeScope({pluginId:'smoke',generation:1,wcId:1});
        const opened = await dbOpen('smoke',{driver:'sqlite',filePath:':memory:'}); console.log('ENEST_PHASE opened');
        const rows = await dbExecute('smoke',{sessionKey:opened.sessionKey,sql:'WITH RECURSIVE t(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM t WHERE x < 20) SELECT x FROM t',maxRows:3});
        const idleLeases=scope.activityCount;
        let ticks=0; const heartbeat=setInterval(()=>ticks++,10);
        const query=dbExecute('smoke',{sessionKey:opened.sessionKey,sql:'WITH RECURSIVE t(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM t WHERE x < 1000000000) SELECT sum(x) FROM t'}).then(()=> 'unexpected success',e=>e.message);
        await new Promise(r=>setTimeout(r,50));
        const started=Date.now(); let cancellation='';
        try { await dbCancel('smoke',opened.sessionKey) } catch(e) { cancellation=e.message }
        const elapsed=Date.now()-started; const queryError=await query; clearInterval(heartbeat);
        const leases=scope.activityCount;
        await releaseDbSessions('smoke'); const utilities=getDbUtilityDiagnostics(); await scope.dispose();
        console.log('ENEST_SMOKE '+JSON.stringify({rows:rows.rows.length,truncated:rows.truncated,idleLeases,ticks,elapsed,cancellation,queryError,leases,utilities}));
        app.exit(0);
      } catch(e) { console.error(e); app.exit(1) }
      });
    ` }, outfile: join(dir, 'bootstrap.mjs'), plugins: [{ name: 'main-adapters', setup(builder) {
      builder.onResolve({ filter: /^@main\// }, ({ path }) => path in adapters ? { path, namespace: 'adapter' } : undefined)
      builder.onLoad({ filter: /.*/, namespace: 'adapter' }, ({ path }) => ({ contents: adapters[path], loader: 'js' }))
      builder.onLoad({ filter: /dbSessionManager\.ts$/ }, async ({ path }) => ({ contents: (await readFile(path, 'utf8')).replace("stdio: 'ignore'", "stdio: 'inherit'"), loader: 'ts' }))
    } }] })
    const result = await new Promise((resolve, reject) => {
      const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
      const child = spawn(require('electron'), [join(dir, 'bootstrap.mjs'), '--no-sandbox'], { env, stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout='', stderr=''
      child.stdout.on('data', chunk => stdout += chunk)
      child.stderr.on('data', chunk => stderr += chunk)
      const timer=setTimeout(()=>{ child.kill('SIGKILL'); reject(new Error('native utility smoke timed out\n'+stdout+'\n'+stderr)) },20000)
      child.once('error', reject)
      child.once('exit', code=>{ clearTimeout(timer); code === 0 ? resolve(stdout) : reject(new Error('Electron exit '+code+'\n'+stderr)) })
    })
    const marker = result.split('\n').find(line => line.startsWith('ENEST_SMOKE '))
    assert.ok(marker, result)
    const data=JSON.parse(marker.slice('ENEST_SMOKE '.length))
    assert.equal(data.rows,3)
    assert.equal(data.truncated,true)
    assert.equal(data.idleLeases,1, 'a connected idle database keeps its plugin runtime active')
    assert.ok(data.ticks >= 3, JSON.stringify(data))
    assert.ok(data.elapsed >= 0 && data.elapsed < 1500, JSON.stringify(data))
    assert.match(data.queryError,/cancelled|service reset/)
    assert.ok(data.cancellation === '' || /service reset/.test(data.cancellation))
    assert.equal(data.leases,0)
    assert.deepEqual(data.utilities, [], 'utility ownership is removed only after the Electron exit event')
    console.log('Native utility evidence:', JSON.stringify(data))
  } finally { await rm(dir,{recursive:true,force:true}) }
})
