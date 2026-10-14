import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { execFile } from 'node:child_process'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
const require=createRequire(import.meta.url), root=fileURLToPath(new URL('../../../',import.meta.url))
const bundle=await build({stdin:{contents:`export {sqliteAdapter} from './src/main/database/sqliteRuntime.ts'; export {duckdbAdapter} from './src/main/database/additionalSqlAdapters.ts'`,resolveDir:root},bundle:true,write:false,platform:'node',format:'esm',tsconfig:root+'tsconfig.node.json',plugins:[{name:'native',setup(b){
  b.onResolve({filter:/^(@duckdb\/node-api|oracledb|mssql|@clickhouse\/client)$/},args=>({path:pathToFileURL(require.resolve(args.path)).href,external:true}))
}}]})
const moduleUrl='data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64')
test('native SQLite and DuckDB cannot read/write arbitrary paths or re-enable unsafe features',{timeout:30000},async()=>{
  const script=`
    import assert from 'node:assert/strict';
    const {sqliteAdapter,duckdbAdapter}=await import(${JSON.stringify(moduleUrl)});
    for(const [name,factory,attacks] of [
      ['sqlite',sqliteAdapter,["ATTACH DATABASE ':memory:' AS bypass", "VACUUM INTO '/tmp/enest-forbidden.sqlite'", 'PRAGMA trusted_schema=ON', 'PRAGMA writable_schema=ON', "SELECT load_extension('anything')"]],
      ['duckdb',duckdbAdapter,["SELECT * FROM read_text('/etc/hosts')", "COPY (SELECT 1) TO '/tmp/enest-forbidden.csv'", "ATTACH '/tmp/enest-forbidden.db'", 'SET enable_external_access=true', "INSTALL httpfs"]]
    ]) {
      const driver=factory(),h=await driver.open({driver:name,filePath:':memory:'});
      try { assert.equal((await driver.execute(h,'SELECT 1 AS n')).rows.length,1); for(const sql of attacks) await assert.rejects(driver.execute(h,sql),undefined,name+': '+sql) }
      finally { await driver.close(h) }
    }
    console.log('local database security policies enforced');
  `
  const dir=await mkdtemp(join(tmpdir(),'enest-db-policy-'))
  try {
    const path=join(dir,'probe.mjs');await writeFile(path,script)
    const {stdout}=await promisify(execFile)(require('electron'),[path],{env:{...process.env,ELECTRON_RUN_AS_NODE:'1'},timeout:25000,maxBuffer:1024*1024})
    assert.match(stdout,/policies enforced/)
  } finally { await rm(dir,{recursive:true,force:true}) }
})
